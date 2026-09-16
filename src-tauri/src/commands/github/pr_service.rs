//! Per-worktree pull-request poll service.
//!
//! A sibling of `worktree/status_service.rs` and deliberately the same shape:
//! the frontend pushes the full set of worktree paths it currently displays
//! (`github_pr_subscribe`), the service reconciles its task map against that
//! set, each task recomputes on trigger or tick, and a `github-pr-changed`
//! event is emitted only when the value actually differs from the cache. Set
//! reconciliation rather than refcounts means backend state cannot drift from
//! the UI across remounts.
//!
//! Three things differ from the status service:
//!
//! * **The tick is adaptive.** GitHub offers no client push channel, so this
//!   polls — but only as fast as the PR state warrants. A PR with a check still
//!   running re-reads every 10 s; a settled open PR every 90 s; a branch with
//!   no PR every 5 minutes. Unfocused windows poll not at all.
//! * **A second event, `github-pr-transition`,** fires when the diff crosses a
//!   notification-worthy edge (checks turned green, checks broke, a review
//!   landed, the PR got merged). The notification centre decides what to do
//!   with it; this service only reports the edge.
//! * **Unavailable paths cost nothing.** Before the first `gh` call a path must
//!   have an `origin` remote on a host `gh` is logged into. A worktree on a
//!   non-GitHub remote emits one `available: false` event and then sits idle.
//!
//! Immediate recomputes come from window focus, the git watcher's remote-ref
//! pulse (`.git/refs/remotes/origin/…` moved, i.e. someone just pushed), a
//! merge, and the manual refresh command.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Emitter;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use super::gh;
use super::types::{
    CheckBucket, PrChangedPayload, PrTransitionKind, PrTransitionPayload, PullRequest, RawPr,
};
use crate::commands::worktree::main_repo_root;
use crate::state::AppHandleState;

/// Trigger bursts coalesce into one recompute within this window.
const DEBOUNCE: Duration = Duration::from_millis(200);

/// Any check queued or in progress: the state the user is actually waiting on.
pub(super) const TICK_HOT: Duration = Duration::from_secs(10);

/// Open PR, every check settled. Catches reviews and merges from elsewhere.
pub(super) const TICK_SETTLED: Duration = Duration::from_secs(90);

/// No PR for this branch (yet), or no GitHub remote at all.
pub(super) const TICK_IDLE: Duration = Duration::from_secs(300);

/// A `gh` call failed. Retry sooner than the idle tick but far slower than the
/// hot one, so a rate limit or a flaky network doesn't turn into a spin.
const TICK_ERROR: Duration = Duration::from_secs(30);

/// The fields `gh pr view` has to return to build a [`PullRequest`].
const PR_VIEW_FIELDS: &str = "number,title,url,state,isDraft,author,baseRefName,headRefName,\
headRefOid,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,commits,updatedAt";

#[derive(Debug)]
struct WatchEntry {
    trigger_tx: mpsc::UnboundedSender<()>,
    task: tauri::async_runtime::JoinHandle<()>,
    /// Main-repo root this worktree belongs to. Remote-ref pulses carry a
    /// project root; only the paths that belong to it recompute. `None` when
    /// resolution failed — those fall open, exactly like the status service.
    repo_root: Option<PathBuf>,
}

#[derive(Debug)]
struct ServiceInner {
    app: tauri::AppHandle,
    entries: Mutex<HashMap<String, WatchEntry>>,
    /// Main-window focus. Ticks are skipped while unfocused; regaining focus
    /// triggers a catch-up across every path.
    focused: AtomicBool,
}

/// Cheap-to-clone handle stored on [`AppHandleState`]. Constructed once in
/// Tauri `.setup` (it needs an `AppHandle` to emit events).
#[derive(Debug, Clone)]
pub struct GithubPrService {
    inner: Arc<ServiceInner>,
}

