//! Per-worktree working-tree file watcher.
//!
//! The `.git` watcher (`commands::git_watcher`) only sees commits, stages, and
//! checkouts — HEAD and `index` touches. A *pure working-tree edit* (an agent
//! writing code without `git add`) touches no `.git` file, so before this it
//! was invisible to the status service until the slow 15 s fallback poll. This
//! watches the worktree root directly and pulses the status service
//! (`RefreshCause::FsEdit`) so the sidebar diffstat updates within a few
//! hundred ms.
//!
//! **Cost control is the whole game.** `target/` (10-30 GB, see AGENTS.md) and
//! `node_modules/` churn constantly during builds. Every event is filtered
//! through a gitignore matcher (the `ignore` crate) and the `.git/` subtree is
//! dropped *before* a pulse is sent — `git diff --numstat HEAD` ignores those
//! paths anyway, so an unfiltered pulse would only burn a subprocess for a
//! no-op recompute. A burst of real edits is coalesced by a 150 ms debounce
//! before the single pulse (the status service then debounces another 200 ms
//! and only emits when the computed status actually changed).
//!
//! **fd cost / registration strategy is platform-split:**
//! * macOS (FSEvents): one *recursive* stream per worktree (~1 fd), inherently
//!   cheap — ignored-subtree events are dropped by the gitignore filter in the
//!   callback, never registered as separate watches.
//! * Linux/other (inotify): a recursive registration would add one watch
//!   *descriptor per subdirectory* — including the ignored `target/` (10-30 GB)
//!   and `node_modules/` — which can exhaust the per-user `max_user_watches`
//!   budget (shared with `git_watcher`) or fail with `ENOSPC`. So we instead
//!   enumerate only the *non-ignored* directories with `ignore::WalkBuilder`
//!   (which honors root + nested `.gitignore`, the global excludesfile, and
//!   `.git/info/exclude`, and prunes `.git`) and register one `NonRecursive`
//!   watch each. Newly created non-ignored dirs are watched on demand (the
//!   dir-add drain in `start`), so coverage stays complete without recursing
//!   into ignored trees.
//!
//! Watcher lifecycle is tied to the status service's subscription set, which
//! only ever holds the *active project's* visible worktrees — never inactive
//! projects. Construction is done off the status-service lock (see
//! `status_service::set_subscriptions`) because the Linux walk can take a while.
//!
//! Errors self-heal like `git_watcher`: notify-backend errors are rate-limited
//! in the log and a supervisor rebuilds the watcher after they persist.
//!
//! The gitignore matcher is built from the worktree's root `.gitignore` plus
//! `.git/info/exclude` once at start. A later edit to `.gitignore` is picked up
//! when the watcher is next rebuilt (project switch / resubscribe) — acceptable,
//! since ignore-rule edits are rare and the big churners (`target/`,
//! `node_modules/`) are stable.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use std::collections::HashSet;

use ignore::WalkBuilder;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::Emitter;
use tokio::sync::mpsc;
use tracing::{info, warn};

use super::status_service::RefreshCause;
use crate::commands::notify_watch::{
    ErrorRateMap, HealthState, SUPERVISOR_TICK, emit_rate_limited_error,
};

/// Coalesce a burst of edits (an agent saving many files at once) into one
/// pulse. The status service debounces another 200 ms on top.
const DEBOUNCE: Duration = Duration::from_millis(150);

/// Max distinct directories carried in one `worktree-fs-changed` payload.
/// A build storm inside an expanded `target/` can touch thousands of dirs per
/// debounce window; past this cap the payload degrades to `dirs: null`
/// ("refetch everything you have loaded") instead of an unbounded list.
const BROWSER_DIR_CAP: usize = 64;

