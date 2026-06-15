//! Transport-agnostic bridge handle.
//!
//! raum has two ways of attaching a tmux client to a pane's session:
//!
//! * [`PtyBridgeHandle`] — a PTY-wrapped `tmux attach-session` whose
//!   *rendered* viewport bytes are streamed to xterm.js. Subject to tmux's
//!   redraw-compression when the consumer falls behind (intermediate scroll
//!   lines are skipped), but battle-tested.
//! * [`ControlBridgeHandle`] — a `tmux -C attach-session` control client
//!   that streams the *raw pane output* losslessly; xterm.js is the only
//!   terminal emulator. The default since the control-mode transport landed;
//!   `RAUM_TERMINAL_TRANSPORT=pty` reverts to the legacy path.
//!
//! The registry and command layer hold this enum so every call site
//! (input, resize, teardown) is transport-agnostic.

use crate::control::ControlBridgeHandle;
use crate::pty_bridge::{PtyBridgeError, PtyBridgeHandle};

#[derive(Clone, Debug)]
pub enum TerminalBridge {
    Pty(PtyBridgeHandle),
    Control(ControlBridgeHandle),
}

impl TerminalBridge {
    /// Forward keystroke bytes from xterm into the pane.
    pub fn write_input(&self, bytes: &[u8]) -> std::io::Result<()> {
        match self {
            Self::Pty(handle) => handle.write_input(bytes),
            Self::Control(handle) => handle.write_input(bytes),
        }
    }

    /// Resize the client viewport. The PTY transport resizes its pty (tmux's
    /// attached client follows via SIGWINCH); the control transport is
    /// sizeless — pane geometry is owned by the server-side `resize-window`
    /// the caller issues alongside this.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PtyBridgeError> {
        match self {
            Self::Pty(handle) => handle.resize(cols, rows),
            Self::Control(handle) => {
                let _ = handle.resize(cols, rows);
                Ok(())
            }
        }
    }

    /// Best-effort kill of the attached client (the exit sink still fires).
    pub fn kill(&self) {
        match self {
            Self::Pty(handle) => handle.kill(),
            Self::Control(handle) => handle.kill(),
        }
    }

    /// Tear the client down without firing the exit sink — reattach,
    /// explicit close, and the reapers use this so the frontend never sees
    /// a spurious bridge-lost for a deliberate teardown.
    pub fn shutdown_silent(&self) {
        match self {
            Self::Pty(handle) => handle.shutdown_silent(),
            Self::Control(handle) => handle.shutdown_silent(),
        }
    }
}
