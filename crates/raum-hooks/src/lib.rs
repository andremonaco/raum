//! raum-hooks: hook-script writer (`~/.config/raum/hooks/<harness>.sh`) and event UDS server.

pub mod scripts;
pub mod socket;

pub use scripts::{HookScriptError, write_hook_scripts};
pub use socket::{
    EventSocketHandle, HookEvent, PER_AGENT_BACKLOG, PendingKey, PendingRequests,
    RAUM_EVENT_SOCK_ENV, RAUM_SESSION_ENV, ReplyError as SocketReplyError,
    set_env as set_event_sock_env, spawn_event_socket,
};