/// Payload of the `worktree-fs-changed` event — the file browser's refresh
/// signal. Unlike the status pulse, this stream is NOT gitignore-filtered
/// (the browser lists everything on disk, Finder-style); only `.git` is
/// excluded.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChangedPayload {
    /// The worktree path exactly as subscribed (what the frontend knows).
    path: String,
    /// Root-relative dirs whose listings changed; `None` = refetch all loaded.
    dirs: Option<Vec<String>>,
}

/// Holds the live watcher and the root it watches so the supervisor can swap
/// the watcher out on rebuild without disturbing anything else.
struct Inner {
    watcher: RecommendedWatcher,
    root: PathBuf,
}

/// Cloneable handles the watcher callback + supervisor rebuild both need, bundled
/// so `build_watcher` / `supervise_watcher` don't carry four positional args.
#[derive(Clone)]
struct WatcherDeps {
    /// One `()` per relevant event → the debounce task → a `FsEdit` trigger.
    raw_tx: mpsc::UnboundedSender<()>,
    /// Newly created non-ignored directories → the dir-add drain (Linux only;
    /// macOS recursion covers new dirs for free, so the callback never sends).
    dir_tx: mpsc::UnboundedSender<PathBuf>,
    /// Parent dir of every touched path (`.git` excluded, gitignore NOT
    /// applied) → the browser debounce → a `worktree-fs-changed` emit.
    browser_tx: mpsc::UnboundedSender<PathBuf>,
    error_state: Arc<Mutex<ErrorRateMap>>,
    health: Arc<Mutex<HealthState>>,
}

/// True on backends where a recursive watch would register a descriptor per
/// subdir (inotify); false where one recursive stream is cheap (macOS FSEvents).
/// A `cfg!` (not `#[cfg]`) so both branches always compile and are type-checked.
const PER_DIR_WATCHES: bool = !cfg!(target_os = "macos");

/// A running working-tree watcher. Dropping it aborts its tasks and releases
/// the underlying notify watcher (stops watching).
pub(super) struct WorktreeFsWatcher {
    supervisor: tauri::async_runtime::JoinHandle<()>,
    debounce: tauri::async_runtime::JoinHandle<()>,
    /// Debounces the unfiltered stream into `worktree-fs-changed` emits.
    browser_debounce: tauri::async_runtime::JoinHandle<()>,
    /// The per-dir add drain (inotify backends only; `None` on macOS, where the
    /// recursive stream covers new dirs). It holds a clone of `_inner`, so
    /// leaving it detached would keep the `Arc` — and with it the live notify
    /// watcher — alive forever after this struct drops.
    dir_drain: Option<tauri::async_runtime::JoinHandle<()>>,
    /// Owns the live notify watcher (the supervisor holds a clone for rebuilds).
    /// Held only to keep the watcher alive for this struct's lifetime — never
    /// read directly, so it carries the conventional leading underscore.
    _inner: Arc<Mutex<Inner>>,
}

impl std::fmt::Debug for WorktreeFsWatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorktreeFsWatcher").finish_non_exhaustive()
    }
}

impl Drop for WorktreeFsWatcher {
    fn drop(&mut self) {
        self.supervisor.abort();
        self.debounce.abort();
        self.browser_debounce.abort();
        if let Some(drain) = self.dir_drain.take() {
            drain.abort();
        }
    }
}

