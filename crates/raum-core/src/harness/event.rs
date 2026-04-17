//! Notification event model (per-harness notification plan, Phase 1).
//!
//! [`NotificationEvent`] is the unified event shape emitted by every
//! harness notification source (hook socket, SSE stream, OSC scraper,
//! silence heuristic) once we finish the rollout. Phase 1 defines the
//! types and a classifier from `raum_hooks::HookEvent` so the Tauri-side
//! drain loop can translate wire events into a typed kind without
//! round-tripping through `String`.
//!
//! [`Reliability`] replaces the previous `via_silence_heuristic: bool`
//! flag on `AgentStateChanged`. It is strictly more expressive — a
//! three-valued enum the UI can render as a badge.

use serde::{Deserialize, Serialize};

use crate::agent::{AgentKind, AgentState, SessionId};

/// Identity of the channel that produced a [`NotificationEvent`]. Kept as
/// a lightweight newtype so callers can reason about provenance without
/// leaking enum variants across the crate boundary. Concrete channels
/// should use short, stable, ASCII-only identifiers such as
/// `"claude-hooks"`, `"opencode-sse"`, `"osc9"`, `"silence"`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SourceId(pub String);

impl SourceId {
    #[must_use]
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&'static str> for SourceId {
    fn from(s: &'static str) -> Self {
        Self(s.to_string())
    }
}

/// Opaque permission-request token passed back to the harness when
/// replying to a blocking prompt. Semantics are harness-specific — the
/// Claude Code hook handler will encode a socket-parked request id, the
/// OpenCode SSE channel will encode OpenCode's `permissionID` — but from
/// raum's perspective it is an opaque string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PermissionRequestId(pub String);

impl PermissionRequestId {
    #[must_use]
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// How deterministic the signal is. Rendered as a UI badge on the
/// Waiting state so users can tell a hook-driven prompt apart from a
/// silence-heuristic guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reliability {
    /// Fully deterministic — the harness told us directly via a
    /// synchronous channel (e.g. Claude Code hook script over UDS).
    Deterministic,
    /// Event-driven — the harness publishes structured events but the
    /// mapping to `NotificationKind` involves some heuristic (e.g.
    /// OpenCode SSE `session.idle`).
    EventDriven,
    /// Heuristic — we inferred state from an indirect signal such as
    /// stdout silence.
    Heuristic,
}

impl Reliability {
    /// Short, human-readable label. Used in logs; the frontend renders
    /// a badge from the serde value directly.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Deterministic => "deterministic",
            Self::EventDriven => "event-driven",
            Self::Heuristic => "heuristic",
        }
    }
}

/// Semantic classification of a notification event. Maps onto the
/// state machine in [`crate::agent_state`] via
/// [`classify_notification_kind`] / [`NotificationKind::target_state`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationKind {
    /// A new user-initiated turn started (prompt submitted, tool call,
    /// session boot). Advances the state machine to `Working`.
    TurnStart,
    /// The harness is blocked waiting on a permission decision the user
    /// must make. `NotificationEvent::request_id` is set when the
    /// channel can deliver a reply back to the harness.
    PermissionNeeded,
    /// The harness is idle and waiting for the user to type something,
    /// but no specific permission is pending (e.g. Claude Code
    /// `Notification` event without a decision).
    IdlePromptNeeded,
    /// The turn completed; state returns to `Completed` / `Idle`.
    TurnEnd,
    /// The harness emitted an error signal.
    Error,
}

impl NotificationKind {
    /// The [`AgentState`] that this kind drives the state machine
    /// toward.
    #[must_use]
    pub fn target_state(self) -> AgentState {
        match self {
            Self::TurnStart => AgentState::Working,
            Self::PermissionNeeded | Self::IdlePromptNeeded => AgentState::Waiting,
            Self::TurnEnd => AgentState::Completed,
            Self::Error => AgentState::Errored,
        }
    }
}

/// Unified notification event shape (Phase 1 wire type). Phase 2+ will
/// emit these from `NotificationChannel` implementations; for now the
/// type exists so downstream code can already depend on it while we
/// migrate producers one by one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NotificationEvent {
    pub session_id: SessionId,
    pub harness: AgentKind,
    pub kind: NotificationKind,
    pub source: SourceId,
    pub reliability: Reliability,
    /// Set for [`NotificationKind::PermissionNeeded`] events whose
    /// channel carries a replyable request id. `None` for
    /// observation-only permission events.
    pub request_id: Option<PermissionRequestId>,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// Classify a raw hook-event name (matching the string emitted by the
