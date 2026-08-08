//! Per-project `.git/HEAD` + index watcher. Emits `worktree-branches-changed`
//! on HEAD touches so the UI refreshes branch badges without polling, and
//! forwards both HEAD and index touches to the worktree status service so
//! commits/stages typed into a pane terminal refresh the sidebar promptly.
//!
//! Watches `<root>/.git/` (main project) plus every
//! `<root>/.git/worktrees/*/` (linked worktrees) non-recursively, filtering
//! notify events by filename to only pulse on HEAD or `index` touches
//! (`index.lock` is deliberately ignored — it churns while git is *working*;
//! the rename onto `index` is the done signal). We watch the *directory*
//! rather than the HEAD file itself because git rewrites HEAD with an atomic
//! rename — on macOS FSEvents this invalidates per-file watches after the
//! first checkout, so subsequent branch switches were silent. Dir inodes
//! stay stable across the rename. FS events are coalesced inside a debounce
//! window before a single event is emitted to the webview.
//!
//! Exactly one watcher runs at a time: the one for the *active* project (see
//! [`set_active_project`]). An FSEvents/inotify stream plus a supervisor task
//! per registered project is real, permanent cost for repos nobody is looking
//! at; a backgrounded project simply has no live watch until it is activated
//! again, at which point the sidebar's fresh status subscriptions seed its
//! diffstats and [`set_active_project`]'s catch-up event re-fetches its
//! worktree/branch list.
//!
//! The watcher self-heals under fd pressure. When the FSEvents stream starts
//! returning errors (typically `EMFILE` once the rest of the app exhausts
//! descriptors) two things happen so we don't degrade silently or spam the
//! log: error reporting is rate-limited per error string (one WARN per
//! 60 s window plus a single suppression-count INFO at the end of the
//! window), and a supervisor task drops + rebuilds the underlying
//! `RecommendedWatcher` once errors persist for `REBUILD_AFTER_SUSTAINED_ERRORS`
//! with no successful events. If the rebuild itself fails it backs off
//! exponentially up to `REBUILD_BACKOFF_CEILING`. The previous behaviour
//! emitted ~80 identical WARNs/min and never recovered without an app
//! restart.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use super::notify_watch::{ErrorRateMap, HealthState, SUPERVISOR_TICK, emit_rate_limited_error};
use crate::state::AppHandleState;

/// Git checkout writes multiple files (HEAD, index, packed-refs) in quick
/// succession. Coalesce the burst so we emit one frontend event per switch.
const DEBOUNCE: Duration = Duration::from_millis(150);

/// What a filtered notify event touched. `Head` identifies a branch switch
/// (emits `worktree-branches-changed` + status pulse); `Index` is a
/// commit/stage/reset from any git client (status pulse only).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PulseKind {
    Head,
    Index,
}

/// Holds the current `RecommendedWatcher` plus the dirs it's watching, so
/// the supervisor can swap the watcher out without disturbing anything
/// else. `root` lives here too so rebuilds and rescans share one source of
/// truth.
struct Inner {
    watcher: RecommendedWatcher,
    watched: HashSet<PathBuf>,
    root: PathBuf,
}

pub struct GitHeadWatcher {
    /// Aborted in `Drop`. Declared first so it's dropped first — the
    /// supervisor holds clones of `inner` / `pulse_tx`, and aborting it
    /// before those fields are dropped avoids a transient race with the
    /// rebuild path during teardown.
    supervisor: tauri::async_runtime::JoinHandle<()>,
    /// Dropping this end closes the channel and shuts down the debounce
    /// task. The supervisor holds a clone for handing to rebuilt watchers;
    /// once the abort lands those clones are released too.
    _pulse_tx: mpsc::UnboundedSender<PulseKind>,
    inner: Arc<Mutex<Inner>>,
    /// Set in `Drop`, checked by the supervisor every tick. `abort()` alone
    /// only takes effect at the task's next await point, so a supervisor that
    /// is mid-tick could still rebuild — and resurrect — a watcher this
    /// project just stopped.
    stopped: Arc<AtomicBool>,
}

