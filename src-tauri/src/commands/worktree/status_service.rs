//! Backend-owned worktree status service. Replaces the frontend's
//! per-row 2 s poll loop (which spawned 3 sequential git processes per
//! worktree every tick) with cached, event-driven recomputes.
//!
//! One long-lived task per *subscribed* worktree path. The frontend pushes
//! the full set of currently mounted worktree paths via
//! `worktree_status_subscribe`; the service reconciles — new paths spawn a
//! task (immediate seed compute + emit), missing paths are aborted. Set
//! reconciliation (instead of subscribe/unsubscribe refcounts) means backend
//! state can never drift from the UI across remounts.
//!
//! Each task recomputes on:
//! * **Subscribe** — immediately on spawn; the result is always emitted so
//!   the UI gets seeded.
//! * **Mutation** — `git_stage` / `git_unstage` / `git_discard` /
//!   `git_checkout_branch` / `worktree_merge` nudge the path they touched.
//! * **WatcherPulse** — the per-project `.git` watcher forwards HEAD *and*
//!   index touches (commits/stages typed into a pane terminal land here).
//!   Scoped to the paths belonging to the project that pulsed, so a background
//!   project's commit doesn't recompute the active project's rows.
//! * **Focus** — window regains focus.
//! * **Fallback** — a slow 15 s tick that catches silent file edits by
//!   agents/editors. Skipped while the window is unfocused, so a backgrounded
//!   app spawns zero git processes.
//!
//! Triggers are debounced 200 ms (bursts coalesce into one recompute) and a
//! `worktree-status-changed` event is emitted **only when the computed
//! status differs** from the cached one — Solid stores never churn on
//! no-op recomputes. The stash count is cached with a 30 s TTL (it needs a
//! third subprocess) and force-recounted on watcher pulses, where a stash
//! push/pop is most likely to have happened.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use super::fs_watcher::WorktreeFsWatcher;
use super::status::compute_status;
use super::types::WorktreeStatus;
use crate::state::AppHandleState;

/// Trigger bursts (a `git checkout` touches HEAD, index, and refs in quick
/// succession; the watcher already debounces 150 ms on top) coalesce within
/// this window into a single recompute.
const DEBOUNCE: Duration = Duration::from_millis(200);

/// Slow fallback tick per subscribed path. Catches working-tree edits that
/// no trigger sees (agents writing files in a pane). Deliberately long —
/// focus/mutation/watcher triggers cover everything latency-sensitive.
const FALLBACK_POLL: Duration = Duration::from_secs(15);

/// How long a cached stash count stays valid before the next recompute also
/// recounts (`git stash list` is the only third subprocess left).
const STASH_TTL: Duration = Duration::from_secs(30);

/// Why a recompute was requested. Only distinction that matters today:
/// `WatcherPulse` forces a stash recount. `FsEdit` (a working-tree file change
/// seen by the per-worktree fs watcher) behaves like `Mutation` — no stash
/// recount, just a debounced recompute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshCause {
    Mutation,
    WatcherPulse,
    Focus,
    FsEdit,
}

/// Payload of the `worktree-status-changed` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusChangedPayload {
    path: String,
    status: WorktreeStatus,
}

#[derive(Debug)]
struct WatchEntry {
    trigger_tx: mpsc::UnboundedSender<RefreshCause>,
    task: tauri::async_runtime::JoinHandle<()>,
    /// Main-repo root this worktree belongs to, resolved once at subscribe
    /// time (see [`main_repo_root`]). Watcher pulses carry a project slug;
    /// only the paths whose repo root matches that project's root recompute.
    /// `None` when resolution failed — those fall open and recompute on every
    /// pulse, exactly as everything did before.
    repo_root: Option<PathBuf>,
    /// Working-tree file watcher for this path — pulses `trigger_tx` with
    /// `FsEdit` so raw edits (no git command) refresh promptly instead of
    /// waiting for the fallback poll. Attached asynchronously after the entry is
    /// inserted (see `set_subscriptions` phase 2); `None` until then or if the
    /// watcher failed to start. Held only for its `Drop` (stops watching when
    /// the entry is unsubscribed) — never read, hence the allow.
    #[allow(dead_code)]
    fs_watcher: Option<WorktreeFsWatcher>,
}

