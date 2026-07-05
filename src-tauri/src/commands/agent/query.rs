//! Read-only Tauri commands: `agent_list`, `agent_state`, `agent_snapshot`,
//! plus the `agent_ack_state` write that records a seen completion.

use serde::Serialize;
use tracing::warn;

use super::registry::AgentListItem;
use crate::state::AppHandleState;

/// Join persisted per-session state metadata onto listed agent items.
///
/// The in-memory `AgentStateMachine` tracks the *current* state but not when
/// it was entered nor whether the user has already seen it — that truth lives
/// in `state/sessions.toml`. This fills `state_entered_at_ms` / `state_acked`
/// for every item carrying a `session_id` so the frontend can render the true
/// completion age (instead of a fabricated `Date.now()` on reload) and keep
/// acked completions quiet across a webview reload / app restart.
///
/// Lock ordering: the caller MUST have already dropped the `agents` (and
/// `terminals`) mutex before calling this. Other code paths lock
/// `config_store` → `agents`; holding both here in the reverse order would
/// invite a deadlock. This function locks only `config_store`.
fn join_persisted_state_meta(state: &AppHandleState, items: &mut [AgentListItem]) {
    // Read the tracked rows ONCE — `read_sessions` parses the TOML from disk
    // on every call, so a per-item `session_state_meta` lookup would re-read
    // the file N times per snapshot.
    let sessions = {
        let Ok(store) = state.config_store.lock() else {
            warn!("agent list: config_store lock poisoned; skipping state-meta join");
            return;
        };
        match store.read_sessions() {
            Ok(st) => st.sessions,
            Err(e) => {
                warn!(error=%e, "agent list: sessions read failed; skipping state-meta join");
                return;
            }
        }
    };
    let meta: std::collections::HashMap<&str, (Option<u64>, bool)> = sessions
        .iter()
        .map(|s| {
            (
                s.session_id.as_str(),
                (s.last_state_at_unix_ms, s.last_state_acked),
            )
        })
        .collect();
    for item in items.iter_mut() {
        let Some(session_id) = item.session_id.as_deref() else {
            continue;
        };
        if let Some((entered_at_ms, acked)) = meta.get(session_id) {
            item.state_entered_at_ms = *entered_at_ms;
            item.state_acked = *acked;
        }
    }
}

#[tauri::command]
pub fn agent_list(state: tauri::State<'_, AppHandleState>) -> Vec<AgentListItem> {
    // Take the registry snapshot and DROP the agents lock before touching the
    // config store (see `join_persisted_state_meta` for the lock-ordering
    // rationale).
    let mut items = {
        let registry = state.agents.lock().expect("agent registry poisoned");
        registry.list()
    };
    join_persisted_state_meta(&state, &mut items);
    items
}

/// Atomic snapshot returned to the frontend on mount / after ⌘R. Combines
/// `agent_list()` + `terminal_list()` into a single round-trip so the
/// frontend can seed both stores before any memo computes a count — the
/// two-invoke sequence `refreshAgents().then(refreshTerminals)` leaves
/// the memos rendering `0 0 0` for the round-trip window, which is the
/// visible symptom users report after cmd+r even when the backend has
/// live state.
///
/// Callers are expected to:
///   1. attach their `agent-state-changed` / `terminal-session-*` listeners,
///   2. buffer events arriving between attach and this call's result,
///   3. apply this snapshot in bulk,
///   4. flush the buffer on top.
#[derive(Debug, Serialize)]
pub struct AgentSnapshot {
    pub agents: Vec<AgentListItem>,
    pub terminals: Vec<crate::commands::terminal::TerminalListItem>,
}

#[tauri::command]
pub fn agent_snapshot(state: tauri::State<'_, AppHandleState>) -> Result<AgentSnapshot, String> {
    // Read the agent + terminal registries, releasing both locks before the
    // config-store join so we never hold `agents` while locking
    // `config_store` (lock-ordering rule — see `join_persisted_state_meta`).
    let mut agents = state
        .agents
        .lock()
        .map_err(|e| format!("agent registry lock: {e}"))?
        .list();
    let terminals = state
        .terminals
        .lock()
        .map_err(|e| format!("terminals lock: {e}"))?
        .list();
    join_persisted_state_meta(&state, &mut agents);
    Ok(AgentSnapshot { agents, terminals })
}

/// Shape returned by [`agent_state`]: the live machine state joined with the
/// persisted `(entered_at_ms, acked)` metadata. Field names are the wire
/// contract the frontend codes against (`state`, `entered_at_ms`, `acked`).
#[derive(Debug, Serialize)]
pub struct AgentStateInfo {
    pub state: raum_core::agent::AgentState,
    /// Unix-ms this session entered `state`, from the persisted
    /// `TrackedSession.last_state_at_unix_ms`. Omitted from the wire when
    /// absent so the frontend renders no fabricated age.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entered_at_ms: Option<u64>,
    /// Whether the user already dismissed this session's current completion.
    pub acked: bool,
}

#[tauri::command]
pub fn agent_state(
    state: tauri::State<'_, AppHandleState>,
    session_id: String,
) -> Option<AgentStateInfo> {
    // Live state from the in-memory machine; the lock is released at the end
    // of this statement, BEFORE the config-store read below (lock-ordering
    // rule — see `join_persisted_state_meta`).
    let live_state = state
        .agents
        .lock()
        .expect("agent registry poisoned")
        .state_for(&session_id)?;

    let (entered_at_ms, acked) = state
        .config_store
        .lock()
        .ok()
        .and_then(|store| store.session_state_meta(&session_id))
        .unwrap_or((None, false));

    Some(AgentStateInfo {
        state: live_state,
        entered_at_ms,
        acked,
    })
}

/// Record that the user has *seen* a session's current `last_state` (e.g. the
/// completion was dismissed in the attention rail). Persists
/// `last_state_acked = true` so a webview reload / app restart restores the
/// pre-reload rail exactly instead of re-flooding the completion.
///
/// Best-effort: a missing tracked row is NOT an error (no-op `Ok`) — the
/// frontend acks by session id and a shell session (or one torn down between
/// the emit and the ack) simply has nothing to flag.
#[tauri::command]
pub fn agent_ack_state(
    state: tauri::State<'_, AppHandleState>,
    session_id: String,
) -> Result<(), String> {
    state
        .config_store
        .lock()
        .map_err(|e| format!("config_store lock: {e}"))?
        .ack_session_last_state(&session_id)
        .map_err(|e| e.to_string())
}
