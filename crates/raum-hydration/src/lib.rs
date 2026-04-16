//! raum-hydration: worktree path-pattern model + speck-style hydration manifest application.

pub mod hydrate;
pub mod pattern;
pub mod prefix;
pub mod worktree;

pub use hydrate::{HydrationError, HydrationReport, apply_hydration, apply_hydration_async};
pub use pattern::{
    PatternError, PatternInputs, preview_path_pattern, resolve_worktree_pattern,
    validate_path_pattern,
};
pub use prefix::{PrefixContext, apply_branch_prefix};
pub use worktree::{
    CreateOptions, WorktreeCliError, WorktreeEntry, worktree_create, worktree_list, worktree_remove,
};