#[derive(Debug)]
struct ServiceInner {
    app: tauri::AppHandle,
    /// Keyed by absolute worktree path.
    entries: Mutex<HashMap<String, WatchEntry>>,
    /// Sender handed to every `GitHeadWatcher` (payload: project slug). One
    /// drain task fans pulses out to all subscribed paths.
    pulse_tx: mpsc::UnboundedSender<String>,
    /// Main-window focus state. Fallback ticks skip recomputes while
    /// unfocused; the focus-gain trigger covers the catch-up.
    focused: AtomicBool,
}

/// Cheap-to-clone handle stored on [`AppHandleState`]. Constructed once in
/// Tauri `.setup` (needs an `AppHandle` for event emission).
#[derive(Debug, Clone)]
pub struct WorktreeStatusService {
    inner: Arc<ServiceInner>,
}

impl WorktreeStatusService {
    pub fn new(app: tauri::AppHandle) -> Self {
        let (pulse_tx, mut pulse_rx) = mpsc::unbounded_channel::<String>();
        let inner = Arc::new(ServiceInner {
            app,
            entries: Mutex::new(HashMap::new()),
            pulse_tx,
            focused: AtomicBool::new(true),
        });
        // Drain watcher pulses → nudge the pulsing project's paths only.
        // Only the active project has a `GitHeadWatcher` today, but a stale
        // subscription from a just-deactivated project would otherwise still
        // respawn `git diff`/`git status` for rows the pulse doesn't own.
        let drain_inner = inner.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(slug) = pulse_rx.recv().await {
                debug!(slug = %slug, "status_service: watcher pulse");
                let root = project_root_for(&drain_inner.app, &slug);
                trigger_scoped(&drain_inner, root.as_deref());
            }
        });
        Self { inner }
    }

    /// Sender for `GitHeadWatcher` status pulses (payload: project slug).
    pub fn pulse_sender(&self) -> mpsc::UnboundedSender<String> {
        self.inner.pulse_tx.clone()
    }

    /// Declarative subscription set: `paths` is the FULL set of worktree
    /// paths the UI currently displays. New paths spawn a watch task (with
    /// an immediate, always-emitted seed compute); paths no longer present
    /// are aborted; a path whose watch task has died is respawned. Idempotent,
    /// so the frontend can re-push the unchanged set (e.g. on window focus,
    /// see `resyncStatusSubscriptions`) purely to self-heal.
    pub fn set_subscriptions(&self, paths: Vec<String>) {
        let wanted: HashSet<String> = paths.into_iter().filter(|p| !p.is_empty()).collect();

        // Phase 1 (brief lock): drop removed and dead paths; for each missing
        // path spawn its cheap, non-blocking watch task and insert a placeholder
        // entry whose working-tree watcher is attached later. The seed status
        // emits from the watch task immediately — the fs watcher only adds
        // raw-edit liveness.
        let to_start: Vec<(String, mpsc::UnboundedSender<RefreshCause>)> = {
            let Ok(mut entries) = self.inner.entries.lock() else {
                warn!("status_service: entries mutex poisoned");
                return;
            };
            let before = entries.len();
            let mut respawned = 0usize;
            entries.retain(|path, entry| {
                if !wanted.contains(path) {
                    debug!(path = %path, "status_service: unsubscribed");
                    entry.task.abort();
                    return false;
                }
                // A watch task normally runs forever (its `trigger_rx` never
                // closes while this entry holds the sender). If it has finished
                // it can only have panicked — Tokio aborts a panicking task and
                // never surfaces the error. Leaving the stale entry in the map
                // would make the `contains_key` check below skip respawning this
                // path *forever*, freezing its diffstat until a project switch
                // cleared the map. Drop it here (also releasing its fs watcher)
                // so the loop below respawns a fresh task + watcher.
                if entry.task.inner().is_finished() {
                    warn!(path = %path, "status_service: watch task ended unexpectedly; respawning");
                    respawned += 1;
                    return false;
                }
                true
            });
            let mut to_start = Vec::new();
            for path in wanted {
                if entries.contains_key(&path) {
                    continue;
                }
                let (trigger_tx, trigger_rx) = mpsc::unbounded_channel();
                let task = spawn_watch_task(self.inner.clone(), path.clone(), trigger_rx);
                let repo_root = main_repo_root(Path::new(&path));
                entries.insert(
                    path.clone(),
                    WatchEntry {
                        trigger_tx: trigger_tx.clone(),
                        task,
                        repo_root,
                        fs_watcher: None,
                    },
                );
                to_start.push((path, trigger_tx));
            }
            // Log only when the set actually shifted — a no-op focus resync
            // (nothing added, removed, or dead) stays silent.
            if entries.len() != before || !to_start.is_empty() || respawned > 0 {
                info!(
                    subscribed = entries.len(),
                    started = to_start.len(),
                    respawned = respawned,
                    "status_service: reconciled subscriptions",
                );
            }
            to_start
        };

        if to_start.is_empty() {
            return;
        }

        // Phase 2 (off the lock AND off the command thread): build each
        // working-tree watcher and attach it. On Linux this walks the tree and
        // registers inotify watches, which can take a while — doing it here
        // keeps the status hot path and the (synchronous) subscribe command
        // responsive. A path unsubscribed mid-build simply drops the watcher.
        let inner = self.inner.clone();
        tauri::async_runtime::spawn(async move {
            for (path, trigger_tx) in to_start {
                // The watcher pulses `trigger_tx`; keep a handle to verify, at
                // attach time, that the entry still owns *this* channel.
                let attach_tx = trigger_tx.clone();
                let build_path = path.clone();
                let built = tokio::task::spawn_blocking(move || {
                    WorktreeFsWatcher::start(PathBuf::from(&build_path), trigger_tx)
                })
                .await;
                let watcher = match built {
                    Ok(Ok(w)) => w,
                    Ok(Err(e)) => {
                        warn!(path = %path, error = %e, "status_service: working-tree watcher failed to start; relying on fallback poll");
                        continue;
                    }
                    Err(e) => {
                        warn!(path = %path, error = %e, "status_service: working-tree watcher build panicked; relying on fallback poll");
                        continue;
                    }
                };
                let Ok(mut entries) = inner.entries.lock() else {
                    return;
                };
                // Attach only if the entry still owns the channel this watcher
                // pulses. If the path was unsubscribed (entry gone) or
                // unsubscribed-then-resubscribed (entry replaced with a fresh
                // `trigger_tx`/watch task) while we were building, this watcher
                // is stale — dropping it stops its OS watch, and the newer
                // subscription's own phase 2 attaches the matching watcher.
                match entries.get_mut(&path) {
                    Some(entry) if entry.trigger_tx.same_channel(&attach_tx) => {
                        entry.fs_watcher = Some(watcher);
                    }
                    _ => drop(watcher),
                }
            }
        });
    }

    /// Debounced refresh nudge for one path. No-op when the path isn't
    /// subscribed — an unsubscribed path has no UI to update.
    pub fn trigger(&self, path: &str, cause: RefreshCause) {
        let Ok(entries) = self.inner.entries.lock() else {
            return;
        };
        if let Some(entry) = entries.get(path) {
            let _ = entry.trigger_tx.send(cause);
        }
    }

    /// Nudge every subscribed path (watcher pulse, window focus).
    pub fn trigger_all(&self, cause: RefreshCause) {
        trigger_all_inner(&self.inner, cause);
    }

    /// Record main-window focus. Gaining focus triggers a catch-up recompute
    /// across all subscribed paths; losing it pauses the fallback ticks.
    pub fn set_focused(&self, focused: bool) {
        self.inner.focused.store(focused, Ordering::Relaxed);
        if focused {
            self.trigger_all(RefreshCause::Focus);
        }
    }
}