impl Drop for GitHeadWatcher {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
        self.supervisor.abort();
    }
}

impl GitHeadWatcher {
    /// Start a watcher for `slug` rooted at `root`. Returns `Err` only when
    /// the OS refuses to create a watcher at all; individual path watch
    /// failures are logged and skipped so a missing worktree HEAD never
    /// blocks startup.
    ///
    /// `status_pulse`: optional sender into the worktree status service
    /// (payload: this watcher's slug). Both HEAD and index touches forward
    /// there after the debounce; `None` (service bootstrap failed) degrades
    /// to branch-badge events only.
    pub fn start<R: Runtime>(
        slug: String,
        root: &Path,
        app: AppHandle<R>,
        status_pulse: Option<mpsc::UnboundedSender<String>>,
    ) -> notify::Result<Self> {
        let (pulse_tx, mut pulse_rx) = mpsc::unbounded_channel::<PulseKind>();
        let error_state = Arc::new(Mutex::new(ErrorRateMap::default()));
        let health = Arc::new(Mutex::new(HealthState::default()));

        let (watcher, watched) = build_watcher(
            slug.clone(),
            root,
            pulse_tx.clone(),
            error_state.clone(),
            health.clone(),
        )?;

        let inner = Arc::new(Mutex::new(Inner {
            watcher,
            watched,
            root: root.to_path_buf(),
        }));

        // Debounce + emit task. Coalesce a burst of git activity (HEAD,
        // index, packed-refs touched in rapid succession during a
        // checkout) into a single frontend event per switch. HEAD touches
        // emit the branch event; both kinds forward one status pulse.
        let emit_slug = slug.clone();
        let emit_app = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(first) = pulse_rx.recv().await {
                let mut saw_head = first == PulseKind::Head;
                let deadline = tokio::time::Instant::now() + DEBOUNCE;
                loop {
                    tokio::select! {
                        maybe = pulse_rx.recv() => {
                            match maybe {
                                Some(kind) => saw_head |= kind == PulseKind::Head,
                                None => return,
                            }
                        }
                        () = tokio::time::sleep_until(deadline) => break,
                    }
                }
                if saw_head {
                    if let Err(e) =
                        emit_app.emit("worktree-branches-changed", json!({ "slug": emit_slug }))
                    {
                        warn!(slug = %emit_slug, error = %e, "worktree-branches-changed emit failed");
                    }
                }
                if let Some(tx) = &status_pulse {
                    let _ = tx.send(emit_slug.clone());
                }
            }
        });

        // Supervisor: notice when the watcher has been erroring for ≥30 s
        // with no successful event, drop it, and re-create. Backs off if
        // the rebuild itself fails (typically also EMFILE).
        let stopped = Arc::new(AtomicBool::new(false));
        let supervisor = tauri::async_runtime::spawn(supervise_watcher(
            slug,
            inner.clone(),
            pulse_tx.clone(),
            error_state,
            health,
            stopped.clone(),
        ));

        Ok(Self {
            supervisor,
            _pulse_tx: pulse_tx,
            inner,
            stopped,
        })
    }

    /// Re-sync the watch set against the current on-disk layout. Called
    /// after `worktree_create` / `worktree_remove` so newly-added worktree
    /// HEADs are watched and stale ones are dropped.
    pub fn rescan(&self, root: &Path) {
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            Err(e) => {
                warn!(error = %e, "git_watcher: rescan: inner mutex poisoned");
                return;
            }
        };
        // Update the canonical root so the supervisor's rebuild path uses
        // the same source of truth as rescan.
        inner.root = root.to_path_buf();

        let fresh = discover_watch_dirs(root);
        let to_add: Vec<PathBuf> = fresh
            .iter()
            .filter(|p| !inner.watched.contains(*p))
            .cloned()
            .collect();
        for path in to_add {
            match inner.watcher.watch(&path, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    debug!(path = %path.display(), "git_watcher: added watch");
                    inner.watched.insert(path);
                }
                Err(e) => {
                    warn!(path = %path.display(), error = %e, "git_watcher: watch failed");
                }
            }
        }
        let stale: Vec<PathBuf> = inner
            .watched
            .iter()
            .filter(|p| !fresh.contains(*p))
            .cloned()
            .collect();
        for path in stale {
            let _ = inner.watcher.unwatch(&path);
            inner.watched.remove(&path);
        }
    }
}

