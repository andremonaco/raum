//! Terminal commands. Owned by Wave 2A.
//!
//! Exposes the full tmux surface to the webview:
//!  - `terminal_spawn(project_slug, worktree_id, kind, on_data) -> String`
//!  - `terminal_kill(session_id)`
//!  - `terminal_resize(session_id, cols, rows)`
//!  - `terminal_list() -> Vec<TerminalListItem>`
//!  - `terminal_send_keys(session_id, keys)`
//!  - `terminal_reap_stale(threshold_days) -> Vec<String>`   (§3.7)
//!
//! Pane I/O runs through a Rust-owned PTY that hosts a child
//! `tmux attach-session`; xterm.js receives the attached client's rendered
//! viewport bytes verbatim. xterm.js on the webview side keeps a 100 000-line
//! scrollback (§3.8); the underlying tmux `history-limit` is set to match for
//! future copy-mode exposure. The scrollback cap is exported as
//! [`raum_core::config::XTERM_SCROLLBACK_LINES`] and consumed by the frontend.

use raum_core::config::XTERM_SCROLLBACK_LINES;

mod bridge;
mod entry;
mod helpers;
mod io;
mod kill;
mod query;
mod reattach;
mod registry;
mod resize;
mod respawn;
mod snapshot;
mod spawn;

#[cfg(test)]
mod tests;

/// Frontend uses this constant to size xterm.js scrollback (§3.8). Re-exported
/// from `raum-core` so the webview and backend stay in sync.
pub const XTERM_SCROLLBACK: u32 = XTERM_SCROLLBACK_LINES;

pub(super) const TERMINAL_SESSION_UPSERTED_EVENT: &str = "terminal-session-upserted";
pub(super) const TERMINAL_SESSION_REMOVED_EVENT: &str = "terminal-session-removed";
pub(super) const TERMINAL_SESSION_REPLACED_EVENT: &str = "terminal-session-replaced";
pub(super) const TERMINAL_PANE_CONTEXT_CHANGED_EVENT: &str = "terminal-pane-context-changed";
pub(super) const AGENT_SESSION_REMOVED_EVENT: &str = "agent-session-removed";
pub(super) const PANE_CONTEXT_DEBOUNCE_MS: u64 = 150;
pub(super) const PANE_CONTEXT_IDLE_REFRESH_MS: u64 = 5_000;
pub(super) const SNAPSHOT_REPLAY_CHUNK_BYTES: usize = 32 * 1024;

// Public surface — the same names that used to live at the root of
// `commands::terminal` so `lib.rs`, `agent_hydrate.rs`, `worktree.rs`,
// `project.rs`, and `state.rs` keep resolving without edits.
pub(crate) use entry::emit_terminal_session_upserted;
pub use io::{terminal_paste_paths, terminal_paste_text, terminal_send_keys};
pub(crate) use kill::{
    kill_orphans_inner, kill_session_inner, protected_session_ids, sessions_for_project,
    sessions_for_worktree,
};
pub use kill::{terminal_kill, terminal_kill_orphans, terminal_reap_stale};
pub use query::{terminal_list, terminal_pane_context, terminal_pane_context_batch};
pub use reattach::{terminal_provider_replace, terminal_provider_replay, terminal_reattach};
pub use registry::{GhostEntry, TerminalListItem, TerminalRegistry};
pub use resize::terminal_resize;
pub use respawn::{terminal_respawn_dead, terminal_self_heal};
pub use snapshot::{terminal_snapshot_delete, terminal_snapshot_load, terminal_snapshot_persist};
pub use spawn::terminal_spawn;

// `#[tauri::command]` expands to a sibling `__cmd__<name>` module next to
// the function. `lib.rs` references each command as
// `commands::terminal::<name>`, which makes Tauri's `generate_handler!` macro
// look up `commands::terminal::__cmd__<name>` — so the dispatcher modules
// must be re-exported from this `mod.rs` alongside their public function.
#[doc(hidden)]
pub use io::{__cmd__terminal_paste_paths, __cmd__terminal_paste_text, __cmd__terminal_send_keys};
#[doc(hidden)]
pub use kill::{__cmd__terminal_kill, __cmd__terminal_kill_orphans, __cmd__terminal_reap_stale};
#[doc(hidden)]
pub use query::{
    __cmd__terminal_list, __cmd__terminal_pane_context, __cmd__terminal_pane_context_batch,
};
#[doc(hidden)]
pub use reattach::{
    __cmd__terminal_provider_replace, __cmd__terminal_provider_replay, __cmd__terminal_reattach,
};
#[doc(hidden)]
pub use resize::__cmd__terminal_resize;
#[doc(hidden)]
pub use respawn::{__cmd__terminal_respawn_dead, __cmd__terminal_self_heal};
#[doc(hidden)]
pub use snapshot::{
    __cmd__terminal_snapshot_delete, __cmd__terminal_snapshot_load,
    __cmd__terminal_snapshot_persist,
};
#[doc(hidden)]
pub use spawn::__cmd__terminal_spawn;