fn trigger_all_inner(inner: &Arc<ServiceInner>, cause: RefreshCause) {
    let Ok(entries) = inner.entries.lock() else {
        return;
    };
    for entry in entries.values() {
        let _ = entry.trigger_tx.send(cause);
    }
}

/// `WatcherPulse` fan-out restricted to the paths belonging to `repo_root`.
/// Entries whose own root is unknown (resolution failed, or the path is not a
/// git worktree) always fire — a spurious debounced recompute is far cheaper
/// than a status that never updates. `repo_root == None` (unknown project)
/// degrades to the old fan-out.
fn trigger_scoped(inner: &Arc<ServiceInner>, repo_root: Option<&Path>) {
    let Ok(entries) = inner.entries.lock() else {
        return;
    };
    for entry in entries.values() {
        let mine = match (repo_root, entry.repo_root.as_deref()) {
            (Some(want), Some(have)) => want == have,
            _ => true,
        };
        if mine {
            let _ = entry.trigger_tx.send(RefreshCause::WatcherPulse);
        }
    }
}

/// Main-repo root of the project registered under `slug`, or `None` when the
/// config can't be read (then the pulse falls open, see [`trigger_scoped`]).
/// Resolved through [`main_repo_root`] — the same resolver the entries use — so
/// a project registered *at* a linked worktree still compares equal to its
/// entries, which always resolve to the main repo. One small TOML read per pulse
/// (pulses are already debounced 150 ms by the `.git` watcher) — cheap next to
/// the git subprocesses a misrouted pulse would spawn.
fn project_root_for(app: &tauri::AppHandle, slug: &str) -> Option<PathBuf> {
    use tauri::Manager;
    let state = app.try_state::<AppHandleState>()?;
    let store = state.config_store.lock().ok()?;
    let project = store.read_project(slug).ok().flatten()?;
    main_repo_root(&project.root_path)
}

