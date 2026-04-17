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
//! * `notifications_list_system_sounds` — enumerate the OS-bundled alert
//!   sounds (macOS `/System/Library/Sounds`, Linux freedesktop) so the
//!   settings dropdown can populate without bundling any audio.
//! * `notifications_read_sound_bytes` — return the raw bytes of a sound
//!   file. The webview can't fetch arbitrary `file://` URLs, so the
//!   notification center wraps the bytes in a `Blob` + ObjectURL.

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

/// One entry in the OS-bundled sound list returned by
/// [`notifications_list_system_sounds`].
#[derive(Debug, serde::Serialize)]
pub struct SystemSound {
    /// Human-friendly label derived from the filename without its extension
    /// (e.g. `"Glass"`, `"complete"`).
    pub name: String,
    /// Absolute path to the sound file. Stored verbatim in
    /// `Config.notifications.sound` when the user picks this entry.
    pub path: String,
}

/// Directories scanned for OS-bundled alert sounds, in priority order. The
/// first directory that yields any matching files wins so we don't mix
/// macOS's curated set with anything weird sitting in `/usr/share/sounds`.
fn system_sound_dirs() -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    {
        &["/System/Library/Sounds"]
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        &["/usr/share/sounds/freedesktop/stereo"]
    }
    #[cfg(not(unix))]
    {
        &[]
    }
}

/// File extensions considered audio. AIFF for macOS system sounds, OGA/OGG
/// for freedesktop sounds, plus the common formats users are likely to drop
/// in via the "Custom path" escape hatch.
const AUDIO_EXTENSIONS: &[&str] = &["aiff", "aif", "oga", "ogg", "wav", "mp3", "flac", "m4a"];

/// §11.5 — list OS-bundled alert sounds for the settings dropdown. Returns an
/// empty `Vec` on platforms without a known sound directory; the caller is
/// expected to gracefully degrade to the "None" / "Custom path" options.
#[tauri::command]
pub fn notifications_list_system_sounds() -> Vec<SystemSound> {
    let mut out: Vec<SystemSound> = Vec::new();
    for dir in system_sound_dirs() {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(ext) = path.extension().and_then(|s| s.to_str()) else {
                continue;
            };
            if !AUDIO_EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(ext)) {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            out.push(SystemSound {
                name: stem.to_string(),
                path: path.to_string_lossy().into_owned(),
            });
        }
        if !out.is_empty() {
            break;
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// §11.5 — return the raw bytes of `path` so the frontend can wrap them in a
/// `Blob` and play via `<audio>`. The webview origin (`tauri://localhost`)
/// can't fetch arbitrary `file://` URLs, and configuring the asset protocol
/// scope dynamically for each user-supplied custom path adds more surface
/// than it saves over a one-shot IPC. The frontend caches the resulting
/// ObjectURL keyed by path, so this fires at most once per sound choice per
/// session.
#[tauri::command]
pub fn notifications_read_sound_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| e.to_string())
}
