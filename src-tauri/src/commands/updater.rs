//! Updater preference surface.
//!
//! The actual `check()` / `downloadAndInstall()` calls are made from the
//! frontend via `@tauri-apps/plugin-updater` (the `updater:default` capability
//! grants the IPC commands). This module only persists the user's
//! "check on launch" toggle so the setting survives restarts.

use raum_core::config::Config;

use crate::state::AppHandleState;

#[tauri::command]
pub fn config_set_updater_check_on_launch(
    state: tauri::State<'_, AppHandleState>,
    enabled: bool,
) -> Result<(), String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut cfg: Config = store.read_config().map_err(|e| e.to_string())?;
    if cfg.updater.check_on_launch == enabled {
        return Ok(());
    }
    cfg.updater.check_on_launch = enabled;
    store.write_config(&cfg).map_err(|e| e.to_string())
}
