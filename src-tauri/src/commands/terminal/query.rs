//! Read-only queries: list known sessions, fetch tmux pane context.

use std::collections::HashMap;

use crate::state::AppHandleState;

use super::entry::PaneContextPayload;
use super::registry::TerminalListItem;

#[tauri::command]
pub fn terminal_list(
    state: tauri::State<'_, AppHandleState>,
) -> Result<Vec<TerminalListItem>, String> {
    let reg = state
        .terminals
        .lock()
        .map_err(|e| format!("terminals lock: {e}"))?;
    Ok(reg.list())
}

#[tauri::command]
pub async fn terminal_pane_context(
    state: tauri::State<'_, AppHandleState>,
    session_id: String,
) -> Result<PaneContextPayload, String> {
    let tmux = state.tmux.clone();
    let res = tokio::task::spawn_blocking(move || tmux.pane_context(&session_id))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?;
    Ok(res.unwrap_or_default().into())
}

#[tauri::command]
pub async fn terminal_pane_context_batch(
    state: tauri::State<'_, AppHandleState>,
    session_ids: Vec<String>,
) -> Result<HashMap<String, PaneContextPayload>, String> {
    let tmux = state.tmux.clone();
    let res = tokio::task::spawn_blocking(move || {
        // One `list-panes -a` for the whole socket instead of a
        // `display-message` fork per requested session.
        let mut all = tmux.pane_context_all().unwrap_or_default();
        let mut out = HashMap::with_capacity(session_ids.len());
        for session_id in session_ids {
            let ctx = all.remove(&session_id).unwrap_or_default();
            out.insert(session_id, ctx.into());
        }
        out
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?;
    Ok(res)
}