/// Scope the live `.git` watcher to `slug` — the project the user currently
/// has selected — stopping every other project's watcher. `None` (no project
/// selected) stops all of them.
///
/// Diffstats need no catch-up pulse from here: switching mounts that project's
/// sidebar rows, and each new status subscription seeds an immediate recompute
/// in the status service (see `set_subscriptions`). *Branch names* do: while
/// the project was backgrounded it had no watcher, so a checkout/merge inside
/// it emitted nothing, and the frontend's worktree-list cache is only
/// invalidated by `worktree-branches-changed`. So we emit one for the
/// newly-activated slug.
pub fn set_active_project<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppHandleState,
    slug: Option<&str>,
) {
    // Resolve the root before touching the watcher map — the config store has
    // its own lock and holding both at once invites a deadlock.
    let target = slug.and_then(|slug| {
        let store = state.config_store.lock().ok()?;
        let project = store.read_project(slug).ok().flatten()?;
        Some((project.slug, project.root_path))
    });
    let status_pulse = state
        .status_service
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|svc| svc.pulse_sender()));

    let Ok(mut watchers) = state.git_watchers.lock() else {
        warn!("git_watcher: set_active_project: git_watchers lock poisoned");
        return;
    };
    // Dropping the removed entries stops their streams and supervisors.
    if !retain_only(&mut watchers, target.as_ref().map(|(s, _)| s.as_str())) {
        return;
    }
    let Some((slug, root)) = target else { return };
    match GitHeadWatcher::start(slug.clone(), &root, app.clone(), status_pulse) {
        Ok(w) => {
            info!(id = %slug, "git_watcher: started");
            watchers.insert(slug.clone(), w);
        }
        Err(e) => warn!(id = %slug, error = %e, "git_watcher: start failed"),
    }
    // Catch-up after the watcher is live, so a checkout landing right now is
    // either included in the refetch or caught by the watcher — never both
    // missed. Emitted on failed starts too: the list is stale either way.
    if let Err(e) = app.emit("worktree-branches-changed", json!({ "slug": slug })) {
        warn!(slug = %slug, error = %e, "worktree-branches-changed emit failed");
    }
}

/// Drop every entry except `keep`, returning whether `keep` still needs a
/// watcher started. Generic over the value so the switch policy is testable
/// without an FSEvents stream.
fn retain_only<V>(watchers: &mut HashMap<String, V>, keep: Option<&str>) -> bool {
    watchers.retain(|slug, _| Some(slug.as_str()) == keep);
    keep.is_some_and(|k| !watchers.contains_key(k))
}