impl GithubPrService {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            inner: Arc::new(ServiceInner {
                app,
                entries: Mutex::new(HashMap::new()),
                focused: AtomicBool::new(true),
            }),
        }
    }

    /// Declarative subscription set: `paths` is the FULL set of worktree paths
    /// the UI currently displays. New paths spawn a poll task with an
    /// always-emitted seed; paths no longer present are aborted; a path whose
    /// task has died is respawned. Idempotent, so the frontend can re-push an
    /// unchanged set purely to self-heal.
    pub fn set_subscriptions(&self, paths: Vec<String>) {
        let wanted: HashSet<String> = paths.into_iter().filter(|p| !p.is_empty()).collect();
        let Ok(mut entries) = self.inner.entries.lock() else {
            warn!("github_pr: entries mutex poisoned");
            return;
        };
        let before = entries.len();
        let mut respawned = 0usize;
        entries.retain(|path, entry| {
            if !wanted.contains(path) {
                entry.task.abort();
                return false;
            }
            // A poll task only ends if it panicked (Tokio swallows the error).
            // Dropping the stale entry lets the loop below respawn it instead
            // of freezing this path's chip forever.
            if entry.task.inner().is_finished() {
                warn!(path = %path, "github_pr: poll task ended unexpectedly; respawning");
                respawned += 1;
                return false;
            }
            true
        });
        let mut started = 0usize;
        for path in wanted {
            if entries.contains_key(&path) {
                continue;
            }
            let (trigger_tx, trigger_rx) = mpsc::unbounded_channel();
            let task = spawn_poll_task(self.inner.clone(), path.clone(), trigger_rx);
            let repo_root = main_repo_root(Path::new(&path));
            entries.insert(
                path,
                WatchEntry {
                    trigger_tx,
                    task,
                    repo_root,
                },
            );
            started += 1;
        }
        if entries.len() != before || started > 0 || respawned > 0 {
            info!(
                subscribed = entries.len(),
                started, respawned, "github_pr: reconciled subscriptions",
            );
        }
    }

    /// Debounced refresh nudge for one path. No-op when the path isn't
    /// subscribed — there is no chip to update.
    pub fn trigger(&self, path: &str) {
        let Ok(entries) = self.inner.entries.lock() else {
            return;
        };
        if let Some(entry) = entries.get(path) {
            let _ = entry.trigger_tx.send(());
        }
    }

    /// Nudge every subscribed path belonging to `repo_root` — the remote-ref
    /// pulse from the git watcher after a push. Entries whose own root is
    /// unknown always fire; a spurious debounced recompute is cheaper than a
    /// chip that never updates.
    pub fn trigger_project(&self, repo_root: Option<&Path>) {
        let Ok(entries) = self.inner.entries.lock() else {
            return;
        };
        for entry in entries.values() {
            let mine = match (repo_root, entry.repo_root.as_deref()) {
                (Some(want), Some(have)) => want == have,
                _ => true,
            };
            if mine {
                let _ = entry.trigger_tx.send(());
            }
        }
    }

    /// Record main-window focus. Gaining it triggers a catch-up across every
    /// subscribed path; losing it pauses the ticks.
    pub fn set_focused(&self, focused: bool) {
        self.inner.focused.store(focused, Ordering::Relaxed);
        if focused {
            self.trigger_project(None);
        }
    }
}

/// How long to wait before the next recompute, from the state we just cached.
pub(super) fn tick_for(available: bool, pr: Option<&PullRequest>) -> Duration {
    match pr {
        _ if !available => TICK_IDLE,
        Some(pr) if pr.rollup == CheckBucket::Pending => TICK_HOT,
        Some(_) => TICK_SETTLED,
        None => TICK_IDLE,
    }
}

/// The notification-worthy edges between two consecutive PR snapshots. Several
/// can cross at once (a green run plus an approval arriving in the same tick),
/// so this returns all of them.
pub(super) fn transitions(prev: &PullRequest, next: &PullRequest) -> Vec<PrTransitionKind> {
    use CheckBucket::{Fail, Pass, Pending};
    let mut kinds = Vec::new();
    if prev.rollup == Pending && next.rollup == Pass {
        kinds.push(PrTransitionKind::ChecksPassed);
    }
    if prev.rollup != Fail && next.rollup == Fail {
        kinds.push(PrTransitionKind::ChecksFailed);
    }
    let was = prev.review_decision.as_deref().unwrap_or_default();
    let now = next.review_decision.as_deref().unwrap_or_default();
    if was != "APPROVED" && now == "APPROVED" {
        kinds.push(PrTransitionKind::ReviewApproved);
    }
    if was != "CHANGES_REQUESTED" && now == "CHANGES_REQUESTED" {
        kinds.push(PrTransitionKind::ChangesRequested);
    }
    if prev.state == "OPEN" && next.state == "MERGED" {
        kinds.push(PrTransitionKind::Merged);
    }
    kinds
}

