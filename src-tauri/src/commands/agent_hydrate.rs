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
use raum_core::harness::Reliability;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tracing::{info, warn};

use crate::commands::agent::{
    RegisterOptions, infer_reattach_hook_fallback, register_harness_session_runtime_opts,
    resolve_project_dir,
};
use crate::commands::terminal::{GhostEntry, TerminalListItem, emit_terminal_session_upserted};
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
    /// Sessions whose previous tmux server is gone (typically an OS
    /// reboot) but whose tracked row carries enough state for the
    /// frontend to invoke the harness's native `--resume` on first
    /// pane open. The frontend uses this count for an optional toast.
    pub recoverable_after_reboot: usize,
}

/// One classified tracked session. The planner produces these; the
/// applier consumes them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RehydrateJob {
    /// The tracked row refers to a tmux session that no longer exists
    /// AND the row carries no state from which the harness can resume
    /// (Shell sessions, or non-Shell rows with neither
    /// `harness_session_id` nor `last_prompt_text`). Drop it from
    /// `sessions.toml`.
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
    /// The tracked row refers to a tmux session that is gone (the tmux
    /// server died with the previous OS session, typically a reboot)
    /// BUT the harness exposes a native `--resume` command and the row
    /// carries either a persisted `harness_session_id` or
    /// `last_prompt_text` we can replay against the on-disk transcript.
    /// The applier inserts a `dead + recoverable_after_reboot` ghost
    /// and leaves the tracked row in place; the frontend auto-fires
    /// `terminal_respawn_dead` on first pane mount.
    Recover {
        session_id: String,
        harness: AgentKind,
        project_slug: Option<String>,
        worktree_id: Option<String>,
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
    /// Sessions whose previous tmux server is gone (typically an OS
    /// reboot) but whose tracked row carries enough state for the
    /// harness's native `--resume` to rebuild the conversation. Each
    /// of these had a ghost inserted with
    /// `recoverable_after_reboot: true`; the row was NOT forgotten.
    pub recoverable_after_reboot: Vec<String>,
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
    pub fn count_recoverable_after_reboot(&self) -> usize {
        self.recoverable_after_reboot.len()
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
            recoverable_after_reboot: self.recoverable_after_reboot.len(),
        }
    }
}

