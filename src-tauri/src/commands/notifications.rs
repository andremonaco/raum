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
//! * `notifications_play_sound` — fire-and-forget playback of a sound
//!   file using the OS-standard event-sound player (`afplay` on macOS,
//!   `canberra-gtk-play` / `paplay` on Linux). These APIs are designed
//!   to mix with other audio, so they don't pause Spotify / Music the
//!   way an in-webview `<audio>` element does.

use std::process::Command as ProcessCommand;

use raum_core::config::{BadgeMode, Config};
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
/// Updates `notify_on_waiting`, `notify_on_done`, the banner master switch,
/// the optional sound path, and the dock/taskbar `badge_mode` atomically in a
/// single config write.
#[tauri::command]
pub fn config_set_notifications(
    state: tauri::State<'_, AppHandleState>,
    notify_on_waiting: bool,
    notify_on_done: bool,
    notify_banner_enabled: bool,
    sound: Option<String>,
    badge_mode: BadgeMode,
) -> Result<(), String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut cfg: Config = store.read_config().map_err(|e| e.to_string())?;
    cfg.notifications.notify_on_waiting = notify_on_waiting;
    cfg.notifications.notify_on_done = notify_on_done;
    cfg.notifications.notify_banner_enabled = notify_banner_enabled;
    cfg.notifications.badge_mode = badge_mode;
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
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

/// §11.5 — play `path` as an OS event sound. Fire-and-forget: spawns the
/// standard per-OS player and returns immediately.
///
/// We delegate to the OS event-sound player instead of the webview's
/// `<audio>` element because `HTMLAudioElement` in WKWebView (and to a
/// lesser extent WebKitGTK) registers with the system's "Now Playing"
/// media session, which pauses Spotify / Apple Music / Music for Linux and
/// never resumes them. `afplay` (macOS) and `canberra-gtk-play` / `paplay`
/// (Linux) are designed as short event-sound players and mix with other
/// audio by default.
///
/// Errors are swallowed into `Ok(())` and logged — notification delivery
/// must not fail just because the user's sound file is missing or the
/// player binary isn't installed.
#[tauri::command]
pub fn notifications_play_sound(path: String) -> Result<(), String> {
    spawn_event_sound(&path);
    Ok(())
}

#[cfg(target_os = "macos")]
fn spawn_event_sound(path: &str) {
    match ProcessCommand::new("afplay").arg(path).spawn() {
        Ok(child) => reap_detached(child),
        Err(e) => eprintln!("afplay spawn failed ({path}): {e}"),
    }
}

#[cfg(target_os = "linux")]
fn spawn_event_sound(path: &str) {
    // libcanberra is the freedesktop event-sound standard; fall back to
    // paplay (PulseAudio / PipeWire compat shim) when it isn't installed.
    let attempt = ProcessCommand::new("canberra-gtk-play")
        .args(["-f", path])
        .spawn()
        .or_else(|_| ProcessCommand::new("paplay").arg(path).spawn());
    match attempt {
        Ok(child) => reap_detached(child),
        Err(e) => eprintln!("event-sound spawn failed ({path}): {e}"),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn spawn_event_sound(_path: &str) {}

/// Dropping a `Child` on Unix does not reap it, leaving a zombie until the
/// parent exits. A tiny detached thread waits on the process so the kernel
/// can clean it up promptly.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn reap_detached(mut child: std::process::Child) {
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

// ---------------------------------------------------------------------------
// Real OS-level authorization probe (replaces the always-true plugin lie).
// `tauri-plugin-notification`'s desktop `permission_state()` is hard-coded to
// `Granted`, so the frontend's badge can never reflect what the user actually
// configured in System Settings. We probe the OS directly here.
// ---------------------------------------------------------------------------

/// Result of [`notifications_check_authorization`].
///
/// `status` is `"granted" | "denied" | "unknown"`. `bundle_id` names the
/// principal that actually receives the notifications — important on macOS
/// where `tauri-plugin-notification` masquerades as Terminal in unbundled
/// dev builds, so the badge reflects Terminal's permission rather than the
/// raum bundle's. `is_dev_mode` lets the UI surface that masquerade.
#[derive(Debug, serde::Serialize)]
pub struct NotificationAuthorization {
    pub status: String,
    pub bundle_id: String,
    pub is_dev_mode: bool,
    pub note: Option<String>,
}

/// Probe the actual OS-level authorization for raum's notifications. Used in
/// place of `@tauri-apps/plugin-notification`'s `isPermissionGranted` because
/// the plugin's desktop impl returns `Granted` unconditionally.
#[tauri::command]
pub fn notifications_check_authorization<R: Runtime>(
    #[allow(unused_variables)] app: AppHandle<R>,
) -> Result<NotificationAuthorization, String> {
    #[cfg(target_os = "macos")]
    {
        let is_dev = tauri::is_dev();
        let bundle_id = app.config().identifier.clone();
        let status = if is_dev {
            "unknown"
        } else {
            check_macos_authorization()
        };
        let note = if is_dev {
            Some(
                "Dev build: desktop notifications are attributed to Terminal \
                 (`com.apple.Terminal`), so raum cannot read an authoritative \
                 permission state here. Build and launch the bundled app \
                 (`task build`) to verify raum's own macOS authorization."
                    .to_string(),
            )
        } else {
            None
        };
        return Ok(NotificationAuthorization {
            status: status.to_string(),
            bundle_id,
            is_dev_mode: is_dev,
            note,
        });
    }
    #[cfg(target_os = "linux")]
    {
        let status = check_linux_dbus_notifications();
        let note = if status == "denied" {
            Some(
                "No notification daemon is registered on the session DBus. \
                 Install/start one (e.g. dunst, mako, GNOME Shell, KDE Plasma)."
                    .to_string(),
            )
        } else {
            None
        };
        return Ok(NotificationAuthorization {
            status: status.to_string(),
            bundle_id: "org.freedesktop.Notifications".to_string(),
            is_dev_mode: false,
            note,
        });
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Ok(NotificationAuthorization {
            status: "unknown".to_string(),
            bundle_id: String::new(),
            is_dev_mode: false,
            note: None,
        })
    }
}

#[cfg(target_os = "macos")]
fn check_macos_authorization() -> &'static str {
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2_user_notifications::{UNNotificationSettings, UNUserNotificationCenter};

    let (tx, rx) = mpsc::channel();
    let completion = RcBlock::new(move |settings: std::ptr::NonNull<UNNotificationSettings>| {
        #[allow(unsafe_code)]
        let settings = unsafe { settings.as_ref() };
        let _ = tx.send(map_macos_authorization_status(
            settings.authorizationStatus(),
        ));
    });

    let center = UNUserNotificationCenter::currentNotificationCenter();
    center.getNotificationSettingsWithCompletionHandler(&completion);

    match rx.recv_timeout(Duration::from_secs(2)) {
        Ok(status) => status,
        Err(_) => "unknown",
    }
}

#[cfg(target_os = "macos")]
fn map_macos_authorization_status(
    status: objc2_user_notifications::UNAuthorizationStatus,
) -> &'static str {
    use objc2_user_notifications::UNAuthorizationStatus;

    if status == UNAuthorizationStatus::Authorized
        || status == UNAuthorizationStatus::Provisional
        || status == UNAuthorizationStatus::Ephemeral
    {
        "granted"
    } else if status == UNAuthorizationStatus::Denied {
        "denied"
    } else {
        return "unknown";
    }
}