/// One `gh pr view` for the branch checked out at `path`. `Ok((false, None))`
/// means the path has no GitHub remote raum may talk to; `Ok((true, None))`
/// means the branch simply has no pull request.
///
/// `remote` caches the answer to "is this path even a GitHub repo", which
/// costs a `git remote get-url`. Once resolved it never changes for the life
/// of the task; an unresolved path re-checks on its (5-minute) tick, so a repo
/// that gains an `origin` — or a user who runs `gh auth login` — is picked up
/// without a restart.
async fn compute(
    path: &str,
    remote: &mut Option<gh::Remote>,
) -> Result<(bool, Option<PullRequest>), String> {
    if remote.is_none() {
        *remote = gh::resolve(path).await;
    }
    if remote.is_none() {
        return Ok((false, None));
    }
    let raw: Option<RawPr> =
        gh::json(Path::new(path), &["pr", "view", "--json", PR_VIEW_FIELDS]).await?;
    Ok((true, raw.map(RawPr::into_pull_request)))
}

/// Per-path poll loop. Seed compute on spawn (always emitted), then recompute
/// on debounced triggers or the adaptive tick, emitting only on change.
fn spawn_poll_task(
    inner: Arc<ServiceInner>,
    path: String,
    mut trigger_rx: mpsc::UnboundedReceiver<()>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut cached: Option<(bool, Option<PullRequest>)> = None;
        let mut remote: Option<gh::Remote> = None;
        let mut tick = recompute_and_emit(&inner, &path, &mut cached, &mut remote).await;

        loop {
            tokio::select! {
                maybe = trigger_rx.recv() => {
                    if maybe.is_none() { return }
                }
                () = tokio::time::sleep(tick) => {
                    // Backgrounded app: spawn nothing. The focus-gain trigger
                    // catches up the moment the chip is visible again.
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
                        if maybe.is_none() { return }
                    }
                    () = tokio::time::sleep_until(deadline) => break,
                }
            }
            tick = recompute_and_emit(&inner, &path, &mut cached, &mut remote).await;
        }
    })
}

/// Recompute, emit on diff, emit any transition edges, and return the tick to
/// wait before the next one.
async fn recompute_and_emit(
    inner: &Arc<ServiceInner>,
    path: &str,
    cached: &mut Option<(bool, Option<PullRequest>)>,
    remote: &mut Option<gh::Remote>,
) -> Duration {
    let fresh = match compute(path, remote).await {
        Ok(fresh) => fresh,
        Err(e) => {
            warn!(path = %path, error = %e, "github_pr: refresh failed");
            // Nothing emitted yet: seed the UI as "no GitHub here" rather than
            // leaving it waiting forever. A later success corrects it.
            if cached.is_none() {
                emit_changed(inner, path, false, None);
                *cached = Some((false, None));
            }
            return TICK_ERROR;
        }
    };
    let (available, pr) = fresh;

    // First compute always emits (seeds the UI); afterwards only diffs do.
    let changed = cached.as_ref() != Some(&(available, pr.clone()));
    if changed {
        debug!(path = %path, available, has_pr = pr.is_some(), "github_pr: changed");
        emit_changed(inner, path, available, pr.clone());
    }
    if let (Some((_, Some(prev))), Some(next)) = (cached.as_ref(), pr.as_ref()) {
        for kind in transitions(prev, next) {
            let payload = PrTransitionPayload {
                path: path.to_string(),
                kind,
                pr: next.clone(),
            };
            if let Err(e) = inner.app.emit("github-pr-transition", payload) {
                warn!(path = %path, error = %e, "github-pr-transition emit failed");
            }
        }
    }
    let tick = tick_for(available, pr.as_ref());
    *cached = Some((available, pr));
    tick
}

fn emit_changed(inner: &Arc<ServiceInner>, path: &str, available: bool, pr: Option<PullRequest>) {
    let payload = PrChangedPayload {
        path: path.to_string(),
        pr,
        available,
    };
    if let Err(e) = inner.app.emit("github-pr-changed", payload) {
        warn!(path = %path, error = %e, "github-pr-changed emit failed");
    }
}

/// Fetch the service handle off managed state without holding the guard.
pub(crate) fn service_handle(state: &AppHandleState) -> Option<GithubPrService> {
    state.github_pr.lock().ok().and_then(|guard| guard.clone())
}

/// Declarative subscription endpoint — see
/// [`GithubPrService::set_subscriptions`].
#[tauri::command]
pub fn github_pr_subscribe(
    state: tauri::State<'_, AppHandleState>,
    paths: Vec<String>,
) -> Result<(), String> {
    if let Some(svc) = service_handle(&state) {
        svc.set_subscriptions(paths);
    }
    Ok(())
}

/// Manual refresh for one path (the refresh button, post-merge nudges).
#[tauri::command]
pub fn github_pr_refresh(
    state: tauri::State<'_, AppHandleState>,
    path: String,
) -> Result<(), String> {
    if let Some(svc) = service_handle(&state) {
        svc.trigger(&path);
    }
    Ok(())
}
