//! Shared config-file I/O helpers used by per-harness adapters.
//!
//! Phase 1 extracts [`managed_json`] so the Claude Code and OpenCode
//! adapters stop duplicating the `<raum-managed>` marker + atomic-write
//! logic. Phase 3 adds a `managed_toml` sibling for Codex's
//! `~/.codex/config.toml` comment-sentinel block.

pub mod managed_json;

pub use managed_json::{
    MARKER_BEGIN, MARKER_END, MARKER_KEY, ManagedJsonError, ManagedJsonHooks, apply_managed_hooks,
    atomic_write, is_raum_managed,
};