#[cfg(target_os = "linux")]
fn check_linux_dbus_notifications() -> &'static str {
    let Ok(out) = ProcessCommand::new("dbus-send")
        .args([
            "--session",
            "--print-reply",
            "--dest=org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus.NameHasOwner",
            "string:org.freedesktop.Notifications",
        ])
        .output()
    else {
        return "unknown";
    };
    if !out.status.success() {
        return "unknown";
    }
    let s = String::from_utf8_lossy(&out.stdout);
    if s.contains("boolean true") {
        "granted"
    } else if s.contains("boolean false") {
        "denied"
    } else {
        "unknown"
    }
}

/// Open the OS notification settings panel so the user can toggle the
/// permission directly. Per-platform deep links land on the right pane;
/// Linux iterates known DE control panels and uses the first one present.
#[tauri::command]
pub fn notifications_open_system_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // The `Notifications-Settings.extension` URL is the macOS 13+ form;
        // older releases that don't recognise it just open System Settings
        // to the home page, which is still better than nothing.
        ProcessCommand::new("open")
            .arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
            .status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let candidates: &[(&str, &[&str])] = &[
            ("gnome-control-center", &["notifications"]),
            ("systemsettings", &["kcm_notifications"]),
            ("systemsettings5", &["kcm_notifications"]),
            ("kcmshell6", &["kcm_notifications"]),
            ("kcmshell5", &["kcm_notifications"]),
            ("xdg-open", &["settings://notifications"]),
        ];
        for (cmd, args) in candidates {
            if ProcessCommand::new(cmd).args(*args).spawn().is_ok() {
                return Ok(());
            }
        }
        Err("no notification settings panel found on this system".to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err("unsupported platform".to_string())
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::map_macos_authorization_status;
    #[cfg(target_os = "macos")]
    use objc2_user_notifications::UNAuthorizationStatus;

    #[cfg(target_os = "macos")]
    #[test]
    fn maps_authorized_statuses_to_granted() {
        assert_eq!(
            map_macos_authorization_status(UNAuthorizationStatus::Authorized),
            "granted"
        );
        assert_eq!(
            map_macos_authorization_status(UNAuthorizationStatus::Provisional),
            "granted"
        );
        assert_eq!(
            map_macos_authorization_status(UNAuthorizationStatus::Ephemeral),
            "granted"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn maps_denied_status_to_denied() {
        assert_eq!(
            map_macos_authorization_status(UNAuthorizationStatus::Denied),
            "denied"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn maps_not_determined_to_unknown() {
        assert_eq!(
            map_macos_authorization_status(UNAuthorizationStatus::NotDetermined),
            "unknown"
        );
    }
}
