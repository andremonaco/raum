//! Startup rehydration: on app launch, re-register state machines and
//! terminal-registry ghosts for every tmux session that survived the
//! previous run.
//!
//! The problem this solves: `AgentRegistry::machines` and
//! `TerminalRegistry::entries` live in memory and start empty on every
//! launch. Without this module they only get populated lazily when
//! `TerminalPane` mounts and fires `terminal_reattach` — so the top-row
//! counters show `0 / 0 / 0` for the window between webview paint and
//! the first reattach, and sessions not bound to an `active-layout.toml`
//! cell stay permanently invisible. Hook events arriving for missing
//! machines fall back to a broadcast-by-harness path that no-ops when
//! nothing is registered.
//!
//! The design splits cleanly into two halves:
//!
//! - `rehydrate_plan(tracked, live_ids)` — pure; classifies each tracked
//!   session into `Register` (still alive in tmux) or `Forget` (tracked
//!   row referring to a dead tmux id). Trivial to unit-test.
//! - `apply_rehydrate_plan(app, state, plan)` — effectful; walks the
//!   plan and drives `register_harness_session_runtime_opts`,
//!   `TerminalRegistry::upsert_ghost`, and the matching Tauri events.
//!
//! Ordering: this module does NOT call `tmux.reap_stale(...)` — the
//! `bootstrap_rehydrate_sessions` bootstrap in `lib.rs` runs reap first
//! so dead sessions disappear from `live_ids` before the plan is built.

use std::collections::HashSet;
use std::path::PathBuf;

use raum_core::agent::{AgentKind, AgentState, SessionId};
use raum_core::agent_state::AgentStateChanged;
use raum_core::config::TrackedSession;
use raum_core::harness::{Reliability, harness_launch_command};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tracing::{info, warn};

use crate::commands::agent::{
    RegisterOptions, infer_reattach_hook_fallback, register_harness_session_runtime_opts,
    resolve_project_dir,
};
use crate::commands::terminal::{
    GhostEntry, TerminalListItem, emit_terminal_session_upserted, reserve_localhost_port,
};
use crate::state::AppHandleState;

/// Tauri event payload summarising the rehydrate pass — emitted once
/// after `apply_rehydrate_plan` returns so the frontend can show a
/// quiet "Recovered N harness panes" toast.
const REHYDRATE_SUMMARY_EVENT: &str = "rehydrate:summary";

#[derive(Debug, Default, Clone, Serialize)]
pub struct RehydrateSummary {
    pub revived: usize,
    pub alive: usize,
    pub dead: usize,
    pub forgotten: usize,
}

/// One classified tracked session. The planner produces these; the
/// applier consumes them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RehydrateJob {
    /// The tracked row refers to a tmux session that no longer exists.
    /// Drop it from `sessions.toml`.
    Forget { session_id: String },
    /// The tracked row refers to a live tmux session. Re-register a
    /// state machine seeded with `last_state`, and insert a
    /// terminal-registry ghost so `terminal_list` returns it before
    /// any `TerminalPane` mounts.
    Register {
        session_id: String,
        harness: AgentKind,
        project_slug: Option<String>,
        worktree_id: Option<String>,
        opencode_port: Option<u16>,
        last_state: Option<AgentState>,
        created_at_unix_ms: u64,
    },
}

/// Summary of `apply_rehydrate_plan`. Logged at INFO on the bootstrap
/// task so the diagnostic surface matches what the user expects.
#[derive(Debug, Default, Clone)]
pub struct RehydrateReport {
    pub rehydrated: Vec<String>,
    pub forgotten: Vec<String>,
    pub errors: Vec<(String, String)>,
    /// Sessions whose tmux pane was dead and which raum successfully
    /// respawned in place via `tmux respawn-pane`.
    pub revived: Vec<String>,
    /// Sessions whose tmux pane was dead and which raum could NOT
    /// auto-revive — Shell sessions (no harness command), respawn
    /// failures, or harnesses with no derivable launch command. The
    /// frontend renders these with the Recover overlay.
    pub dead_skipped: Vec<String>,
}

