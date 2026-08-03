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
//! Detection is therefore indirect, and it must separate two states that
//! look identical for the first few seconds after unlock: a *dead*
//! WebContent process (never answers, at any deadline) and a
//! *suspended-then-resumed* one (drains its queued event deliveries and
//! answers whenever the OS reschedules it — late, but it answers). Patience
//! can never produce a false negative here, only a slightly later true
//! positive, so on every window focus the backend runs a probe sequence:
//! after a short [`WAKE_GRACE`] it emits up to [`MAX_MISSES`] `raum:ping`s,
//! each with a [`PROBE_TIMEOUT`] wait and [`PROBE_BACKOFF`] spacing. Any
//! pong from the sequence — even a stale one for an earlier ping — proves
//! the page alive. Only ~12 s of total silence across six independently
//! queued deliveries declares the page dead, and we issue
//! [`tauri::webview::Webview::reload`] — the native `-[WKWebView reload]`,
//! Apple's documented recovery, which relaunches the content process.
//! Downstream recovery is the proven Cmd+R path: `app.tsx` rehydrates the
//! layout and every pane runs `terminal_reattach`, while the tmux sessions
//! (and the agents inside them) survive untouched.
//!
//! The cost of that patience: a genuinely dead page sits black ~12 s
//! instead of ~3 s before auto-recovery (Cmd+R remains the manual escape).
//! In exchange, a live page that is merely slow to wake is never reloaded —
//! a false-positive reload throws away the whole page and costs a full
//! rehydrate, far worse than the extra seconds on the rare true death.
//!
//! Kept cross-platform on purpose: webkit2gtk has the same web-process-crash
//! failure mode on Linux, and the check is free while the page is healthy.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

/// Settle time between `Focused(true)` and the first ping. The focus edge
/// is the most contended instant of a wake — the orphan reconciler, the
/// status service catch-up and the frontend resync all land there — and a
/// ping emitted into that stampede measures system load, not page health.
const WAKE_GRACE: Duration = Duration::from_millis(500);

/// How long each individual probe waits for proof of life. Deliberately
/// short: a miss is cheap now — it's just the next probe.
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// Spacing between probes, so the sequence emits six pings over ~12 s
/// instead of six in a burst.
const PROBE_BACKOFF: Duration = Duration::from_millis(500);

/// Consecutive misses before the page is presumed dead:
/// ~`6 × (1.5 s + 0.5 s) = 12 s` of total silence. The one observed
/// false positive answered 225 ms after the (unnecessary) reload — orders
/// of magnitude inside this budget. A page that runs no JS at all across
/// six independently queued deliveries for 12 s is beyond any credible
/// suspension; a dead process stays dead forever, so waiting costs little.
const MAX_MISSES: u32 = 6;

/// Pongs slower than this get logged — the "we nearly false-positived"
/// signal used to tune [`MAX_MISSES`] from real-world wake data.
const SLOW_PONG_LOG_THRESHOLD: Duration = Duration::from_millis(500);

/// Minimum spacing between reloads. Belt-and-braces against a reload loop
/// if a future bug makes the page die during boot.
const RELOAD_COOLDOWN: Duration = Duration::from_secs(120);

/// Outcome of one probe sequence.
enum ProbeOutcome {
    /// The page answered. `misses` counts the probes that timed out first;
    /// `lag` is measured from the first ping of the sequence.
    Alive { lag: Duration, misses: u32 },
    /// [`MAX_MISSES`] consecutive probes went unanswered.
    Dead,
}

/// Liveness-gate state.
pub struct WebviewHealthState {
    /// True once the frontend invoked `webview_ready` since the last reload
    /// we issued. Gates all probes so a slow first page load can never be
    /// mistaken for a dead one (which would cause a reload loop).
    ready: AtomicBool,
    /// Monotonic ping-nonce generator. Starts handing out 1, so the pong
    /// default of 0 can never satisfy a real probe.
    next_nonce: AtomicU64,
    /// Highest nonce echoed by `webview_pong` (watch channel so the probe
    /// task can await it instead of sleep-then-compare).
    pong_tx: tokio::sync::watch::Sender<u64>,
    /// True while a probe sequence is running. Doubles as a rate limit
    /// when the window is focus-cycled rapidly.
    probe_in_flight: AtomicBool,
    /// When the last reload was issued, for [`RELOAD_COOLDOWN`].
    /// Only ever locked briefly and never held across an await.
    last_reload: Mutex<Option<Instant>>,
}

