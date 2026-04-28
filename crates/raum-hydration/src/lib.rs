//! raum-hydration: worktree path-pattern model + speck-style hydration manifest application.

pub mod hooks;
pub mod hydrate;
pub mod pattern;
pub mod prefix;
pub mod worktree;

pub use hooks::{
    HOOK_OUTPUT_TAIL_BYTES, HookContext, HookError, HookPhase, HookReport, resolve_hook_path,
    run_hook,
};
pub use hydrate::{
    HydrationError, HydrationReport, apply_hydration, apply_hydration_async,
    apply_hydration_async_with_progress, apply_hydration_with_progress,
};
pub use pattern::{
    PatternError, PatternInputs, preview_path_pattern, resolve_worktree_pattern,
    validate_path_pattern,
};
pub use prefix::{PrefixContext, apply_branch_prefix};
pub use worktree::{
    CreateOptions, WorktreeCliError, WorktreeEntry, worktree_create, worktree_list, worktree_remove,
};
