//! raum-core: shared types and the foundational config / project / agent model.

pub mod adapters;
pub mod agent;
pub mod agent_state;
pub mod config;
pub mod config_io;
pub mod harness;
pub mod logging;
pub mod paths;
pub mod prereqs;
pub mod project;
pub mod sigil;
pub mod store;

pub use harness::{ClaudeCodeAdapter, CodexAdapter, OpenCodeAdapter};
// Note: `EventStreamParser` (the Codex stdout parser that lived here) was
// removed in Phase 1. It was unreachable — `CODEX_JSON=1` is not a real
// Codex feature per <https://developers.openai.com/codex/config-reference>
// and `spawn_env` was never wired into the tmux layer. Phase 3 will
// replace it with real hooks + `notify` script + OSC 9 channels.
#[allow(deprecated)]
pub use agent::AgentAdapter;
pub use agent::{
    AgentError, AgentKind, AgentState, SessionId, SpawnOptions, VersionReport,
    build_default_adapters,
};
pub use agent_state::{AgentStateChanged, AgentStateMachine, HookEvent, resolve_silence_threshold};
pub use config::{
    BranchPrefixMode, Config, DEFAULT_HOOK_TIMEOUT_SECS, EffectiveProjectConfig, HydrationManifest,
    Keybindings, ProjectConfig, QuickfireHistory, RaumToml, RenderingConfig, SessionState,
    TrackedSession, WorktreeConfig, WorktreeHooks,
};
pub use harness::{
    NotificationEvent, NotificationKind, PermissionRequestId, Reliability, SourceId,
    classify_notification_kind,
};
pub use prereqs::{
    HarnessReport, HarnessStatus, PrereqReport, ToolStatus, check_harnesses, check_prereqs,
};
pub use sigil::{SIGIL_PALETTE, derive_sigil, is_valid_sigil, resolve_sigil};
pub use store::{
    ConfigStore, DebouncedWriter, StoreError, atomic_write, merge_project_with_raum_toml,
};