impl RehydrateReport {
    #[must_use]
    pub fn count_rehydrated(&self) -> usize {
        self.rehydrated.len()
    }
    #[must_use]
    pub fn count_forgotten(&self) -> usize {
        self.forgotten.len()
    }
    #[must_use]
    pub fn count_errors(&self) -> usize {
        self.errors.len()
    }
    #[must_use]
    pub fn count_revived(&self) -> usize {
        self.revived.len()
    }
    #[must_use]
    pub fn count_dead_skipped(&self) -> usize {
        self.dead_skipped.len()
    }
    #[must_use]
    pub fn summary(&self) -> RehydrateSummary {
        // Live = rehydrated minus revived (revived sessions also land
        // in `rehydrated` because the register-job path runs after a
        // successful respawn).
        let alive = self.rehydrated.len().saturating_sub(self.revived.len());
        RehydrateSummary {
            revived: self.revived.len(),
            alive,
            dead: self.dead_skipped.len(),
            forgotten: self.forgotten.len(),
        }
    }
}

/// Pure classifier. For every tracked row: if the tmux session is alive
/// (id is in `live_ids`), emit a `Register`; otherwise, emit a
/// `Forget`. `Shell` sessions get a `Register` with `last_state == None`
/// — the applier uses the kind to skip state-machine registration for
/// shells while still inserting a ghost so `terminal_list` returns them
/// (shells don't contribute to the counters because
/// `isProjectScopedHarnessTerminal` filters them out, but the user
/// still sees them in the tab row).
///
/// Duplicate tracked rows for the same session id are tolerated — we
/// only emit a job for the first occurrence.
#[must_use]
pub fn rehydrate_plan(tracked: &[TrackedSession], live_ids: &HashSet<String>) -> Vec<RehydrateJob> {
    let mut out = Vec::with_capacity(tracked.len());
    let mut seen: HashSet<&str> = HashSet::new();
    for row in tracked {
        if !seen.insert(row.session_id.as_str()) {
            continue;
        }
        if live_ids.contains(row.session_id.as_str()) {
            out.push(RehydrateJob::Register {
                session_id: row.session_id.clone(),
                harness: row.kind,
                project_slug: row.project_slug.clone(),
                worktree_id: row.worktree_id.clone(),
                opencode_port: row.opencode_port,
                last_state: row.last_state,
                created_at_unix_ms: row.created_at_unix_ms,
            });
        } else {
            out.push(RehydrateJob::Forget {
                session_id: row.session_id.clone(),
            });
        }
    }
    out
}

/// Run every job in `plan`. Best-effort: per-session errors are
/// collected into the report but don't abort the rest of the
/// rehydrate.
///
/// Must be called from an async context with `state` reachable via
/// the Tauri `AppHandle`. Expected to run inside the spawned task in
/// `bootstrap_rehydrate_sessions`.
pub fn apply_rehydrate_plan<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppHandleState,
    plan: Vec<RehydrateJob>,
) -> RehydrateReport {
    let mut report = RehydrateReport::default();
    for job in plan {
        match job {
            RehydrateJob::Forget { session_id } => match state.config_store.lock() {
                Ok(store) => {
                    if let Err(e) = store.forget_session(&session_id) {
                        warn!(error=%e, session_id=%session_id, "rehydrate: forget_session failed");
                        report.errors.push((session_id.clone(), e.to_string()));
                    } else {
                        report.forgotten.push(session_id);
                    }
                }
                Err(_) => {
                    report
                        .errors
                        .push((session_id, "config_store lock poisoned".into()));
                }
            },
            RehydrateJob::Register {
                session_id,
                harness,
                project_slug,
                worktree_id,
                opencode_port,
                last_state,
                created_at_unix_ms,
            } => {
                let outcome = apply_register_job(
                    app,
                    state,
                    &session_id,
                    harness,
                    project_slug.as_deref(),
                    worktree_id.as_deref(),
                    opencode_port,
                    last_state,
                    created_at_unix_ms,
                );
                match outcome {
                    Ok(RegisterOutcome::Alive) => {
                        report.rehydrated.push(session_id);
                    }
                    Ok(RegisterOutcome::Revived) => {
                        report.rehydrated.push(session_id.clone());
                        report.revived.push(session_id);
                    }
                    Ok(RegisterOutcome::DeadSkipped) => {
                        report.rehydrated.push(session_id.clone());
                        report.dead_skipped.push(session_id);
                    }
                    Err(e) => {
                        warn!(error=%e, session_id=%session_id, "rehydrate: register failed");
                        report.errors.push((session_id, e));
                    }
                }
            }
        }
    }
    info!(
        rehydrated = report.count_rehydrated(),
        revived = report.count_revived(),
        dead_skipped = report.count_dead_skipped(),
        forgotten = report.count_forgotten(),
        errors = report.count_errors(),
        "rehydrate: plan applied",
    );
    let summary = report.summary();
    if let Err(e) = app.emit(REHYDRATE_SUMMARY_EVENT, &summary) {
        warn!(error=%e, "rehydrate: summary emit failed");
    }
    report
}

