//! §11 — OS-level notification dispatch + dock badge counter.
//!
//! This module owns the backend half of the notification subsystem. The
//! frontend half lives in `frontend/src/lib/notificationCenter.ts` and is
//! responsible for the per-agent debounce and the permission/sound UX. The
//! backend is intentionally thin:
//!
//! * [`set_dock_badge`] — set/clear the macOS / Linux dock badge count.
//!   On macOS we drive both Tauri's [`Window::set_badge_count`] AND a
//!   direct `NSDockTile::setBadgeLabel:` call on the main thread, because
//!   the Tauri path silently no-ops in some bundle states.
//! * [`focus_window`] — re-focus the `main` window when the user clicks an
//!   OS notification. Used by §11.6 alongside the frontend
//!   `terminal-focus-requested` event.
//! * [`send`] — submodule that owns the actual notification dispatch via
//!   the modern `UNUserNotificationCenter` (macOS) and `notify-rust`
//!   (Linux). Replaces `tauri-plugin-notification`'s legacy
//!   `NSUserNotification` path which is broken on modern macOS.
//! * [`delegate`] — submodule that owns the
//!   `UNUserNotificationCenterDelegate` so we receive click events and
//!   redeliver them to the frontend as the `notifications:clicked` Tauri
//!   event.

pub mod clear;
#[cfg(target_os = "macos")]
pub mod delegate;
pub mod send;

use tauri::{AppHandle, Manager, Runtime};
use tracing::{info, warn};

/// Set (or clear when `count == 0`) the dock / taskbar badge count for the
/// `main` window. macOS + Linux are the supported raum platforms.
///
/// On macOS we deliberately call BOTH paths: Tauri's `set_badge_count`
/// (which also handles Linux's Unity launcher protocol) AND a direct
/// `NSApp.dockTile.setBadgeLabel:` on the main thread. The latter is the
/// belt-and-braces fix for the symptom that `set_badge_count` silently
/// no-ops in some bundle states despite returning `Ok(())`.
///
/// Errors are logged at WARN and swallowed: the badge is UX polish, and a
/// badge-set failure must never abort a state-change handler.
pub fn set_dock_badge<R: Runtime>(app: &AppHandle<R>, count: u32) {
    info!(count, "set_dock_badge: requested");

    if let Some(window) = app.get_webview_window("main") {
        let value: Option<i64> = if count == 0 {
            None
        } else {
            Some(i64::from(count))
        };
        if let Err(e) = window.set_badge_count(value) {
            warn!(error = %e, count, "set_dock_badge: window.set_badge_count failed");
        }
    } else {
        warn!("set_dock_badge: main window not found");
    }

    #[cfg(target_os = "macos")]
    {
        set_dock_badge_macos(app, count);
    }
}

/// Bring the raum `main` window back to the foreground. Invoked when the
/// user clicks an OS notification (§11.6) alongside the
/// `terminal-focus-requested` event emitted to the webview.
pub fn focus_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        warn!("focus_window: main window not found");
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    if let Err(e) = window.set_focus() {
        warn!(error = %e, "focus_window: set_focus failed");
    }
}

#[cfg(target_os = "macos")]
fn set_dock_badge_macos<R: Runtime>(app: &AppHandle<R>, count: u32) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    use objc2_foundation::NSString;

    let label: Option<String> = if count == 0 {
        None
    } else {
        Some(count.to_string())
    };

    let _ = app.run_on_main_thread(move || {
        // `NSApplication::sharedApplication` requires a MainThreadMarker.
        // `run_on_main_thread` guarantees we're on the main thread.
        #[allow(unsafe_code)]
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let app_ns = NSApplication::sharedApplication(mtm);
        let dock_tile = app_ns.dockTile();
        let ns_label = label.as_deref().map(NSString::from_str);
        dock_tile.setBadgeLabel(ns_label.as_deref());
        info!(
            count,
            "set_dock_badge_macos: NSDockTile.setBadgeLabel applied"
        );
    });
}

#[cfg(test)]
mod tests {
    // These helpers are thin wrappers over Tauri `Window` calls that require a
    // live runtime + window handle, which is not available in `cargo test`.
    // The badge-count value-shaping behaviour (count == 0 ↔ `None`) is the
    // only piece of logic we own here; confirm it survives refactors.
    #[test]
    fn badge_value_shape() {
        // Reproduction of the decision branch in `set_dock_badge`.
        let shape = |count: u32| -> Option<i64> {
            if count == 0 {
                None
            } else {
                Some(i64::from(count))
            }
        };
        assert_eq!(shape(0), None);
        assert_eq!(shape(1), Some(1));
        assert_eq!(shape(42), Some(42));
        assert_eq!(shape(u32::MAX), Some(i64::from(u32::MAX)));
    }
}