/// Pure classifier. Tristate decision per tracked row:
///
/// - `Register` — `session_id` is in `live_ids`; the tmux server
///   survived the previous run.
/// - `Recover` — `session_id` is NOT in `live_ids` (tmux server died
///   between runs, typically OS reboot), the kind is non-`Shell`, and
///   the row carries either `harness_session_id` or `last_prompt_text`
///   so the harness's native `--resume` can rebuild the conversation.
/// - `Forget` — everything else: shell sessions whose tmux is gone,
///   non-shell rows with neither resume id nor last prompt persisted
///   (no recovery surface), or duplicate ids.
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
        } else if !matches!(row.kind, AgentKind::Shell)
            && (row.harness_session_id.is_some() || row.last_prompt_text.is_some())
        {
            out.push(RehydrateJob::Recover {
                session_id: row.session_id.clone(),
                harness: row.kind,
                project_slug: row.project_slug.clone(),
                worktree_id: row.worktree_id.clone(),
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
            RehydrateJob::Recover {
                session_id,
                harness,
                project_slug,
                worktree_id,
                created_at_unix_ms,
            } => match apply_recover_job(
                app,
                state,
                &session_id,
                harness,
                project_slug.as_deref(),
                worktree_id.as_deref(),
                created_at_unix_ms,
            ) {
                Ok(()) => {
                    report.recoverable_after_reboot.push(session_id);
                }
                Err(e) => {
                    warn!(error=%e, session_id=%session_id, "rehydrate: recover-after-reboot failed");
                    report.errors.push((session_id, e));
                }
            },
        }
    }
    info!(
        rehydrated = report.count_rehydrated(),
        revived = report.count_revived(),
        dead_skipped = report.count_dead_skipped(),
        forgotten = report.count_forgotten(),
        recoverable_after_reboot = report.count_recoverable_after_reboot(),
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
    let effective_opencode_port = opencode_port;
    let state_seed = last_state;
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
            // Do not respawn here: this bootstrap has no frontend PTY
            // channel, so any harness resume output would be lost before
            // xterm can capture it. Leave the dead ghost for
            // `terminal_respawn_dead`, which attaches first and then runs
            // the resume command.
            outcome = RegisterOutcome::DeadSkipped;
            ghost_dead = true;
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
            recoverable_after_reboot: false,
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
                recoverable_after_reboot: false,
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

/// Applier for `RehydrateJob::Recover`. The previous tmux server is
/// gone so there is no pane to probe and no state machine to bind —
/// we just insert a `dead + recoverable_after_reboot` ghost into
/// `TerminalRegistry` so `terminal_list` returns the row before any
/// pane mounts.
///
/// Crucially, this path does **not** call `store.forget_session(...)`.
/// The tracked row stays intact in `state/sessions.toml` so its
/// `harness_session_id`, `last_prompt_text`, and `opencode_port`
/// fields survive into the eventual `terminal_respawn_dead` call —
/// without them, the frontend's auto-fire-on-mount would have nothing
/// to resume against.
///
/// It also deliberately keeps the persisted **disk scrollback snapshot**
/// (`raum_core::snapshot_store`) for this session id: the boot GC keep-set
/// preserves snapshots for every still-tracked id (see Contract 4 in
/// `lib.rs` / `snapshot_store::gc_orphans`), and the Recover path never
/// spawns a pane-death monitor for a placeholder that would delete it. That
/// snapshot is the last-resort fallback the frontend replays when the
/// harness's native `--resume` is impossible (stale/pruned transcript) —
/// without it the user would get a permanently blank pane after a reboot.
fn apply_recover_job<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppHandleState,
    session_id: &str,
    harness: AgentKind,
    project_slug: Option<&str>,
    worktree_id: Option<&str>,
    created_at_unix_ms: u64,
) -> Result<(), String> {
    let created_unix = created_at_unix_ms / 1000;
    let mut reg = state
        .terminals
        .lock()
        .map_err(|_| "terminals lock poisoned".to_string())?;
    let inserted = reg.upsert_ghost(GhostEntry {
        session_id: session_id.to_string(),
        project_slug: project_slug.map(str::to_string),
        worktree_id: worktree_id.map(str::to_string),
        kind: harness,
        created_unix,
        dead: true,
        recoverable_after_reboot: true,
    });
    drop(reg);
    if inserted {
        let item = TerminalListItem {
            session_id: session_id.to_string(),
            project_slug: project_slug.map(str::to_string),
            worktree_id: worktree_id.map(str::to_string),
            kind: harness,
            created_unix,
            dead: true,
            recoverable_after_reboot: true,
        };
        emit_terminal_session_upserted(app, &item);
    }
    info!(
        session_id = %session_id,
        harness = ?harness,
        "rehydrate: marked session recoverable-after-reboot",
    );
    Ok(())
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
            harness_session_id: None,
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
    fn rehydrate_plan_marks_unrecoverable_tracked_sessions_for_forget() {
        // Both rows lack `harness_session_id` and `last_prompt_text`,
        // so the dead non-Shell row has no recovery surface and gets
        // Forget. The alive row is unchanged.
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
    fn rehydrate_plan_marks_dead_non_shell_with_harness_id_for_recover() {
        let mut row = tracked("raum-dead", AgentKind::ClaudeCode, Some("acme"), None, None);
        row.harness_session_id = Some("11111111-2222-3333-4444-555555555555".into());
        let plan = rehydrate_plan(&[row], &HashSet::new());
        assert_eq!(plan.len(), 1);
        assert!(
            matches!(
                &plan[0],
                RehydrateJob::Recover {
                    session_id,
                    harness: AgentKind::ClaudeCode,
                    ..
                } if session_id == "raum-dead",
            ),
            "row with persisted harness_session_id should be Recover, got {:?}",
            plan[0]
        );
    }

    #[test]
    fn rehydrate_plan_marks_dead_non_shell_with_last_prompt_for_recover() {
        // No harness_session_id, but last_prompt_text is enough — the
        // resolve_resume_target fallback walks the transcript dir to
        // discover the id from the prompt.
        let mut row = tracked("raum-dead", AgentKind::Codex, Some("acme"), None, None);
        row.last_prompt_text = Some("review this PR".into());
        let plan = rehydrate_plan(&[row], &HashSet::new());
        assert_eq!(plan.len(), 1);
        assert!(matches!(
            &plan[0],
            RehydrateJob::Recover { session_id, .. } if session_id == "raum-dead"
        ));
    }

    #[test]
    fn rehydrate_plan_forgets_dead_shell_even_with_persisted_state() {
        // Shells have no `--resume`. A Shell row is always Forget when
        // its tmux session is gone, even if last_prompt_text is set
        // (which can't happen in practice, but be defensive).
        let mut row = tracked("raum-dead-shell", AgentKind::Shell, None, None, None);
        row.last_prompt_text = Some("ignored".into());
        let plan = rehydrate_plan(&[row], &HashSet::new());
        assert_eq!(plan.len(), 1);
        assert!(matches!(&plan[0], RehydrateJob::Forget { .. }));
    }

    #[test]
    fn rehydrate_plan_registers_live_shell_sessions() {
        // Shell sessions are tracked in `sessions.toml` (see
        // `terminal_spawn`) so the orphan/stale reapers leave them alone
        // across app restarts. A live shell row must come back as
        // Register — the applier inserts an identity-only ghost without
        // any harness runtime — so `kill_orphans_inner` sees it as
        // tracked and the frontend can reattach to the surviving pane.
        let tracked_rows = vec![tracked(
            "raum-shell-1",
            AgentKind::Shell,
            Some("acme"),
            None,
            None,
        )];
        let live_ids = live(&["raum-shell-1"]);
        let plan = rehydrate_plan(&tracked_rows, &live_ids);
        assert_eq!(plan.len(), 1);
        assert!(matches!(
            &plan[0],
            RehydrateJob::Register {
                session_id,
                harness: AgentKind::Shell,
                ..
            } if session_id == "raum-shell-1"
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

    #[test]
    fn rehydrate_plan_recovers_all_three_supported_harnesses_after_reboot() {
        // Simulates the post-OS-reboot state: three rows persisted with
        // harness_session_id but the live tmux socket is empty (server
        // died with the OS). Each non-Shell row should become a Recover
        // job, and none should be Forget'd — preserving the
        // harness_session_id needed by terminal_respawn_dead.
        let mut claude_row = tracked(
            "raum-claude",
            AgentKind::ClaudeCode,
            Some("acme"),
            None,
            None,
        );
        claude_row.harness_session_id = Some("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".into());
        let mut codex_row = tracked("raum-codex", AgentKind::Codex, Some("acme"), None, None);
        codex_row.harness_session_id = Some("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb".into());
        let mut opencode_row = tracked(
            "raum-opencode",
            AgentKind::OpenCode,
            Some("acme"),
            None,
            None,
        );
        opencode_row.harness_session_id = Some("cccccccc-cccc-cccc-cccc-cccccccccccc".into());
        opencode_row.opencode_port = Some(5123);

        let plan = rehydrate_plan(&[claude_row, codex_row, opencode_row], &HashSet::new());

        assert_eq!(plan.len(), 3);
        let recover_kinds: Vec<AgentKind> = plan
            .iter()
            .filter_map(|j| match j {
                RehydrateJob::Recover { harness, .. } => Some(*harness),
                _ => None,
            })
            .collect();
        assert_eq!(
            recover_kinds,
            vec![AgentKind::ClaudeCode, AgentKind::Codex, AgentKind::OpenCode],
            "all three harnesses get a Recover job; none are Forget'd",
        );
        assert!(
            plan.iter()
                .all(|j| !matches!(j, RehydrateJob::Forget { .. })),
            "no Forget jobs — recoverable rows must keep their state",
        );
    }
}
