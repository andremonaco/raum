//! Per-project `.git/HEAD` watcher. Emits `worktree-branches-changed` so the
//! UI refreshes branch badges without polling.
//!
//! Watches `<root>/.git/` (main project) plus every
//! `<root>/.git/worktrees/*/` (linked worktrees) non-recursively, filtering
//! notify events by filename to only pulse on HEAD touches. We watch the
//! *directory* rather than the HEAD file itself because git rewrites HEAD
//! with an atomic rename — on macOS FSEvents this invalidates per-file
//! watches after the first checkout, so subsequent branch switches were
//! silent. Dir inodes stay stable across the rename. FS events are coalesced
//! inside a debounce window before a single event is emitted to the webview.
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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

/// Git checkout writes multiple files (HEAD, index, packed-refs) in quick
/// succession. Coalesce the burst so we emit one frontend event per switch.
const DEBOUNCE: Duration = Duration::from_millis(150);

/// Minimum time between identical-error WARN emissions per (slug, error)
/// pair. Anything inside the window increments a `suppressed` counter that
/// surfaces as a single INFO at window close — so a 7 000-warn-per-day
/// burst becomes ~30 lines and the *transitions* stay visible.
const ERROR_WARN_WINDOW: Duration = Duration::from_secs(60);

/// Sustained-error duration that triggers a watcher rebuild. Below this, an
/// occasional EMFILE during a transient pressure spike is left alone — the
/// FSEvents stream usually recovers on its own. Above it the stream is
/// effectively dead and only a fresh watcher will resume events.
const REBUILD_AFTER_SUSTAINED_ERRORS: Duration = Duration::from_secs(30);

/// Initial wait between rebuild attempts after a failure. Doubles up to
/// `REBUILD_BACKOFF_CEILING`.
const REBUILD_BACKOFF_INITIAL: Duration = Duration::from_secs(30);
const REBUILD_BACKOFF_CEILING: Duration = Duration::from_secs(300);

/// How often the supervisor checks the watcher's health.
const SUPERVISOR_TICK: Duration = Duration::from_secs(15);

/// Number of consecutive errors required (in addition to the time
/// threshold) before we consider rebuilding. Guards against rebuilding on a
/// single transient error that happened to land just before a tick.
const REBUILD_MIN_ERR_COUNT: u64 = 3;

/// Holds the current `RecommendedWatcher` plus the dirs it's watching, so
/// the supervisor can swap the watcher out without disturbing anything
/// else. `root` lives here too so rebuilds and rescans share one source of
/// truth.
struct Inner {
    watcher: RecommendedWatcher,
    watched: HashSet<PathBuf>,
    root: PathBuf,
}

#[derive(Default)]
struct ErrorRateMap {
    by_kind: HashMap<String, KindBucket>,
}

struct KindBucket {
    window_start: Instant,
    suppressed: u64,
}

#[derive(Default)]
struct HealthState {
    /// First error since the last successful event reception, if any.
    first_err_at: Option<Instant>,
    /// Errors observed since the last successful event.
    err_count: u64,
    /// Consecutive rebuild failures so we can back off exponentially.
    rebuild_attempts: u32,
    /// Earliest time the supervisor is allowed to retry a previously
    /// failed rebuild. `None` means "no pending backoff".
    next_rebuild_eligible_at: Option<Instant>,
}

impl HealthState {
    fn record_ok(&mut self) {
        self.first_err_at = None;
        self.err_count = 0;
    }
    fn record_err(&mut self, now: Instant) {
        self.err_count = self.err_count.saturating_add(1);
        if self.first_err_at.is_none() {
            self.first_err_at = Some(now);
        }
    }
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
    _pulse_tx: mpsc::UnboundedSender<()>,
    inner: Arc<Mutex<Inner>>,
}

impl Drop for GitHeadWatcher {
    fn drop(&mut self) {
        self.supervisor.abort();
    }
}

