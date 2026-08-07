//! One-time migration off a legacy-born tmux server.
//!
//! Before 0.1.13 raum birthed the `-L raum` tmux server with its macOS TCC
//! responsibility disclaimed, which made the *server* — not raum.app — the
//! process macOS holds responsible for everything a pane touches. Grants
//! attributed to an ad-hoc-signed Homebrew binary don't persist, so the same
//! permission dialog returns forever.
//!
//! 0.1.13 stops doing that, but updating raum cannot fix an existing user:
//! responsibility is fixed when the server is born, and the server deliberately
//! outlives the app. The server has to be replaced, and that ends every live
//! session — so this is a prompt, never an automatic action.
//!
//! The restart is deferred to the next launch rather than performed in place.
//! At boot, before rehydrate, raum kills the legacy server and lets the normal
//! cold-server path take over: tracked harness rows become `Recover` jobs and
//! resume through `claude --resume` / `codex resume` / `opencode --session`.
//! Doing it mid-session instead would tear panes down underneath their attached
//! control-mode clients, outside the one path that knows how to rebuild them.
//!
//! What survives: harness conversations, scrollback (from snapshots), the grid.
//! What doesn't: plain shell panes (no resume concept — `rehydrate_plan` sends
//! them to `Forget`) and any in-flight agent turn.
//!
//! # This module is temporary — delete it at [`REMOVE_AT_VERSION`]
//!
//! It only exists for installs that were already running before 0.1.13. A
//! legacy server dies at the first reboot or whenever its last session closes
//! (`exit-empty` is on), so the population it serves shrinks to nothing on its
//! own; past that point this is dead weight that still costs a config read and
//! a `ps` on every launch.
//!
//! Rather than trusting a comment to be noticed, [`tests::migration_has_not
//! _outlived_its_purpose`] fails the build once the crate version reaches
//! `REMOVE_AT_VERSION` — the release that bumps past it cannot go green until
//! someone deletes:
//!
//! - `server_restart_status` / `server_restart_dismiss`, their two
//!   `generate_handler!` entries
//! - `TerminalsConfig::server_restart_hint_dismissed` (`#[serde(default)]`,
//!   so dropping it leaves any stale key in the forward-compat `unknown` map —
//!   no migration needed)
//! - `TmuxManager::server_born_legacy_disclaimed` / `is_legacy_birth_argv`
//!   and their tests
//! - `frontend/src/lib/serverRestartNotice.ts` and its call in `app.tsx`
//!
//! What STAYS — the deferred-restart mechanism outgrew the migration and is
//! now shared with the permanent tmux version health check
//! (`commands::tmux_health` + `frontend/src/lib/tmuxVersionNotice.ts`):
//! `server_restart_now`, `apply_pending_server_restart`,
//! `TerminalsConfig::restart_server_on_next_launch`, `TmuxManager::server_pid`,
//! and the `read_config` / `mutate_terminals` helpers below. When deleting,
//! rehome those into a non-temporary module (`tmux_health` is the natural
//! spot). `lifecycle::flush_frontend_writers` also stays — generally useful.

use serde::Serialize;
use tauri::Manager;
use tracing::{info, warn};

use crate::state::AppHandleState;

/// The release at which this migration must be gone. See the module docs for
/// the deletion checklist; [`tests::migration_has_not_outlived_its_purpose`]
/// enforces it.
///
/// Chosen as the next minor rather than a date: by the time raum cuts a
/// milestone, every install still carrying a pre-0.1.13 tmux server has long
/// since rebooted. If that turns out to be optimistic, moving this constant is
/// a deliberate, reviewable act — which is the point.
pub const REMOVE_AT_VERSION: &str = "0.2.0";

/// Whether the one-time restart prompt should be shown.
#[derive(Debug, Clone, Serialize)]
pub struct ServerRestartStatus {
    /// True only when a legacy-born server is live AND the user hasn't
    /// dismissed the prompt. False on a fresh install, on Linux, and — without
    /// any flag needing to be set — for anyone who has already restarted.
    pub needed: bool,
    /// How many sessions the restart would take down, so the prompt can be
    /// honest about the cost instead of hand-waving it.
    pub live_sessions: u32,
}

