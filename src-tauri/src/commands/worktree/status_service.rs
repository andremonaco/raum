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
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;
use tokio::sync::mpsc;
use tracing::{debug, warn};

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
    /// Working-tree file watcher for this path — pulses `trigger_tx` with
    /// `FsEdit` so raw edits (no git command) refresh promptly instead of
    /// waiting for the fallback poll. Held only for its `Drop` (stops watching
    /// when the entry is unsubscribed); `None` if the watcher failed to start.
    _fs_watcher: Option<WorktreeFsWatcher>,
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
        // Drain watcher pulses → nudge every subscribed path. v1 fans out to
        // all paths regardless of which project pulsed: the subscribed set
        // is just the visible rows, recomputes are debounced + diffed, and
        // mapping `.git/worktrees/<id>` back to a worktree path would need a
        // `gitdir`-file read that isn't worth it yet.
        let drain_inner = inner.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(slug) = pulse_rx.recv().await {
                debug!(slug = %slug, "status_service: watcher pulse");
                trigger_all_inner(&drain_inner, RefreshCause::WatcherPulse);
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
    /// are aborted. Idempotent.
    pub fn set_subscriptions(&self, paths: Vec<String>) {
        let wanted: HashSet<String> = paths.into_iter().filter(|p| !p.is_empty()).collect();
        let Ok(mut entries) = self.inner.entries.lock() else {
            warn!("status_service: entries mutex poisoned");
            return;
        };
        entries.retain(|path, entry| {
            let keep = wanted.contains(path);
            if !keep {
                debug!(path = %path, "status_service: unsubscribed");
                entry.task.abort();
            }
            keep
        });
        for path in wanted {
            entries.entry(path.clone()).or_insert_with(|| {
                let (trigger_tx, trigger_rx) = mpsc::unbounded_channel();
                let task = spawn_watch_task(self.inner.clone(), path.clone(), trigger_rx);
                // Working-tree watcher for instant raw-edit refresh. Failure to
                // start is non-fatal — the fallback poll still covers the path.
                let fs_watcher =
                    match WorktreeFsWatcher::start(PathBuf::from(&path), trigger_tx.clone()) {
                        Ok(w) => Some(w),
                        Err(e) => {
                            warn!(path = %path, error = %e, "status_service: working-tree watcher failed to start; relying on fallback poll");
                            None
                        }
                    };
                WatchEntry {
                    trigger_tx,
                    task,
                    _fs_watcher: fs_watcher,
                }
            });
        }
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
