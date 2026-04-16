//! §11 — OS-level notification dispatch + dock badge counter.
//!
//! This module owns the backend half of the notification subsystem. The
//! frontend half lives in `frontend/src/lib/notificationCenter.ts` and is
//! responsible for the per-agent debounce, the unfocused-window gate, and
//! the permission/sound UX. The backend is intentionally thin:
//!
//! * [`set_dock_badge`] — set/clear the macOS / Linux dock badge count
//!   via [`Window::set_badge_count`]. The frontend calls this through the
//!   exposed Tauri command [`crate::commands::notifications::set_dock_badge`].
//! * [`focus_window`] — re-focus the `main` window when the user clicks an
//!   OS notification. Used by §11.6 alongside the frontend
//!   `terminal-focus-requested` event.
//!
//! Why not let the frontend call `sendNotification` directly without the
//! backend? It can and does — §11.1 emits the OS notification from the TS
//! layer via `@tauri-apps/plugin-notification`. The backend only owns the
//! pieces that require Tauri-core APIs not exposed over IPC: the badge
//! counter and direct `set_focus` on the webview window.

use tauri::{AppHandle, Manager, Runtime};
use tracing::warn;

/// Set (or clear when `count == 0`) the dock / taskbar badge count for the
/// `main` window. macOS + Linux are the supported raum platforms, both of
/// which honour `Window::set_badge_count`.
///
/// Errors from the underlying Tauri call are logged at WARN and swallowed:
/// the badge is UX polish, and a badge-set failure must never propagate up
/// and abort a state-change handler.
pub fn set_dock_badge<R: Runtime>(app: &AppHandle<R>, count: u32) {
    let Some(window) = app.get_webview_window("main") else {
        warn!("set_dock_badge: main window not found");
        return;
    };
    let value: Option<i64> = if count == 0 {
        None
    } else {
        Some(i64::from(count))
    };
    if let Err(e) = window.set_badge_count(value) {
        warn!(error = %e, count, "set_dock_badge: set_badge_count failed");
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