impl WorktreeFsWatcher {
    /// Start watching `root` (a worktree path). Forwards a `RefreshCause::FsEdit`
    /// into `trigger_tx` (the status service's per-path trigger channel) on each
    /// debounced burst of non-ignored file activity. Returns `Err` only when the
    /// OS refuses to create the watcher at all — the caller degrades to the
    /// status service's fallback poll.
    pub(super) fn start(
        root: PathBuf,
        trigger_tx: mpsc::UnboundedSender<RefreshCause>,
        app: tauri::AppHandle,
    ) -> notify::Result<Self> {
        // The frontend keys worktrees by the path it subscribed with — carry
        // that verbatim in the event payload, before canonicalization below.
        let payload_path = root.to_string_lossy().to_string();
        // Canonicalize once up front. notify's FSEvents backend reports
        // canonical event paths, so a non-canonical root (e.g. a worktree under
        // a symlinked dir like macOS `/tmp` -> `/private/tmp`) would make every
        // `strip_prefix(root)` in `under_skipped_top_level` / the gitignore matcher fail
        // and the filters fail *open* — re-admitting the `.git/` and `target/`
        // churn this watcher exists to drop. Fall back to the raw path if the
        // dir can't be resolved (it always should — it's a live worktree).
        let root = std::fs::canonicalize(&root).unwrap_or(root);

        // Raw notify pulses (one `()` per relevant event) feed the debounce
        // task; new-dir paths feed the dir-add drain (Linux only).
        let (raw_tx, mut raw_rx) = mpsc::unbounded_channel::<()>();
        let (dir_tx, mut dir_rx) = mpsc::unbounded_channel::<PathBuf>();
        let (browser_tx, mut browser_rx) = mpsc::unbounded_channel::<PathBuf>();
        let deps = WatcherDeps {
            raw_tx,
            dir_tx,
            browser_tx,
            error_state: Arc::new(Mutex::new(ErrorRateMap::default())),
            health: Arc::new(Mutex::new(HealthState::default())),
        };

        // `deps` is cloned into the supervisor (for rebuilds) and the callback;
        // the debounce task owns the sole `raw_rx`.
        let watcher = build_watcher(root.clone(), &deps)?;
        // Canonical root for rel-path computation in the browser emitter.
        let evt_root = root.clone();
        let inner = Arc::new(Mutex::new(Inner { watcher, root }));

        let trigger_for_debounce = trigger_tx;
        let debounce = tauri::async_runtime::spawn(async move {
            while raw_rx.recv().await.is_some() {
                let deadline = tokio::time::Instant::now() + DEBOUNCE;
                loop {
                    tokio::select! {
                        maybe = raw_rx.recv() => {
                            if maybe.is_none() {
                                return;
                            }
                        }
                        () = tokio::time::sleep_until(deadline) => break,
                    }
                }
                // The receiver is gone only once the path is unsubscribed; stop.
                if trigger_for_debounce.send(RefreshCause::FsEdit).is_err() {
                    return;
                }
            }
        });

        // Browser stream: collect the touched dirs over a debounce window,
        // then emit one `worktree-fs-changed`. Past the cap the dir list
        // degrades to `None` ("refetch all loaded") — the frontend only ever
        // refetches levels it has loaded, so a build storm in a collapsed
        // `target/` costs it nothing.
        let browser_debounce = tauri::async_runtime::spawn(async move {
            while let Some(first) = browser_rx.recv().await {
                let mut dirs: HashSet<PathBuf> = HashSet::from([first]);
                let deadline = tokio::time::Instant::now() + DEBOUNCE;
                loop {
                    tokio::select! {
                        maybe = browser_rx.recv() => match maybe {
                            Some(dir) => {
                                if dirs.len() <= BROWSER_DIR_CAP {
                                    dirs.insert(dir);
                                }
                            }
                            None => return,
                        },
                        () = tokio::time::sleep_until(deadline) => break,
                    }
                }
                let rel = (dirs.len() <= BROWSER_DIR_CAP).then(|| {
                    dirs.iter()
                        .filter_map(|d| {
                            let r = d.strip_prefix(&evt_root).ok()?;
                            Some(r.to_string_lossy().into_owned())
                        })
                        .collect::<Vec<_>>()
                });
                let payload = FsChangedPayload {
                    path: payload_path.clone(),
                    dirs: rel,
                };
                let _ = app.emit("worktree-fs-changed", &payload);
            }
        });

        // On inotify-style backends, NonRecursive watches don't cover newly
        // created subdirs. Watch each new non-ignored dir (and any non-ignored
        // subdirs already inside it) on demand, then pulse so files written in
        // the brief watch-setup race window are still reflected via the git
        // recompute. On macOS the recursive stream covers new dirs, so the
        // callback never sends and this drain is never spawned (`dir_rx` is just
        // dropped).
        let dir_drain = if PER_DIR_WATCHES {
            let drain_inner = inner.clone();
            let drain_pulse = deps.raw_tx.clone();
            Some(tauri::async_runtime::spawn(async move {
                while let Some(new_dir) = dir_rx.recv().await {
                    let dirs = watchable_dirs(&new_dir);
                    if let Ok(mut guard) = drain_inner.lock() {
                        for dir in &dirs {
                            let _ = guard.watcher.watch(dir, RecursiveMode::NonRecursive);
                        }
                    }
                    let _ = drain_pulse.send(());
                }
            }))
        } else {
            None
        };

        let supervisor = tauri::async_runtime::spawn(supervise_watcher(inner.clone(), deps));

        Ok(Self {
            supervisor,
            debounce,
            browser_debounce,
            dir_drain,
            _inner: inner,
        })
    }
}