/// Canonical main-repo root for a worktree path: for the primary worktree that
/// is the path itself; for a linked worktree the `.git` *file* points at
/// `<main>/.git/worktrees/<id>`, so we climb back out. Returns `None` when the
/// path has no `.git` at all (not a worktree — nothing a project pulse owns).
fn main_repo_root(path: &Path) -> Option<PathBuf> {
    let git = path.join(".git");
    if git.is_dir() {
        return Some(canonical(path));
    }
    let raw = std::fs::read_to_string(&git).ok()?;
    let pointer = raw.strip_prefix("gitdir:")?.trim();
    let gitdir = if Path::new(pointer).is_absolute() {
        PathBuf::from(pointer)
    } else {
        path.join(pointer)
    };
    // `<main>/.git/worktrees/<id>` → `<main>`. `parent()` three times; anything
    // shaped differently (submodule pointer) resolves to nothing rather than a
    // wrong owner.
    let main = gitdir.parent()?.parent()?.parent()?;
    (gitdir.parent()?.file_name()? == "worktrees").then(|| canonical(main))
}

fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Per-path watch loop. Seed compute on spawn (always emitted), then
/// recompute on debounced triggers or the fallback tick, emitting only when
/// the status actually changed.
fn spawn_watch_task(
    inner: Arc<ServiceInner>,
    path: String,
    mut trigger_rx: mpsc::UnboundedReceiver<RefreshCause>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut last_status: Option<WorktreeStatus> = None;
        let mut stash_checked_at: Option<Instant> = None;

        recompute_and_emit(
            &inner,
            &path,
            &mut last_status,
            &mut stash_checked_at,
            false,
        )
        .await;

        loop {
            let mut force_stash = false;
            tokio::select! {
                maybe = trigger_rx.recv() => {
                    let Some(cause) = maybe else { return };
                    force_stash |= cause == RefreshCause::WatcherPulse;
                }
                () = tokio::time::sleep(FALLBACK_POLL) => {
                    // Backgrounded app: skip — the focus-gain trigger
                    // catches up the moment status is visible again.
                    if !inner.focused.load(Ordering::Relaxed) {
                        continue;
                    }
                }
            }
            // Drain the burst until DEBOUNCE of quiet.
            let deadline = tokio::time::Instant::now() + DEBOUNCE;
            loop {
                tokio::select! {
                    maybe = trigger_rx.recv() => {
                        let Some(cause) = maybe else { return };
                        force_stash |= cause == RefreshCause::WatcherPulse;
                    }
                    () = tokio::time::sleep_until(deadline) => break,
                }
            }
            recompute_and_emit(
                &inner,
                &path,
                &mut last_status,
                &mut stash_checked_at,
                force_stash,
            )
            .await;
        }
    })
}