/// Report whether this install is still on a legacy-born tmux server.
#[tauri::command]
pub fn server_restart_status(state: tauri::State<'_, AppHandleState>) -> ServerRestartStatus {
    let dismissed = read_config(&state).is_some_and(|c| c.terminals.server_restart_hint_dismissed);
    if dismissed || !state.tmux.server_born_legacy_disclaimed() {
        return ServerRestartStatus {
            needed: false,
            live_sessions: 0,
        };
    }
    let live_sessions = state
        .tmux
        .list_sessions()
        .map_or(0, |s| u32::try_from(s.len()).unwrap_or(u32::MAX));
    // Also the breadcrumb that says why this code still exists, for anyone
    // reading a support log long after the reason stopped being obvious.
    info!(
        live_sessions,
        remove_at = REMOVE_AT_VERSION,
        "server-restart: legacy tmux server detected; prompting",
    );
    ServerRestartStatus {
        needed: true,
        live_sessions,
    }
}

/// Record that the user never wants to be asked again.
#[tauri::command]
pub fn server_restart_dismiss(state: tauri::State<'_, AppHandleState>) -> Result<(), String> {
    mutate_terminals(&state, |t| t.server_restart_hint_dismissed = true)
}

/// Accept the restart: mark it pending, flush, and relaunch.
///
/// The kill itself happens on the way back up (see
/// [`apply_pending_server_restart`]) so the cold server is rebuilt by the same
/// boot path a reboot uses. Flushing first matters: the frontend's debounced
/// layout and snapshot writers hold the grid and the scrollback that the
/// recovered panes are rebuilt from.
///
/// Never returns on success — `AppHandle::restart` execs.
#[tauri::command]
pub async fn server_restart_now(app: tauri::AppHandle) -> Result<(), String> {
    {
        let state = app.state::<AppHandleState>();
        mutate_terminals(&state, |t| t.restart_server_on_next_launch = true)?;
    }
    info!("server-restart: pending flag set; flushing before relaunch");
    crate::commands::lifecycle::flush_frontend_writers(&app).await;
    app.restart();
}

/// Consume a pending restart. Call at boot, *before* rehydrate reads the socket.
///
/// Clears the flag first and unconditionally: a kill that fails (or a crash
/// mid-boot) must not leave raum killing the server on every launch forever.
/// One missed migration costs a prompt next time; a stuck flag costs sessions
/// every single boot.
pub fn apply_pending_server_restart(app: &mut tauri::App) {
    let state: tauri::State<'_, AppHandleState> = app.state();
    let pending = read_config(&state).is_some_and(|c| c.terminals.restart_server_on_next_launch);
    if !pending {
        return;
    }
    if let Err(e) = mutate_terminals(&state, |t| t.restart_server_on_next_launch = false) {
        warn!(error = %e, "server-restart: could not clear the pending flag");
    }
    match state.tmux.kill_server() {
        Ok(()) => info!("server-restart: legacy tmux server killed; rehydrate will recover"),
        Err(e) => warn!(error = %e, "server-restart: kill-server failed; leaving the server as-is"),
    }
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/// Read the user config, recovering a poisoned lock (same convention as
/// `config_get`) and degrading to `None` rather than failing a caller whose
/// worst case is "don't show a prompt". Shared with `tmux_health`.
pub(crate) fn read_config(state: &AppHandleState) -> Option<raum_core::config::Config> {
    state
        .config_store
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .read_config()
        .ok()
}

/// Read-modify-write one field of `[terminals]`, preserving everything else.
/// Shared with `tmux_health`.
pub(crate) fn mutate_terminals(
    state: &AppHandleState,
    edit: impl FnOnce(&mut raum_core::config::TerminalsConfig),
) -> Result<(), String> {
    let store = state
        .config_store
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut cfg = store.read_config().map_err(|e| e.to_string())?;
    edit(&mut cfg.terminals);
    store.write_config(&cfg).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use raum_core::agent::semver_lite::Version;

    /// Expiry guard for the whole module.
    ///
    /// Migration code is easy to add and easy to forget, and a `TODO: remove
    /// after 0.2.0` is invisible the day it matters. This makes the deadline
    /// mechanical: the release that bumps `src-tauri/Cargo.toml` to
    /// [`super::REMOVE_AT_VERSION`] or beyond fails here, and the only way to
    /// green the build is to do the deletion listed in the module docs.
    ///
    /// If the migration genuinely still has users at that point, move the
    /// constant — deliberately, in a reviewed diff — rather than deleting the
    /// test.
    #[test]
    fn migration_has_not_outlived_its_purpose() {
        let current = Version::parse(env!("CARGO_PKG_VERSION"))
            .expect("crate version is always valid semver");
        let deadline =
            Version::parse(super::REMOVE_AT_VERSION).expect("REMOVE_AT_VERSION must be semver");
        assert!(
            current < deadline,
            "raum is at {current:?}, which has reached the {deadline:?} deadline for the \
             pre-0.1.13 tmux-server migration. Delete it — see the checklist in this \
             module's docs — or move REMOVE_AT_VERSION on purpose.",
        );
    }
}