/// Build a `RecommendedWatcher` rooted at `root`. The callback drops `.git/` and
/// gitignore-matched paths, records health for the supervisor, routes errors
/// through the rate-limited reporter, and (on inotify) forwards newly created
/// non-ignored directories to the dir-add drain. Used by both initial start and
/// the supervisor rebuild so the two paths can't drift.
fn build_watcher(root: PathBuf, deps: &WatcherDeps) -> notify::Result<RecommendedWatcher> {
    let gitignore = build_gitignore(&root);
    let cb_root = root.clone();
    let deps = deps.clone();

    let mut watcher =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
            Ok(ev) => {
                if let Ok(mut h) = deps.health.lock() {
                    h.record_ok();
                }
                if !matches!(
                    ev.kind,
                    EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
                ) {
                    return;
                }
                let mut pulse = false;
                for path in &ev.paths {
                    if under_git_dir(path, &cb_root) {
                        continue;
                    }
                    // Browser stream: unfiltered (the file browser lists
                    // gitignored files too). Send the containing dir.
                    if let Some(parent) = path.parent() {
                        let _ = deps.browser_tx.send(parent.to_path_buf());
                    }
                    if !is_relevant(path, &cb_root, &gitignore) {
                        continue;
                    }
                    pulse = true;
                    // inotify only: a newly created non-ignored dir needs its own
                    // watch (NonRecursive doesn't descend). `is_dir` stats the
                    // path — cheap, and only on Create events.
                    if PER_DIR_WATCHES && matches!(ev.kind, EventKind::Create(_)) && path.is_dir() {
                        let _ = deps.dir_tx.send(path.clone());
                    }
                }
                if pulse {
                    let _ = deps.raw_tx.send(());
                }
            }
            Err(e) => {
                if let Ok(mut h) = deps.health.lock() {
                    h.record_err(Instant::now());
                }
                emit_rate_limited_error(
                    &deps.error_state,
                    "worktree_fs_watcher",
                    cb_root.display(),
                    &e,
                );
            }
        })?;

    register_watches(&mut watcher, &root)?;
    Ok(watcher)
}

/// Register the OS watches for `root`.
///
/// macOS (FSEvents): a single recursive stream — cheap, and ignored-subtree
/// events are dropped later by the callback's gitignore filter.
///
/// inotify et al.: a recursive registration would add a descriptor per subdir,
/// including the multi-GB ignored trees, risking `max_user_watches`/`ENOSPC` and
/// starving `git_watcher`. So register `NonRecursive` watches only for the
/// non-ignored directories (`watchable_dirs`). The root watch is propagated as
/// an error if it fails (deliberate degrade to the fallback poll); per-subdir
/// failures are skipped so one vanished dir can't disable the whole watcher.
fn register_watches(watcher: &mut RecommendedWatcher, root: &Path) -> notify::Result<()> {
    if PER_DIR_WATCHES {
        watcher.watch(root, RecursiveMode::NonRecursive)?;
        for dir in watchable_dirs(root) {
            if dir == root {
                continue;
            }
            let _ = watcher.watch(&dir, RecursiveMode::NonRecursive);
        }
        Ok(())
    } else {
        watcher.watch(root, RecursiveMode::Recursive)
    }
}

