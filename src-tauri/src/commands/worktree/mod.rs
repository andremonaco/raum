//! Worktree commands (§6.5–§6.8, §9.1–§9.7). Owned by Wave 2B;
//! Wave 3C adds `worktree_status`, `quickfire_history_*`, and
//! `config_set_sidebar_width` for the sidebar
//! (`frontend/src/components/Sidebar.tsx`).
//!
//! Exposes the Tauri surface that the Solid UI calls:
//!
//! * `worktree_preview_path` — live path preview for the "Create worktree"
//!   modal. Rendered from the effective project config.
//! * `worktree_preview_manifest` — return the effective hydration manifest
//!   so the modal can show "will be copied / symlinked".
//! * `worktree_create` — resolve branch prefix + path pattern, run
//!   `git worktree add`, then apply the hydration manifest.
//! * `worktree_list` — list worktrees for a project.
//! * `worktree_remove` — remove a worktree.
//! * `worktree_config_write` — save a TOML fragment either into the project's
//!   `.raum.toml` (if `in_repo`) or into the user-level `project.toml`.
//! * `worktree_status` — §9.1 poll `git status --porcelain=v2` for a worktree
//!   and return a classified `{dirty, untracked, modified, staged}` snapshot
//!   used by the sidebar dirty indicator and the Open/Staged file groups.
//! * `quickfire_history_get` / `quickfire_history_push` — §9.6 persist the
//!   bounded ring of recent quick-fire commands in
//!   `~/.config/raum/state/quickfire-history.toml`.
//! * `config_set_sidebar_width` — §9.7 persist the sidebar width drag handle
//!   into `config.toml.sidebar.width_px` (debounced client-side).

mod branches;
mod config_io;
mod create;
mod git_ops;
mod merge;
mod preview;
mod remove;
mod sidebar_persist;
mod status;
mod types;

#[cfg(test)]
mod tests;

// Glob re-exports: `tauri::generate_handler!` resolves each command at the
// path `commands::<name>` (via `pub use worktree::*` in `commands/mod.rs`),
// which means every `#[tauri::command]`'s hidden `__cmd__<name>` shim has to
// be visible at this module's top level too. Globbing the submodules is the
// simplest way to forward both halves.
pub use branches::*;
pub use config_io::*;
pub use create::*;
pub use git_ops::*;
pub use merge::*;
pub use preview::*;
pub use remove::*;
pub use sidebar_persist::*;
pub use status::*;
// Types are reachable via `commands::worktree::WorktreeStatus` etc., even
// though nothing inside this crate names them directly — they live across
// the Tauri IPC boundary.
#[allow(unused_imports)]
pub use types::*;
