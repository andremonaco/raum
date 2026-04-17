//! Expose the WebView's built-in devtools so the frontend can invoke them
//! from a keyboard shortcut now that the native right-click "Inspect" path
//! is suppressed globally.
//!
//! `WebviewWindow::open_devtools()` is only available when the runtime has
//! devtools compiled in, which Tauri gates behind `debug_assertions` or the
//! `devtools` cargo feature. In a release build without that feature the
//! command is a no-op and a warning is emitted so the user sees *something*
//! in the log rather than silently nothing.

use tauri::{AppHandle, Manager, Runtime};

#[tauri::command]
pub fn open_devtools<R: Runtime>(app: AppHandle<R>) {
    #[cfg(any(debug_assertions, feature = "devtools"))]
    {
        if let Some(win) = app.get_webview_window("main") {
            win.open_devtools();
        } else {
            tracing::warn!("open_devtools: main window not found");
        }
    }

    #[cfg(not(any(debug_assertions, feature = "devtools")))]
    {
        tracing::warn!(
            "open_devtools: unavailable — this build has neither debug_assertions nor the \
             `devtools` feature enabled"
        );
        let _ = app;
    }
}
