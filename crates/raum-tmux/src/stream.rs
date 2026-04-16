//! Per-session output stream (§3.2) + coalescer (§3.3).
//!
//! The data path:
//!   `tmux pipe-pane -O 'cat >> <fifo>'`
//!     -> tokio tail task reads the fifo into `mpsc<Bytes>`
//!     -> `Coalescer::run()` batches into 16 KB / 12 ms chunks
//!     -> Tauri `Channel<InvokeResponseBody::Raw>` delivery (wired in
//!        `src-tauri/src/commands/terminal.rs`).

use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use bytes::{Bytes, BytesMut};
use tokio::fs::File;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use tokio::time::{MissedTickBehavior, interval};

use crate::manager::{TmuxError, TmuxManager};

pub const COALESCE_INTERVAL_MS: u64 = 12;
pub const COALESCE_BYTES: usize = 16 * 1024;

/// Size of the tail task's read buffer. Big enough to keep up with bursty
/// interactive output without fragmenting the coalescer's work.
const TAIL_READ_BUF: usize = 8 * 1024;

/// Resolve the preferred directory for transient pipe-pane FIFOs. §3.9 forbids
/// writing pane content under `~/.config/raum`; we prefer `$XDG_RUNTIME_DIR`
/// when it is set (and non-empty), otherwise `/tmp`.
#[must_use]
pub fn fifo_root() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg);
        }
    }
    PathBuf::from("/tmp")
}

/// Canonical fifo path for a session id. Used by both `pipe_pane_to_fifo` and
/// the command layer's cleanup path.
#[must_use]
pub fn fifo_path_for(session_id: &str) -> PathBuf {
    fifo_root().join(format!("raum-{session_id}.fifo"))
}

/// §3.2 — wire a tmux session's output to a fresh FIFO and spawn a tokio tail
/// task that feeds bytes into an `mpsc<Bytes>` channel. The returned
/// `PipePaneHandle` owns the fifo path so callers can clean it up on pane
/// close (§3.9).
///
/// Implementation notes:
/// - `tmux pipe-pane -O 'cat >> <fifo>'` appends rather than truncates, which
///   lets us re-open the fifo on reattach without losing buffered bytes.
/// - `mkfifo` is created with 0600 perms; if an old fifo is lingering from a
///   crashed process we unlink it first.
pub async fn pipe_pane_to_fifo(
    mgr: &TmuxManager,
    session_id: &str,
    fifo_path: &Path,
) -> Result<PipePaneHandle, TmuxError> {
    // Clean up any stale fifo from a previous crash.
    let _ = std::fs::remove_file(fifo_path);
    make_fifo(fifo_path)?;

    let cmd = format!("cat >> {}", shell_escape(fifo_path));
    let out = std::process::Command::new(&mgr.binary)
        .args(["-L", &mgr.socket])
        .args(["pipe-pane", "-O", "-t", session_id, &cmd])
        .stdin(Stdio::null())
        .output()?;
    if !out.status.success() {
        let _ = std::fs::remove_file(fifo_path);
        return Err(TmuxError::NonZero {
            status: out.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        });
    }

    let (tx, rx) = mpsc::channel::<Bytes>(256);
    let path = fifo_path.to_path_buf();
    let task = tokio::spawn(async move {
        if let Err(err) = tail_fifo(&path, tx).await {
            tracing::warn!(?err, path=%path.display(), "pipe-pane tail task ended");
        }
    });

    Ok(PipePaneHandle {
        fifo_path: fifo_path.to_path_buf(),
        rx: Some(rx),
        task: Some(task),
    })
}

/// Handle returned by [`pipe_pane_to_fifo`]. Dropping it aborts the tail task
/// and unlinks the fifo so no pane content leaks beyond pane lifetime (§3.9).
#[derive(Debug)]
pub struct PipePaneHandle {
    pub fifo_path: PathBuf,
    rx: Option<mpsc::Receiver<Bytes>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl PipePaneHandle {
    /// Take ownership of the inner receiver. Returns `None` after the first
    /// call; callers typically hand the receiver straight to a coalescer.
    pub fn take_receiver(&mut self) -> Option<mpsc::Receiver<Bytes>> {
        self.rx.take()
    }
}

impl Drop for PipePaneHandle {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        let _ = std::fs::remove_file(&self.fifo_path);
    }
}

