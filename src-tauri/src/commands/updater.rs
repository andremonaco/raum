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

/// How this binary was delivered, as far as the update flow cares.
///
/// Tauri v2's updater can replace a macOS `.app` in place and can swap out
/// an AppImage on Linux, but it cannot update a distro-managed `.deb` — apt
/// owns those files. The frontend uses this to hide the in-app Install
/// button when we know it would fail, and fall back to "open the release
/// page" so Linux `.deb` users can update via their package manager or a
/// manual re-download instead of seeing a raw plugin error.
///
/// Linux detection relies on `APPIMAGE`, which the AppImage runtime sets
/// automatically when it mounts + executes the bundle. Its absence on
/// Linux is taken as `.deb` (the only other bundle we ship).
#[tauri::command]
pub fn updater_install_flavor() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("APPIMAGE").is_some() {
            "appimage"
        } else {
            "deb"
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        "unknown"
    }
}
