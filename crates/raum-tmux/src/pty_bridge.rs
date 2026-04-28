//! PTY-wrapped tmux client bridge.
//!
//! Each mounted pane spawns a child `tmux -L raum attach-session -t <id>`
//! inside a Rust-owned pseudo-terminal. The webview's xterm.js receives the
//! attached client's rendered viewport bytes verbatim — exactly what a real
//! terminal emulator would see — so resize, alt-screen toggles, mouse
//! reporting, and reattach behave the same way they do under iTerm2 / WezTerm.
//!
//! Compared to the previous `pipe-pane` wire, this hands the inner harness
//! process tmux's renderer instead of forwarding raw process stdout. Ink-based
//! TUIs (Claude Code, Codex, OpenCode) no longer cascade banner repaints into
//! xterm scrollback on SIGWINCH because tmux owns the redraw, not the inner
//! process.
//!
//! Lifecycle:
//! 1. Open a portable-pty pair sized to xterm's current cols/rows.
//! 2. Spawn `tmux attach-session` on the pty slave with `TERM=xterm-256color`.
//! 3. A reader thread pumps master → `on_data` Channel byte-for-byte.
//! 4. A writer (`Box<Write>` behind `Arc<Mutex<…>>`) accepts xterm keystrokes.
//! 5. A waiter thread blocks on `child.wait()` and signals exit via
//!    `on_exit`.
//! 6. Dropping the handle kills the child; the master fd closes; the reader
//!    thread observes EOF and exits naturally.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use thiserror::Error;

use crate::manager::TmuxManager;

#[derive(Debug, Error)]
pub enum PtyBridgeError {
    #[error("openpty: {0}")]
    OpenPty(String),
    #[error("spawn tmux attach: {0}")]
    Spawn(String),
    #[error("clone reader: {0}")]
    CloneReader(String),
    #[error("take writer: {0}")]
    TakeWriter(String),
    #[error("resize: {0}")]
    Resize(String),
}

/// Callback invoked from the reader thread for every chunk of pty output.
/// Returns `false` to signal the caller has gone away — the reader exits.
pub type DataSink = Box<dyn FnMut(Vec<u8>) -> bool + Send>;

/// Callback invoked once after the attached tmux client exits. Receives the
/// child's exit code (`-1` if not available) so the frontend can render an
/// "exited" overlay.
pub type ExitSink = Box<dyn FnOnce(i32) + Send>;

/// Owning handle returned by [`attach_via_pty`]. Cheap to clone via the
/// internal `Arc`s; dropping the last clone kills the child and tears down
/// the worker threads.
#[derive(Clone)]
pub struct PtyBridgeHandle {
    inner: Arc<BridgeInner>,
}

struct BridgeInner {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// Set by callers tearing the bridge down deliberately (reattach,
    /// explicit kill, reap). Suppresses the waiter thread's exit sink so
    /// the frontend doesn't see a spurious `terminal:process-exited` event
    /// for a session that's still very much alive.
    suppress_exit: Arc<AtomicBool>,
}

impl std::fmt::Debug for PtyBridgeHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PtyBridgeHandle").finish_non_exhaustive()
    }
}

impl PtyBridgeHandle {
    /// Forward a chunk of bytes from xterm's `onData` to the pty master.
    /// Holds a brief mutex around the blocking write; pty writes are typically
    /// non-blocking because the slave is always being read.
    pub fn write_input(&self, bytes: &[u8]) -> std::io::Result<()> {
        let mut w = self.inner.writer.lock().expect("pty writer poisoned");
        w.write_all(bytes)?;
        w.flush()
    }