async fn tail_fifo(path: &Path, tx: mpsc::Sender<Bytes>) -> io::Result<()> {
    // Opening a FIFO for read blocks until a writer appears. tmux's `pipe-pane`
    // opens the writer side asynchronously; `File::open` on tokio uses the
    // blocking pool so the task yields cleanly while waiting.
    let mut file = File::open(path).await?;
    let mut buf = vec![0u8; TAIL_READ_BUF];
    loop {
        match file.read(&mut buf).await {
            Ok(0) => {
                // Writer closed. Re-open to survive tmux `pipe-pane` restarts.
                match File::open(path).await {
                    Ok(f) => file = f,
                    Err(e) => {
                        // If the fifo has been unlinked (pane closed / dropped)
                        // we exit quietly.
                        if e.kind() == io::ErrorKind::NotFound {
                            return Ok(());
                        }
                        return Err(e);
                    }
                }
            }
            Ok(n) => {
                let chunk = Bytes::copy_from_slice(&buf[..n]);
                if tx.send(chunk).await.is_err() {
                    return Ok(());
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
}

fn shell_escape(path: &Path) -> String {
    // tmux runs the pipe-pane command through /bin/sh; wrap in single quotes
    // and escape any embedded single quotes.
    let s = path.to_string_lossy();
    let escaped = s.replace('\'', "'\\''");
    format!("'{escaped}'")
}

#[cfg(unix)]
fn make_fifo(path: &Path) -> io::Result<()> {
    use nix::sys::stat::Mode;
    use nix::unistd::mkfifo;
    let mode = Mode::S_IRUSR | Mode::S_IWUSR;
    mkfifo(path, mode).map_err(|errno| io::Error::from_raw_os_error(errno as i32))
}

#[cfg(not(unix))]
fn make_fifo(_path: &Path) -> io::Result<()> {
    // Windows fallback — streaming via pipe-pane is a Unix-only path; callers
    // on Windows must use the WebSocket fallback documented in design.md.
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "pipe-pane FIFO streaming requires a Unix platform",
    ))
}

/// §3.3 — output coalescer: flush every 12 ms *or* when the accumulator hits
/// 16 KB, whichever lands first. Emits `Bytes` on the output channel.
#[derive(Debug)]
pub struct Coalescer {
    rx: mpsc::Receiver<Bytes>,
    out: mpsc::Sender<Bytes>,
    buf: BytesMut,
}

impl Coalescer {
    #[must_use]
    pub fn new(rx: mpsc::Receiver<Bytes>, out: mpsc::Sender<Bytes>) -> Self {
        Self {
            rx,
            out,
            buf: BytesMut::with_capacity(COALESCE_BYTES * 2),
        }
    }

    pub async fn run(mut self) {
        let mut tick = interval(Duration::from_millis(COALESCE_INTERVAL_MS));
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        // The first tick fires immediately; consume it so we don't flush an
        // empty buffer before any input has been observed.
        tick.tick().await;
        loop {
            tokio::select! {
                maybe_chunk = self.rx.recv() => {
                    let Some(chunk) = maybe_chunk else { break; };
                    self.buf.extend_from_slice(&chunk);
                    if self.buf.len() >= COALESCE_BYTES {
                        self.flush().await;
                    }
                }
                _ = tick.tick() => {
                    if !self.buf.is_empty() {
                        self.flush().await;
                    }
                }
            }
        }
        if !self.buf.is_empty() {
            self.flush().await;
        }
    }

    async fn flush(&mut self) {
        let chunk = self.buf.split().freeze();
        let _ = self.out.send(chunk).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{Duration, advance};

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn coalescer_flushes_after_tick() {
        // §3.3 verification: with a paused clock, write one small chunk and
        // then advance the mock clock past the 12 ms interval. The coalescer
        // MUST flush the buffered bytes on the tick — not wait for a 16 KB
        // threshold. Clock is already paused via `start_paused = true`.
        let (in_tx, in_rx) = mpsc::channel::<Bytes>(8);
        let (out_tx, mut out_rx) = mpsc::channel::<Bytes>(8);
        let c = Coalescer::new(in_rx, out_tx);
        let handle = tokio::spawn(c.run());

        // Feed a tiny chunk (well under the 16 KB threshold) and yield so the
        // coalescer accumulates it without flushing.
        in_tx.send(Bytes::from_static(b"hello")).await.unwrap();
        tokio::task::yield_now().await;

        // Advance past one tick boundary and yield so the tick branch wins
        // the next `select!` iteration.
        advance(Duration::from_millis(13)).await;
        tokio::task::yield_now().await;

        let flushed = out_rx.recv().await.expect("tick flushed a chunk");
        assert_eq!(&flushed[..], b"hello");

        drop(in_tx);
        handle.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn coalescer_flushes_on_size_threshold() {
        let (in_tx, in_rx) = mpsc::channel::<Bytes>(8);
        let (out_tx, mut out_rx) = mpsc::channel::<Bytes>(8);
        let c = Coalescer::new(in_rx, out_tx);
        let handle = tokio::spawn(c.run());

        // Fire a chunk at exactly the threshold.
        let big = Bytes::from(vec![b'x'; COALESCE_BYTES]);
        in_tx.send(big).await.unwrap();
        tokio::task::yield_now().await;

        let flushed = out_rx.recv().await.expect("size threshold flushed a chunk");
        assert_eq!(flushed.len(), COALESCE_BYTES);

        drop(in_tx);
        handle.await.unwrap();
    }
}
