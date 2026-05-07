//! Read-only Tauri commands: `agent_list`, `agent_state`, `agent_snapshot`.

use serde::Serialize;

use super::registry::AgentListItem;
use crate::state::AppHandleState;

#[tauri::command]
pub fn agent_list(state: tauri::State<'_, AppHandleState>) -> Vec<AgentListItem> {
    let registry = state.agents.lock().expect("agent registry poisoned");
    registry.list()
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
    // Acquire both locks before reading so we can't serve an agent list
    // referencing a terminal that was removed between the two reads.
    let agents = state
        .agents
        .lock()
        .map_err(|e| format!("agent registry lock: {e}"))?
        .list();
    let terminals = state
        .terminals
        .lock()
        .map_err(|e| format!("terminals lock: {e}"))?
        .list();
    Ok(AgentSnapshot { agents, terminals })
}

#[tauri::command]
pub fn agent_state(
    state: tauri::State<'_, AppHandleState>,
    session_id: String,
) -> Option<raum_core::agent::AgentState> {
    state
        .agents
        .lock()
        .expect("agent registry poisoned")
        .state_for(&session_id)
}
