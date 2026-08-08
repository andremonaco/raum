//! Boot / focus / reload reconciliation: make the live `-L raum` tmux socket
//! and raum's tracked-session set agree by ADOPTING every live session raum
//! has no record of.
//!
//! The invariant this enforces: **the set of live tmux sessions on the socket
//! is always exactly the set of sessions the user can see and close.** Before
//! this module, `rehydrate_plan` only ever walked `sessions.toml` rows — a
//! session that was alive on the socket but missing from `sessions.toml` (a
//! spawn that crashed before its tracking write, a row forgotten while the
//! pane was transiently unlisted, leftovers from an older build) was invisible
//! to the frontend AND, depending on the protected set, either an unkillable
//! fd leak or silently age-reaped out from under recoverable work.
//!
//! Reconciliation closes that gap from the other direction: list the socket,
//! and for every live session NOT already known (registry ∪ `sessions.toml`)
//! whose id matches the raum grammar, write a tracked row and insert a live
//! ghost so `terminal_list` returns it. The frontend renders any tracked
//! session that isn't placed in its grid as an orphan in the dock tray, so the
//! user can place or close it. Adopted sessions are tracked authority from
//! then on, so the next boot rehydrates them normally.

use std::collections::HashSet;

use raum_core::AgentKind;
use raum_core::store::TrackedSessionUpsert;
use raum_tmux::TmuxSession;
use tauri::{AppHandle, Runtime};
use tracing::{info, warn};

use super::kill::protected_session_ids;
use crate::commands::terminal::{GhostEntry, TerminalListItem, emit_terminal_session_upserted};
use crate::state::AppHandleState;

/// Parse the `AgentKind` out of a raum session id of the form
/// `raum-<binary>-<unix_ms>-<pid>` (see `helpers::generate_session_id`).
/// Returns `None` for ids that don't match the grammar — foreign tmux
/// sessions we must never adopt or surface as raum panes.
#[must_use]
pub(crate) fn kind_from_session_id(session_id: &str) -> Option<AgentKind> {
    let rest = session_id.strip_prefix("raum-")?;
    match rest.split('-').next()? {
        "claude" => Some(AgentKind::ClaudeCode),
        "codex" => Some(AgentKind::Codex),
        "opencode" => Some(AgentKind::OpenCode),
        "sh" => Some(AgentKind::Shell),
        _ => None,
    }
}

/// One live tmux session raum has no record of — to be adopted so it becomes a
/// visible, closable pane instead of an invisible fd leak.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AdoptJob {
    pub session_id: String,
    pub kind: AgentKind,
    /// tmux `session_created`, seconds since epoch.
    pub created_unix: u64,
}

/// Pure classifier: every live session whose id is NOT already known
/// (registry ∪ `sessions.toml`) and which matches the raum grammar becomes an
/// adopt job. Foreign or already-tracked sessions are skipped.
#[must_use]
pub(crate) fn adopt_plan(live: &[TmuxSession], known: &HashSet<String>) -> Vec<AdoptJob> {
    live.iter()
        .filter(|s| !known.contains(&s.id))
        .filter_map(|s| {
            kind_from_session_id(&s.id).map(|kind| AdoptJob {
                session_id: s.id.clone(),
                kind,
                created_unix: s.created_unix,
            })
        })
        .collect()
}

/// Reconcile the live tmux socket against raum's records: adopt every live
/// `-L raum` session with no registry / `sessions.toml` record so it surfaces
/// as a closable orphan pane. Returns the adopted session ids. Invoked after
/// boot rehydrate, on window focus, and from the frontend after a Cmd+R
/// reload (which does not re-run the Rust bootstrap).
#[tauri::command]
pub async fn terminal_reconcile<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
) -> Result<Vec<String>, String> {
    reconcile_inner(&app, &state).await
}

