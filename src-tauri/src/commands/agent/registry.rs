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
    /// Unix-ms timestamp this session *entered* its current `state`, joined
    /// from the persisted `TrackedSession.last_state_at_unix_ms` by the query
    /// layer (the in-memory machine doesn't track it). Lets the frontend show
    /// the true completion age after a reload instead of a fabricated
    /// `Date.now()`. `None` for adapter rows and sessions with no persisted
    /// timestamp; omitted from the wire when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_entered_at_ms: Option<u64>,
    /// Whether the user already dismissed this session's current completion
    /// (persisted `TrackedSession.last_state_acked`). The frontend seeds its
    /// acknowledged-set from this so an acked "done" stays quiet across a
    /// webview reload / app restart. Always `false` on adapter rows.
    pub state_acked: bool,
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

    /// Resolve which registered machine a hook event for `kind` /
    /// `session_id` routes to, if any. The single source of truth for the
    /// routing rules — used by [`Self::route_hook_event`] and by the
    /// event-socket drain to decide whether a permission notification may
    /// be surfaced at all (a badge for a session no machine represents
    /// would be un-clearable).
    ///
    /// 1. A `Some(sid)` that resolves to a machine of the matching harness
    ///    routes to that machine.
    /// 2. Any other `Some(sid)` — unknown or harness-mismatched — routes
    ///    **nowhere**. A concrete-but-wrong id means the sender's env is
    ///    stale (killed pane, respawned session); applying its events to a
    ///    *different* session's machine would flip an unrelated pane.
    /// 3. `None` routes to the **sole** machine of that harness if exactly
    ///    one exists — the legacy no-`$RAUM_SESSION` case, where a single
    ///    candidate leaves no room for ambiguity *within the registry*.
    ///    With zero or ≥2 candidates it routes nowhere. Known limitation:
    ///    the registry is cross-project, so a session-less sender that is
    ///    NOT the sole registered machine (a harness hand-started with the
    ///    socket env but no session env, in another project) would be
    ///    attributed to it. Accepted: it requires deliberately running a
    ///    harness outside raum's spawn path while exactly one managed pane
    ///    of that harness exists, and the blast radius is that one pane.
    #[must_use]
    pub fn route_target(&self, kind: AgentKind, session_id: Option<&str>) -> Option<String> {
        if let Some(sid) = session_id {
            return self
                .machines
                .get(sid)
                .filter(|m| m.harness() == kind)
                .map(|_| sid.to_string());
        }
        let mut it = self.machines.iter().filter(|(_, m)| m.harness() == kind);
        match (it.next(), it.next()) {
            (Some((sid, _)), None) => Some(sid.clone()),
            _ => None,
        }
    }

    /// Route a hook event to the state machine it belongs to (per
    /// [`Self::route_target`]). `None` means the event was **unroutable**
    /// and has been dropped; `Some(transitions)` means it reached a machine
    /// (the vec is empty when the machine's state did not change). The
    /// distinction lets callers gate side effects — permission
    /// notifications, prompt recording — on the same routing decision
    /// without resolving the route twice.
    ///
    /// Unroutable events are **dropped**, never broadcast. The old
    /// behavior — applying an unknown-session event to every machine of
    /// the harness across all projects — meant a single stray `Stop` /
    /// `PermissionRequest` (harness run outside raum, stale env after a
    /// respawn, killed session) flipped *every* pane at once: the
    /// post-screen-lock "everything needs attention" storm. A wrong
    /// routing is strictly worse than a missed one here; the silence
    /// heuristic still recovers coarse Working/Idle state.
    pub fn route_hook_event(
        &mut self,
        kind: AgentKind,
        session_id: Option<&str>,
        event: &CoreHookEvent,
    ) -> Option<Vec<AgentStateChanged>> {
        let Some(target) = self.route_target(kind, session_id) else {
            let machine_count = self
                .machines
                .values()
                .filter(|m| m.harness() == kind)
                .count();
            if session_id.is_none() && machine_count == 0 {
                // Normal during boot, before rehydrate has registered
                // machines — not worth a warn.
                tracing::debug!(
                    harness = ?kind,
                    event = %event.event,
                    "hook event with no session and no machines of this harness; dropped",
                );
            } else {
                tracing::warn!(
                    harness = ?kind,
                    event = %event.event,
                    session_id = ?session_id,
                    machine_count,
                    "hook event for unroutable session dropped; refusing to broadcast or guess",
                );
            }
            return None;
        };
        if session_id.is_none() {
            tracing::debug!(
                harness = ?kind,
                event = %event.event,
                routed_to = %target,
                "session-less hook event routed to the sole machine of this harness",
            );
        }
        let machine = self.machines.get_mut(&target)?;
        Some(machine.on_hook_event(event).into_iter().collect())
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

    /// Re-arm output-based recovery when a parked permission request expires
    /// unanswered (`PermissionExpired`): the user will answer in the
    /// harness's own TUI, so the resulting output burst must be able to
    /// reclaim the machine out of `Waiting`. Resolves the target via
    /// [`Self::route_target`] so the legacy no-`$RAUM_SESSION` sole-machine
    /// case is covered too — those are exactly the sessions most likely to
    /// park a session-less request.
    pub fn arm_activity_for_permission_expiry(
        &mut self,
        kind: AgentKind,
        session_id: Option<&str>,
    ) -> bool {
        let Some(target) = self.route_target(kind, session_id) else {
            return false;
        };
        self.arm_activity_for_submit(&target)
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
                // Persisted state metadata is joined in by the query layer
                // (`agent_list` / `agent_snapshot`) against the config store —
                // the registry has no access to it. Leave defaults here.
                state_entered_at_ms: None,
                state_acked: false,
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
                state_entered_at_ms: None,
                state_acked: false,
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
