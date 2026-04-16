//! raum-core: shared types and the foundational config / project / agent model.

pub mod adapters;
pub mod agent;
pub mod agent_state;
pub mod config;
pub mod logging;
pub mod paths;
pub mod prereqs;
pub mod project;
pub mod sigil;
pub mod store;

pub use adapters::{ClaudeCodeAdapter, CodexAdapter, EventStreamParser, OpenCodeAdapter};
pub use agent::{
    AgentAdapter, AgentError, AgentKind, AgentState, SessionId, SpawnOptions, VersionReport,
    build_default_adapters,
};
pub use agent_state::{AgentStateChanged, AgentStateMachine, HookEvent, resolve_silence_threshold};
pub use config::{
    BranchPrefixMode, Config, EffectiveProjectConfig, HydrationManifest, Keybindings, LayoutCell,
    LayoutLibrary, LayoutPreset, ProjectConfig, QuickfireHistory, RaumToml, RenderingConfig,
    SessionState, TrackedSession, WorktreeConfig, WorktreePresetPointer,
};
pub use prereqs::{
    HarnessReport, HarnessStatus, PrereqReport, ToolStatus, check_harnesses, check_prereqs,
};
pub use sigil::{SIGIL_PALETTE, derive_sigil, is_valid_sigil, resolve_sigil};
pub use store::{
    ConfigStore, DebouncedWriter, StoreError, atomic_write, merge_project_with_raum_toml,
};
