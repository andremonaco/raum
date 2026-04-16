//! raum-tmux: tmux-CLI-driven session manager, output streamer, and coalescer.

#![allow(clippy::cast_possible_truncation)]

pub mod manager;
pub mod stream;

pub use manager::{RAUM_TMUX_SOCKET, RecoveryReport, TmuxError, TmuxManager, TmuxSession};
pub use stream::{
    COALESCE_BYTES, COALESCE_INTERVAL_MS, Coalescer, PipePaneHandle, fifo_path_for, fifo_root,
    pipe_pane_to_fifo,
};
