//! Agent registry, state-machine map, and broadcast event bus.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use raum_core::agent::{AgentAdapter, AgentKind};
use raum_core::agent_state::{
    AgentStateChanged, AgentStateMachine, HookEvent as CoreHookEvent, PromptEntry, PromptUpdated,
};
use raum_core::harness::default_registry;
use serde::Serialize;
use tokio::sync::broadcast;

/// Number of `AgentStateChanged` records the broadcast channel buffers before
/// slow subscribers start losing events. 256 is comfortable for bursty hook
/// traffic while keeping memory bounded.
pub const AGENT_EVENT_CHANNEL_CAPACITY: usize = 256;

/// Rendered adapter descriptor for the top-row UI.
#[derive(Debug, Serialize)]
pub struct AgentListItem {
    pub session_id: Option<String>,
    pub harness: AgentKind,
    pub state: raum_core::agent::AgentState,
    pub supports_native_events: bool,
    /// The user's most recently submitted prompt for this session, if
    /// any. Surfaced on the snapshot so the frontend can render the tab
    /// subtitle on rehydrate without waiting for a fresh
    /// `pane:prompt-updated` emit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_prompt: Option<PromptEntry>,
}

/// Shared agent registry + state-machine map. Stored behind `Arc<Mutex<_>>`
/// inside `AppHandleState` (additive field; safe to add to alongside other
/// Wave-2 owners).
#[derive(Default)]
pub struct AgentRegistry {
    adapters: Vec<Arc<dyn AgentAdapter>>,
    machines: HashMap<String, AgentStateMachine>,
}

impl std::fmt::Debug for AgentRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentRegistry")
            .field("adapter_count", &self.adapters.len())
            .field("machine_count", &self.machines.len())
            .finish()
    }
}

impl AgentRegistry {
    #[must_use]
    pub fn with_defaults() -> Self {
        Self {
            adapters: default_registry(),
            machines: HashMap::new(),
        }
    }

    #[must_use]
    pub fn find_adapter(&self, kind: AgentKind) -> Option<Arc<dyn AgentAdapter>> {
        self.adapters.iter().find(|a| a.kind() == kind).cloned()
    }

    #[must_use]
    #[allow(dead_code)]
    pub fn adapters(&self) -> &[Arc<dyn AgentAdapter>] {
        &self.adapters
    }

    /// Clobbering register (inserts unconditionally). Production callers
    /// should prefer `register_machine_if_absent` so a pre-populated
    /// machine (e.g. from the startup rehydrate task) isn't reset to
    /// its seed on a later reattach. Kept for tests that want to force
    /// a specific state into the registry.
    #[cfg(test)]
    pub fn register_machine(&mut self, machine: AgentStateMachine) {
        self.machines
            .insert(machine.session_id().as_str().to_string(), machine);
    }

    /// Idempotent counterpart to `register_machine`: inserts `machine` only
    /// when no entry exists for its session_id. Returns `true` when the
    /// machine was inserted, `false` when an entry already existed (the
    /// caller's `machine` is dropped in that case). Used by the reattach
    /// path so a state machine pre-populated by the startup rehydrate
    /// bootstrap keeps any in-flight transitions instead of being reset to
    /// the `last_state` seed a second time.
    pub fn register_machine_if_absent(&mut self, machine: AgentStateMachine) -> bool {
        let sid = machine.session_id().as_str().to_string();
        if self.machines.contains_key(&sid) {
            return false;
        }
        self.machines.insert(sid, machine);
        true
    }

    /// Flip the silence-only fallback flag on an existing machine without
    /// otherwise touching its state. Used on reattach to re-sync the flag
    /// when the hook-installed status changed between startup rehydrate
    /// (where the event socket may not have been bound yet) and the user
    /// actually opening a pane. Returns `true` iff the machine existed.
    pub fn set_silence_only(&mut self, session_id: &str, silence_only: bool) -> bool {
        let Some(machine) = self.machines.get_mut(session_id) else {
            return false;
        };
        machine.set_silence_only(silence_only);
        true
    }

    /// Drop the state machine for a session. Called by `terminal_kill` so
    /// the silence-tick task doesn't keep emitting heuristic transitions
    /// on a dead session id.
    pub fn remove_machine(&mut self, session_id: &str) -> bool {
        self.machines.remove(session_id).is_some()
    }

    /// Apply a hook event to every state machine whose harness matches
    /// `kind`. Returns the subset of resulting transitions (`None` when
    /// the machine's state did not change). Called by the event-socket
    /// drain task when no session_id is present on the wire (legacy
    /// fire-and-forget events).
    pub fn apply_hook_to_matching(
        &mut self,
        kind: AgentKind,
        event: &CoreHookEvent,
    ) -> Vec<AgentStateChanged> {
        let mut out = Vec::new();
        for machine in self.machines.values_mut() {
            if machine.harness() != kind {
                continue;
            }
            if let Some(change) = machine.on_hook_event(event) {
                out.push(change);
            }
        }
        out
    }

    /// Phase-2 session-scoped routing: apply `event` to only the
    /// machine matching `session_id`, if one exists. Falls back to
    /// broadcasting by harness when the session is unknown — some
    /// hook events race the spawn path and arrive before
    /// `agent_spawn` has registered the state machine.
    pub fn apply_hook_for_session(
        &mut self,
        kind: AgentKind,
        session_id: &str,
        event: &CoreHookEvent,
    ) -> Vec<AgentStateChanged> {
        if let Some(machine) = self.machines.get_mut(session_id) {
            if machine.harness() == kind {
                if let Some(change) = machine.on_hook_event(event) {
                    return vec![change];
                }
                return Vec::new();
            }
        }
        self.apply_hook_to_matching(kind, event)
    }