async fn recompute_and_emit(
    inner: &Arc<ServiceInner>,
    path: &str,
    last_status: &mut Option<WorktreeStatus>,
    stash_checked_at: &mut Option<Instant>,
    force_stash: bool,
) {
    let stash_fresh = !force_stash && stash_checked_at.is_some_and(|t| t.elapsed() < STASH_TTL);
    let cached_stash = if stash_fresh {
        last_status.as_ref().map(|s| s.stash_count)
    } else {
        None
    };

    let status = match compute_status(path.to_string(), cached_stash).await {
        Ok(s) => s,
        Err(e) => {
            warn!(path = %path, error = %e, "status_service: compute failed");
            return;
        }
    };
    if cached_stash.is_none() {
        *stash_checked_at = Some(Instant::now());
    }

    // First compute always emits (seeds the UI); afterwards only diffs do.
    let changed = last_status.as_ref() != Some(&status);
    if changed {
        let payload = StatusChangedPayload {
            path: path.to_string(),
            status: status.clone(),
        };
        if let Err(e) = inner.app.emit("worktree-status-changed", payload) {
            warn!(path = %path, error = %e, "worktree-status-changed emit failed");
        }
    }
    *last_status = Some(status);
}

/// Fetch the service handle off managed state without holding the guard.
/// `None` when setup failed — callers degrade silently (the one-shot
/// `worktree_status` command still works).
pub(crate) fn service_handle(state: &AppHandleState) -> Option<WorktreeStatusService> {
    state
        .status_service
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

/// Convenience for sibling command modules: nudge one path after a
/// successful git mutation (stage/unstage/discard/checkout/merge).
pub(super) fn trigger_status_refresh(state: &AppHandleState, path: &str) {
    if let Some(svc) = service_handle(state) {
        svc.trigger(path, RefreshCause::Mutation);
    }
}

/// Declarative subscription endpoint — see
/// [`WorktreeStatusService::set_subscriptions`].
#[tauri::command]
pub fn worktree_status_subscribe(
    state: tauri::State<'_, AppHandleState>,
    paths: Vec<String>,
) -> Result<(), String> {
    if let Some(svc) = service_handle(&state) {
        svc.set_subscriptions(paths);
    }
    Ok(())
}

/// Explicit refresh escape hatch (e.g. after the commit box runs its
/// command through the PTY).
#[tauri::command]
pub fn worktree_status_refresh(
    state: tauri::State<'_, AppHandleState>,
    paths: Vec<String>,
) -> Result<(), String> {
    if let Some(svc) = service_handle(&state) {
        for path in &paths {
            svc.trigger(path, RefreshCause::Mutation);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pulse scoping hinges entirely on this: a linked worktree must resolve
    /// back to the main repo whose `.git` the project watcher pulses for.
    #[test]
    fn main_repo_root_resolves_primary_and_linked_worktrees() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("repo");
        std::fs::create_dir_all(main.join(".git/worktrees/feat")).unwrap();
        let linked = tmp.path().join("repo-worktrees/feat");
        std::fs::create_dir_all(&linked).unwrap();
        std::fs::write(
            linked.join(".git"),
            format!("gitdir: {}/.git/worktrees/feat\n", main.display()),
        )
        .unwrap();

        assert_eq!(main_repo_root(&main), Some(canonical(&main)));
        assert_eq!(main_repo_root(&linked), Some(canonical(&main)));
        // A submodule-style pointer isn't a worktree — no owner, falls open.
        let sub = tmp.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join(".git"), "gitdir: ../repo/.git/modules/sub\n").unwrap();
        assert_eq!(main_repo_root(&sub), None);
        // Not a git dir at all.
        assert_eq!(main_repo_root(tmp.path()), None);
    }
}
