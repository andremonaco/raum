//! Tauri command surface, split per feature so each Wave can own its own file.
//!
//! All commands are registered via `register` in `src-tauri/src/lib.rs`.

pub mod agent;
pub mod config;
pub mod files;
pub mod git_watcher;
pub mod hotkeys;
pub mod layouts;
pub mod notifications;
pub mod project;
pub mod search;
pub mod terminal;
pub mod updater;
pub mod worktree;

// Each submodule's `#[tauri::command]` items are referenced fully-qualified from
// `lib.rs::generate_handler!`, so we only re-export the small + small surfaces
// that still consume the wildcard form.
pub use config::*;
pub use hotkeys::*;
pub use worktree::*;

#[tauri::command]
pub fn ping() -> &'static str {
    "pong"
}