    /// Resize the pty. tmux's attached client picks up the change on its
    /// SIGWINCH handler, propagates a server-side pane resize, and the inner
    /// harness process receives its own SIGWINCH.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PtyBridgeError> {
        let m = self.inner.master.lock().expect("pty master poisoned");
        m.resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| PtyBridgeError::Resize(e.to_string()))
    }

    /// Best-effort kill of the attached tmux client. The reader thread will
    /// observe EOF on the master and exit; the waiter thread's `child.wait()`
    /// returns. The exit sink will fire — use [`Self::shutdown_silent`] if
    /// you need to tear the client down without notifying the frontend (e.g.
    /// during reattach or explicit pane close).
    pub fn kill(&self) {
        let mut k = self.inner.killer.lock().expect("pty killer poisoned");
        let _ = k.kill();
    }

    /// Tear the bridge down without firing the exit sink AND without leaking
    /// portable-pty's writer-Drop EOT into the harness. Used by reattach
    /// (we're replacing the client, not exiting the session), `terminal_kill`
    /// (the user clicked close — no overlay needed), and `terminal_reap_stale`
    /// (silent garbage collection). The waiter thread still observes the
    /// child's exit and joins itself; we just skip the on_exit callback.
    pub fn shutdown_silent(&self) {
        self.inner.suppress_exit.store(true, Ordering::SeqCst);
        // Zero VEOF before killing the client. The eventual writer drop
        // reads `c_cc[VEOF]` and only writes `b"\n\x04"` when it's
        // non-zero; doing this here (not just in `Drop`) closes the race
        // where the writer drops before our `Drop` impl runs — e.g. when
        // `terminal_kill` aborts via an early `?`.
        if let Ok(m) = self.inner.master.lock() {
            disable_pty_veof(m.as_ref());
        }
        self.kill();
    }
}

impl Drop for BridgeInner {
    fn drop(&mut self) {
        // Last reference to the bridge: silence the exit sink and kill the
        // attached tmux client so its reader/waiter threads exit. Dropping
        // the bridge always implies the caller is done with this client —
        // emitting `terminal:process-exited` from here would either be
        // redundant (caller already cleaned up) or actively wrong (reattach
        // is replacing the client, not exiting the session).
        self.suppress_exit.store(true, Ordering::SeqCst);
        // Disable the writer's "send EOT on Drop" behavior BEFORE the
        // killer/writer drop in field order. portable-pty's
        // `UnixMasterWriter::drop` writes `b"\n\x04"` to the master if the
        // slave's `c_cc[VEOF]` is non-zero — those bytes hit the still-
        // alive tmux client, which forwards them to the harness as Enter +
        // Ctrl-D. The Enter moves the cursor down; the Ctrl-D exits any
        // shell sitting at an empty prompt. Setting VEOF=0 short-circuits
        // the Drop's `if eot != 0 { write }` check.
        if let Ok(m) = self.master.lock() {
            disable_pty_veof(m.as_ref());
        }
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }
}

/// Zero the slave-side `VEOF` slot on the master's termios so portable-pty's
/// writer Drop impl reads `c_cc[VEOF] == 0` and skips its EOT write. Used by
/// every silent-teardown path so reattach / explicit kill / reap don't send
/// a stray `\n\x04` into the harness.
#[cfg(unix)]
#[allow(unsafe_code)]
fn disable_pty_veof(master: &(dyn MasterPty + Send)) {
    let Some(fd) = master.as_raw_fd() else {
        return;
    };
    // SAFETY: `fd` is owned by the master, which the caller holds a lock on
    // for the duration of this call. tcgetattr/tcsetattr are POSIX-safe on
    // a TTY fd; we ignore failures because the worst case is the legacy EOT
    // behavior firing — annoying but not unsound.
    unsafe {
        let mut t: libc::termios = std::mem::zeroed();
        let t_ptr: *mut libc::termios = &raw mut t;
        if libc::tcgetattr(fd, t_ptr) == 0 {
            t.c_cc[libc::VEOF] = 0;
            let t_const: *const libc::termios = &raw const t;
            let _ = libc::tcsetattr(fd, libc::TCSANOW, t_const);
        }
    }
}

#[cfg(not(unix))]
fn disable_pty_veof(_master: &(dyn MasterPty + Send)) {}

