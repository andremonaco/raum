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
/// an AppImage on Linux, but two cases must NOT self-update:
///
/// * Linux `.deb` — apt owns the file.
/// * macOS Homebrew cask — brew owns the cask record. Replacing
///   `/Applications/raum.app` out of band leaves `brew list --cask` stuck on
///   the old version, and a later `brew upgrade` becomes a confused no-op.
///
/// In both cases the frontend hides the in-app Install button and surfaces
/// a package-manager-friendly path instead (release page for `.deb`, copy
/// `brew upgrade --cask raum` for Homebrew).
///
/// Linux detection relies on `APPIMAGE`, which the AppImage runtime sets
/// automatically when it mounts + executes the bundle. Its absence on
/// Linux is taken as `.deb` (the only other bundle we ship).
///
/// macOS Homebrew detection probes the Caskroom metadata directory rather
/// than shelling out to `brew`. The directory is created by
/// `brew install --cask raum` and removed by `brew uninstall --cask raum`,
/// so its presence is a reliable signal even though brew copies (rather
/// than symlinks) the bundle into `/Applications`. Both prefixes are
/// checked because Homebrew lives at `/opt/homebrew` on Apple Silicon and
/// `/usr/local` on Intel.
#[tauri::command]
pub fn updater_install_flavor() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        const CASKROOM_PATHS: [&str; 2] =
            ["/opt/homebrew/Caskroom/raum", "/usr/local/Caskroom/raum"];
        if CASKROOM_PATHS
            .iter()
            .any(|p| std::fs::metadata(p).is_ok_and(|m| m.is_dir()))
        {
            "homebrew"
        } else {
            "macos"
        }
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