/// Build a `RecommendedWatcher` and watch every dir from
/// `discover_watch_dirs(root)`. The closure classifies HEAD/index touches
/// into pulses for the debounce task, updates `health` for the supervisor,
/// and routes errors through the rate-limited reporter. Used by both initial
/// start and the supervisor's rebuild path so the two paths can't drift.
fn build_watcher(
    slug: String,
    root: &Path,
    pulse_tx: mpsc::UnboundedSender<PulseKind>,
    error_state: Arc<Mutex<ErrorRateMap>>,
    health: Arc<Mutex<HealthState>>,
) -> notify::Result<(RecommendedWatcher, HashSet<PathBuf>)> {
    let cb_slug = slug;
    let cb_pulse = pulse_tx;
    let cb_error = error_state;
    let cb_health = health;

    let mut watcher =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
            Ok(ev) => {
                if let Ok(mut h) = cb_health.lock() {
                    h.record_ok();
                }
                if matches!(
                    ev.kind,
                    EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
                ) {
                    if event_touches_head(&ev) {
                        let _ = cb_pulse.send(PulseKind::Head);
                    } else if event_touches_index(&ev) {
                        let _ = cb_pulse.send(PulseKind::Index);
                    }
                }
            }
            Err(e) => {
                if let Ok(mut h) = cb_health.lock() {
                    h.record_err(Instant::now());
                }
                emit_rate_limited_error(&cb_error, "git_watcher", &cb_slug, &e);
            }
        })?;

    let mut watched = HashSet::new();
    for path in discover_watch_dirs(root) {
        match watcher.watch(&path, RecursiveMode::NonRecursive) {
            Ok(()) => {
                debug!(path = %path.display(), "git_watcher: added watch");
                watched.insert(path);
            }
            Err(e) => {
                warn!(path = %path.display(), error = %e, "git_watcher: watch failed");
            }
        }
    }
    Ok((watcher, watched))
}

/// Long-running supervisor: every [`SUPERVISOR_TICK`], rebuild the watcher when
/// it has been erroring long enough (see [`HealthState::rebuild_due`]). On
/// rebuild failure (typically also EMFILE), back off exponentially before the
/// next attempt.
async fn supervise_watcher(
    slug: String,
    inner: Arc<Mutex<Inner>>,
    pulse_tx: mpsc::UnboundedSender<PulseKind>,
    error_state: Arc<Mutex<ErrorRateMap>>,
    health: Arc<Mutex<HealthState>>,
    stopped: Arc<AtomicBool>,
) {
    let mut tick = tokio::time::interval(SUPERVISOR_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Skip the immediate first tick — interval fires once at start.
    tick.tick().await;
    loop {
        tick.tick().await;
        // The watcher was stopped (project deactivated / removed): never
        // rebuild it, and release our `inner` clone so the OS stream goes away.
        if stopped.load(Ordering::Relaxed) {
            return;
        }

        let now = Instant::now();
        let dropped_errors = {
            let Ok(h) = health.lock() else { continue };
            match h.rebuild_due(now) {
                Some(n) => n,
                None => continue,
            }
        };

        // Snapshot the root outside the watcher-construction call so we don't
        // hold the inner lock while notify creates its FSEvents stream.
        let root = match inner.lock() {
            Ok(g) => g.root.clone(),
            Err(_) => continue,
        };

        match build_watcher(
            slug.clone(),
            &root,
            pulse_tx.clone(),
            error_state.clone(),
            health.clone(),
        ) {
            Ok((new_watcher, new_watched)) => {
                if let Ok(mut g) = inner.lock() {
                    g.watcher = new_watcher;
                    g.watched = new_watched;
                }
                if let Ok(mut h) = health.lock() {
                    h.mark_rebuilt();
                }
                info!(
                    id = %slug,
                    dropped_errors = dropped_errors,
                    "git_watcher: rebuilt watcher after sustained errors",
                );
            }
            Err(e) => {
                if let Ok(mut h) = health.lock() {
                    let (attempt, backoff) = h.defer_rebuild(now);
                    warn!(
                        id = %slug,
                        error = %e,
                        attempt = attempt,
                        retry_in_secs = backoff.as_secs(),
                        "git_watcher: rebuild failed, backing off",
                    );
                }
            }
        }
    }
}

/// Collect every directory whose `HEAD` file identifies a branch — the main
/// `<root>/.git/` plus `<root>/.git/worktrees/<id>/` for each linked
/// worktree. Only existing dirs with a HEAD inside are returned so a
/// never-initialised worktree doesn't pollute the watch set.
fn discover_watch_dirs(root: &Path) -> HashSet<PathBuf> {
    let mut dirs = HashSet::new();
    let git_dir = resolve_git_dir(root);
    if git_dir.join("HEAD").is_file() {
        dirs.insert(git_dir.clone());
    }
    if let Ok(entries) = std::fs::read_dir(git_dir.join("worktrees")) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if dir.join("HEAD").is_file() {
                dirs.insert(dir);
            }
        }
    }
    dirs
}