/// Shared body for [`terminal_reconcile`], reusable from the boot/focus
/// bootstraps in `lib.rs` without an IPC round-trip.
pub(crate) async fn reconcile_inner<R: Runtime>(
    app: &AppHandle<R>,
    state: &tauri::State<'_, AppHandleState>,
) -> Result<Vec<String>, String> {
    let tmux = state.tmux.clone();
    let live = tokio::task::spawn_blocking(move || tmux.list_sessions())
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
        .map_err(|e| format!("tmux list-sessions: {e}"))?;

    // `known` = registry ghosts/entries ∪ every `sessions.toml` row.
    let known = protected_session_ids(state)?;
    let plan = adopt_plan(&live, &known);
    if plan.is_empty() {
        return Ok(Vec::new());
    }

    // 1. Persist a tracked row per orphan so each session is authority going
    //    forward: the reaper protects it, and the next boot rehydrates it
    //    normally. Metadata (project/worktree) is unknown for an orphan — by
    //    definition it had no surviving `sessions.toml` row — so `None`. One
    //    batched write; per-job writes rewrote the whole file N times.
    if let Ok(store) = state.config_store.lock() {
        let rows: Vec<TrackedSessionUpsert<'_>> = plan
            .iter()
            .map(|job| TrackedSessionUpsert {
                session_id: &job.session_id,
                harness: job.kind,
                project_slug: None,
                worktree_id: None,
                opencode_port: None,
                created_at_unix_ms: job.created_unix.saturating_mul(1000),
            })
            .collect();
        if let Err(e) = store.upsert_tracked_sessions(&rows) {
            warn!(error=%e, count = rows.len(), "reconcile: upsert_tracked_sessions failed");
        }
    } else {
        warn!("reconcile: config_store lock poisoned; skipping track");
    }

    let mut adopted = Vec::new();
    for job in plan {
        // 2. Probe pane health before adopting. `remain-on-exit on`
        //    (manager.rs) keeps a pane whose process has exited on the socket
        //    as a zombie, and `list_sessions` reports it as live — exactly why
        //    the rehydrate REGISTER path probes `check_pane_dead` too. Without
        //    this probe a dead-but-listed pane is adopted as `dead: false`,
        //    the dock shows it as a placeable orphan, and clicking it attaches
        //    a fresh bridge to a corpse: a blank pane with no Recover overlay
        //    (the overlay only renders for `dead: true` ghosts). Mark it
        //    `dead: true` so the frontend routes through the Recover/Close
        //    overlay instead. We do NOT set `recoverable_after_reboot` — an
        //    adopted orphan has no surviving tracked metadata to resume
        //    against, so the manual Recover affordance is the right surface.
        let dead = state
            .tmux
            .check_pane_dead(&job.session_id)
            .ok()
            .flatten()
            .is_some();

        // 3. Insert the ghost and tell the frontend, so the session shows up
        //    in `terminal_list` (and thus the orphan tray) before any pane
        //    mounts. A live pane (`dead: false`) mounts a normal reattach; a
        //    dead one surfaces the Recover/Close overlay.
        let inserted = state.terminals.lock().is_ok_and(|mut reg| {
            reg.upsert_ghost(GhostEntry {
                session_id: job.session_id.clone(),
                project_slug: None,
                worktree_id: None,
                kind: job.kind,
                created_unix: job.created_unix,
                dead,
                recoverable_after_reboot: false,
            })
        });
        if inserted {
            emit_terminal_session_upserted(
                app,
                &TerminalListItem {
                    session_id: job.session_id.clone(),
                    project_slug: None,
                    worktree_id: None,
                    kind: job.kind,
                    created_unix: job.created_unix,
                    dead,
                    recoverable_after_reboot: false,
                },
            );
        }
        adopted.push(job.session_id);
    }
    info!(count = adopted.len(), ids = ?adopted, "reconcile: adopted orphan tmux sessions");
    Ok(adopted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sess(id: &str, created_unix: u64) -> TmuxSession {
        TmuxSession {
            id: id.to_string(),
            created_unix,
            width: 80,
            height: 24,
        }
    }

    fn known(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn kind_from_session_id_maps_every_binary() {
        assert_eq!(
            kind_from_session_id("raum-claude-1700000000000-42"),
            Some(AgentKind::ClaudeCode)
        );
        assert_eq!(
            kind_from_session_id("raum-codex-1700000000000-42"),
            Some(AgentKind::Codex)
        );
        assert_eq!(
            kind_from_session_id("raum-opencode-1700000000000-42"),
            Some(AgentKind::OpenCode)
        );
        assert_eq!(
            kind_from_session_id("raum-sh-1700000000000-42"),
            Some(AgentKind::Shell)
        );
    }

    #[test]
    fn kind_from_session_id_rejects_foreign_ids() {
        assert_eq!(kind_from_session_id("scratch"), None);
        assert_eq!(kind_from_session_id("raum-"), None);
        assert_eq!(kind_from_session_id("raum-vim-1-2"), None);
        // A bare `raum-claude` with no trailing segments still classifies —
        // the binary token is all `adopt_plan` needs.
        assert_eq!(
            kind_from_session_id("raum-claude"),
            Some(AgentKind::ClaudeCode)
        );
    }

    #[test]
    fn adopt_plan_adopts_only_live_unknown_raum_sessions() {
        let live = vec![
            sess("raum-claude-1-1", 1_000), // unknown -> adopt
            sess("raum-codex-2-2", 2_000),  // known -> skip
            sess("raum-sh-3-3", 3_000),     // unknown -> adopt
            sess("tmux-foreign", 4_000),    // foreign grammar -> skip
        ];
        let plan = adopt_plan(&live, &known(&["raum-codex-2-2"]));
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].session_id, "raum-claude-1-1");
        assert_eq!(plan[0].kind, AgentKind::ClaudeCode);
        assert_eq!(plan[0].created_unix, 1_000);
        assert_eq!(plan[1].session_id, "raum-sh-3-3");
        assert_eq!(plan[1].kind, AgentKind::Shell);
    }

    #[test]
    fn adopt_plan_is_empty_when_everything_is_known() {
        let live = vec![sess("raum-claude-1-1", 1_000)];
        let plan = adopt_plan(&live, &known(&["raum-claude-1-1"]));
        assert!(plan.is_empty());
    }

    #[test]
    fn adopt_plan_never_adopts_foreign_sessions_even_when_unknown() {
        let live = vec![sess("htop", 1_000), sess("scratch-pad", 2_000)];
        let plan = adopt_plan(&live, &known(&[]));
        assert!(plan.is_empty());
    }
}
