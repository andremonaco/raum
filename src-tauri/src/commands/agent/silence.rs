//! Periodic silence-tick task: walks every state machine through
//! [`super::registry::AgentRegistry::tick_silence_all`] so the UI can recover
//! activity / idle state when a harness-native event path is unavailable.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use raum_core::agent_state::AgentStateChanged;
use tauri::{AppHandle, Manager, Runtime};
use tracing::warn;

/// Silence-heuristic tick interval. 250 ms is well below the state
/// machine's silence threshold (default 10 s, per-harness configurable),
/// so fallback state recovery reacts within a tick of a meaningful PTY
/// activity/silence change.
const SILENCE_TICK_INTERVAL: Duration = Duration::from_millis(250);

/// Spawn the periodic silence-tick task. Idempotent: guarded by a
/// `OnceLock` so repeated calls during hot-reload test paths are safe.
///
/// Reads `session_activity` timestamps (updated by the PTY bytes
/// callback in `commands::terminal::open_bridge_and_monitor`) and
/// walks every registered state machine through
/// [`super::registry::AgentRegistry::tick_silence_all`]. Resulting
/// transitions are published onto [`super::registry::AgentEventBus`]
/// the same way hook-driven transitions are, so the frontend
/// `agent-state-changed` listener treats them uniformly.
///
/// This is the only path that can recover `Idle -> Working`,
/// `Waiting -> Working`, `Completed -> Working`, and `Working -> Idle`
/// when the harness-native notification path never fires. Deterministic
/// "needs input" remains event-driven.
pub fn spawn_silence_tick<R: Runtime>(app: &AppHandle<R>) {
    static SPAWNED: OnceLock<()> = OnceLock::new();
    if SPAWNED.get().is_some() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(SILENCE_TICK_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let state: tauri::State<'_, crate::state::AppHandleState> = app.state();
            let activity_snapshot: HashMap<String, Instant> = {
                match state.session_activity.lock() {
                    Ok(g) => g.clone(),
                    Err(_) => {
                        warn!("silence-tick: session_activity lock poisoned; skipping tick");
                        continue;
                    }
                }
            };
            let now = Instant::now();
            let changes: Vec<AgentStateChanged> = {
                let Ok(mut registry) = state.agents.lock() else {
                    warn!("silence-tick: agent registry lock poisoned; skipping tick");
                    continue;
                };
                registry.tick_silence_all(&activity_snapshot, now)
            };
            if changes.is_empty() {
                continue;
            }
            let bus = &state.agent_events;
            for change in changes {
                // Broadcast only; persistence + emit happen in the
                // bridge task (see `super::runtime::ensure_bridge_running`)
                // so there is exactly one persist per transition regardless
                // of whether the transition originated from a hook, SSE,
                // or the silence heuristic.
                let _ = bus.tx.send(change);
            }
        }
    });
    let _ = SPAWNED.set(());
}
