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

use std::borrow::Cow;

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

    #[must_use]
    pub fn from_label(label: &str) -> Option<Self> {
        match label {
            "deterministic" => Some(Self::Deterministic),
            "event-driven" => Some(Self::EventDriven),
            "heuristic" => Some(Self::Heuristic),
            _ => None,
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
    /// The harness is blocked on a prompt the user must answer, but the
    /// prompt is not a tool permission decision (e.g. a Claude Code MCP
    /// `elicitation_dialog` Notification, or an OpenCode SSE question).
    /// Claude's generic `idle_prompt` and `permission_prompt` subtypes
    /// are deliberately excluded — see `classify_notification_payload`.
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

    #[must_use]
    pub fn wire_event_name(self) -> &'static str {
        match self {
            Self::TurnStart => "UserPromptSubmit",
            Self::PermissionNeeded => "PermissionRequest",
            Self::IdlePromptNeeded => "Notification",
            Self::TurnEnd => "Stop",
            Self::Error => "Error",
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

/// Parse a hook payload that may arrive either as a structured JSON value
/// or as a JSON string emitted by a shell script over the UDS socket.
#[must_use]
pub fn decode_payload(payload: &serde_json::Value) -> Cow<'_, serde_json::Value> {
    if let Some(raw) = payload.as_str()
        && let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw)
    {
        return Cow::Owned(parsed);
    }
    Cow::Borrowed(payload)
}

/// Classify a raw hook-event name (matching the string emitted by the
/// installed hook scripts) into a [`NotificationKind`].
///
/// This is the Phase 1 bridge: it keeps the existing
/// [`crate::agent_state::classify_hook_event`] classifier callable for
/// backwards compatibility while giving the new code path a typed
/// classifier to delegate to.
#[must_use]
pub fn classify_notification_kind(event_name: &str) -> Option<NotificationKind> {
    match event_name {
        "Notification" => Some(NotificationKind::IdlePromptNeeded),
        "PermissionRequest" => Some(NotificationKind::PermissionNeeded),
        "Stop" => Some(NotificationKind::TurnEnd),
        "Error" | "ToolError" | "StopFailure" => Some(NotificationKind::Error),
        // SessionStart fires at harness boot before the user has typed
        // anything — it must not promote to Working. The state machine
        // still arms output-based recovery on SessionStart via
        // `AgentStateMachine::on_hook_event` so real PTY activity can
        // later flip Idle → Working.
        "SessionStart" => None,
        // Everything else (UserPromptSubmit, PreToolUse, …) counts as the
        // harness working.
        _ => Some(NotificationKind::TurnStart),
    }
}

/// Harness-aware classifier used by the state machine and the Tauri event
/// bridge. Returns `None` for observation-only notifications that should not
/// change the visible working / waiting / idle state.
#[must_use]
pub fn classify_notification_event(
    harness: AgentKind,
    event_name: &str,
    source: Option<&str>,
    payload: &serde_json::Value,
) -> Option<NotificationKind> {
    match event_name {
        "PermissionRequest" => Some(NotificationKind::PermissionNeeded),
        "Stop" => Some(NotificationKind::TurnEnd),
        "Error" | "ToolError" | "StopFailure" => Some(NotificationKind::Error),
        "Notification" => classify_notification_payload(harness, source, payload),
        // SessionStart is observed at harness boot before any real turn
        // has begun. Returning None keeps the machine in its current state
        // (Idle for a fresh session) while the state machine separately
        // arms output-based recovery on this event name.
        "SessionStart" => None,
        _ => Some(NotificationKind::TurnStart),
    }
}

fn classify_notification_payload(
    harness: AgentKind,
    source: Option<&str>,
    payload: &serde_json::Value,
) -> Option<NotificationKind> {
    let decoded = decode_payload(payload);
    match harness {
        AgentKind::ClaudeCode => match decoded
            .as_ref()
            .get("notification_type")
            .and_then(serde_json::Value::as_str)
        {
            // MCP elicitation is the only Notification subtype that
            // warrants Waiting: it has no synchronous PermissionRequest
            // counterpart, so raum would otherwise miss the blocked state.
            Some("elicitation_dialog") => Some(NotificationKind::IdlePromptNeeded),
            // permission_prompt is a non-blocking echo of the synchronous
            // `PermissionRequest` hook (already drives Waiting on its own);
            // idle_prompt just means the prompt has been idle — if Stop
            // already landed the pane is Completed and must stay there,
            // otherwise the silence heuristic demotes Working → Idle;
            // auth_success / anything else is observational.
            _ => None,
        },
        AgentKind::Codex => {
            if source != Some("notify") {
                return None;
            }
            match decoded
                .as_ref()
                .get("type")
                .and_then(serde_json::Value::as_str)
            {
                Some(kind) if kind.contains("approval-requested") => {
                    Some(NotificationKind::PermissionNeeded)
                }
                Some(kind) if kind.contains("agent-turn-complete") => {
                    Some(NotificationKind::TurnEnd)
                }
                _ => None,
            }
        }
        AgentKind::OpenCode => {
            if source == Some("opencode-sse") {
                return Some(NotificationKind::IdlePromptNeeded);
            }
            None
        }
        AgentKind::Shell => None,
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
        assert_eq!(
            Reliability::from_label("event-driven"),
            Some(Reliability::EventDriven)
        );
        assert_eq!(Reliability::from_label("unknown"), None);
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
        assert_eq!(
            NotificationKind::PermissionNeeded.wire_event_name(),
            "PermissionRequest"
        );
    }

    #[test]
    fn classifier_maps_known_hook_names() {
        assert_eq!(
            classify_notification_kind("Notification"),
            Some(NotificationKind::IdlePromptNeeded)
        );
        assert_eq!(
            classify_notification_kind("PermissionRequest"),
            Some(NotificationKind::PermissionNeeded)
        );
        assert_eq!(
            classify_notification_kind("Stop"),
            Some(NotificationKind::TurnEnd)
        );
        assert_eq!(
            classify_notification_kind("Error"),
            Some(NotificationKind::Error)
        );
        assert_eq!(
            classify_notification_kind("StopFailure"),
            Some(NotificationKind::Error)
        );
        assert_eq!(
            classify_notification_kind("UserPromptSubmit"),
            Some(NotificationKind::TurnStart)
        );
        // SessionStart is observational only — must not drive state.
        assert_eq!(classify_notification_kind("SessionStart"), None);
    }

    #[test]
    fn classify_notification_event_ignores_session_start() {
        assert_eq!(
            classify_notification_event(
                AgentKind::Codex,
                "SessionStart",
                None,
                &serde_json::Value::Null,
            ),
            None
        );
        assert_eq!(
            classify_notification_event(
                AgentKind::ClaudeCode,
                "SessionStart",
                None,
                &serde_json::Value::Null,
            ),
            None
        );
    }

    #[test]
    fn decode_payload_parses_json_string_payloads() {
        let raw = serde_json::Value::String("{\"notification_type\":\"idle_prompt\"}".into());
        let decoded = decode_payload(&raw);
        assert_eq!(
            decoded
                .as_ref()
                .get("notification_type")
                .and_then(serde_json::Value::as_str),
            Some("idle_prompt")
        );
    }

    #[test]
    fn classify_notification_event_is_harness_aware() {
        assert_eq!(
            classify_notification_event(
                AgentKind::ClaudeCode,
                "Notification",
                None,
                &serde_json::json!({ "notification_type": "elicitation_dialog" }),
            ),
            Some(NotificationKind::IdlePromptNeeded)
        );
        // idle_prompt is observational — Claude is just idle at the
        // prompt, the harness is not blocked on anything the user has
        // to answer.
        assert_eq!(
            classify_notification_event(
                AgentKind::ClaudeCode,
                "Notification",
                None,
                &serde_json::json!({ "notification_type": "idle_prompt" }),
            ),
            None
        );
        // permission_prompt is a non-blocking echo of the synchronous
        // `PermissionRequest` hook and must not drive a transition on
        // its own.
        assert_eq!(
            classify_notification_event(
                AgentKind::ClaudeCode,
                "Notification",
                None,
                &serde_json::json!({ "notification_type": "permission_prompt" }),
            ),
            None
        );
        assert_eq!(
            classify_notification_event(
                AgentKind::ClaudeCode,
                "Notification",
                None,
                &serde_json::json!({ "notification_type": "auth_success" }),
            ),
            None
        );
        assert_eq!(
            classify_notification_event(
                AgentKind::Codex,
                "Notification",
                Some("notify"),
                &serde_json::json!({ "type": "agent-turn-complete" }),
            ),
            Some(NotificationKind::TurnEnd)
        );
        assert_eq!(
            classify_notification_event(
                AgentKind::Codex,
                "Notification",
                None,
                &serde_json::json!({ "type": "agent-turn-complete" }),
            ),
            None
        );
        assert_eq!(
            classify_notification_event(
                AgentKind::OpenCode,
                "Notification",
                Some("opencode-sse"),
                &serde_json::Value::Null,
            ),
            Some(NotificationKind::IdlePromptNeeded)
        );
        assert_eq!(
            classify_notification_event(
                AgentKind::OpenCode,
                "Notification",
                None,
                &serde_json::Value::Null,
            ),
            None
        );
        assert_eq!(
            classify_notification_event(
                AgentKind::OpenCode,
                "PermissionRequest",
                Some("opencode-sse"),
                &serde_json::Value::Null,
            ),
            Some(NotificationKind::PermissionNeeded)
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
