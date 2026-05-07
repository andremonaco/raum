//! Agent commands (§7). Owned by Wave 2C.
//!
//! Exposes:
//!
//! * `agent_list()` — registered adapters + currently-tracked session states.
//! * `agent_spawn(project_slug, worktree_id, harness)` — prepare to launch an
//!   agent harness. Performs missing-binary (§7.9) and minimum-version (§7.10)
//!   preflight and emits `agent-state-changed` / `version-warning` /
//!   `hook-fallback` events as needed. The actual tmux session creation is
//!   delegated to `terminal_spawn`; this command is responsible for adapter
//!   preflight.
//! * `agent_state(session_id)` — current `AgentState` for a tracked session.
//!
//! State propagation: the state machine in `raum-core::agent_state` publishes
//! `AgentStateChanged` records onto a tokio broadcast channel owned by
//! `AppHandleState`. A background task (registered on first use) re-emits those
//! records to the webview via `app.emit("agent-state-changed", …)`.
//!
//! The existing consumer of `raum_core::AgentAdapter` continues to use it via
//! the Phase-2 deprecation shim; `#![allow(deprecated)]` keeps the callsite
//! warning-free until the src-tauri migration to the split trait surface
//! completes in a follow-up change.
#![allow(deprecated)]

mod diagnostics;
mod helpers;
mod models;
mod persistence;
mod query;
mod registry;
mod runtime;
mod silence;
mod spawn;

#[cfg(test)]
mod tests;

pub use diagnostics::{harness_selftest, hooks_diagnostics, hooks_selftest};
pub use helpers::{cleanup_harness_session, resolve_project_dir};
pub use models::{ModelsCache, list_harness_models, list_harness_models_refresh};
pub use persistence::infer_reattach_hook_fallback;
pub use query::{agent_list, agent_snapshot, agent_state};
pub use registry::{AgentEventBus, AgentRegistry};
pub use runtime::{
    RegisterOptions, drive_event_socket, ensure_bridge_running, prepare_harness_launch_fast,
    register_harness_session_runtime, register_harness_session_runtime_opts,
};
pub use silence::spawn_silence_tick;
pub use spawn::{agent_spawn, spawn_harness_launch_refresh};

// `#[tauri::command]` expands to a sibling `__cmd__<name>` module next to
// the function. `lib.rs` references each command as
// `commands::agent::<name>`, which makes Tauri's `generate_handler!` macro
// look up `commands::agent::__cmd__<name>` — so the dispatcher modules
// must be re-exported from this `mod.rs` alongside their public function.
#[doc(hidden)]
pub use diagnostics::{__cmd__harness_selftest, __cmd__hooks_diagnostics, __cmd__hooks_selftest};
#[doc(hidden)]
pub use models::{__cmd__list_harness_models, __cmd__list_harness_models_refresh};
#[doc(hidden)]
pub use query::{__cmd__agent_list, __cmd__agent_snapshot, __cmd__agent_state};
#[doc(hidden)]
pub use spawn::__cmd__agent_spawn;
