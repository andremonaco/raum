//! Shared config-file I/O helpers used by per-harness adapters.
//!
//! Phase 1 extracts [`managed_json`] so the Claude Code and OpenCode
//! adapters stop duplicating the `<raum-managed>` marker + atomic-write
//! logic. Phase 3 adds a [`managed_toml`] sibling for Codex's
//! `~/.codex/config.toml` comment-sentinel block and extends
//! [`managed_json`] with a Codex-flavoured array-wrapped helper
//! ([`managed_json::apply_managed_codex_hooks`]).

pub mod managed_json;
pub mod managed_toml;

pub use managed_json::{
    MARKER_BEGIN, MARKER_END, MARKER_KEY, ManagedCodexHooks, ManagedJsonError, ManagedJsonHooks,
    apply_managed_codex_hooks, apply_managed_hooks, atomic_write, is_raum_managed,
};
pub use managed_toml::{
    BEGIN_MARKER as TOML_BEGIN_MARKER, END_MARKER as TOML_END_MARKER, ManagedTomlError,
    apply_managed_block as apply_managed_toml_block,
};
