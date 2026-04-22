//! raum-hooks: Unix-domain event socket that the per-harness hook
//! dispatcher scripts talk to.
//!
//! The dispatcher scripts themselves (`claude-code.sh`, `codex.sh`,
//! `codex-notify.sh`) are written by per-adapter
//! `NotificationSetup::plan` emitting `WriteShellScript` actions —
//! their bodies live in `raum_core::harness::hook_script` and
//! `raum_core::harness::codex::codex_notify_script_body`. This crate
//! owns only the runtime half: socket lifecycle, session-scoped
//! request tracking, and env-var export.

pub mod socket;

pub use socket::{
    EventSocketHandle, HookEvent, PER_AGENT_BACKLOG, PendingKey, PendingRequests,
    RAUM_EVENT_SOCK_ENV, RAUM_SESSION_ENV, ReplyError as SocketReplyError,
    set_env as set_event_sock_env, spawn_event_socket,
};