/// Spawn a `tmux -L raum attach-session -t <session_id>` into a fresh PTY.
///
/// `cols` / `rows` size the PTY at attach time; tmux uses this as the
/// effective viewport size and resizes the underlying pane to match. Pass the
/// xterm's current measured dims so the very first paint lands at the real
/// geometry without a follow-up SIGWINCH cascade.
///
/// `on_data` is invoked from a dedicated OS thread for every chunk read off
/// the master. Returning `false` (i.e. the receiving channel is closed) ends
/// the reader.
///
/// `on_exit` fires once when the attached tmux client exits — typically because
/// the session was killed externally, the user closed the pane, or the inner
/// process exited and tmux's `remain-on-exit` was off. The exit code is `-1`
/// when unavailable.
pub fn attach_via_pty(
    mgr: &TmuxManager,
    session_id: &str,
    cols: u16,
    rows: u16,
    mut on_data: DataSink,
    on_exit: ExitSink,
) -> Result<PtyBridgeHandle, PtyBridgeError> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| PtyBridgeError::OpenPty(e.to_string()))?;

    // Build the `tmux attach-session` command. We reuse `TmuxManager`'s
    // socket + binary so the bridge talks to the exact same server the rest
    // of the app drives.
    let mut cmd = CommandBuilder::new(&mgr.binary);
    cmd.arg("-L");
    cmd.arg(&mgr.socket);
    cmd.arg("attach-session");
    cmd.arg("-t");
    cmd.arg(session_id);
    // Force a sane TERM regardless of the parent process env. xterm-256color
    // matches what xterm.js advertises; tmux propagates it to the inner
    // process. (The session was created with the same TERM via -e, but the
    // attached client also needs it set so its own renderer picks the right
    // capability set.)
    cmd.env("TERM", "xterm-256color");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| PtyBridgeError::Spawn(e.to_string()))?;

    // We're done with the slave end after spawning — drop it so the kernel
    // doesn't hold an extra ref-count when the child exits. Without this the
    // reader can hang waiting for EOF.
    drop(pair.slave);

    let killer = child.clone_killer();
    let suppress_exit = Arc::new(AtomicBool::new(false));

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| PtyBridgeError::CloneReader(e.to_string()))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| PtyBridgeError::TakeWriter(e.to_string()))?;

    // Reader thread: pulls bytes off the master and hands them to `on_data`.
    // Detached — the reader exits when the master fd is closed (drop) or
    // when `on_data` returns false (frontend channel gone).
    let reader_session = session_id.to_string();
    std::thread::Builder::new()
        .name(format!("raum-pty-reader-{session_id}"))
        .spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = buf[..n].to_vec();
                        if !on_data(chunk) {
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(e) => {
                        // Convert the previously-silent swallow into an
                        // actionable diagnostic. Lands in the daily
                        // `raum.log` and (in dev) the stderr mirror so
                        // "lost tty" investigations have something to
                        // grep for.
                        tracing::warn!(
                            session_id = %reader_session,
                            kind = ?e.kind(),
                            error = %e,
                            "pty bridge: reader exited on I/O error",
                        );
                        break;
                    }
                }
            }
        })
        .map_err(|e| PtyBridgeError::Spawn(e.to_string()))?;

    // Waiter thread: blocks on `child.wait()` and reports the exit code —
    // unless the bridge has been silenced (reattach / explicit close /
    // reap), in which case the wait still happens (so the OS reaps the
    // child) but we skip the on_exit callback.
    let waiter_session = session_id.to_string();
    let suppress_for_waiter = suppress_exit.clone();
    std::thread::Builder::new()
        .name(format!("raum-pty-waiter-{session_id}"))
        .spawn(move || {
            let exit = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(_) => -1,
            };
            let silenced = suppress_for_waiter.load(Ordering::SeqCst);
            tracing::debug!(
                session_id = %waiter_session,
                exit,
                silenced,
                "pty bridge: tmux client exited",
            );
            if !silenced {
                on_exit(exit);
            }
        })
        .map_err(|e| PtyBridgeError::Spawn(e.to_string()))?;

    Ok(PtyBridgeHandle {
        inner: Arc::new(BridgeInner {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            suppress_exit,
        }),
    })
}
