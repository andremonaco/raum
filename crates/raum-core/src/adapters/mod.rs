//! Concrete `AgentAdapter` implementations. Populated in Wave 2C (§7.3-§7.5).
//!
//! Each submodule wires one harness (Claude Code, OpenCode, Codex) to raum's
//! hook pipeline. Adapters never own long-lived mutable state here — the
//! tmux / session layer takes ownership of spawned processes and threads.

pub mod claude_code;
pub mod codex;
pub mod opencode;

pub use claude_code::ClaudeCodeAdapter;
pub use codex::{CodexAdapter, EventStreamParser};
pub use opencode::OpenCodeAdapter;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::agent::AgentAdapter;

/// Marker string embedded in JSON values to delimit the raum-managed block.
///
/// JSON does not allow `//` comments, so the literal `<raum-managed>` / `</raum-managed>`
/// tokens from the spec are wrapped in `"_raum_managed_marker": "<begin>"` /
/// `"_raum_managed_marker": "<end>"` sentinel keys. The **start** sentinel is
/// written as the first key under the managed object, and the **end** sentinel
/// as the last key. Everything between the markers is safe to rewrite;
/// anything outside is preserved byte-for-byte on re-installation.
pub const MARKER_KEY: &str = "_raum_managed_marker";
pub const MARKER_BEGIN: &str = "<raum-managed>";
pub const MARKER_END: &str = "</raum-managed>";

/// Resolve the absolute path to the raum hook script for a given harness.
#[must_use]
pub fn hook_script_path(hooks_dir: &Path, harness_filename: &str) -> PathBuf {
    hooks_dir.join(format!("{harness_filename}.sh"))
}

/// Build the default registered adapter set. Used by `AppHandleState` and
/// downstream tests; order is stable (Claude Code, OpenCode, Codex).
#[must_use]
pub fn default_registry() -> Vec<Arc<dyn AgentAdapter>> {
    vec![
        Arc::new(ClaudeCodeAdapter::new()) as Arc<dyn AgentAdapter>,
        Arc::new(OpenCodeAdapter::new()) as Arc<dyn AgentAdapter>,
        Arc::new(CodexAdapter::new()) as Arc<dyn AgentAdapter>,
    ]
}

#[cfg(test)]
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