impl Default for WebviewHealthState {
    fn default() -> Self {
        Self {
            ready: AtomicBool::new(false),
            next_nonce: AtomicU64::new(0),
            pong_tx: tokio::sync::watch::channel(0).0,
            probe_in_flight: AtomicBool::new(false),
            last_reload: Mutex::new(None),
        }
    }
}

impl WebviewHealthState {
    fn mark_ready(&self) {
        self.ready.store(true, Ordering::SeqCst);
        // A ready call is proof of life too: if the page reloaded (manual
        // Cmd+R) mid-sequence, its boot signal must satisfy the running
        // probe rather than let it count misses against the fresh page.
        self.record_pong(self.next_nonce.load(Ordering::SeqCst));
    }

    /// Deliberately does *not* set `ready`: a late pong from a dying page
    /// must not re-arm probes while a reload is in flight.
    fn record_pong(&self, nonce: u64) {
        // Keep the maximum — an out-of-order echo must never regress the
        // watermark below a pong the probe task may already have seen.
        self.pong_tx.send_if_modified(|last| {
            if nonce > *last {
                *last = nonce;
                true
            } else {
                false
            }
        });
    }

    /// Begin a probe sequence. Returns `since`, the first nonce this
    /// sequence will hand out: any pong `>= since` proves the page alive.
    /// `None` when the page never reported ready or a sequence is already
    /// running.
    fn begin_probe_sequence(&self) -> Option<u64> {
        if !self.ready.load(Ordering::SeqCst) {
            return None;
        }
        self.probe_in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()?;
        Some(self.next_nonce.load(Ordering::SeqCst) + 1)
    }

