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
//! * `worktree_status` — §9.1 one-shot `git status --porcelain=v2 -z`
//!   snapshot with per-file [`types::FileChange`] entries. Live updates flow
//!   through `worktree_status_subscribe` + the `worktree-status-changed`
//!   event instead (see `status_service`).
//! * `git_log` / `git_commit_files` / `git_diff_commit` — read-only commit
//!   history for the sidebar's History tab (see `history`).
//! * `worktree_list_dir` — lazy directory listing for the sidebar's
//!   per-worktree file browser (see `browse`).
//! * `quickfire_history_get` / `quickfire_history_push` — §9.6 persist the
//!   bounded ring of recent quick-fire commands in
//!   `~/.config/raum/state/quickfire-history.toml`.
//! * `config_set_sidebar_width` — §9.7 persist the sidebar width drag handle
//!   into `config.toml.sidebar.width_px` (debounced client-side).

mod branches;
mod browse;
mod config_io;
mod create;
mod git_ops;
mod git_parse;
mod history;
mod merge;
mod preview;
mod remove;
mod sidebar_persist;
mod status;
mod status_service;
mod types;

#[cfg(test)]
mod tests;

// Glob re-exports: `tauri::generate_handler!` resolves each command at the
// path `commands::<name>` (via `pub use worktree::*` in `commands/mod.rs`),
// which means every `#[tauri::command]`'s hidden `__cmd__<name>` shim has to
// be visible at this module's top level too. Globbing the submodules is the
// simplest way to forward both halves.
pub use branches::*;
pub use browse::*;
pub use config_io::*;
pub use create::*;
pub use git_ops::*;
pub use history::*;
pub use merge::*;
pub use preview::*;
pub use remove::*;
pub use sidebar_persist::*;
pub use status::*;
pub use status_service::*;
// Types are reachable via `commands::worktree::WorktreeStatus` etc., even
// though nothing inside this crate names them directly — they live across
// the Tauri IPC boundary.
#[allow(unused_imports)]
pub use types::*;
