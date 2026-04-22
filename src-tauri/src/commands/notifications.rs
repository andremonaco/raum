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
/// Updates `notify_on_waiting`, `notify_on_done`, the optional sound path, and
/// the dock/taskbar `badge_mode` atomically in a single config write.
#[tauri::command]
pub fn config_set_notifications(
    state: tauri::State<'_, AppHandleState>,
    notify_on_waiting: bool,
    notify_on_done: bool,
    sound: Option<String>,
    badge_mode: BadgeMode,
) -> Result<(), String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut cfg: Config = store.read_config().map_err(|e| e.to_string())?;
    cfg.notifications.notify_on_waiting = notify_on_waiting;
    cfg.notifications.notify_on_done = notify_on_done;
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
        // notify_rust calls `set_application("com.apple.Terminal")` in dev so
        // the system attributes our notifications to Terminal. Probing the
        // raum bundle in that case would show "unknown" forever even when
        // notifications are actually working.
        let is_dev = tauri::is_dev();
        let bundle_id = if is_dev {
            "com.apple.Terminal".to_string()
        } else {
            app.config().identifier.clone()
        };
        let status = check_macos_authorization(&bundle_id);
        let note = if is_dev {
            Some(format!(
                "Dev build: notifications fire as Terminal ({bundle_id}). \
                 Build a release bundle (`task build`) for raum-branded alerts."
            ))
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
fn check_macos_authorization(bundle_id: &str) -> &'static str {
    let Some(home) = std::env::var_os("HOME") else {
        return "unknown";
    };
    let mut plist = std::path::PathBuf::from(home);
    plist.push("Library/Preferences/com.apple.ncprefs.plist");
    let Ok(out) = ProcessCommand::new("plutil")
        .args(["-convert", "xml1", "-o", "-", "--"])
        .arg(&plist)
        .output()
    else {
        return "unknown";
    };
    if !out.status.success() {
        return "unknown";
    }
    let Ok(xml) = std::str::from_utf8(&out.stdout) else {
        return "unknown";
    };
    parse_macos_flags(xml, bundle_id)
}

/// Single-pass scan for `<string>{bundle}</string>` followed by the next
/// `<key>flags</key><integer>N</integer>` pair. The plist is a few kilobytes
/// in practice, so a hand-rolled scan beats pulling in an XML crate.
///
/// `flags == 0` matches macOS's "Allow Notifications: off" toggle. Any
/// nonzero value means the user has at least one notification surface
/// enabled.
#[cfg(target_os = "macos")]
fn parse_macos_flags(xml: &str, bundle_id: &str) -> &'static str {
    let target = format!("<string>{bundle_id}</string>");
    let Some(start) = xml.find(&target) else {
        return "unknown";
    };
    let after = &xml[start + target.len()..];
    let Some(flags_pos) = after.find("<key>flags</key>") else {
        return "unknown";
    };
    let after_flags = &after[flags_pos + "<key>flags</key>".len()..];
    let Some(open) = after_flags.find("<integer>") else {
        return "unknown";
    };
    let int_start = open + "<integer>".len();
    let Some(close_rel) = after_flags[int_start..].find("</integer>") else {
        return "unknown";
    };
    let n: i64 = after_flags[int_start..int_start + close_rel]
        .trim()
        .parse()
        .unwrap_or(0);
    if n == 0 { "denied" } else { "granted" }
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
    use super::parse_macos_flags;

    #[cfg(target_os = "macos")]
    const SAMPLE: &str = r"
        <plist><dict><key>apps</key><array>
            <dict>
                <key>bundle-id</key><string>com.apple.mail</string>
                <key>flags</key><integer>310378510</integer>
            </dict>
            <dict>
                <key>bundle-id</key><string>com.example.muted</string>
                <key>flags</key><integer>0</integer>
            </dict>
        </array></dict></plist>
    ";

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_granted_when_flags_nonzero() {
        assert_eq!(parse_macos_flags(SAMPLE, "com.apple.mail"), "granted");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_denied_when_flags_zero() {
        assert_eq!(parse_macos_flags(SAMPLE, "com.example.muted"), "denied");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unknown_when_bundle_absent() {
        assert_eq!(parse_macos_flags(SAMPLE, "com.never.here"), "unknown");
    }
}