/// What `apply_register_job` did with a single live tmux session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RegisterOutcome {
    /// Pane was alive; nothing extra to do beyond the standard
    /// register flow.
    Alive,
    /// Pane was dead and we ran `tmux respawn-pane` to revive it in
    /// place. The state machine seeds with `Idle` instead of the
    /// stale persisted `last_state`.
    Revived,
    /// Pane was dead and could not be auto-revived (Shell session, no
    /// harness command derivable, or respawn failed). The ghost is
    /// inserted with `dead: true` so the frontend renders the Recover
    /// overlay.
    DeadSkipped,
}

#[allow(clippy::too_many_arguments)]
fn apply_register_job<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppHandleState,
    session_id: &str,
    harness: AgentKind,
    project_slug: Option<&str>,
    worktree_id: Option<&str>,
    opencode_port: Option<u16>,
    last_state: Option<AgentState>,
    created_at_unix_ms: u64,
) -> Result<RegisterOutcome, String> {
    let project_dir: PathBuf = resolve_project_dir(state, project_slug, worktree_id);

    // Probe pane health before registering. `remain-on-exit on` keeps
    // dead panes visible on the tmux socket — `list_sessions` happily
    // reports them as live, so without this probe the user gets a
    // sidebar full of zombie panes that show "lost tty" the moment
    // they're clicked. See plan §1 of the recovery work.
    let pane_dead_status: Option<i32> = state.tmux.check_pane_dead(session_id).ok().flatten();
    let mut outcome = RegisterOutcome::Alive;
    let mut effective_opencode_port = opencode_port;
    let mut state_seed = last_state;
    let mut ghost_dead = false;

    if let Some(exit_code) = pane_dead_status {
        info!(
            session_id = %session_id,
            harness = ?harness,
            exit_code,
            "rehydrate: detected dead pane; attempting revival",
        );
        if matches!(harness, AgentKind::Shell) {
            // No harness command for shells — leave the dead pane in
            // place and let the frontend offer Close.
            outcome = RegisterOutcome::DeadSkipped;
            ghost_dead = true;
        } else {
            // Reconstruct the harness command from the persisted state.
            let extra_flags = read_extra_flags(state, harness);
            // OpenCode wants a port. Prefer the persisted one (it was
            // probably released when the harness died); only reserve
            // a fresh ephemeral port if the persisted value is gone.
            let port_for_revival = if matches!(harness, AgentKind::OpenCode) {
                opencode_port.or_else(|| match reserve_localhost_port() {
                    Ok(p) => Some(p),
                    Err(e) => {
                        warn!(error=%e, session_id=%session_id, "rehydrate: port reserve failed");
                        None
                    }
                })
            } else {
                None
            };
            if matches!(harness, AgentKind::OpenCode) {
                effective_opencode_port = port_for_revival;
            }
            let cmd = harness_launch_command(harness, extra_flags.as_deref(), port_for_revival);
            match cmd {
                Some(cmd) => match state.tmux.respawn_with(session_id, &cmd) {
                    Ok(()) => {
                        info!(
                            session_id = %session_id,
                            harness = ?harness,
                            "rehydrate: revived dead pane via respawn",
                        );
                        // Fresh process — discard the stale persisted
                        // state. The new harness starts at Idle.
                        state_seed = None;
                        outcome = RegisterOutcome::Revived;
                    }
                    Err(e) => {
                        warn!(error=%e, session_id=%session_id, "rehydrate: respawn failed");
                        outcome = RegisterOutcome::DeadSkipped;
                        ghost_dead = true;
                    }
                },
                None => {
                    warn!(
                        session_id = %session_id,
                        harness = ?harness,
                        "rehydrate: no launch command derivable for dead pane",
                    );
                    outcome = RegisterOutcome::DeadSkipped;
                    ghost_dead = true;
                }
            }
        }
    }

    // Skip state-machine + channel registration for shell sessions —
    // they have no harness, and the counters explicitly exclude them.
    // We still want a ghost so the tab row can show them if the
    // frontend ever decides to. Currently no frontend surface consumes
    // shell ghosts, but inserting one is cheap.
    //
    // Skip it too for harnesses we couldn't auto-revive — there's no
    // live process to bind state to. The frontend will route the user
    // through `terminal_respawn_dead`, which re-runs the standard
    // register path on success.
    if !matches!(harness, AgentKind::Shell) && outcome != RegisterOutcome::DeadSkipped {
        let hook_fallback =
            infer_reattach_hook_fallback(state, harness, project_slug, project_dir.clone());
        register_harness_session_runtime_opts(
            app,
            state,
            harness,
            session_id,
            project_slug,
            worktree_id,
            project_dir,
            hook_fallback,
            RegisterOptions {
                opencode_port: effective_opencode_port,
                ..RegisterOptions::default()
            },
        )?;
    }

    // Insert the identity-only ghost so `terminal_list` returns this
    // session before any `TerminalPane` mounts. `created_unix` is
    // stored in seconds in `TerminalListItem` but persisted in
    // milliseconds in `TrackedSession`, so divide.
    let created_unix = created_at_unix_ms / 1000;
    if let Ok(mut reg) = state.terminals.lock() {
        let inserted = reg.upsert_ghost(GhostEntry {
            session_id: session_id.to_string(),
            project_slug: project_slug.map(str::to_string),
            worktree_id: worktree_id.map(str::to_string),
            kind: harness,
            created_unix,
            dead: ghost_dead,
        });
        drop(reg);
        if inserted {
            let item = TerminalListItem {
                session_id: session_id.to_string(),
                project_slug: project_slug.map(str::to_string),
                worktree_id: worktree_id.map(str::to_string),
                kind: harness,
                created_unix,
                dead: ghost_dead,
            };
            emit_terminal_session_upserted(app, &item);
        }
    } else {
        return Err("terminals lock poisoned".to_string());
    }

    // The `register_harness_session_runtime_opts` path emits a synthetic
    // `agent-state-changed` when the persisted seed is non-`Idle`. That's
    // enough for the agentStore; we don't duplicate here. For `Shell`
    // (which skips state-machine registration), there's no state to
    // broadcast either.
    //
    // Defensive: if the caller re-registers a session for which a
    // machine was already present (e.g. second call in a test), we
    // didn't emit the seed above. Explicitly emit once here for
    // non-Idle seeds so the frontend's listener wakes up.
    //
    // Skip the seed entirely when we just revived the pane — the
    // persisted state belonged to the dead process; the fresh harness
    // is at Idle.
    if let Some(seed) = state_seed
        && seed != AgentState::Idle
        && !matches!(harness, AgentKind::Shell)
        && outcome != RegisterOutcome::DeadSkipped
    {
        let change = AgentStateChanged {
            session_id: SessionId::new(session_id.to_string()),
            harness,
            from: AgentState::Idle,
            to: seed,
            reliability: Reliability::Deterministic,
        };
        if let Err(e) = app.emit("agent-state-changed", &change) {
            warn!(error=%e, session_id=%session_id, "rehydrate: agent-state-changed emit failed");
        }
    }

    Ok(outcome)
}