impl GitHeadWatcher {
    /// Start a watcher for `slug` rooted at `root`. Returns `Err` only when
    /// the OS refuses to create a watcher at all; individual path watch
    /// failures are logged and skipped so a missing worktree HEAD never
    /// blocks startup.
    pub fn start<R: Runtime>(slug: String, root: &Path, app: AppHandle<R>) -> notify::Result<Self> {
        let (pulse_tx, mut pulse_rx) = mpsc::unbounded_channel::<()>();
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
        // checkout) into a single frontend event per switch.
        let emit_slug = slug.clone();
        let emit_app = app.clone();
        tauri::async_runtime::spawn(async move {
            while pulse_rx.recv().await.is_some() {
                let deadline = tokio::time::Instant::now() + DEBOUNCE;
                loop {
                    tokio::select! {
                        maybe = pulse_rx.recv() => {
                            if maybe.is_none() { return; }
                        }
                        () = tokio::time::sleep_until(deadline) => break,
                    }
                }
                if let Err(e) =
                    emit_app.emit("worktree-branches-changed", json!({ "slug": emit_slug }))
                {
                    warn!(slug = %emit_slug, error = %e, "worktree-branches-changed emit failed");
                }
            }
        });

        // Supervisor: notice when the watcher has been erroring for ≥30 s
        // with no successful event, drop it, and re-create. Backs off if
        // the rebuild itself fails (typically also EMFILE).
        let supervisor = tauri::async_runtime::spawn(supervise_watcher(
            slug,
            inner.clone(),
            pulse_tx.clone(),
            error_state,
            health,
        ));

        Ok(Self {
            supervisor,
            _pulse_tx: pulse_tx,
            inner,
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

/// Build a `RecommendedWatcher` and watch every dir from
/// `discover_watch_dirs(root)`. The closure forwards HEAD-touch pulses to
/// the debounce task, updates `health` for the supervisor, and routes
/// errors through the rate-limited reporter. Used by both initial start
/// and the supervisor's rebuild path so the two paths can't drift.
fn build_watcher(
    slug: String,
    root: &Path,
    pulse_tx: mpsc::UnboundedSender<()>,
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
                ) && event_touches_head(&ev)
                {
                    let _ = cb_pulse.send(());
                }
            }
            Err(e) => {
                if let Ok(mut h) = cb_health.lock() {
                    h.record_err(Instant::now());
                }
                emit_rate_limited_error(&cb_error, &cb_slug, &e);
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

/// Emit at most one WARN per `(slug, error)` per `ERROR_WARN_WINDOW`, then
/// a single suppression-count INFO at the end of the window. Keeps the log
/// useful when notify is in a sustained-error state — the transitions and
/// the count are still visible.
fn emit_rate_limited_error(state: &Arc<Mutex<ErrorRateMap>>, slug: &str, err: &notify::Error) {
    let key = format!("{err}");
    let Ok(mut state) = state.lock() else {
        // Poisoned mutex: drop the warn rather than panic in a callback
        // that runs on notify's backend thread.
        return;
    };
    let now = Instant::now();
    match state.by_kind.get_mut(&key) {
        None => {
            state.by_kind.insert(
                key.clone(),
                KindBucket {
                    window_start: now,
                    suppressed: 0,
                },
            );
            warn!(slug = %slug, error = %key, "git_watcher: notify error");
        }
        Some(bucket) => {
            if now.duration_since(bucket.window_start) >= ERROR_WARN_WINDOW {
                if bucket.suppressed > 0 {
                    info!(
                        slug = %slug,
                        error = %key,
                        suppressed = bucket.suppressed,
                        window_secs = ERROR_WARN_WINDOW.as_secs(),
                        "git_watcher: suppressed repeated notify errors",
                    );
                }
                bucket.window_start = now;
                bucket.suppressed = 0;
                warn!(slug = %slug, error = %key, "git_watcher: notify error");
            } else {
                bucket.suppressed = bucket.suppressed.saturating_add(1);
            }
        }
    }
}

/// Long-running supervisor: every `SUPERVISOR_TICK`, check whether the
/// watcher has been erroring for `REBUILD_AFTER_SUSTAINED_ERRORS` with no
/// successful events in between. If so, build a fresh watcher and swap it
/// in. On rebuild failure (typically also EMFILE), back off exponentially
/// before the next attempt.
async fn supervise_watcher(
    slug: String,
    inner: Arc<Mutex<Inner>>,
    pulse_tx: mpsc::UnboundedSender<()>,
    error_state: Arc<Mutex<ErrorRateMap>>,
    health: Arc<Mutex<HealthState>>,
) {
    let mut tick = tokio::time::interval(SUPERVISOR_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Skip the immediate first tick — interval fires once at start.
    tick.tick().await;
    loop {
        tick.tick().await;

        let now = Instant::now();
        let trigger = {
            let Ok(h) = health.lock() else { continue };
            if let Some(eligible) = h.next_rebuild_eligible_at {
                if now < eligible {
                    continue;
                }
            }
            match h.first_err_at {
                Some(first)
                    if now.duration_since(first) >= REBUILD_AFTER_SUSTAINED_ERRORS
                        && h.err_count >= REBUILD_MIN_ERR_COUNT =>
                {
                    Some(h.err_count)
                }
                _ => continue,
            }
        };
        let Some(dropped_errors) = trigger else {
            continue;
        };

        // Snapshot the root outside the watcher-construction call so we
        // don't hold the inner lock while notify creates its FSEvents
        // stream.
        let root = match inner.lock() {
            Ok(g) => g.root.clone(),
            Err(_) => continue,
        };
        let result = build_watcher(
            slug.clone(),
            &root,
            pulse_tx.clone(),
            error_state.clone(),
            health.clone(),
        );

        match result {
            Ok((new_watcher, new_watched)) => {
                if let Ok(mut g) = inner.lock() {
                    g.watcher = new_watcher;
                    g.watched = new_watched;
                }
                if let Ok(mut h) = health.lock() {
                    h.first_err_at = None;
                    h.err_count = 0;
                    h.rebuild_attempts = 0;
                    h.next_rebuild_eligible_at = None;
                }
                info!(
                    slug = %slug,
                    dropped_errors = dropped_errors,
                    "git_watcher: rebuilt watcher after sustained errors",
                );
            }
            Err(e) => {
                if let Ok(mut h) = health.lock() {
                    h.rebuild_attempts = h.rebuild_attempts.saturating_add(1);
                    let backoff = backoff_for_attempt(h.rebuild_attempts);
                    h.next_rebuild_eligible_at = Some(now + backoff);
                    warn!(
                        slug = %slug,
                        error = %e,
                        attempt = h.rebuild_attempts,
                        retry_in_secs = backoff.as_secs(),
                        "git_watcher: rebuild failed, backing off",
                    );
                }
            }
        }
    }
}

/// Exponential backoff schedule: 30 s, 60 s, 120 s, 240 s, capped at the
/// 300 s ceiling. `attempt` is 1-indexed (we always increment before
/// looking up).
fn backoff_for_attempt(attempt: u32) -> Duration {
    let shift = attempt.saturating_sub(1).min(8);
    let mult = 1u64 << shift;
    let secs = REBUILD_BACKOFF_INITIAL
        .as_secs()
        .saturating_mul(mult)
        .min(REBUILD_BACKOFF_CEILING.as_secs());
    Duration::from_secs(secs)
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

    #[test]
    fn backoff_doubles_then_caps() {
        assert_eq!(backoff_for_attempt(1), Duration::from_secs(30));
        assert_eq!(backoff_for_attempt(2), Duration::from_secs(60));
        assert_eq!(backoff_for_attempt(3), Duration::from_secs(120));
        assert_eq!(backoff_for_attempt(4), Duration::from_secs(240));
        // 30 * 2^4 = 480 -> capped at 300
        assert_eq!(backoff_for_attempt(5), Duration::from_secs(300));
        // Far-future attempts also stay capped.
        assert_eq!(backoff_for_attempt(50), Duration::from_secs(300));
    }
}
