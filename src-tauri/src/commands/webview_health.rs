//! Focus-gated webview liveness check.
//!
//! macOS sometimes kills the WKWebView WebContent process while the screen
//! is locked (suspension + memory/GPU pressure under RunningBoard/jetsam).
//! WebKit reports this via `webViewWebContentProcessDidTerminate:` and wry
//! implements that delegate method, but Tauri never registers wry's optional
//! handler and does not expose it — so the page stays black and dead until
//! the app is restarted. Since every pixel and event handler lives in that
//! page, the whole app appears frozen.
//!
//! Detection is therefore indirect: on every window focus the backend emits
//! `raum:ping` with a nonce; the page answers through the `webview_pong`
//! command. No pong within [`PONG_TIMEOUT`] means the page is presumed dead
//! and we issue [`tauri::webview::Webview::reload`] — the native
//! `-[WKWebView reload]`, Apple's documented recovery, which relaunches the
//! content process. Downstream recovery is the proven Cmd+R path: `app.tsx`
//! rehydrates the layout and every pane runs `terminal_reattach`, while the
//! tmux sessions (and the agents inside them) survive untouched.
//!
//! Kept cross-platform on purpose: webkit2gtk has the same web-process-crash
//! failure mode on Linux, and the check is free while the page is healthy.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

/// How long the page gets to echo a ping before we declare it dead.
/// Generous enough to absorb post-unlock system load; short enough that
/// recovery beats the user reaching for force-quit.
const PONG_TIMEOUT: Duration = Duration::from_secs(3);

/// Liveness-gate state. All atomics — nothing is ever held across an await.
#[derive(Default)]
pub struct WebviewHealthState {
    /// True once the frontend invoked `webview_ready` since the last reload
    /// we issued. Gates all checks so a slow first page load can never be
    /// mistaken for a dead one (which would cause a reload loop).
    ready: AtomicBool,
    /// Monotonic ping-nonce generator. Starts handing out 1, so the
    /// `last_pong` default of 0 can never satisfy a real check.
    next_nonce: AtomicU64,
    /// Nonce echoed by the most recent `webview_pong`.
    last_pong: AtomicU64,
    /// True while a check is awaiting its pong. Doubles as a rate limit
    /// when the window is focus-cycled rapidly.
    check_in_flight: AtomicBool,
}

impl WebviewHealthState {
    fn mark_ready(&self) {
        self.ready.store(true, Ordering::SeqCst);
    }

    /// Deliberately does *not* set `ready`: a late pong from a dying page
    /// must not re-arm checks while a reload is in flight.
    fn record_pong(&self, nonce: u64) {
        self.last_pong.store(nonce, Ordering::SeqCst);
    }

    /// Begin a health check. `None` when the page never reported ready or
    /// another check is already awaiting its pong.
    fn begin_check(&self) -> Option<u64> {
        if !self.ready.load(Ordering::SeqCst) {
            return None;
        }
        self.check_in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()?;
        Some(self.next_nonce.fetch_add(1, Ordering::SeqCst) + 1)
    }

    /// Finish the in-flight check; true iff the page echoed `nonce`.
    fn finish_check(&self, nonce: u64) -> bool {
        let healthy = self.last_pong.load(Ordering::SeqCst) == nonce;
        self.check_in_flight.store(false, Ordering::SeqCst);
        healthy
    }

    /// Close the gate until the freshly loaded page calls `webview_ready`.
    fn arm_reload(&self) {
        self.ready.store(false, Ordering::SeqCst);
    }
}

/// Page boot signal. Invoked from `installWebviewHealth` in
/// `frontend/src/lib/webviewHealth.ts` after its ping listener is
/// registered, on every page load — including the post-reload boot, which
/// re-arms the gate that `arm_reload` closed.
#[tauri::command]
pub fn webview_ready(state: tauri::State<'_, crate::state::AppHandleState>) {
    state.webview_health.mark_ready();
    tracing::info!("webview health: frontend ready");
}

/// Ping echo from the page.
#[tauri::command]
pub fn webview_pong(state: tauri::State<'_, crate::state::AppHandleState>, nonce: u64) {
    state.webview_health.record_pong(nonce);
}

/// Run one focus-gated liveness check. Called from the window-event
/// callback (Tauri's event thread), so all waiting happens on the async
/// runtime and the event loop is never blocked.
pub fn on_focus_gained(handle: &AppHandle) {
    let app = handle.clone();
    tauri::async_runtime::spawn(async move {
        let nonce = {
            let state: tauri::State<'_, crate::state::AppHandleState> = app.state();
            let Some(nonce) = state.webview_health.begin_check() else {
                return;
            };
            nonce
        };

        // Emitting into a dead WebContent process is a harmless no-op —
        // the missing pong is the actual signal.
        if let Err(e) = app.emit("raum:ping", nonce) {
            tracing::warn!(error = %e, "webview health: ping emit failed");
            let state: tauri::State<'_, crate::state::AppHandleState> = app.state();
            let _ = state.webview_health.finish_check(nonce);
            return;
        }

        tokio::time::sleep(PONG_TIMEOUT).await;

        let state: tauri::State<'_, crate::state::AppHandleState> = app.state();
        if state.webview_health.finish_check(nonce) {
            return;
        }
        tracing::warn!(
            nonce,
            timeout_s = PONG_TIMEOUT.as_secs(),
            "webview health: no pong — reloading webview (WebContent process presumed dead \
             after screen lock)",
        );
        state.webview_health.arm_reload();
        match app.get_webview_window("main") {
            Some(win) => {
                if let Err(e) = win.reload() {
                    tracing::warn!(error = %e, "webview health: reload failed");
                }
            }
            None => tracing::warn!("webview health: main window not found"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::WebviewHealthState;

    #[test]
    fn check_blocked_until_ready() {
        let state = WebviewHealthState::default();
        assert_eq!(state.begin_check(), None);
        state.mark_ready();
        assert!(state.begin_check().is_some());
    }

    #[test]
    fn concurrent_check_blocked_while_in_flight() {
        let state = WebviewHealthState::default();
        state.mark_ready();
        let nonce = state.begin_check().expect("first check starts");
        assert_eq!(state.begin_check(), None);
        let _ = state.finish_check(nonce);
        assert!(state.begin_check().is_some());
    }

    #[test]
    fn matching_pong_is_healthy() {
        let state = WebviewHealthState::default();
        state.mark_ready();
        let nonce = state.begin_check().expect("check starts");
        state.record_pong(nonce);
        assert!(state.finish_check(nonce));
    }

    #[test]
    fn missing_pong_is_unhealthy() {
        let state = WebviewHealthState::default();
        state.mark_ready();
        let nonce = state.begin_check().expect("check starts");
        assert!(!state.finish_check(nonce));
    }

    #[test]
    fn stale_pong_is_unhealthy() {
        let state = WebviewHealthState::default();
        state.mark_ready();
        let first = state.begin_check().expect("first check starts");
        state.record_pong(first);
        assert!(state.finish_check(first));

        let second = state.begin_check().expect("second check starts");
        // Page never echoes `second`; the stale `first` pong must not count.
        assert!(!state.finish_check(second));
    }

    #[test]
    fn arm_reload_closes_gate_until_next_ready() {
        let state = WebviewHealthState::default();
        state.mark_ready();
        state.arm_reload();
        assert_eq!(state.begin_check(), None);
        // Late pong from the dying page must not reopen the gate.
        state.record_pong(42);
        assert_eq!(state.begin_check(), None);
        state.mark_ready();
        assert!(state.begin_check().is_some());
    }
}