/// Enumerate the non-ignored directories under `root` to watch on inotify-style
/// backends. `ignore::WalkBuilder` honors root + nested `.gitignore`, the global
/// excludesfile, and `.git/info/exclude`, and we prune `.git` itself — so the
/// huge ignored trees (`target/`, `node_modules/`) are never descended into and
/// never registered. Includes `root` as the first entry.
fn watchable_dirs(root: &Path) -> Vec<PathBuf> {
    WalkBuilder::new(root)
        .hidden(false) // keep tracked dotdirs (.github, .vscode, .cargo)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(false) // worktrees are self-contained; don't read above root
        .require_git(false) // honor .gitignore even via a linked worktree's `.git` file
        // prune the git dir/file, keep .github etc.
        .filter_entry(|e| e.file_name() != std::ffi::OsStr::new(".git"))
        .build()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_dir()))
        .map(ignore::DirEntry::into_path)
        .collect()
}

/// Build a gitignore matcher from the worktree's root `.gitignore` and
/// `.git/info/exclude`. Missing files are skipped; on a build error we fall
/// back to an empty matcher (no filtering) rather than failing the watcher.
// ponytail: root .gitignore only on macOS; nested-ignored trees still pulse
// (harmless — the recompute just finds nothing). Feeding every nested
// `.gitignore` in would cost a full `WalkBuilder` pass at watcher start, which
// macOS currently avoids entirely; add it if a nested-ignored tree ever churns
// hard enough to matter.
fn build_gitignore(root: &Path) -> Gitignore {
    let mut builder = GitignoreBuilder::new(root);
    // `add` returns `Some(err)` on failure; a missing file is a benign skip.
    let _ = builder.add(root.join(".gitignore"));
    let _ = builder.add(root.join(".git").join("info").join("exclude"));
    builder.build().unwrap_or_else(|e| {
        warn!(id = %root.display(), error = %e, "worktree_fs_watcher: gitignore build failed");
        Gitignore::empty()
    })
}

/// Top-level directory names under the worktree root whose whole subtree is
/// dropped on a single `OsStr` compare, before the gitignore matcher runs.
///
/// `.git` is git's own state (a linked worktree's `.git` is a pointer file —
/// same first component). The rest are the churners a `cargo build` /
/// `bun install` fires thousands of events per second for, straight onto
/// notify's callback thread; `matched_path_or_any_parents` re-walks every
/// ancestor of every one of them, and would reject them anyway.
///
// ponytail: a repo that *tracks* a top-level `target`/`dist`/`node_modules`
// loses prompt status on edits there — the 15 s fallback poll still catches
// them. Make it gitignore-derived if that ever bites.
const SKIP_TOP_LEVEL: [&str; 4] = [".git", "target", "node_modules", "dist"];

/// True when an event path should trigger a status recompute: not under a
/// [`SKIP_TOP_LEVEL`] directory, and not matched by gitignore (so the rest of
/// the build churn is dropped before any `git diff`).
fn is_relevant(path: &Path, root: &Path, gitignore: &Gitignore) -> bool {
    if under_skipped_top_level(path, root) {
        return false;
    }
    !gitignore
        .matched_path_or_any_parents(path, false)
        .is_ignore()
}

/// True when `path` is `.git` itself or lives under it — the only exclusion
/// the browser stream applies (it must see gitignored files).
fn under_git_dir(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root)
        .ok()
        .and_then(|rel| rel.components().next())
        .is_some_and(|c| c.as_os_str() == ".git")
}

