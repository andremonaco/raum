//! Backwards-compatibility shim for the `crate::adapters` module path
//! (per-harness notification plan, Phase 2).
//!
//! The concrete harness adapters moved to `crate::harness::*` along with
//! the split-trait surface. Callers that still reach for
//! `raum_core::adapters::ClaudeCodeAdapter` (notably `src-tauri` until its
//! migration completes) keep compiling against this re-export. A future
//! release will delete this file.
#![allow(deprecated)]

#[deprecated(
    since = "0.2.0",
    note = "use `raum_core::harness::ClaudeCodeAdapter` / split trait surface instead"
)]
pub use crate::harness::ClaudeCodeAdapter;
#[deprecated(
    since = "0.2.0",
    note = "use `raum_core::harness::CodexAdapter` / split trait surface instead"
)]
pub use crate::harness::CodexAdapter;
#[deprecated(
    since = "0.2.0",
    note = "use `raum_core::harness::OpenCodeAdapter` / split trait surface instead"
)]
pub use crate::harness::OpenCodeAdapter;
pub use crate::harness::{
    MARKER_BEGIN, MARKER_END, MARKER_KEY, default_registry, hook_script_path,
};
