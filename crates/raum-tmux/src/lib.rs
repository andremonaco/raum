//! raum-tmux: tmux-CLI-driven session manager + tmux client bridges.
//!
//! The CLI surface (`TmuxManager`) owns session lifecycle on the `-L raum`
//! socket. Pane I/O runs through one of two client bridges behind
//! [`TerminalBridge`]: the lossless control-mode transport ([`control`],
//! the default — raw pane bytes, no redraw-compression) or the legacy
//! PTY-wrapped rendered client ([`pty_bridge`]).

#![allow(clippy::cast_possible_truncation)]

pub mod coalescer;
pub mod control;
mod disclaim;
pub mod manager;
pub mod pty_bridge;
pub mod transport;

pub use coalescer::{FLUSH_BYTES, FLUSH_MS, StreamCoalescer};
pub use control::{ControlBridgeError, ControlBridgeHandle, attach_via_control};
pub use manager::{
    PaneContext, PaneSnapshot, PaneTextSnapshot, RAUM_TMUX_SOCKET, RecoveryReport, TmuxError,
    TmuxManager, TmuxSession,
};
pub use pty_bridge::{DataSink, ExitSink, PtyBridgeError, PtyBridgeHandle, attach_via_pty};
pub use transport::TerminalBridge;
