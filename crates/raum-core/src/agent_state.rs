//! Agent state machine (§7.7).
//!
//! Drives `{Idle, Working, Waiting, Completed, Errored}` transitions from hook
//! events (Claude Code, OpenCode) or Codex JSON stream events, with a silence
//! heuristic fallback per harness.
//!
//! The machine is intentionally synchronous and pure — the broadcast plumbing
//! to the Tauri webview lives one layer up (see `src-tauri/src/commands/agent.rs`).

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::agent::{AgentKind, AgentState, SessionId};
use crate::config::DEFAULT_SILENCE_THRESHOLD_MS;
use crate::harness::Reliability;

/// Hook event shape consumed by the state machine.
///
/// Structurally identical to `raum_hooks::HookEvent`; duplicated here to avoid
/// a dependency cycle between `raum-core` and `raum-hooks` (the latter already
/// depends on `AgentKind` from `raum-core`). The `src-tauri` layer performs
/// the trivial `From<raum_hooks::HookEvent>` conversion at the adapter edge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookEvent {
    pub harness: String,
    pub event: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// A state transition record that can be re-emitted onto the Tauri event bus
/// (`agent-state-changed`, §7.8).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AgentStateChanged {
    pub session_id: SessionId,
    pub harness: AgentKind,
    pub from: AgentState,
    pub to: AgentState,
    /// How confident we are in the transition. Replaces the previous
    /// `via_silence_heuristic: bool` flag (per-harness notification plan,
    /// Phase 1). `Deterministic` / `EventDriven` transitions came from a
    /// harness-native signal (hook, SSE, OSC); `Heuristic` transitions
    /// came from the silence fallback in `tick_silence`.
    pub reliability: Reliability,
}

#[derive(Debug, Clone)]
pub struct AgentStateMachine {
    session_id: SessionId,
    harness: AgentKind,
    state: AgentState,
    silence_threshold: Duration,
    /// When true, the machine bases Working→Waiting purely on silence ticks
    /// (fallback path, §7.11).
    silence_only: bool,
}

impl AgentStateMachine {
    #[must_use]
    pub fn new(session_id: SessionId, harness: AgentKind) -> Self {
        Self {
            session_id,
            harness,
            state: AgentState::Idle,
            silence_threshold: Duration::from_millis(DEFAULT_SILENCE_THRESHOLD_MS),
            silence_only: false,
        }
    }

    #[must_use]
    pub fn with_silence_threshold(mut self, threshold: Duration) -> Self {
        self.silence_threshold = threshold;
        self
    }

    /// Switch to silence-heuristic-only mode for this harness. Used when the
    /// hooks dir is not writable (`HookScriptError::NotWritable`, §7.11).
    pub fn set_silence_only(&mut self, yes: bool) {
        self.silence_only = yes;
    }

    #[must_use]
    pub fn state(&self) -> AgentState {
        self.state
    }

    #[must_use]
    pub fn harness(&self) -> AgentKind {
        self.harness
    }

    #[must_use]
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    #[must_use]
    pub fn silence_threshold(&self) -> Duration {
        self.silence_threshold
    }

    /// Apply a hook event. Returns `Some(change)` if the state advanced.
    pub fn on_hook_event(&mut self, ev: &HookEvent) -> Option<AgentStateChanged> {
        if self.silence_only {
            // In fallback mode, the only signal is silence. Treat hook events
            // purely as "activity" → Working. The transition itself is still
            // deterministic (we saw a real hook fire) even though the
            // downstream Waiting transition will be heuristic.
            return self.transition(AgentState::Working, Reliability::Deterministic);
        }
        let next = classify_hook_event(&ev.event);
        self.transition(next, Reliability::Deterministic)
    }

    /// Apply a Codex-stream event. The `event` name space is the same as
    /// `HookEvent::event` so we delegate.
    pub fn on_codex_event(&mut self, event_name: &str) -> Option<AgentStateChanged> {
        let next = classify_hook_event(event_name);
        self.transition(next, Reliability::Deterministic)
    }

    /// Silence-heuristic tick: the caller supplies the age of the last stdout
    /// chunk observed on the pane. If we're currently Working and the age
    /// crosses the threshold, advance to Waiting.
    pub fn tick_silence(&mut self, last_output_age: Duration) -> Option<AgentStateChanged> {
        if self.state != AgentState::Working {
            return None;
        }
        if last_output_age >= self.silence_threshold {
            return self.transition(AgentState::Waiting, Reliability::Heuristic);
        }
        None
    }

    fn transition(
        &mut self,
        next: AgentState,
        reliability: Reliability,
    ) -> Option<AgentStateChanged> {
        if next == self.state {
            return None;
        }
        let from = self.state;
        self.state = next;
        Some(AgentStateChanged {
            session_id: self.session_id.clone(),
            harness: self.harness,
            from,
            to: next,
            reliability,
        })
    }
}

fn classify_hook_event(name: &str) -> AgentState {
    match name {
        "Notification" => AgentState::Waiting,
        "Stop" => AgentState::Completed,
        "Error" | "ToolError" => AgentState::Errored,
        // Any other event (UserPromptSubmit, PreToolUse, Working, ...) counts
        // as "agent is working".
        _ => AgentState::Working,
    }
}

