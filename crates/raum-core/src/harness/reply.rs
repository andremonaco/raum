//! Permission replier trait (Phase 2, per-harness notification plan).
//!
//! A [`PermissionReplier`] answers a parked permission request coming from
//! a harness. Each harness picks the transport that avoids racing with its
//! own TUI:
//!
//! * Claude Code → synchronous hook response (Phase 2).
//! * OpenCode → HTTP `POST /session/:sid/permissions/:pid` (Phase 4).
//! * Codex → no replier today; observation-only (Phase 3).
//!
//! Absence of a replier means "observation only" for that harness — the UI
//! surfaces a notification without action buttons, and the user answers
//! inside the harness's own TUI.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use crate::harness::event::PermissionRequestId;

/// User's answer to a permission prompt. Serialised kebab-case on the
/// wire so the Tauri command surface can pass it through verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Decision {
    /// Allow this one invocation.
    Allow,
    /// Allow and persist a permission rule so the harness stops asking.
    AllowAndRemember,
    /// Deny this one invocation. The harness should not persist a rule.
    Deny,
    /// Bounce to the harness's native TUI prompt (e.g. raum timeout).
    Ask,
}

impl Decision {
    /// Short ASCII tag used on-the-wire between the hook script and the
    /// event socket (stays stable regardless of serde rename rules).
    #[must_use]
    pub fn wire_tag(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::AllowAndRemember => "allow-and-remember",
            Self::Deny => "deny",
            Self::Ask => "ask",
        }
    }

    /// Parse the wire tag emitted by the hook script. Case-insensitive;
    /// returns `None` for unknown tags so the caller can log + drop.
    #[must_use]
    pub fn from_wire_tag(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "allow" => Some(Self::Allow),
            "allow-and-remember" | "allow_and_remember" => Some(Self::AllowAndRemember),
            "deny" => Some(Self::Deny),
            "ask" => Some(Self::Ask),
            _ => None,
        }
    }
}

/// Which transport the replier uses. Rendered next to the permission
/// actions in the UI ("via hook" / "via HTTP") so users can see why some
/// harnesses support remember-me and others don't.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReplyMode {
    /// Claude Code: hook script blocks, raum writes the decision line,
    /// script prints JSON to stdout and exits. Deterministic; no TUI
    /// race because Claude is still waiting on the hook return.
    HookResponse,
    /// OpenCode: raum POSTs the decision to the REST endpoint. Two-
    /// surface by design (OpenCode's TUI and raum's notification are
    /// both valid answer surfaces).
    HttpReply,
    /// Codex (future): tmux keystroke replay. Gated behind per-harness
    /// key-binding maps; out-of-scope for Phase 2.
    TmuxKeys,
}

/// Errors a replier can surface. Kept opaque so harness-specific detail
/// (HTTP status, socket closed, unknown request id) maps to a single
/// enum the UI renders consistently.
#[derive(Debug, Error)]
pub enum ReplyError {
    #[error("unknown request id: {0}")]
    UnknownRequest(String),
    #[error("transport: {0}")]
    Transport(String),
    #[error("harness rejected decision: {0}")]
    Rejected(String),
    #[error("timeout waiting for transport")]
    Timeout,
}

/// Reply a parked permission request. Absence of a replier means the
/// harness is observation-only.
#[async_trait]
pub trait PermissionReplier: Send + Sync {
    /// Deliver `decision` to the harness for `request_id`. Implementations
    /// must be idempotent for the same `request_id` (duplicate clicks on
    /// the notification action are expected).
    async fn reply(
        &self,
        request_id: &PermissionRequestId,
        decision: Decision,
    ) -> Result<(), ReplyError>;

    /// Transport label. Static — doesn't depend on the request.
    fn mode(&self) -> ReplyMode;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_wire_tags_round_trip() {
        for d in [
            Decision::Allow,
            Decision::AllowAndRemember,
            Decision::Deny,
            Decision::Ask,
        ] {
            let tag = d.wire_tag();
            let back = Decision::from_wire_tag(tag).unwrap();
            assert_eq!(back, d);
        }
    }

    #[test]
    fn decision_wire_tag_underscore_fallback() {
        // Some older hook drivers wrote `allow_and_remember` with an
        // underscore; keep accepting that to stay robust.
        assert_eq!(
            Decision::from_wire_tag("allow_and_remember"),
            Some(Decision::AllowAndRemember)
        );
    }

    #[test]
    fn decision_serialises_kebab_case() {
        let s = serde_json::to_string(&Decision::AllowAndRemember).unwrap();
        assert_eq!(s, "\"allow-and-remember\"");
    }

    #[test]
    fn unknown_wire_tag_is_none() {
        assert_eq!(Decision::from_wire_tag("maybe"), None);
        assert_eq!(Decision::from_wire_tag(""), None);
    }
}
