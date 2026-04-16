//! §11 — notification command surface.
//!
//! Exposes:
//!
//! * `set_dock_badge(count)` — set / clear the dock or taskbar badge count.
//!   Called from the frontend notification center whenever the cross-project
//!   `waiting` agent total changes.
//! * `notifications_focus_main` — bring the raum main window back to the
//!   foreground, invoked from the TS notification action handler (§11.6).
//! * `notifications_mark_hint_shown` — persist
//!   `Config.notifications.notifications_hint_shown = true` after the
//!   one-time in-app banner has been rendered (§11.4). Reading the field is
//!   covered by the existing `config_get` command.

use raum_core::config::Config;
use tauri::{AppHandle, Runtime};

use crate::notifications;
use crate::state::AppHandleState;

/// §11.3 — `app.set_dock_badge(count)`. A `count` of 0 clears the badge.
#[tauri::command]
pub fn set_dock_badge<R: Runtime>(app: AppHandle<R>, count: u32) -> Result<(), String> {
    notifications::set_dock_badge(&app, count);
    Ok(())
}

/// §11.6 — bring the raum window forward when the user clicks an OS
/// notification. The TS side also emits `terminal-focus-requested` with the
/// originating session id so the pane scrolls into view.
#[tauri::command]
pub fn notifications_focus_main<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    notifications::focus_window(&app);
    Ok(())
}

/// §11.4 — persist that the one-time "notifications denied" hint banner has
/// been shown. Idempotent; safe to call more than once.
#[tauri::command]
pub fn notifications_mark_hint_shown(
    state: tauri::State<'_, AppHandleState>,
) -> Result<(), String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut cfg: Config = store.read_config().map_err(|e| e.to_string())?;
    if cfg.notifications.notifications_hint_shown {
        return Ok(());
    }
    cfg.notifications.notifications_hint_shown = true;
    store.write_config(&cfg).map_err(|e| e.to_string())
}

/// §11 — persist user notification preferences from the settings modal.
/// Updates `notify_on_waiting`, `notify_on_done`, and the optional sound path
/// atomically in a single config write.
#[tauri::command]
pub fn config_set_notifications(
    state: tauri::State<'_, AppHandleState>,
    notify_on_waiting: bool,
    notify_on_done: bool,
    sound: Option<String>,
) -> Result<(), String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut cfg: Config = store.read_config().map_err(|e| e.to_string())?;
    cfg.notifications.notify_on_waiting = notify_on_waiting;
    cfg.notifications.notify_on_done = notify_on_done;
    // Treat empty string as None (no sound file configured).
    cfg.notifications.sound = sound.filter(|s| !s.trim().is_empty());
    store.write_config(&cfg).map_err(|e| e.to_string())
}