/// True when `path`'s first component under `root` is one of
/// [`SKIP_TOP_LEVEL`]. The real linked gitdir lives outside the worktree root,
/// so it is never seen here.
fn under_skipped_top_level(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root)
        .ok()
        .and_then(|rel| rel.components().next())
        .is_some_and(|c| SKIP_TOP_LEVEL.iter().any(|skip| c.as_os_str() == *skip))
}

/// Rebuild the watcher once notify has been erroring long enough (see
/// [`HealthState::rebuild_due`]). Backs off exponentially when the rebuild
/// itself fails (typically also EMFILE). The rebuilt watcher gets fresh clones
/// of `raw_tx`/`dir_tx` into the same channels (via `deps`), so the debounce and
/// dir-add tasks — which hold the receivers — keep working.
async fn supervise_watcher(inner: Arc<Mutex<Inner>>, deps: WatcherDeps) {
    let health = deps.health.clone();
    let mut tick = tokio::time::interval(SUPERVISOR_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    tick.tick().await; // interval fires immediately once; skip it.
    loop {
        tick.tick().await;

        let now = Instant::now();
        {
            let Ok(h) = health.lock() else { continue };
            if h.rebuild_due(now).is_none() {
                continue;
            }
        }

        // Snapshot the root outside the lock so notify's stream construction
        // doesn't run while `inner` is held.
        let root = match inner.lock() {
            Ok(g) => g.root.clone(),
            Err(_) => continue,
        };
        match build_watcher(root.clone(), &deps) {
            Ok(new_watcher) => {
                if let Ok(mut g) = inner.lock() {
                    g.watcher = new_watcher;
                }
                if let Ok(mut h) = health.lock() {
                    h.mark_rebuilt();
                }
                info!(id = %root.display(), "worktree_fs_watcher: rebuilt watcher after sustained errors");
            }
            Err(e) => {
                if let Ok(mut h) = health.lock() {
                    let (attempt, backoff) = h.defer_rebuild(now);
                    warn!(
                        id = %root.display(),
                        error = %e,
                        attempt = attempt,
                        retry_in_secs = backoff.as_secs(),
                        "worktree_fs_watcher: rebuild failed, backing off",
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a matcher in-memory (no filesystem) for the given root + rules.
    fn matcher(root: &str, rules: &[&str]) -> Gitignore {
        let mut builder = GitignoreBuilder::new(root);
        for rule in rules {
            builder.add_line(None, rule).expect("valid gitignore rule");
        }
        builder.build().expect("gitignore builds")
    }

    #[test]
    fn under_skipped_top_level_matches_git_and_churners() {
        let root = Path::new("/repo");
        // Main worktree: `.git` is a directory; everything under it is git's.
        assert!(under_skipped_top_level(Path::new("/repo/.git"), root));
        assert!(under_skipped_top_level(Path::new("/repo/.git/index"), root));
        assert!(under_skipped_top_level(
            Path::new("/repo/.git/objects/ab/cd"),
            root
        ));
        // Linked worktree: `.git` is a pointer *file* — same first component.
        assert!(under_skipped_top_level(Path::new("/repo/.git"), root));
        // The gitignore-matcher bypass: build churn rejected on one compare.
        assert!(under_skipped_top_level(
            Path::new("/repo/target/debug/deps/x.o"),
            root
        ));
        assert!(under_skipped_top_level(
            Path::new("/repo/node_modules/a/b.js"),
            root
        ));
        assert!(under_skipped_top_level(
            Path::new("/repo/dist/app.js"),
            root
        ));
        // Lookalikes are NOT skipped.
        assert!(!under_skipped_top_level(
            Path::new("/repo/.github/workflows/ci.yml"),
            root
        ));
        assert!(!under_skipped_top_level(
            Path::new("/repo/src/.gitkeep"),
            root
        ));
        assert!(!under_skipped_top_level(
            Path::new("/repo/src/main.rs"),
            root
        ));
        // Nested, not top-level — the gitignore matcher still owns these.
        assert!(!under_skipped_top_level(
            Path::new("/repo/crates/core/target/x"),
            root
        ));
        // A path outside the root has no first component under it.
        assert!(!under_skipped_top_level(
            Path::new("/other/.git/index"),
            root
        ));
    }

    #[test]
    fn under_git_dir_only_excludes_git() {
        let root = Path::new("/repo");
        assert!(under_git_dir(Path::new("/repo/.git"), root));
        assert!(under_git_dir(Path::new("/repo/.git/index"), root));
        // The browser stream must keep everything else — including the
        // gitignored churners the status stream drops.
        assert!(!under_git_dir(Path::new("/repo/target/debug/x.o"), root));
        assert!(!under_git_dir(Path::new("/repo/node_modules/a.js"), root));
        assert!(!under_git_dir(Path::new("/repo/.github/ci.yml"), root));
        assert!(!under_git_dir(Path::new("/other/.git/index"), root));
    }

    #[test]
    fn is_relevant_drops_git_and_ignored_paths() {
        let root = Path::new("/repo");
        let gi = matcher("/repo", &["target/", "node_modules/", "*.log"]);

        // Dropped: the .git subtree.
        assert!(!is_relevant(Path::new("/repo/.git/index"), root, &gi));
        // Dropped: gitignored build churn (parent-walk catches the dir rule).
        assert!(!is_relevant(
            Path::new("/repo/target/debug/foo.rlib"),
            root,
            &gi
        ));
        assert!(!is_relevant(
            Path::new("/repo/node_modules/x/index.js"),
            root,
            &gi
        ));
        assert!(!is_relevant(Path::new("/repo/run.log"), root, &gi));

        // Kept: real source edits — these must still pulse.
        assert!(is_relevant(Path::new("/repo/src/main.rs"), root, &gi));
        assert!(is_relevant(Path::new("/repo/Cargo.toml"), root, &gi));
        assert!(is_relevant(
            Path::new("/repo/crates/core/lib.rs"),
            root,
            &gi
        ));
    }

    /// The inotify watch-set must exclude ignored trees (`target/`,
    /// `node_modules/`) and `.git/`, while keeping real source dirs — including
    /// nested-gitignore'd ones and tracked dotdirs (`.github`). This is the
    /// whole point of `watchable_dirs` vs. a blanket recursive watch.
    #[test]
    fn watchable_dirs_excludes_ignored_and_git_keeps_source() {
        use std::fs;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        // A worktree-shaped tree.
        fs::write(root.join(".gitignore"), "target/\nnode_modules/\n").unwrap();
        fs::create_dir_all(root.join("src/inner")).unwrap();
        fs::create_dir_all(root.join(".github/workflows")).unwrap(); // tracked dotdir
        fs::create_dir_all(root.join("target/debug/incremental")).unwrap(); // ignored
        fs::create_dir_all(root.join("node_modules/pkg/sub")).unwrap(); // ignored
        fs::create_dir_all(root.join(".git/objects/ab")).unwrap(); // git internals
        // Nested-gitignore'd dir: only the inner .gitignore mentions `out/`.
        fs::create_dir_all(root.join("pkg/out/blah")).unwrap();
        fs::write(root.join("pkg/.gitignore"), "out/\n").unwrap();

        let dirs = watchable_dirs(root);
        let has = |rel: &str| dirs.iter().any(|d| d == &root.join(rel));

        // Kept: root + real source + tracked dotdirs.
        assert!(
            dirs.iter().any(|d| d == root),
            "root itself must be watched"
        );
        assert!(has("src"));
        assert!(has("src/inner"));
        assert!(has(".github"));
        assert!(has(".github/workflows"));
        assert!(has("pkg"));

        // Dropped: ignored trees, .git, and nested-ignored dirs.
        assert!(!has("target"), "target/ must not be registered");
        assert!(!has("target/debug"));
        assert!(!has("node_modules"));
        assert!(!has(".git"));
        assert!(!has(".git/objects"));
        assert!(!has("pkg/out"), "nested-gitignore'd dir must be dropped");
    }
}