    /// Walk every registered machine and advance it via the silence
    /// heuristic. Machines without a recorded `last_output_at` are
    /// skipped — they are still spinning up, or the PTY tap has not
    /// fired yet. Used by the silence-tick task in
    /// [`super::silence::spawn_silence_tick`] so the UI can recover
    /// activity / idle state when a harness-native event path is
    /// unavailable.
    pub fn tick_silence_all(
        &mut self,
        last_output_at: &HashMap<String, Instant>,
        now: Instant,
    ) -> Vec<AgentStateChanged> {
        let mut out = Vec::new();
        for (sid, machine) in self.machines.iter_mut() {
            let Some(last) = last_output_at.get(sid) else {
                continue;
            };
            let age = now.saturating_duration_since(*last);
            if let Some(change) = machine.tick_silence(age) {
                out.push(change);
            }
        }
        out
    }

    #[must_use]
    pub fn state_for(&self, session_id: &str) -> Option<raum_core::agent::AgentState> {
        self.machines.get(session_id).map(|m| m.state())
    }

    /// The user submitting input is the first trustworthy signal that a future
    /// burst of PTY output belongs to a real turn rather than startup or
    /// attach redraw. This arms output-based recovery for sessions whose
    /// follow-up start hook is missed.
    pub fn arm_activity_for_submit(&mut self, session_id: &str) -> bool {
        let Some(machine) = self.machines.get_mut(session_id) else {
            return false;
        };
        machine.arm_activity();
        true
    }

    /// The user pressed the abort key (Ctrl-C) in this pane. No harness
    /// emits a cancellation hook, so this synthetic signal is the only way
    /// the state machine can return to `Idle` without waiting for the full
    /// silence heuristic. Working/Waiting → Idle; other states are left
    /// alone (terminal semantics preserved).
    pub fn abort_session(&mut self, session_id: &str) -> Option<AgentStateChanged> {
        self.machines.get_mut(session_id)?.on_user_abort()
    }

    /// The user answered a permission prompt for this session. Demote
    /// Waiting → Working so the NEXT `PermissionRequest` produces a
    /// visible state transition (without this, the machine sticks at
    /// Waiting and every subsequent request is a silent no-op).
    pub fn on_permission_reply(&mut self, session_id: &str) -> Option<AgentStateChanged> {
        self.machines.get_mut(session_id)?.on_permission_reply()
    }

    /// Record the user's most recently submitted prompt for `session_id`.
    /// Returns the resulting [`PromptUpdated`] record so the caller can
    /// broadcast it on the prompt bus and persist it. Returns `None` when
    /// no machine is registered for the session yet (the spawn path
    /// occasionally races the first hook).
    pub fn record_user_prompt(
        &mut self,
        session_id: &str,
        text: String,
        submitted_at_ms: u64,
    ) -> Option<PromptUpdated> {
        Some(
            self.machines
                .get_mut(session_id)?
                .record_user_prompt(text, submitted_at_ms),
        )
    }

    /// Seed a session machine with a previously-persisted prompt. Used
    /// by the rehydration path so a freshly-relaunched raum repopulates
    /// the tab subtitle without waiting for a fresh submit.
    pub fn seed_last_prompt(&mut self, session_id: &str, entry: PromptEntry) -> bool {
        let Some(machine) = self.machines.get_mut(session_id) else {
            return false;
        };
        machine.seed_last_prompt(entry);
        true
    }

    /// Snapshot the last-known prompt for a session, if any.
    #[must_use]
    pub fn last_prompt(&self, session_id: &str) -> Option<PromptEntry> {
        self.machines.get(session_id)?.last_prompt().cloned()
    }

    #[must_use]
    pub fn list(&self) -> Vec<AgentListItem> {
        let mut out = Vec::new();
        for adapter in &self.adapters {
            out.push(AgentListItem {
                session_id: None,
                harness: adapter.kind(),
                state: raum_core::agent::AgentState::Idle,
                supports_native_events: adapter.supports_native_events(),
                last_prompt: None,
            });
        }
        for (id, machine) in &self.machines {
            out.push(AgentListItem {
                session_id: Some(id.clone()),
                harness: machine.harness(),
                state: machine.state(),
                supports_native_events: self
                    .find_adapter(machine.harness())
                    .is_some_and(|a| a.supports_native_events()),
                last_prompt: machine.last_prompt().cloned(),
            });
        }
        out
    }
}

/// Broadcast channel owner. Instantiated lazily via `OnceLock` so we don't
/// need to touch `AppHandleState::default()` unnecessarily — the first call
/// to any agent command populates the channel and spawns the re-emit task.
///
/// Two parallel channels: state changes and prompt updates. They share the
/// same backlog budget — a sibling channel for prompts keeps the wire
/// schema for `agent-state-changed` unchanged while still letting the
/// bridge task fan-out a separate `pane:prompt-updated` event.
pub struct AgentEventBus {
    pub tx: broadcast::Sender<AgentStateChanged>,
    pub prompt_tx: broadcast::Sender<PromptUpdated>,
}

impl std::fmt::Debug for AgentEventBus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentEventBus")
            .field("receiver_count", &self.tx.receiver_count())
            .field("prompt_receiver_count", &self.prompt_tx.receiver_count())
            .finish()
    }
}

impl AgentEventBus {
    #[must_use]
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(AGENT_EVENT_CHANNEL_CAPACITY);
        let (prompt_tx, _prompt_rx) = broadcast::channel(AGENT_EVENT_CHANNEL_CAPACITY);
        Self { tx, prompt_tx }
    }
}

impl Default for AgentEventBus {
    fn default() -> Self {
        Self::new()
    }
}

// The `AgentRegistry` / `AgentEventBus` fields are exposed through
// `state::AppHandleState`; see that module for the wiring.
