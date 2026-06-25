//! App-lifecycle commands + the quit-flush protocol (Contract 1) and the
//! rehydrate-ready poll (Contract 2).
//!
//! ## Quit-flush (Contract 1)
//!
//! Several recovery-critical writes are debounced on the FRONTEND: the
//! active-layout save (500 ms) and the per-pane terminal snapshots (2 s). A
//! naive window close tears down the webview with those timers still pending,
//! losing the last layout mutation and the freshest scrollback — which on the
//! next launch surfaces as panes missing from the grid (dock orphans) and
//! stale/empty restored terminals.
//!
//! To close that window the backend intercepts the close, asks the frontend to
//! flush, and only then exits:
//!
//! 1. `WindowEvent::CloseRequested` → [`begin_quit_flush`] calls
//!    `api.prevent_close()`, emits the `app-will-quit` event, and parks waiting
//!    for the frontend.
//! 2. The frontend listens for `app-will-quit`, flushes its debounced writers,
//!    then invokes [`app_quit_flush_done`].
//! 3. On ack OR a bounded timeout the backend runs its own final flush (a short
//!    grace so any in-flight agent-state hook event still riding the
//!    event-socket drain lands in `sessions.toml`, whose writes are synchronous)
//!    and then `app.exit(0)`.
//!
//! Re-entrancy: `CloseRequested` fires again after we call `app.exit(0)`, so the
//! whole dance is guarded by [`QUIT_IN_PROGRESS`]; the second and later events
//! are allowed to proceed (do nothing / let the close happen).

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{Emitter, Runtime};
use tokio::sync::Notify;
use tracing::{info, warn};

use crate::state::AppHandleState;

/// Set once the quit-flush dance has started so a re-fired `CloseRequested`
/// (Tauri delivers another after `app.exit`) doesn't restart it.
static QUIT_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Signalled by [`app_quit_flush_done`] when the frontend has finished
/// flushing its debounced writers. The quit task waits on this (bounded).
fn quit_ack() -> &'static Notify {
    static ACK: OnceLock<Notify> = OnceLock::new();
    ACK.get_or_init(Notify::new)
}

/// Hard ceiling on how long the backend waits for the frontend flush ack
/// before forcing the exit. Generous enough for a couple of synchronous IPC
/// round-trips + the snapshot serialization, short enough that the window
/// never feels stuck on quit.
const QUIT_FLUSH_TIMEOUT: Duration = Duration::from_millis(1500);

/// Grace period after the frontend ack (or timeout) during which the backend
/// lets the event-socket drain + agent-state bridge persist any in-flight hook
/// event to `sessions.toml`. `sessions.toml` writes are synchronous, so the
/// only loss is an event still sitting in the mpsc/broadcast at the instant of
/// exit; a short pause lets the freshest `last_state` / `last_prompt` land.
const QUIT_DRAIN_GRACE: Duration = Duration::from_millis(150);

/// Frontend → backend ack that all debounced writers have been flushed.
/// No-op-safe: extra calls just re-notify the (possibly already-consumed)
/// `Notify`, which is harmless.
#[tauri::command]
pub fn app_quit_flush_done() {
    quit_ack().notify_one();
}

/// Contract 2 — current value of the rehydrate-done latch. A pane that mounts
/// after `bootstrap_rehydrate_sessions` finished (and therefore missed the
/// `rehydrate:complete` event) polls this before committing to a
/// spawn/reattach decision, so the `recoverable_after_reboot` ghost is
/// guaranteed to have landed in the registry first.
#[tauri::command]
pub fn terminal_rehydrate_ready(state: tauri::State<'_, AppHandleState>) -> bool {
    *state.rehydrate_done_tx.borrow()
}

/// Entry point for the `WindowEvent::CloseRequested` handler (wired in
/// `lib.rs`). Returns `true` when it has taken ownership of the close (caller
/// must NOT let the window close — `api.prevent_close()` was already invoked by
/// the caller), `false` when a quit is already in progress and the caller
/// should let the event fall through.
///
/// Spawns the async flush+exit task; the synchronous event callback returns
/// immediately so Tauri's event thread is never blocked.
pub fn begin_quit_flush<R: Runtime>(app: &tauri::AppHandle<R>) -> bool {
    if QUIT_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        // Already flushing (or the post-exit re-fire) — let it through.
        return false;
    }
    spawn_quit_task(app.clone());
    true
}

/// Fallback for non-window exits (`RunEvent::ExitRequested`). Same dance, but
/// the caller is responsible for calling `api.prevent_exit()`. Returns `false`
/// when a quit is already running (caller should not prevent the exit).
pub fn begin_quit_flush_for_exit<R: Runtime>(app: &tauri::AppHandle<R>) -> bool {
    if QUIT_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return false;
    }
    spawn_quit_task(app.clone());
    true
}

fn spawn_quit_task<R: Runtime>(app: tauri::AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        // Ask the frontend to flush its debounced writers (active-layout
        // 500 ms + terminal snapshots 2 s). If the webview is already gone
        // the emit just fails — we still fall through to the timeout + exit.
        if let Err(e) = app.emit("app-will-quit", ()) {
            warn!(error = %e, "quit-flush: app-will-quit emit failed; exiting after grace");
        }

        // Wait (bounded) for the frontend ack. A stuck or already-dead webview
        // must never wedge the quit, so the timeout always wins eventually.
        let notified = quit_ack().notified();
        match tokio::time::timeout(QUIT_FLUSH_TIMEOUT, notified).await {
            Ok(()) => info!("quit-flush: frontend flush acked"),
            Err(_) => warn!("quit-flush: timed out waiting for frontend ack; exiting anyway"),
        }

        // Backend final flush. raum has no live `DebouncedWriter` instances
        // today (config/session/layout writes are synchronous), so the only
        // backend-side debounce is the in-flight agent-state hook event riding
        // the event-socket drain. Give it a short grace to persist before exit.
        tokio::time::sleep(QUIT_DRAIN_GRACE).await;

        info!("quit-flush: complete; exiting");
        app.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_ack_is_a_stable_singleton() {
        // Both accessors must hand back the same Notify so the waiter in the
        // quit task and the `app_quit_flush_done` notifier rendezvous.
        let a = std::ptr::from_ref::<Notify>(quit_ack());
        let b = std::ptr::from_ref::<Notify>(quit_ack());
        assert_eq!(a, b);
    }

    #[tokio::test]
    async fn ack_before_wait_still_unblocks() {
        // `Notify::notify_one` stores a single permit, so an ack that races
        // ahead of the waiter (frontend flushed before the quit task parked on
        // `notified()`) is NOT lost — the subsequent wait returns immediately.
        // This is why the quit task can emit `app-will-quit` and only then await
        // the ack without missing a fast frontend.
        let n = Notify::new();
        n.notify_one(); // permit stored ahead of any waiter
        let r = tokio::time::timeout(Duration::from_millis(50), n.notified()).await;
        assert!(r.is_ok(), "a permit stored before the wait must unblock it");
    }

    #[tokio::test]
    async fn missing_ack_falls_back_to_timeout() {
        // With no ack at all the waiter must rely on the bounded timeout rather
        // than hang the quit forever (stuck / already-dead webview).
        let n = Notify::new();
        let r = tokio::time::timeout(Duration::from_millis(20), n.notified()).await;
        assert!(r.is_err(), "expected the wait to time out with no ack");
    }
}
