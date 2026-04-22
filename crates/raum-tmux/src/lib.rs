//! raum-tmux: tmux-CLI-driven session manager + PTY-wrapped client bridge.
//!
//! The CLI surface (`TmuxManager`) owns session lifecycle on the `-L raum`
//! socket. Pane I/O happens inside a Rust-owned PTY that runs
//! `tmux attach-session` as a child — see [`pty_bridge`] — so xterm.js sees
//! exactly the bytes a real terminal client would render.

#![allow(clippy::cast_possible_truncation)]

pub mod manager;
pub mod pty_bridge;

pub use manager::{
    PaneContext, PaneSnapshot, PaneTextSnapshot, RAUM_TMUX_SOCKET, RecoveryReport, TmuxError,
    TmuxManager, TmuxSession,
};
pub use pty_bridge::{DataSink, ExitSink, PtyBridgeError, PtyBridgeHandle, attach_via_pty};