    fn next_probe_nonce(&self) -> u64 {
        self.next_nonce.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn end_probe_sequence(&self) {
        self.probe_in_flight.store(false, Ordering::SeqCst);
    }

    /// Close the gate until the freshly loaded page calls `webview_ready`.
    fn arm_reload(&self) {
        self.ready.store(false, Ordering::SeqCst);
    }

    /// Reopen the gate after a reload could NOT actually be issued (window
    /// lookup failed, `reload()` errored). The page — very possibly alive,
    /// given the false-positive history of this check — keeps running, and
    /// nothing else would ever set `ready` again (only a fresh page's
    /// `webview_ready` does), so leaving the gate closed would silently
    /// disable dead-WebContent recovery for the rest of the process.
    fn reopen_after_failed_reload(&self) {
        self.ready.store(true, Ordering::SeqCst);
    }

    /// True while the previous *issued* reload is younger than
    /// [`RELOAD_COOLDOWN`]. Read-only — pair with [`Self::record_reload`],
    /// which is called only once a reload was actually issued, so a failed
    /// attempt doesn't burn the cooldown.
    fn cooldown_active(&self, now: Instant) -> bool {
        self.last_reload
            .lock()
            .ok()
            .and_then(|last| *last)
            .is_some_and(|prev| now.duration_since(prev) < RELOAD_COOLDOWN)
    }

    fn record_reload(&self, now: Instant) {
        if let Ok(mut last) = self.last_reload.lock() {
            *last = Some(now);
        }
    }

    /// Run the ping/wait/backoff loop. `emit_ping` is injected so tests can
    /// drive the sequence without a Tauri runtime.
    async fn run_probes(&self, since: u64, mut emit_ping: impl FnMut(u64)) -> ProbeOutcome {
        let mut rx = self.pong_tx.subscribe();
        let started = tokio::time::Instant::now();
        for miss in 0..MAX_MISSES {
            emit_ping(self.next_probe_nonce());
            // `>= since`, not equality: a stale pong for an *earlier* ping of
            // this sequence is still proof the page runs JS — exactly the
            // evidence a slowly-resuming page produces. Collapsed to a bool
            // immediately: the `watch::Ref` guard is not `Send` and must not
            // live across the backoff await below.
            let hit = match tokio::time::timeout(PROBE_TIMEOUT, rx.wait_for(|last| *last >= since))
                .await
            {
                Ok(Ok(_)) => true,
                // Sender dropped — state is being torn down; nothing to do.
                Ok(Err(_)) => return ProbeOutcome::Dead,
                Err(_) => false,
            };
            if hit {
                return ProbeOutcome::Alive {
                    lag: started.elapsed(),
                    misses: miss,
                };
            }
            tracing::warn!(
                miss = miss + 1,
                max = MAX_MISSES,
                "webview health: probe missed"
            );
            tokio::time::sleep(PROBE_BACKOFF).await;
        }
        ProbeOutcome::Dead
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

/// Frontend → backend wake timing, so post-unlock phase costs land in the
/// daily log next to the probe/reload/reattach markers and "restore feels
/// slow" becomes measurable.
#[tauri::command]
pub fn webview_wake_report(phase: String, ms: u64) {
    tracing::info!(phase = %phase, ms, "webview wake");
}

/// Releases `probe_in_flight` when the probe task ends — including panic
/// and cancellation paths. Without this, one wedged sequence would leave
/// the flag set forever and silently disable dead-WebContent recovery for
/// the rest of the process.
struct ProbeSequenceGuard {
    app: AppHandle,
}

impl Drop for ProbeSequenceGuard {
    fn drop(&mut self) {
        let state: tauri::State<'_, crate::state::AppHandleState> = self.app.state();
        state.webview_health.end_probe_sequence();
    }
}

/// Run one focus-gated probe sequence. Called from the window-event
/// callback (Tauri's event thread), so all waiting happens on the async
/// runtime and the event loop is never blocked.
pub fn on_focus_gained(handle: &AppHandle) {
    let app = handle.clone();
    tauri::async_runtime::spawn(async move {
        let since = {
            let state: tauri::State<'_, crate::state::AppHandleState> = app.state();
            let Some(since) = state.webview_health.begin_probe_sequence() else {
                return;
            };
            since
        };
        let _guard = ProbeSequenceGuard { app: app.clone() };
        // The wake marker: everything after this line in the daily log
        // happened during this restore.
        tracing::info!("webview health: probe start");
        tokio::time::sleep(WAKE_GRACE).await;

        let state: tauri::State<'_, crate::state::AppHandleState> = app.state();
        let health = &state.webview_health;
        let emit_failures = AtomicU32::new(0);
        let outcome = health
            .run_probes(since, |nonce| {
                // Emitting into a dead WebContent process is a harmless
                // no-op — the missing pong is the actual signal. But a
                // backend-side emit failure is NOT evidence about the page,
                // so it is counted and, if every ping failed to emit, the
                // sequence is treated as inconclusive rather than dead.
                if let Err(e) = app.emit("raum:ping", nonce) {
                    emit_failures.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(error = %e, "webview health: ping emit failed");
                }
            })
            .await;

        match outcome {
            ProbeOutcome::Alive { lag, misses } => {
                if misses > 0 || lag > SLOW_PONG_LOG_THRESHOLD {
                    tracing::info!(
                        lag_ms = u64::try_from(lag.as_millis()).unwrap_or(u64::MAX),
                        misses,
                        "webview health: slow pong — page alive but waking slowly",
                    );
                }
            }
            ProbeOutcome::Dead => {
                if emit_failures.load(Ordering::Relaxed) >= MAX_MISSES {
                    tracing::warn!(
                        "webview health: every ping failed to emit — page health unknown, \
                         not reloading (a backend emit problem is not a dead page)",
                    );
                    return;
                }
                let now = Instant::now();
                if health.cooldown_active(now) {
                    tracing::warn!(
                        "webview health: no pong, but a reload ran moments ago — \
                         suppressing to avoid a reload loop",
                    );
                    return;
                }
                let Some(win) = app.get_webview_window("main") else {
                    tracing::warn!("webview health: main window not found; cannot reload");
                    return;
                };
                tracing::warn!(
                    misses = MAX_MISSES,
                    "webview health: no pong across the whole probe sequence — reloading \
                     webview (WebContent process presumed dead after screen lock)",
                );
                health.arm_reload();
                match win.reload() {
                    Ok(()) => health.record_reload(now),
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            "webview health: reload failed — reopening gate so future \
                             probes (and recovery) still run",
                        );
                        health.reopen_after_failed_reload();
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::{MAX_MISSES, ProbeOutcome, RELOAD_COOLDOWN, WebviewHealthState};

    #[test]
    fn probe_blocked_until_ready() {
        let state = WebviewHealthState::default();
        assert_eq!(state.begin_probe_sequence(), None);
        state.mark_ready();
        assert!(state.begin_probe_sequence().is_some());
    }

    #[test]
    fn concurrent_sequence_blocked_while_in_flight() {
        let state = WebviewHealthState::default();
        state.mark_ready();
        assert!(state.begin_probe_sequence().is_some());
        assert_eq!(state.begin_probe_sequence(), None);
        state.end_probe_sequence();
        assert!(state.begin_probe_sequence().is_some());
    }

    #[test]
    fn arm_reload_closes_gate_until_next_ready() {
        let state = WebviewHealthState::default();
        state.mark_ready();
        state.arm_reload();
        assert_eq!(state.begin_probe_sequence(), None);
        // Late pong from the dying page must not reopen the gate.
        state.record_pong(42);
        assert_eq!(state.begin_probe_sequence(), None);
        state.mark_ready();
        assert!(state.begin_probe_sequence().is_some());
    }

    #[test]
    fn reload_cooldown_blocks_second_reload() {
        let state = WebviewHealthState::default();
        let t = Instant::now();
        // No reload issued yet — cooldown must not be active.
        assert!(!state.cooldown_active(t));
        state.record_reload(t);
        assert!(state.cooldown_active(t + Duration::from_secs(1)));
        assert!(!state.cooldown_active(t + RELOAD_COOLDOWN));
    }

    #[test]
    fn failed_reload_reopens_the_gate() {
        let state = WebviewHealthState::default();
        state.mark_ready();
        state.arm_reload();
        // Gate closed: no fresh page will ever call `webview_ready` because
        // the reload never happened. The rollback must reopen probing.
        assert_eq!(state.begin_probe_sequence(), None);
        state.reopen_after_failed_reload();
        assert!(state.begin_probe_sequence().is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn stale_pong_in_same_sequence_counts_as_alive() {
        let state = Arc::new(WebviewHealthState::default());
        state.mark_ready();
        let since = state.begin_probe_sequence().expect("sequence starts");

        // Echo only the FIRST ping of the sequence, and do it late enough
        // (4.2 s) that two probes have already timed out — the sequence must
        // still conclude "alive" because pong-for-an-earlier-ping is proof
        // of life (the `>= since` predicate; the old `==` check failed this).
        let echo_state = Arc::clone(&state);
        let (first_ping_tx, first_ping_rx) = tokio::sync::oneshot::channel::<u64>();
        tokio::spawn(async move {
            let first = first_ping_rx.await.expect("first ping observed");
            tokio::time::sleep(Duration::from_millis(4200)).await;
            echo_state.record_pong(first);
        });

        let mut first_ping_tx = Some(first_ping_tx);
        let outcome = state
            .run_probes(since, move |nonce| {
                if let Some(tx) = first_ping_tx.take() {
                    let _ = tx.send(nonce);
                }
            })
            .await;

        match outcome {
            ProbeOutcome::Alive { misses, .. } => assert_eq!(misses, 2),
            ProbeOutcome::Dead => panic!("late pong must count as alive"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn pong_before_probe_start_does_not_count() {
        let state = Arc::new(WebviewHealthState::default());
        state.mark_ready();

        // A full earlier sequence whose pong was recorded...
        let first_since = state.begin_probe_sequence().expect("first sequence");
        let nonce = state.next_probe_nonce();
        state.record_pong(nonce);
        state.end_probe_sequence();

        // ...must not satisfy a NEW sequence that the page never answered.
        let since = state.begin_probe_sequence().expect("second sequence");
        assert!(since > first_since);
        let outcome = state.run_probes(since, |_| {}).await;
        assert!(matches!(outcome, ProbeOutcome::Dead));
    }

    #[tokio::test(start_paused = true)]
    async fn silent_page_is_dead_after_max_misses() {
        let state = Arc::new(WebviewHealthState::default());
        state.mark_ready();
        let since = state.begin_probe_sequence().expect("sequence starts");

        let mut pings = 0u32;
        let started = tokio::time::Instant::now();
        let outcome = state.run_probes(since, |_| pings += 1).await;

        assert!(matches!(outcome, ProbeOutcome::Dead));
        assert_eq!(pings, MAX_MISSES);
        // 6 × (1.5 s timeout + 0.5 s backoff) — the full patience budget.
        assert_eq!(started.elapsed(), Duration::from_secs(12));
    }

    #[tokio::test(start_paused = true)]
    async fn ready_mid_sequence_counts_as_alive() {
        let state = Arc::new(WebviewHealthState::default());
        state.mark_ready();
        let since = state.begin_probe_sequence().expect("sequence starts");

        // A manual Cmd+R lands mid-sequence: the fresh page boots and calls
        // `webview_ready` without ever echoing a ping. That boot signal must
        // satisfy the probe.
        let ready_state = Arc::clone(&state);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(700)).await;
            ready_state.mark_ready();
        });

        let outcome = state.run_probes(since, |_| {}).await;
        assert!(matches!(outcome, ProbeOutcome::Alive { .. }));
    }
}