/// Per-session silence threshold overrides (maps a harness name → millis).
///
/// Used by callers that want to apply per-harness thresholds coming from
/// `~/.config/raum/config.toml` `agent_defaults.silence_threshold_ms`.
#[must_use]
pub fn resolve_silence_threshold(
    harness: AgentKind,
    overrides: &BTreeMap<String, u64>,
) -> Duration {
    let key = match harness {
        AgentKind::Shell => "shell",
        AgentKind::ClaudeCode => "claude-code",
        AgentKind::Codex => "codex",
        AgentKind::OpenCode => "opencode",
    };
    if let Some(ms) = overrides.get(key) {
        return Duration::from_millis(*ms);
    }
    Duration::from_millis(DEFAULT_SILENCE_THRESHOLD_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sm() -> AgentStateMachine {
        AgentStateMachine::new(SessionId::new("raum-abc"), AgentKind::ClaudeCode)
    }

    fn ev(name: &str) -> HookEvent {
        HookEvent {
            harness: "claude-code".into(),
            event: name.into(),
            payload: serde_json::Value::Null,
        }
    }

    #[test]
    fn starts_idle() {
        assert_eq!(sm().state(), AgentState::Idle);
    }

    #[test]
    fn user_prompt_submit_moves_to_working() {
        let mut m = sm();
        let change = m.on_hook_event(&ev("UserPromptSubmit")).unwrap();
        assert_eq!(change.from, AgentState::Idle);
        assert_eq!(change.to, AgentState::Working);
        assert_eq!(m.state(), AgentState::Working);
    }

    #[test]
    fn notification_moves_to_waiting() {
        let mut m = sm();
        m.on_hook_event(&ev("UserPromptSubmit"));
        let change = m.on_hook_event(&ev("Notification")).unwrap();
        assert_eq!(change.to, AgentState::Waiting);
        assert_eq!(change.reliability, Reliability::Deterministic);
    }

    #[test]
    fn stop_moves_to_completed() {
        let mut m = sm();
        m.on_hook_event(&ev("UserPromptSubmit"));
        let change = m.on_hook_event(&ev("Stop")).unwrap();
        assert_eq!(change.to, AgentState::Completed);
    }

    #[test]
    fn error_event_moves_to_errored() {
        let mut m = sm();
        m.on_hook_event(&ev("UserPromptSubmit"));
        let change = m.on_hook_event(&ev("Error")).unwrap();
        assert_eq!(change.to, AgentState::Errored);
    }

    #[test]
    fn repeated_event_is_noop() {
        let mut m = sm();
        let first = m.on_hook_event(&ev("UserPromptSubmit"));
        let second = m.on_hook_event(&ev("UserPromptSubmit"));
        assert!(first.is_some());
        assert!(second.is_none());
    }

    #[test]
    fn silence_advances_working_to_waiting_after_threshold() {
        let mut m = sm().with_silence_threshold(Duration::from_millis(100));
        m.on_hook_event(&ev("UserPromptSubmit"));
        // Below threshold: no transition.
        assert!(m.tick_silence(Duration::from_millis(50)).is_none());
        // At / above threshold: → Waiting, flagged via heuristic.
        let change = m.tick_silence(Duration::from_millis(150)).unwrap();
        assert_eq!(change.to, AgentState::Waiting);
        assert_eq!(change.reliability, Reliability::Heuristic);
    }

    #[test]
    fn silence_is_ignored_when_not_working() {
        let mut m = sm();
        // Still Idle — tick should not fire.
        assert!(m.tick_silence(Duration::from_secs(10)).is_none());
    }

    #[test]
    fn codex_event_classifies_like_hook_event() {
        let mut m = AgentStateMachine::new(SessionId::new("s"), AgentKind::Codex);
        assert_eq!(
            m.on_codex_event("UserPromptSubmit").unwrap().to,
            AgentState::Working
        );
        assert_eq!(
            m.on_codex_event("Notification").unwrap().to,
            AgentState::Waiting
        );
    }

    #[test]
    fn silence_only_fallback_treats_hooks_as_activity() {
        let mut m = sm().with_silence_threshold(Duration::from_millis(100));
        m.set_silence_only(true);
        // Any hook event → Working, regardless of the event name.
        let change = m.on_hook_event(&ev("Notification")).unwrap();
        assert_eq!(change.to, AgentState::Working);
    }

    #[test]
    fn resolve_silence_threshold_uses_default_when_missing() {
        let empty = BTreeMap::new();
        let d = resolve_silence_threshold(AgentKind::ClaudeCode, &empty);
        assert_eq!(d, Duration::from_millis(DEFAULT_SILENCE_THRESHOLD_MS));
    }

    #[test]
    fn resolve_silence_threshold_honors_override() {
        let mut m = BTreeMap::new();
        m.insert("codex".into(), 2000u64);
        let d = resolve_silence_threshold(AgentKind::Codex, &m);
        assert_eq!(d, Duration::from_secs(2));
    }
}
