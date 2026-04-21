//! Harness integration primitives (per-harness notification plan).
//!
//! This module owns the concrete per-harness adapters (Claude Code,
//! OpenCode, Codex) and the trait surface they implement:
//!
//! * [`event`] — `NotificationEvent`, `NotificationKind`, `Reliability`,
//!   `classify_notification_kind` (Phase 1).
//! * [`traits`] — `HarnessIdentity`, `NotificationSetup`, `HarnessRuntime`
//!   (Phase 2 trait split). Supersedes the single `AgentAdapter` trait in
//!   `crate::agent`.
//! * [`setup`] — `SetupPlan`, `SetupAction`, `SetupExecutor`,
//!   `SetupReport`, `SelftestReport`, `SetupError` (Phase 2).
//! * [`reply`] — `PermissionReplier`, `Decision`, `ReplyMode`,
//!   `ReplyError` (Phase 2).
//! * [`channel`] — `NotificationChannel`, `NotificationSink`,
//!   `ChannelError`, `ChannelHealth` (Phase 2).
//!
//! The per-harness files (`claude_code`, `codex`, `opencode`) continue to
//! export their original `AgentAdapter` implementations for one release so
//! the `src-tauri` layer compiles unchanged while callsites migrate to
//! the split traits.

pub mod channel;
pub mod claude_code;
pub mod codex;
pub mod event;
pub mod hook_script;
pub mod opencode;
pub mod opencode_reply;
pub mod opencode_sse;
pub mod reply;
pub mod setup;
pub mod traits;

pub use channel::{ChannelError, ChannelHealth, NotificationChannel, NotificationSink};
pub use claude_code::ClaudeCodeAdapter;
pub use codex::CodexAdapter;
pub use event::{
    NotificationEvent, NotificationKind, PermissionRequestId, Reliability, SourceId,
    classify_notification_event, classify_notification_kind, decode_payload,
};
pub use opencode::OpenCodeAdapter;
pub use reply::{Decision, PermissionReplier, ReplyError, ReplyMode};
pub use setup::{
    ActionOutcome, ActionReport, ConfigPathEntry, ConfigScope, ScanReport, SelftestReport,
    SetupAction, SetupContext, SetupError, SetupExecutor, SetupPlan, SetupReport,
};
pub use traits::{
    HarnessIdentity, HarnessRuntime, LaunchOverrides, NotificationSetup, SessionSpec,
};

// Re-exported so the config-io helpers stay reachable under their original
// path during the `adapters` → `harness` rename.
pub use crate::config_io::managed_json::{MARKER_BEGIN, MARKER_END, MARKER_KEY};

use std::path::{Path, PathBuf};
use std::sync::Arc;

#[allow(deprecated)]
use crate::agent::AgentAdapter;

/// Resolve the absolute path to the raum hook script for a given harness.
#[must_use]
pub fn hook_script_path(hooks_dir: &Path, harness_filename: &str) -> PathBuf {
    hooks_dir.join(format!("{harness_filename}.sh"))
}

/// Build the default registered adapter set. Used by `AppHandleState` and
/// downstream tests; order is stable (Claude Code, OpenCode, Codex).
///
/// Returns the deprecation-shim trait-objects so `src-tauri` keeps
/// compiling during the Phase-2 transition; the inner adapter types are
/// the same ones that implement the split trait surface.
#[must_use]
#[allow(deprecated)]
pub fn default_registry() -> Vec<Arc<dyn AgentAdapter>> {
    vec![
        Arc::new(ClaudeCodeAdapter::new()) as Arc<dyn AgentAdapter>,
        Arc::new(OpenCodeAdapter::new()) as Arc<dyn AgentAdapter>,
        Arc::new(CodexAdapter::new()) as Arc<dyn AgentAdapter>,
    ]
}

#[cfg(test)]
#[allow(deprecated)]
mod tests {
    use super::*;

    #[test]
    fn default_registry_has_three_adapters_in_stable_order() {
        let r = default_registry();
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].kind(), crate::agent::AgentKind::ClaudeCode);
        assert_eq!(r[1].kind(), crate::agent::AgentKind::OpenCode);
        assert_eq!(r[2].kind(), crate::agent::AgentKind::Codex);
    }

    #[test]
    fn marker_constants_are_non_empty() {
        assert!(!MARKER_KEY.is_empty());
        assert!(!MARKER_BEGIN.is_empty());
        assert!(!MARKER_END.is_empty());
    }
}