/// Pull the per-harness `extra_flags` from the user's config so the
/// revival path renders the same launch command the user gets when
/// spawning a fresh session.
fn read_extra_flags(state: &AppHandleState, harness: AgentKind) -> Option<String> {
    let store = state.config_store.lock().ok()?;
    store
        .read_config()
        .ok()
        .and_then(|cfg| match harness {
            AgentKind::ClaudeCode => cfg.harnesses.claude_code.extra_flags,
            AgentKind::Codex => cfg.harnesses.codex.extra_flags,
            AgentKind::OpenCode => cfg.harnesses.opencode.extra_flags,
            AgentKind::Shell => None,
        })
        .filter(|s| !s.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use raum_core::config::TrackedSession;

    fn tracked(
        id: &str,
        kind: AgentKind,
        project_slug: Option<&str>,
        worktree_id: Option<&str>,
        last_state: Option<AgentState>,
    ) -> TrackedSession {
        TrackedSession {
            session_id: id.to_string(),
            project_slug: project_slug.map(str::to_string),
            worktree_id: worktree_id.map(str::to_string),
            opencode_port: None,
            kind,
            created_at_unix_ms: 1_000,
            last_state,
            last_state_at_unix_ms: last_state.map(|_| 2_000),
            last_prompt_text: None,
            last_prompt_at_unix_ms: None,
        }
    }

    fn live(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn rehydrate_plan_classifies_live_tracked_sessions_for_registration() {
        let tracked_rows = vec![
            tracked(
                "raum-a",
                AgentKind::ClaudeCode,
                Some("acme"),
                Some("wt-main"),
                Some(AgentState::Working),
            ),
            tracked(
                "raum-b",
                AgentKind::Codex,
                Some("acme"),
                None,
                Some(AgentState::Waiting),
            ),
        ];
        let live_ids = live(&["raum-a", "raum-b"]);
        let plan = rehydrate_plan(&tracked_rows, &live_ids);
        assert_eq!(plan.len(), 2);
        assert!(matches!(
            &plan[0],
            RehydrateJob::Register {
                session_id,
                harness: AgentKind::ClaudeCode,
                last_state: Some(AgentState::Working),
                ..
            } if session_id == "raum-a"
        ));
        assert!(matches!(
            &plan[1],
            RehydrateJob::Register {
                session_id,
                harness: AgentKind::Codex,
                last_state: Some(AgentState::Waiting),
                ..
            } if session_id == "raum-b"
        ));
    }

    #[test]
    fn rehydrate_plan_marks_tracked_sessions_not_in_tmux_for_forget() {
        let tracked_rows = vec![
            tracked("raum-alive", AgentKind::OpenCode, Some("acme"), None, None),
            tracked("raum-dead", AgentKind::Codex, Some("acme"), None, None),
        ];
        let live_ids = live(&["raum-alive"]);
        let plan = rehydrate_plan(&tracked_rows, &live_ids);
        assert_eq!(plan.len(), 2);
        assert!(matches!(
            &plan[0],
            RehydrateJob::Register { session_id, .. } if session_id == "raum-alive"
        ));
        assert!(matches!(
            &plan[1],
            RehydrateJob::Forget { session_id } if session_id == "raum-dead"
        ));
    }

    #[test]
    fn rehydrate_plan_dedupes_duplicate_session_ids() {
        let tracked_rows = vec![
            tracked("raum-a", AgentKind::ClaudeCode, Some("acme"), None, None),
            // Should never happen in practice, but be defensive.
            tracked(
                "raum-a",
                AgentKind::Codex,
                Some("other"),
                None,
                Some(AgentState::Working),
            ),
        ];
        let live_ids = live(&["raum-a"]);
        let plan = rehydrate_plan(&tracked_rows, &live_ids);
        assert_eq!(plan.len(), 1, "duplicate rows collapse to one job");
    }

    #[test]
    fn rehydrate_plan_on_empty_tracked_returns_empty() {
        let plan = rehydrate_plan(&[], &live(&["raum-orphan"]));
        assert!(plan.is_empty());
    }

    #[test]
    fn rehydrate_plan_on_empty_live_ids_forgets_everything() {
        let tracked_rows = vec![
            tracked("raum-a", AgentKind::ClaudeCode, None, None, None),
            tracked("raum-b", AgentKind::Shell, None, None, None),
        ];
        let plan = rehydrate_plan(&tracked_rows, &HashSet::new());
        assert_eq!(plan.len(), 2);
        assert!(
            plan.iter()
                .all(|j| matches!(j, RehydrateJob::Forget { .. }))
        );
    }
}
