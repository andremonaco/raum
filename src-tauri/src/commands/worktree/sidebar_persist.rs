//! Sidebar-only persistence: §9.6 quickfire history and §9.7 sidebar
//! width. Both round-trip through `ConfigStore` so the values survive
//! restarts.

use raum_core::config::QUICKFIRE_HISTORY_LIMIT;

use crate::state::AppHandleState;

/// §9.6 — list persisted quick-fire commands, most-recent first.
#[tauri::command(async)]
pub fn quickfire_history_get(
    state: tauri::State<'_, AppHandleState>,
) -> Result<Vec<String>, String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let hist = store
        .read_quickfire_history()
        .map_err(|e| format!("read quickfire history: {e}"))?;
    Ok(hist.entries)
}

/// §9.6 — push a new command to the ring. Delegates to
/// `QuickfireHistory::push` which dedupes and truncates to
/// `QUICKFIRE_HISTORY_LIMIT`. Returns the updated list so the UI can avoid a
/// follow-up `_get` round-trip.
#[tauri::command(async)]
pub fn quickfire_history_push(
    state: tauri::State<'_, AppHandleState>,
    command: String,
) -> Result<Vec<String>, String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut hist = store
        .read_quickfire_history()
        .map_err(|e| format!("read quickfire history: {e}"))?;
    hist.push(command);
    // Belt-and-braces cap in case the persisted file was ever written past
    // the limit by a future version.
    if hist.entries.len() > QUICKFIRE_HISTORY_LIMIT {
        hist.entries.truncate(QUICKFIRE_HISTORY_LIMIT);
    }
    store
        .write_quickfire_history(&hist)
        .map_err(|e| format!("write quickfire history: {e}"))?;
    Ok(hist.entries)
}

/// §9.7 — persist the sidebar width drag handle into
/// `config.toml.sidebar.width_px`. The frontend already debounces drag events;
/// this command is a direct read-modify-write.
///
/// Width is clamped to `[160, 800]` to defend against accidental "drag to
/// 0" states that would render the sidebar invisible and unrecoverable
/// without editing config.toml by hand.
#[tauri::command(async)]
pub fn config_set_sidebar_width(
    state: tauri::State<'_, AppHandleState>,
    width: u32,
) -> Result<u32, String> {
    let clamped = width.clamp(160, 800);
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut cfg = store.read_config().map_err(|e| format!("read: {e}"))?;
    cfg.sidebar.width_px = clamped;
    store
        .write_config(&cfg)
        .map_err(|e| format!("write: {e}"))?;
    Ok(clamped)
}