/// True when any of the event's paths points at a file named `HEAD`. Dir
/// watches fire for every file touched inside `.git/` (index, ORIG_HEAD,
/// packed-refs, etc.); HEAD is the one that identifies the branch.
fn event_touches_head(ev: &notify::Event) -> bool {
    ev.paths
        .iter()
        .any(|p| p.file_name().is_some_and(|n| n == "HEAD"))
}

/// True when any of the event's paths points at a file named exactly
/// `index` — a commit/stage/reset finished (git renames the new index into
/// place). `index.lock` is deliberately excluded: it churns while git is
/// still working, and our own status recomputes run with
/// `GIT_OPTIONAL_LOCKS=0` so they never touch either file.
fn event_touches_index(ev: &notify::Event) -> bool {
    ev.paths
        .iter()
        .any(|p| p.file_name().is_some_and(|n| n == "index"))
}

/// Resolve `<root>/.git` to its actual directory. A plain `.git` directory is
/// returned as-is; a `.git` file (submodule / linked worktree edge case) is
/// parsed for its `gitdir:` pointer.
fn resolve_git_dir(root: &Path) -> PathBuf {
    let git = root.join(".git");
    if git.is_dir() {
        return git;
    }
    if git.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&git) {
            if let Some(rest) = raw.strip_prefix("gitdir:") {
                let p = PathBuf::from(rest.trim());
                return if p.is_absolute() { p } else { root.join(p) };
            }
        }
    }
    git
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn discover_watch_dirs_finds_main_and_worktrees() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let git = root.join(".git");
        std::fs::create_dir_all(git.join("worktrees/feat-a")).unwrap();
        std::fs::create_dir_all(git.join("worktrees/feat-b")).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(
            git.join("worktrees/feat-a/HEAD"),
            "ref: refs/heads/feat-a\n",
        )
        .unwrap();
        std::fs::write(
            git.join("worktrees/feat-b/HEAD"),
            "ref: refs/heads/feat-b\n",
        )
        .unwrap();

        let dirs = discover_watch_dirs(root);
        assert_eq!(dirs.len(), 3);
        assert!(dirs.contains(&git));
        assert!(dirs.contains(&git.join("worktrees/feat-a")));
        assert!(dirs.contains(&git.join("worktrees/feat-b")));
    }

    #[test]
    fn discover_watch_dirs_skips_worktree_without_head() {
        // `git worktree add` briefly creates the dir before writing HEAD; we
        // should not return a dir that lacks a HEAD file yet.
        let dir = tempdir().unwrap();
        let root = dir.path();
        let git = root.join(".git");
        std::fs::create_dir_all(git.join("worktrees/half-done")).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        let dirs = discover_watch_dirs(root);
        assert_eq!(dirs.len(), 1);
        assert!(dirs.contains(&git));
    }

    #[test]
    fn discover_watch_dirs_missing_repo_is_empty() {
        let dir = tempdir().unwrap();
        assert!(discover_watch_dirs(dir.path()).is_empty());
    }

    #[test]
    fn event_touches_head_matches_head_paths() {
        let ev = notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Data(
            notify::event::DataChange::Any,
        )))
        .add_path(PathBuf::from("/repo/.git/HEAD"));
        assert!(event_touches_head(&ev));
    }

    #[test]
    fn event_touches_head_ignores_index_writes() {
        let ev = notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Data(
            notify::event::DataChange::Any,
        )))
        .add_path(PathBuf::from("/repo/.git/index"));
        assert!(!event_touches_head(&ev));
        assert!(event_touches_index(&ev));
    }

    #[test]
    fn event_touches_index_ignores_lock_file() {
        let ev = notify::Event::new(notify::EventKind::Create(notify::event::CreateKind::File))
            .add_path(PathBuf::from("/repo/.git/index.lock"));
        assert!(!event_touches_index(&ev));
        assert!(!event_touches_head(&ev));
    }

    /// Project switch: the old project's watcher is *dropped* (its stream
    /// stops), the new one is reported as needing a start, and re-activating
    /// the same project doesn't churn a restart.
    #[test]
    fn retain_only_swaps_the_active_project() {
        struct DropFlag(Arc<AtomicBool>);
        impl Drop for DropFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Relaxed);
            }
        }

        let dropped = Arc::new(AtomicBool::new(false));
        let mut map = HashMap::new();
        map.insert("alpha".to_string(), DropFlag(dropped.clone()));

        assert!(retain_only(&mut map, Some("beta")));
        assert!(dropped.load(Ordering::Relaxed), "alpha's watcher must stop");
        assert!(map.is_empty());

        let mut live: HashMap<String, u8> = HashMap::from([("beta".to_string(), 1)]);
        assert!(!retain_only(&mut live, Some("beta")));
        assert_eq!(live.len(), 1);

        assert!(!retain_only(&mut live, None));
        assert!(live.is_empty());
    }

    /// Health state that has been erroring long enough to justify a rebuild.
    /// `None` on a machine booted seconds ago (monotonic clock can't go back
    /// that far) — the supervisor tests then skip rather than hang.
    fn erroring_health() -> Option<Arc<Mutex<HealthState>>> {
        let long_ago = Instant::now().checked_sub(Duration::from_secs(120))?;
        let mut h = HealthState::default();
        for _ in 0..5 {
            h.record_err(long_ago);
        }
        Some(Arc::new(Mutex::new(h)))
    }

    fn empty_inner(root: &Path) -> Arc<Mutex<Inner>> {
        let watcher = notify::recommended_watcher(|_res| {}).unwrap();
        Arc::new(Mutex::new(Inner {
            watcher,
            watched: HashSet::new(),
            root: root.to_path_buf(),
        }))
    }

    fn repo_with_head() -> tempfile::TempDir {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        dir
    }

    /// Control for the test below: a *live* watcher does get rebuilt, so an
    /// empty watch set there really is the stop flag's doing.
    #[tokio::test(start_paused = true)]
    async fn supervisor_rebuilds_a_live_watcher() {
        let Some(health) = erroring_health() else {
            return;
        };
        let dir = repo_with_head();
        let inner = empty_inner(dir.path());
        let (tx, _rx) = mpsc::unbounded_channel();
        let stopped = Arc::new(AtomicBool::new(false));
        tokio::spawn(supervise_watcher(
            "alpha".into(),
            inner.clone(),
            tx,
            Arc::new(Mutex::new(ErrorRateMap::default())),
            health,
            stopped,
        ));
        tokio::time::sleep(SUPERVISOR_TICK * 3).await;
        assert!(!inner.lock().unwrap().watched.is_empty());
    }

    /// A stopped watcher's supervisor exits instead of resurrecting it.
    #[tokio::test(start_paused = true)]
    async fn supervisor_does_not_rebuild_after_stop() {
        let Some(health) = erroring_health() else {
            return;
        };
        let dir = repo_with_head();
        let inner = empty_inner(dir.path());
        let (tx, _rx) = mpsc::unbounded_channel();
        let stopped = Arc::new(AtomicBool::new(true));
        let task = tokio::spawn(supervise_watcher(
            "alpha".into(),
            inner.clone(),
            tx,
            Arc::new(Mutex::new(ErrorRateMap::default())),
            health,
            stopped,
        ));
        tokio::time::timeout(SUPERVISOR_TICK * 3, task)
            .await
            .expect("supervisor should exit once stopped")
            .unwrap();
        assert!(inner.lock().unwrap().watched.is_empty());
    }

    #[test]
    fn resolve_git_dir_follows_file_pointer() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("wt");
        let real = dir.path().join("real-gitdir");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(root.join(".git"), format!("gitdir: {}\n", real.display())).unwrap();
        assert_eq!(resolve_git_dir(&root), real);
    }
}