/// installed hook scripts) into a [`NotificationKind`].
///
/// This is the Phase 1 bridge: it keeps the existing
/// [`crate::agent_state::classify_hook_event`] classifier callable for
/// backwards compatibility while giving the new code path a typed
/// classifier to delegate to.
#[must_use]
pub fn classify_notification_kind(event_name: &str) -> NotificationKind {
    match event_name {
        "Notification" => NotificationKind::IdlePromptNeeded,
        "PermissionRequest" => NotificationKind::PermissionNeeded,
        "Stop" => NotificationKind::TurnEnd,
        "Error" | "ToolError" | "StopFailure" => NotificationKind::Error,
        // Everything else (UserPromptSubmit, PreToolUse, SessionStart, …)
        // counts as the harness working.
        _ => NotificationKind::TurnStart,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reliability_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_string(&Reliability::Deterministic).unwrap(),
            "\"deterministic\""
        );
        assert_eq!(
            serde_json::to_string(&Reliability::EventDriven).unwrap(),
            "\"event-driven\""
        );
        assert_eq!(
            serde_json::to_string(&Reliability::Heuristic).unwrap(),
            "\"heuristic\""
        );
    }

    #[test]
    fn notification_kind_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_string(&NotificationKind::TurnStart).unwrap(),
            "\"turn-start\""
        );
        assert_eq!(
            serde_json::to_string(&NotificationKind::PermissionNeeded).unwrap(),
            "\"permission-needed\""
        );
        assert_eq!(
            serde_json::to_string(&NotificationKind::IdlePromptNeeded).unwrap(),
            "\"idle-prompt-needed\""
        );
        assert_eq!(
            serde_json::to_string(&NotificationKind::TurnEnd).unwrap(),
            "\"turn-end\""
        );
        assert_eq!(
            serde_json::to_string(&NotificationKind::Error).unwrap(),
            "\"error\""
        );
    }

    #[test]
    fn target_state_mapping() {
        assert_eq!(
            NotificationKind::TurnStart.target_state(),
            AgentState::Working
        );
        assert_eq!(
            NotificationKind::PermissionNeeded.target_state(),
            AgentState::Waiting
        );
        assert_eq!(
            NotificationKind::IdlePromptNeeded.target_state(),
            AgentState::Waiting
        );
        assert_eq!(
            NotificationKind::TurnEnd.target_state(),
            AgentState::Completed
        );
        assert_eq!(NotificationKind::Error.target_state(), AgentState::Errored);
    }

    #[test]
    fn classifier_maps_known_hook_names() {
        assert_eq!(
            classify_notification_kind("Notification"),
            NotificationKind::IdlePromptNeeded
        );
        assert_eq!(
            classify_notification_kind("PermissionRequest"),
            NotificationKind::PermissionNeeded
        );
        assert_eq!(
            classify_notification_kind("Stop"),
            NotificationKind::TurnEnd
        );
        assert_eq!(classify_notification_kind("Error"), NotificationKind::Error);
        assert_eq!(
            classify_notification_kind("StopFailure"),
            NotificationKind::Error
        );
        assert_eq!(
            classify_notification_kind("UserPromptSubmit"),
            NotificationKind::TurnStart
        );
        assert_eq!(
            classify_notification_kind("SessionStart"),
            NotificationKind::TurnStart
        );
    }

    #[test]
    fn source_id_newtype_roundtrips() {
        let id = SourceId::from("claude-hooks");
        let s = serde_json::to_string(&id).unwrap();
        assert_eq!(s, "\"claude-hooks\"");
        let back: SourceId = serde_json::from_str(&s).unwrap();
        assert_eq!(back, id);
    }

    #[test]
    fn notification_event_roundtrips() {
        let ev = NotificationEvent {
            session_id: SessionId::new("raum-abc"),
            harness: AgentKind::ClaudeCode,
            kind: NotificationKind::PermissionNeeded,
            source: SourceId::from("claude-hooks"),
            reliability: Reliability::Deterministic,
            request_id: Some(PermissionRequestId::new("req-1")),
            payload: serde_json::json!({ "tool": "Bash" }),
        };
        let s = serde_json::to_string(&ev).unwrap();
        let back: NotificationEvent = serde_json::from_str(&s).unwrap();
        assert_eq!(back, ev);
    }
}
