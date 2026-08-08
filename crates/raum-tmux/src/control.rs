//! Control-mode tmux client bridge — the lossless transport.
//!
//! Each mounted pane spawns a child `tmux -L raum -C attach-session -t <id>`
//! with **piped stdio** (no PTY). In control mode tmux does not render a
//! screen for the client at all; it streams the *raw bytes the pane's program
//! wrote* as `%output` notifications and never applies the redraw-compression
//! it uses to protect itself from slow rendered clients. That gives xterm.js
//! the same byte stream a bare terminal emulator would see — every escape
//! sequence, every intermediate scroll line — with tmux buffering (not
//! dropping) when the consumer briefly falls behind. This is the same
//! mechanism iTerm2's tmux integration is built on.
//!
//! Lifecycle:
//! 1. Spawn the control client; queue two synchronisation commands on its
//!    stdin: a `display-message` for pane metadata (alt-screen, cursor,
//!    DECSET-style mode flags) and an escape-preserving `capture-pane` of the
//!    visible viewport.
//! 2. The reader thread parses the control protocol. `%output` seen *before*
//!    the capture reply is discarded — those bytes are, by server ordering,
//!    already contained in the capture — so the initial paint is exact and
//!    race-free. When the capture reply lands, the assembled replay
//!    (content + SGR reset + restored modes + cursor position) is emitted
//!    as the first frame, then live `%output` is forwarded verbatim.
//! 3. Input goes back as `send-keys -H <hex…>` commands on the same stdin,
//!    so keystroke bytes reach the pane unmodified. Operational commands
//!    ([`ControlBridgeHandle::run_command`]) ride the same stdin and their
//!    reply block is correlated back to the caller — that is what lets
//!    `resize-window` stop forking a `tmux` process per pointer-move event.
//! 4. A waiter thread polls the child for exit and signals `on_exit` unless
//!    the bridge was torn down deliberately (`shutdown_silent`).
//!
//! Pane geometry is owned server-side: every session runs `window-size
//! manual` and raum drives `resize-window`, so the (sizeless) control client
//! never participates in size negotiation and `resize` on this handle is a
//! no-op.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use thiserror::Error;

use crate::manager::TmuxManager;
use crate::pty_bridge::{DataSink, ExitSink};

#[derive(Debug, Error)]
pub enum ControlBridgeError {
    #[error("spawn tmux control client: {0}")]
    Spawn(String),
    #[error("control client stdio unavailable: {0}")]
    Stdio(String),
}

/// Max raw input bytes encoded into a single `send-keys -H` command line.
/// Keystrokes are a handful of bytes; only large pastes ever chunk — and a
/// 256-byte chunk turned a modest paste into dozens of command lines, each
/// its own round trip through the server's command parser. At 4 KB the
/// encoded line is ~12 KB, still far under what tmux's control-mode reader
/// (an unbounded evbuffer line) and command parser handle.
const INPUT_CHUNK_BYTES: usize = 4096;

/// Lowercase hex digit pairs for every byte value. `send-keys -H` sits on the
/// keystroke path, so encoding is a table index per byte instead of a
/// `write!("{b:02x}")` formatting machine invocation per byte.
const HEX_PAIRS: [[u8; 2]; 256] = {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut table = [[0u8; 2]; 256];
    let mut i = 0usize;
    while i < 256 {
        table[i] = [DIGITS[i >> 4], DIGITS[i & 0x0f]];
        i += 1;
    }
    table
};

/// Reader-thread batch target: parsed `%output` accumulates until the batch
/// reaches this size (or the read buffer runs dry) before crossing the
/// channel. tmux emits one `%output` per pane write, so a busy pane produces
/// thousands of sub-100-byte lines a second — one channel slot each turned a
/// 512-slot channel into a ~50 KB pipe and woke the coalescer per line.
const BATCH_BYTES: usize = 16 * 1024;

/// ≥50 ms blocked on a full channel means the IPC pipeline (coalescer →
/// WebView) was the bottleneck for that interval. Warned once per reader —
/// see [`forward_chunk`].
const BLOCKED_SEND_WARN_MS: u128 = 50;

/// Poll interval for the child-exit waiter thread. The control child has no
/// PTY we can block on, and `Child::wait` would hold the kill mutex forever,
/// so the waiter polls `try_wait` instead.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(150);

/// How long [`ControlBridgeHandle::run_command`] waits for its reply before
/// declaring the control path unusable. A wedged client must never brick a
/// caller — it falls back to a `tmux` subprocess — and the first timeout
/// latches the path off (`degraded`) so later callers don't each pay the
/// stall. Note this is a *reply* deadline, not a command one: a busy pane can
/// hold the reader off for far longer than tmux takes to apply the command,
/// which is why the resize path doesn't wait at all.
const REPLY_TIMEOUT: Duration = Duration::from_secs(2);

/// A command reply: the block's content lines, or the server's `%error` text.
type ReplyResult = Result<Vec<Vec<u8>>, String>;

/// Reply correlation for commands written to this client's stdin.
///
/// tmux answers one control client's commands **in order**, one
/// `%begin`…`%end`/`%error` block each, so a sequence number is all the
/// correlation needed: every command written bumps `written` (input
/// `send-keys` included — those consume a reply block too), the reader bumps
/// `answered` per finished block, and a waiter fires when the two meet.
/// Both counters start after the attach-time sync commands, whose blocks the
/// parser consumes in its pre-`Live` phases.
#[derive(Default)]
struct Pending {
    written: u64,
    answered: u64,
    /// `(sequence number, reply channel)` in issue order. Holds only the
    /// commands somebody is actually waiting on — normally zero or one.
    waiters: VecDeque<(u64, SyncSender<ReplyResult>)>,
}

impl Pending {
    /// Writer side: account for one command about to hit stdin. Callers hold
    /// the stdin lock, so the numbering matches the order tmux receives them.
    fn issued(&mut self) -> u64 {
        self.written += 1;
        self.written
    }

    /// Reader side: one reply block finished. Wakes its waiter, if any.
    fn complete(&mut self, lines: Vec<Vec<u8>>, errored: bool) {
        self.answered += 1;
        let reply = if errored {
            Err(block_error_text(&lines))
        } else {
            Ok(lines)
        };
        let mut reply = Some(reply);
        while let Some(&(seq, _)) = self.waiters.front() {
            if seq > self.answered {
                break;
            }
            // `seq < answered` can only mean the counters desynced (a write
            // that never produced a block). Popping drops the sender, which
            // fails that waiter immediately instead of hanging it.
            let (_, tx) = self.waiters.pop_front().unwrap_or_else(|| unreachable!());
            if seq == self.answered {
                if let Some(reply) = reply.take() {
                    let _ = tx.try_send(reply);
                }
                break;
            }
        }
    }
}

/// `%error` block content → one error string. Dropping the senders instead
/// would look like a torn-down client, so an empty body still gets text.
fn block_error_text(lines: &[Vec<u8>]) -> String {
    let text = lines
        .iter()
        .map(|l| String::from_utf8_lossy(l))
        .collect::<Vec<_>>()
        .join("; ");
    if text.trim().is_empty() {
        "tmux reported an error".to_string()
    } else {
        text
    }
}

/// Owning handle returned by [`attach_via_control`]. Cheap to clone via the
/// internal `Arc`; dropping the last clone kills the child and tears down the
/// worker threads.
#[derive(Clone)]
pub struct ControlBridgeHandle {
    inner: Arc<ControlInner>,
}

struct ControlInner {
    session_id: String,
    /// `None` after a deliberate shutdown — closing stdin asks the control
    /// client to exit gracefully before the kill lands.
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    /// Set by callers tearing the bridge down deliberately (reattach,
    /// explicit kill, reap). Suppresses the waiter thread's exit sink so the
    /// frontend doesn't see a spurious bridge-lost event for a session that
    /// is still very much alive.
    suppress_exit: Arc<AtomicBool>,
    /// Command-reply correlation, shared with the reader thread.
    pending: Arc<Mutex<Pending>>,
    /// Latched when the command path proved unusable (reply timeout, failed
    /// write). Streaming and input are unaffected — only [`ControlBridgeHandle::run_command`]
    /// gives up, so its callers stay on their subprocess fallback.
    degraded: AtomicBool,
}

impl std::fmt::Debug for ControlBridgeHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ControlBridgeHandle")
            .field("session_id", &self.inner.session_id)
            .finish_non_exhaustive()
    }
}

impl ControlBridgeHandle {
    /// Forward a chunk of bytes from xterm's `onData` to the pane.
    ///
    /// Encoded as `send-keys -H <hex>…` on the control client's stdin — the
    /// hex form writes each byte literally into the pane's PTY, so control
    /// characters, escape sequences (arrow keys, kitty CSI-u), and multi-byte
    /// UTF-8 all round-trip unmodified. Commands on one stdin are processed
    /// by the server in order, so input never reorders against itself.
    pub fn write_input(&self, bytes: &[u8]) -> std::io::Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        // A poisoned stdin mutex means some other writer panicked mid-command;
        // report it like any other write failure instead of taking this thread
        // down too (`kill` / `Drop` already degrade gracefully the same way).
        let mut guard = self
            .inner
            .stdin
            .lock()
            .map_err(|_| std::io::Error::other("control client stdin mutex poisoned"))?;
        let Some(stdin) = guard.as_mut() else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "control client stdin closed",
            ));
        };
        let prefix_len = self.inner.session_id.len() + 17;
        let mut cmd: Vec<u8> = Vec::with_capacity(prefix_len + INPUT_CHUNK_BYTES * 3);
        for chunk in bytes.chunks(INPUT_CHUNK_BYTES) {
            cmd.clear();
            cmd.extend_from_slice(b"send-keys -t ");
            cmd.extend_from_slice(self.inner.session_id.as_bytes());
            cmd.extend_from_slice(b" -H");
            for &b in chunk {
                cmd.push(b' ');
                cmd.extend_from_slice(&HEX_PAIRS[usize::from(b)]);
            }
            cmd.push(b'\n');
            // Count the command *before* it is written: its reply block can
            // land the instant the write returns, and the reader must not
            // credit that block to a later command's waiter. A failed write
            // leaves the counter one ahead, so it also latches the command
            // path off (input itself is already failing at that point).
            self.inner.lock_pending().issued();
            if let Err(e) = stdin.write_all(&cmd) {
                self.inner.degraded.store(true, Ordering::Relaxed);
                return Err(e);
            }
        }
        stdin.flush()
    }

    /// Issue a tmux command on this control client and wait for its reply.
    ///
    /// Returns the reply block's content lines, or the server's message when
    /// tmux answered `%error`. Every failure mode (no live client, wedged
    /// reader, tmux refusal) is an `Err` the caller is expected to answer with
    /// its subprocess fallback.
    ///
    /// **Waiting couples the caller to the pane's output backlog.** The reply
    /// is parsed by the same reader thread that parses `%output`, and that
    /// thread blocks in [`forward_chunk`] whenever the data channel to the
    /// coalescer saturates — so on a pane spewing output the `%end` sits
    /// behind megabytes of queued `%output`. Only use this where a reply is
    /// actually needed and a [`REPLY_TIMEOUT`] stall is acceptable; anything
    /// on a latency path wants a fire-and-forget `issue(cmd, None)` the way
    /// [`ControlBridgeHandle::resize_window`] does.
    ///
    /// ponytail: the pane-context and pane-death polls could ride this too,
    /// but round 1 already batched them to one fork per 200 ms tick for *all*
    /// panes — routing them would trade that for one control round trip per
    /// pane. Not worth it; revisit only if the batched tick shows up in a
    /// profile.
    pub fn run_command(&self, cmd: &str) -> ReplyResult {
        if self.inner.degraded.load(Ordering::Relaxed) {
            return Err("control command path degraded".to_string());
        }
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        self.issue(cmd, Some(tx))?;
        match rx.recv_timeout(REPLY_TIMEOUT) {
            Ok(reply) => reply,
            Err(RecvTimeoutError::Timeout) => {
                self.inner.degraded.store(true, Ordering::Relaxed);
                Err(format!("control command timed out after {REPLY_TIMEOUT:?}"))
            }
            // Sender dropped: the reader hit EOF or the bridge was torn down.
            Err(RecvTimeoutError::Disconnected) => Err("control client gone".to_string()),
        }
    }

    /// Write one command line and, when the caller wants the reply, register
    /// its waiter. The stdin lock is held across both so a command line can
    /// never interleave with `send-keys` input bytes mid-line, and so the
    /// sequence number matches the order the server will answer in.
    ///
    /// `waiter: None` is fire-and-forget: the command still consumes a reply
    /// block and the reader still counts it, nobody is woken.
    fn issue(&self, cmd: &str, waiter: Option<SyncSender<ReplyResult>>) -> Result<(), String> {
        let mut guard = self
            .inner
            .stdin
            .lock()
            .map_err(|_| "control client stdin mutex poisoned".to_string())?;
        let Some(stdin) = guard.as_mut() else {
            return Err("control client stdin closed".to_string());
        };
        {
            let mut pending = self.inner.lock_pending();
            let seq = pending.issued();
            if let Some(tx) = waiter {
                pending.waiters.push_back((seq, tx));
            }
        }
        if let Err(e) = stdin
            .write_all(cmd.as_bytes())
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush())
        {
            // The counter (and the queued waiter) are now one ahead of what
            // tmux will ever answer. Latch the path off rather than unwind:
            // a client whose stdin fails is not coming back.
            self.inner.degraded.store(true, Ordering::Relaxed);
            return Err(format!("control client write: {e}"));
        }
        Ok(())
    }

    /// Server-side `resize-window` over this client instead of a `tmux
    /// resize-window` subprocess.
    ///
    /// Fire-and-forget on purpose: a divider drag fires this at pointer-move
    /// rate, and waiting for the reply would put resize latency behind the
    /// pane's `%output` backlog (see [`ControlBridgeHandle::run_command`]) —
    /// dragging next to a pane running `yes` stalled the full
    /// [`REPLY_TIMEOUT`]. Command order on this client's stdin is the only
    /// guarantee the caller's grow/shrink sequencing rests on, and that
    /// survives.
    ///
    /// ponytail: this gives up the `%error` → subprocess-fallback path, so a
    /// resize tmux *refuses* (dead session) now reads as success; a failed
    /// write still falls back. Route the reply to a background waiter if a
    /// refusal ever needs to be acted on.
    pub fn resize_window(&self, cols: u32, rows: u32) -> Result<(), String> {
        let cmd = format!(
            "resize-window -t {} -x {cols} -y {rows}",
            self.inner.session_id
        );
        self.issue(&cmd, None)
    }

    /// No-op: the control client has no viewport. Pane geometry is owned by
    /// the server-side `resize-window` the resize command already issues
    /// (`window-size manual` on every session).
    pub fn resize(&self, _cols: u16, _rows: u16) -> Result<(), ControlBridgeError> {
        Ok(())
    }

    /// Best-effort kill of the control client. The reader thread observes
    /// EOF on stdout and exits; the waiter thread reports the exit unless
    /// the bridge was silenced first.
    pub fn kill(&self) {
        if let Ok(mut child) = self.inner.child.lock() {
            let _ = child.kill();
        }
    }

    /// Tear the bridge down without firing the exit sink. Used by reattach
    /// (we're replacing the client, not exiting the session), `terminal_kill`
    /// (no overlay needed), and the reapers (silent garbage collection).
    pub fn shutdown_silent(&self) {
        self.inner.suppress_exit.store(true, Ordering::SeqCst);
        // Close stdin first: a control client exits cleanly on stdin EOF,
        // which lets tmux detach it properly before the kill races in.
        if let Ok(mut stdin) = self.inner.stdin.lock() {
            let _ = stdin.take();
        }
        self.inner.fail_pending();
        self.kill();
    }
}

impl ControlInner {
    /// A panicking writer must not wedge every later command — the counters
    /// are plain integers, so the recovered state is still coherent.
    fn lock_pending(&self) -> std::sync::MutexGuard<'_, Pending> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Drop every waiter's sender so pending callers fail *now* rather than
    /// sitting out [`REPLY_TIMEOUT`] on a client that is going away.
    fn fail_pending(&self) {
        self.lock_pending().waiters.clear();
    }
}

impl Drop for ControlInner {
    fn drop(&mut self) {
        // Last reference: silence the exit sink and kill the client so the
        // reader/waiter threads exit. Dropping the bridge always means the
        // caller is done with this client — an exit event here would be
        // redundant or actively wrong (reattach replaces the client).
        self.suppress_exit.store(true, Ordering::SeqCst);
        if let Ok(mut stdin) = self.stdin.lock() {
            let _ = stdin.take();
        }
        self.fail_pending();
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

// ---------------------------------------------------------------------------
// Protocol parser (pure — unit-tested without a tmux server)
// ---------------------------------------------------------------------------

/// Pane metadata captured by the initial `display-message` sync command.
/// Field order matches [`META_FORMAT`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct PaneMeta {
    alternate_on: bool,
    cursor_x: u32,
    cursor_y: u32,
    cursor_visible: bool,
    keypad_cursor: bool,
    keypad_app: bool,
    wrap: bool,
    origin: bool,
    insert: bool,
    mouse_standard: bool,
    mouse_button: bool,
    mouse_any: bool,
    mouse_sgr: bool,
    mouse_utf8: bool,
}

/// Comma-separated so the control-mode command line needs no quoting. The
/// leading `#{pane_id}` is peeled off by the parser before [`PaneMeta::parse`]
/// sees the rest — it identifies the session's own pane so live `%output` can
/// be filtered to it (a foreign tool running `split-window` in our window,
/// e.g. Claude Code's tmux teammate mode, must not bleed its panes' bytes
/// into this xterm).
const META_FORMAT: &str = "#{pane_id},#{alternate_on},#{cursor_x},#{cursor_y},#{cursor_flag},\
#{keypad_cursor_flag},#{keypad_flag},#{wrap_flag},#{origin_flag},#{insert_flag},\
#{mouse_standard_flag},#{mouse_button_flag},#{mouse_any_flag},#{mouse_sgr_flag},\
#{mouse_utf8_flag}";

impl PaneMeta {
    fn parse(line: &[u8]) -> Option<Self> {
        let text = std::str::from_utf8(line).ok()?;
        let mut it = text.trim().split(',').map(|f| f.trim().parse::<u32>());
        let mut next = || it.next().and_then(Result::ok);
        Some(Self {
            alternate_on: next()? == 1,
            cursor_x: next()?,
            cursor_y: next()?,
            cursor_visible: next()? == 1,
            keypad_cursor: next()? == 1,
            keypad_app: next()? == 1,
            wrap: next()? == 1,
            origin: next()? == 1,
            insert: next()? == 1,
            mouse_standard: next()? == 1,
            mouse_button: next()? == 1,
            mouse_any: next()? == 1,
            mouse_sgr: next()? == 1,
            mouse_utf8: next()? == 1,
        })
    }
}

/// Where the parser is in the attach → sync → live pipeline. The first three
/// `%begin`/`%end` blocks on the wire are, in order: the attach greeting, the
/// metadata reply, and the capture reply — guaranteed because both sync
/// commands are written before the handle (and therefore any `send-keys`)
/// exists, and tmux replies to one client's commands in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyncPhase {
    AwaitGreeting,
    AwaitMeta,
    AwaitCapture,
    Live,
}

/// One parsed wire event the bridge has to act on.
#[derive(Debug, PartialEq, Eq)]
enum ControlEvent {
    /// Bytes for xterm — either the assembled initial replay or live,
    /// unescaped `%output` data — were appended to the caller's buffer.
    /// The parser never owns a payload: the reader thread passes the batch
    /// buffer straight in, so a `%output` line costs no allocation at all
    /// until the batch actually crosses the channel.
    Data,
    /// The control client announced it is exiting (`%exit`).
    Exit,
    /// A `%layout-change` reported more than one pane in the window: some
    /// outside tool split our one-pane session. Surfaced once so the bridge
    /// can log it; foreign panes' output is dropped either way.
    ForeignSplit,
    /// A command's reply block closed while live — its content lines, and
    /// whether tmux terminated it with `%error`. Block content, never pane
    /// output: it goes to the command's waiter, not to xterm.
    Reply { lines: Vec<Vec<u8>>, errored: bool },
    /// Nothing actionable (notification we ignore, block bookkeeping, …).
    None,
}

struct ControlParser {
    phase: SyncPhase,
    /// Lines of the currently open `%begin` block, when inside one.
    block: Option<Vec<Vec<u8>>>,
    meta: Option<PaneMeta>,
    /// The session's own pane id (`%N`), learned from the meta reply. Live
    /// `%output` for any other pane is discarded: raum sessions are one
    /// window/one pane by construction, so another pane can only be a foreign
    /// split (Claude Code agent teams in tmux mode) whose bytes would
    /// otherwise interleave into the same xterm.
    lead_pane: Option<Vec<u8>>,
    /// Debounces [`ControlEvent::ForeignSplit`] to once per bridge.
    foreign_split_seen: bool,
}

impl ControlParser {
    fn new() -> Self {
        Self {
            phase: SyncPhase::AwaitGreeting,
            block: None,
            meta: None,
            lead_pane: None,
            foreign_split_seen: false,
        }
    }

    /// Feed one wire line (trailing `\n`/`\r` already stripped). Bytes for
    /// xterm are appended to `out`; [`ControlEvent::Data`] says it grew.
    fn feed_line(&mut self, line: &[u8], out: &mut Vec<u8>) -> ControlEvent {
        // Hot path: once live, essentially every line is `%output`. Test it
        // before the block/`%begin` bookkeeping so the common line costs one
        // prefix compare. The `block.is_none()` guard is load-bearing —
        // capture/command-reply content lines may themselves start with
        // `%output ` and must stay block content.
        if self.phase == SyncPhase::Live && self.block.is_none() {
            if let Some(rest) = line.strip_prefix(b"%output ") {
                return self.live_output(rest, out);
            }
        }

        if self.block.is_some() {
            if is_block_terminator(line, b"%end ") || is_block_terminator(line, b"%error ") {
                let lines = self.block.take().unwrap_or_default();
                let errored = line.starts_with(b"%error ");
                return self.finish_block(lines, errored, out);
            }
            if let Some(block) = self.block.as_mut() {
                block.push(line.to_vec());
            }
            return ControlEvent::None;
        }

        if line.starts_with(b"%begin ") {
            self.block = Some(Vec::new());
            return ControlEvent::None;
        }
        if line.starts_with(b"%output ") {
            // Live output was handled above, so this is pre-sync output —
            // already contained in the capture the server will answer next
            // (single ordered stream). Dropping it here is what makes the
            // initial paint exact instead of duplicated.
            return ControlEvent::None;
        }
        if line == b"%exit" || line.starts_with(b"%exit ") {
            return ControlEvent::Exit;
        }
        if line.starts_with(b"%layout-change ") {
            // A `{`/`[` in the layout string means the window now holds more
            // than one pane — someone split our one-pane window. Single-pane
            // layout changes (raum's own resize-window) stay silent.
            if !self.foreign_split_seen && (line.contains(&b'{') || line.contains(&b'[')) {
                self.foreign_split_seen = true;
                return ControlEvent::ForeignSplit;
            }
            return ControlEvent::None;
        }
        // %session-changed, %window-renamed, %pause, … — nothing raum
        // consumes today.
        ControlEvent::None
    }

    /// Live `%output %<pane-id> <escaped-data>` — unescape straight into the
    /// caller's buffer.
    fn live_output(&mut self, rest: &[u8], out: &mut Vec<u8>) -> ControlEvent {
        let Some(idx) = rest.iter().position(|&b| b == b' ') else {
            return ControlEvent::None;
        };
        let (pane, data) = (&rest[..idx], &rest[idx + 1..]);
        // Foreign panes (see `lead_pane`) never reach xterm. Unknown lead
        // (meta reply errored) degrades to forwarding everything.
        if self.lead_pane.as_deref().is_some_and(|lead| lead != pane) {
            return ControlEvent::None;
        }
        unescape_into(out, data);
        ControlEvent::Data
    }

    fn finish_block(
        &mut self,
        lines: Vec<Vec<u8>>,
        errored: bool,
        out: &mut Vec<u8>,
    ) -> ControlEvent {
        match self.phase {
            SyncPhase::AwaitGreeting => {
                self.phase = SyncPhase::AwaitMeta;
                ControlEvent::None
            }
            SyncPhase::AwaitMeta => {
                self.phase = SyncPhase::AwaitCapture;
                if !errored {
                    if let Some((pane, meta)) = lines.first().and_then(|l| {
                        // `%N,<meta fields…>` — the pane id, then PaneMeta.
                        let idx = l.iter().position(|&b| b == b',')?;
                        Some(l.split_at(idx))
                    }) {
                        if pane.starts_with(b"%") {
                            self.lead_pane = Some(pane.to_vec());
                        }
                        self.meta = PaneMeta::parse(&meta[1..]);
                    }
                }
                ControlEvent::None
            }
            SyncPhase::AwaitCapture => {
                self.phase = SyncPhase::Live;
                let content = if errored { Vec::new() } else { lines };
                let replay = assemble_replay(self.meta.as_ref(), &content);
                if replay.is_empty() {
                    ControlEvent::None
                } else {
                    out.extend_from_slice(&replay);
                    ControlEvent::Data
                }
            }
            // Live-phase blocks are command replies: the attach-time sync is
            // long done, so the only `%begin` blocks left are answers to
            // commands raum wrote on stdin (`send-keys`, `resize-window`, …).
            SyncPhase::Live => ControlEvent::Reply { lines, errored },
        }
    }
}

/// `%end`/`%error` terminator check: prefix plus a numeric first argument, so
/// pane content lines that merely *start* with the prefix (inside a capture
/// block) are vanishingly unlikely to be misread.
fn is_block_terminator(line: &[u8], prefix: &[u8]) -> bool {
    let Some(rest) = line.strip_prefix(prefix) else {
        return false;
    };
    rest.first().is_some_and(u8::is_ascii_digit)
}

/// Decode tmux's `%output` escaping: `\ooo` octal for non-printables
/// (including `\\` for backslash). C-style single-character escapes are
/// handled defensively for portability across tmux builds; valid UTF-8 passes
/// through untouched.
fn unescape_into(out: &mut Vec<u8>, data: &[u8]) {
    out.reserve(data.len());
    let mut i = 0;
    while i < data.len() {
        // Printable runs are the overwhelming majority of a `%output` line,
        // so copy each run to the next backslash in bulk and let only the
        // escapes themselves go byte-wise.
        let run = data[i..]
            .iter()
            .position(|&b| b == b'\\')
            .unwrap_or(data.len() - i);
        out.extend_from_slice(&data[i..i + run]);
        i += run;
        if i == data.len() {
            break;
        }
        i += 1;
        let Some(&c) = data.get(i) else {
            out.push(b'\\');
            break;
        };
        match c {
            b'0'..=b'7' => {
                let mut value: u32 = 0;
                let mut digits = 0;
                while digits < 3 && i < data.len() && data[i].is_ascii_digit() && data[i] <= b'7' {
                    value = value * 8 + u32::from(data[i] - b'0');
                    i += 1;
                    digits += 1;
                }
                out.push((value & 0xff) as u8);
            }
            b'\\' => {
                out.push(b'\\');
                i += 1;
            }
            b'n' => {
                out.push(b'\n');
                i += 1;
            }
            b'r' => {
                out.push(b'\r');
                i += 1;
            }
            b't' => {
                out.push(b'\t');
                i += 1;
            }
            b'a' => {
                out.push(0x07);
                i += 1;
            }
            b'b' => {
                out.push(0x08);
                i += 1;
            }
            b'f' => {
                out.push(0x0c);
                i += 1;
            }
            b'v' => {
                out.push(0x0b);
                i += 1;
            }
            b'e' => {
                out.push(0x1b);
                i += 1;
            }
            b's' => {
                out.push(b' ');
                i += 1;
            }
            _ => {
                out.push(b'\\');
                out.push(c);
                i += 1;
            }
        }
    }
}

/// Build the first frame for xterm from the sync replies: viewport content
/// (escape-preserving capture, trailing blank rows trimmed), an SGR reset,
/// the pane's DECSET-style modes, and finally the cursor position. With no
/// rendered client there is no attach repaint — this replay *is* the initial
/// paint, for both fresh spawns and reattaches.
fn assemble_replay(meta: Option<&PaneMeta>, lines: &[Vec<u8>]) -> Vec<u8> {
    let mut end = lines.len();
    while end > 0 && lines[end - 1].is_empty() {
        end -= 1;
    }
    let lines = &lines[..end];

    let mut replay: Vec<u8> = Vec::new();
    let alt = meta.is_some_and(|m| m.alternate_on);
    if alt {
        // Mirror `build_snapshot_replay`: flip xterm into the alternate
        // buffer and paint the visible TUI frame there, leaving the normal
        // buffer's scrollback untouched.
        replay.extend_from_slice(b"\x1b[?1049h\x1b[H\x1b[2J");
    }
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            replay.extend_from_slice(b"\r\n");
        }
        replay.extend_from_slice(line);
    }
    let Some(meta) = meta else {
        return replay;
    };
    // Reset SGR state the capture may have left dangling, then restore the
    // pane's terminal modes so live interaction (arrow keys in vim, mouse
    // apps, hidden cursors) behaves correctly from the first keystroke.
    replay.extend_from_slice(b"\x1b[0m");
    if !meta.cursor_visible {
        replay.extend_from_slice(b"\x1b[?25l");
    }
    if meta.keypad_cursor {
        replay.extend_from_slice(b"\x1b[?1h");
    }
    if meta.keypad_app {
        replay.extend_from_slice(b"\x1b=");
    }
    if !meta.wrap {
        replay.extend_from_slice(b"\x1b[?7l");
    }
    if meta.origin {
        replay.extend_from_slice(b"\x1b[?6h");
    }
    if meta.insert {
        replay.extend_from_slice(b"\x1b[4h");
    }
    if meta.mouse_standard {
        replay.extend_from_slice(b"\x1b[?1000h");
    }
    if meta.mouse_button {
        replay.extend_from_slice(b"\x1b[?1002h");
    }
    if meta.mouse_any {
        replay.extend_from_slice(b"\x1b[?1003h");
    }
    if meta.mouse_utf8 {
        replay.extend_from_slice(b"\x1b[?1005h");
    }
    if meta.mouse_sgr {
        replay.extend_from_slice(b"\x1b[?1006h");
    }
    let _ = write!(
        replay_str(&mut replay),
        "\x1b[{};{}H",
        meta.cursor_y + 1,
        meta.cursor_x + 1
    );
    replay
}

/// `Vec<u8>` adapter for `write!` — the payload is byte-oriented but the CUP
/// sequence is pure ASCII.
fn replay_str(buf: &mut Vec<u8>) -> impl std::fmt::Write + '_ {
    struct W<'a>(&'a mut Vec<u8>);
    impl std::fmt::Write for W<'_> {
        fn write_str(&mut self, s: &str) -> std::fmt::Result {
            self.0.extend_from_slice(s.as_bytes());
            Ok(())
        }
    }
    W(buf)
}

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

/// Spawn a control-mode tmux client against `session_id` and start streaming.
///
/// `rows` bounds the initial viewport capture (mirrors the PTY transport's
/// view-only snapshot — full-history replay would ship tmux's mixed-width
/// scrollback into a fresh xterm).
///
/// `on_data` receives coalesced frames: first the assembled initial paint,
/// then raw pane output verbatim. `on_exit` fires once when the control
/// client exits, unless the bridge was torn down via [`ControlBridgeHandle::shutdown_silent`].
pub fn attach_via_control(
    mgr: &TmuxManager,
    session_id: &str,
    rows: u16,
    on_data: DataSink,
    on_exit: ExitSink,
) -> Result<ControlBridgeHandle, ControlBridgeError> {
    let mut child = std::process::Command::new(&mgr.binary)
        .arg("-L")
        .arg(&mgr.socket)
        .arg("-C")
        .arg("attach-session")
        .arg("-t")
        .arg(session_id)
        .env("TERM", "xterm-256color")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| ControlBridgeError::Spawn(e.to_string()))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| ControlBridgeError::Stdio("stdin not piped".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ControlBridgeError::Stdio("stdout not piped".into()))?;

    // Queue both sync commands before the handle exists, so no `send-keys`
    // can interleave and the reader's three-block pipeline (greeting → meta
    // → capture) holds by construction. The format string must be quoted:
    // tmux's command parser treats an unquoted `#` as a comment start, which
    // would silently degrade `display-message` to its default status line.
    let start = format!("-{}", rows.max(1) - 1);
    let sync = format!(
        "display-message -p -t {session_id} '{META_FORMAT}'\n\
         capture-pane -p -e -J -S {start} -E - -t {session_id}\n"
    );
    stdin
        .write_all(sync.as_bytes())
        .and_then(|()| stdin.flush())
        .map_err(|e| ControlBridgeError::Stdio(e.to_string()))?;

    let suppress_exit = Arc::new(AtomicBool::new(false));

    // Reader thread: control protocol → bounded channel. Mirrors the PTY
    // transport's reader/coalescer split so a busy WebView never stalls the
    // pipe tmux writes into.
    let (data_tx, data_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(512);
    // Both counters start at zero *after* the two sync commands above: their
    // reply blocks are consumed by the parser's pre-`Live` phases, so the
    // first block the reader counts is the first command a caller issued.
    let pending = Arc::new(Mutex::new(Pending::default()));
    let reader_pending = pending.clone();
    let reader_session = session_id.to_string();
    std::thread::Builder::new()
        .name(format!("raum-ctl-reader-{session_id}"))
        .spawn(move || {
            let mut parser = ControlParser::new();
            let mut reader = BufReader::with_capacity(128 * 1024, stdout);
            let mut line: Vec<u8> = Vec::with_capacity(4096);
            let mut batch: Vec<u8> = Vec::new();
            let mut blocked_send_warned = false;
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        while line.last().is_some_and(|&b| b == b'\n' || b == b'\r') {
                            line.pop();
                        }
                        match parser.feed_line(&line, &mut batch) {
                            // Bytes landed in `batch`; the send decision is
                            // made below, once per read.
                            ControlEvent::Data => {}
                            ControlEvent::Exit => {
                                tracing::debug!(
                                    session_id = %reader_session,
                                    "control bridge: %exit received",
                                );
                            }
                            ControlEvent::ForeignSplit => {
                                tracing::warn!(
                                    session_id = %reader_session,
                                    "control bridge: foreign split-window detected in a raum \
                                     window (tmux-mode agent teams?); dropping other panes' \
                                     output — the lead pane will render at reduced width",
                                );
                            }
                            ControlEvent::Reply { lines, errored } => {
                                reader_pending
                                    .lock()
                                    .unwrap_or_else(PoisonError::into_inner)
                                    .complete(lines, errored);
                            }
                            ControlEvent::None => {}
                        }
                        // Ship the batch once it is worth a frame, or as soon
                        // as the read buffer runs dry — i.e. we are about to
                        // block on the pipe anyway, so holding bytes back
                        // would only add latency.
                        // ponytail: "input exhausted" is buffer-empty, not
                        // "no complete line buffered"; a batch can sit for the
                        // time tmux takes to finish a line split across reads.
                        // Scanning the (128 KB) buffer for a newline per line
                        // costs more than that wait — revisit with memchr if a
                        // stall ever shows up.
                        if !batch.is_empty()
                            && (batch.len() >= BATCH_BYTES || reader.buffer().is_empty())
                            && !forward_chunk(
                                &data_tx,
                                std::mem::take(&mut batch),
                                &reader_session,
                                &mut blocked_send_warned,
                            )
                        {
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(e) => {
                        tracing::warn!(
                            session_id = %reader_session,
                            kind = ?e.kind(),
                            error = %e,
                            "control bridge: reader exited on I/O error",
                        );
                        break;
                    }
                }
            }
            if !batch.is_empty() {
                let _ = forward_chunk(&data_tx, batch, &reader_session, &mut blocked_send_warned);
            }
            // No further replies can arrive: fail anyone still waiting rather
            // than leave them to time out.
            reader_pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .waiters
                .clear();
            // Drop `data_tx` so the coalescer thread observes channel close.
        })
        .map_err(|e| ControlBridgeError::Spawn(e.to_string()))?;

    let coalescer_session = session_id.to_string();
    std::thread::Builder::new()
        .name(format!("raum-ctl-coalescer-{session_id}"))
        .spawn(move || {
            crate::coalescer::drain_coalesced(&data_rx, on_data);
            tracing::debug!(
                session_id = %coalescer_session,
                "control bridge: coalescer exited",
            );
        })
        .map_err(|e| ControlBridgeError::Spawn(e.to_string()))?;

    let inner = Arc::new(ControlInner {
        session_id: session_id.to_string(),
        stdin: Mutex::new(Some(stdin)),
        child: Mutex::new(child),
        suppress_exit: suppress_exit.clone(),
        pending,
        degraded: AtomicBool::new(false),
    });

    // Waiter thread: polls `try_wait` (the kill path needs the child mutex,
    // so a blocking `wait` would deadlock it) and reports the exit code.
    let waiter_inner = inner.clone();
    let waiter_session = session_id.to_string();
    std::thread::Builder::new()
        .name(format!("raum-ctl-waiter-{session_id}"))
        .spawn(move || {
            let exit = loop {
                {
                    let Ok(mut child) = waiter_inner.child.lock() else {
                        break -1;
                    };
                    match child.try_wait() {
                        Ok(Some(status)) => break status.code().unwrap_or(-1),
                        Ok(None) => {}
                        Err(_) => break -1,
                    }
                }
                std::thread::sleep(EXIT_POLL_INTERVAL);
            };
            let silenced = waiter_inner.suppress_exit.load(Ordering::SeqCst);
            tracing::debug!(
                session_id = %waiter_session,
                exit,
                silenced,
                "control bridge: tmux control client exited",
            );
            if !silenced {
                on_exit(exit);
            }
        })
        .map_err(|e| ControlBridgeError::Spawn(e.to_string()))?;

    Ok(ControlBridgeHandle { inner })
}

/// `try_send` first, blocking `send` on a full channel — same no-drop
/// discipline as the PTY reader. Returns `false` when the coalescer is gone.
///
/// `warned` is the reader thread's one-shot latch: a saturated channel stays
/// saturated for the whole burst, so warning per blocked send would emit
/// thousands of identical lines. Mirrors `pty_bridge`'s `blocked_send_warned`.
fn forward_chunk(
    tx: &std::sync::mpsc::SyncSender<Vec<u8>>,
    bytes: Vec<u8>,
    session_id: &str,
    warned: &mut bool,
) -> bool {
    match tx.try_send(bytes) {
        Ok(()) => true,
        Err(std::sync::mpsc::TrySendError::Full(bytes)) => {
            let waited_at = std::time::Instant::now();
            if tx.send(bytes).is_err() {
                return false;
            }
            if !*warned {
                let waited = waited_at.elapsed().as_millis();
                if waited >= BLOCKED_SEND_WARN_MS {
                    tracing::warn!(
                        session_id = %session_id,
                        waited_ms = u64::try_from(waited).unwrap_or(u64::MAX),
                        "control bridge: reader blocked on send (IPC drain bottleneck)",
                    );
                    *warned = true;
                }
            }
            true
        }
        Err(std::sync::mpsc::TrySendError::Disconnected(_)) => false,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::Receiver;

    use super::*;

    fn unescape_output(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        unescape_into(&mut out, data);
        out
    }

    fn line(parser: &mut ControlParser, s: &str) -> ControlEvent {
        parser.feed_line(s.as_bytes(), &mut Vec::new())
    }

    /// Feed a line and return both the event and whatever it appended.
    fn feed(parser: &mut ControlParser, s: &str) -> (ControlEvent, Vec<u8>) {
        let mut out = Vec::new();
        let ev = parser.feed_line(s.as_bytes(), &mut out);
        (ev, out)
    }

    /// Drive the greeting → meta → capture handshake; returns the assembled
    /// replay frame (the only data the handshake emits).
    fn drive_to_live(parser: &mut ControlParser, meta: &str, capture: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut feed = |s: &str| parser.feed_line(s.as_bytes(), &mut out);
        feed("%begin 100 0 0");
        feed("%end 100 0 0");
        feed("%begin 100 1 1");
        feed(meta);
        feed("%end 100 1 1");
        feed("%begin 100 2 1");
        for l in capture {
            feed(l);
        }
        feed("%end 100 2 1");
        out
    }

    const META_SHELL: &str = "%0,0,7,2,1,0,0,1,0,0,0,0,0,0,0";

    #[test]
    fn unescape_decodes_octal_backslash_and_cstyle() {
        assert_eq!(unescape_output(b"plain"), b"plain");
        assert_eq!(unescape_output(b"a\\033[1mb"), b"a\x1b[1mb");
        assert_eq!(unescape_output(b"x\\\\y"), b"x\\y");
        assert_eq!(unescape_output(b"\\015\\012"), b"\r\n");
        // Defensive C-style forms some libvis builds emit.
        assert_eq!(unescape_output(b"a\\tb\\rc"), b"a\tb\rc");
        // Two-digit octal followed by a non-octal char.
        assert_eq!(unescape_output(b"\\07x"), b"\x07x");
        // Trailing lone backslash survives.
        assert_eq!(unescape_output(b"tail\\"), b"tail\\");
        // Unknown escape passes through.
        assert_eq!(unescape_output(b"\\z"), b"\\z");
    }

    #[test]
    fn utf8_passes_through_unescaped() {
        let payload = "prompt ➜ café".as_bytes();
        assert_eq!(unescape_output(payload), payload);
    }

    #[test]
    fn output_before_sync_is_discarded_and_after_is_forwarded() {
        let mut p = ControlParser::new();
        assert_eq!(line(&mut p, "%begin 1 0 0"), ControlEvent::None);
        assert_eq!(line(&mut p, "%end 1 0 0"), ControlEvent::None);
        // Pre-sync output: covered by the capture, must be dropped.
        assert_eq!(line(&mut p, "%output %0 early"), ControlEvent::None);
        assert_eq!(line(&mut p, "%begin 1 1 1"), ControlEvent::None);
        assert_eq!(line(&mut p, META_SHELL), ControlEvent::None);
        assert_eq!(line(&mut p, "%end 1 1 1"), ControlEvent::None);
        assert_eq!(line(&mut p, "%begin 1 2 1"), ControlEvent::None);
        // Empty capture still assembles modes + cursor for a fresh pane.
        let (ev, replay) = feed(&mut p, "%end 1 2 1");
        assert_eq!(ev, ControlEvent::Data);
        assert!(replay.ends_with(b"\x1b[3;8H"), "cursor restore missing");
        let (ev, bytes) = feed(&mut p, "%output %0 live\\033[0m");
        assert_eq!(ev, ControlEvent::Data);
        assert_eq!(bytes, b"live\x1b[0m");
    }

    #[test]
    fn capture_content_lines_are_not_misread_as_notifications() {
        let mut p = ControlParser::new();
        let replay = drive_to_live(
            &mut p,
            META_SHELL,
            &["%output %0 fake", "$ echo done", "done"],
        );
        let text = String::from_utf8_lossy(&replay).into_owned();
        assert!(
            text.contains("%output %0 fake"),
            "content line lost: {text}"
        );
        assert!(
            text.contains("$ echo done\r\ndone"),
            "CRLF join missing: {text}"
        );
    }

    #[test]
    fn alt_screen_replay_switches_buffers_and_positions_cursor() {
        let mut p = ControlParser::new();
        // alt on, cursor 4,1; cursor hidden; mouse any+sgr on.
        let meta = "%0,1,4,1,0,0,0,1,0,0,0,0,1,1,0";
        let replay = drive_to_live(&mut p, meta, &["┌ TUI ┐", "└─────┘"]);
        let text = String::from_utf8_lossy(&replay).into_owned();
        assert!(
            text.starts_with("\x1b[?1049h\x1b[H\x1b[2J"),
            "alt switch: {text}"
        );
        assert!(text.contains("\x1b[?25l"), "hidden cursor: {text}");
        assert!(text.contains("\x1b[?1003h"), "mouse any: {text}");
        assert!(text.contains("\x1b[?1006h"), "mouse sgr: {text}");
        assert!(text.ends_with("\x1b[2;5H"), "cursor pos: {text}");
    }

    #[test]
    fn trailing_blank_capture_rows_are_trimmed() {
        let mut p = ControlParser::new();
        let replay = drive_to_live(&mut p, META_SHELL, &["$ ls", "", "", ""]);
        let text = String::from_utf8_lossy(&replay).into_owned();
        assert!(
            text.starts_with("$ ls\x1b[0m"),
            "blank rows should be trimmed before the SGR reset: {text}"
        );
    }

    #[test]
    fn capture_error_block_yields_modes_only_replay() {
        let mut p = ControlParser::new();
        assert_eq!(line(&mut p, "%begin 1 0 0"), ControlEvent::None);
        assert_eq!(line(&mut p, "%end 1 0 0"), ControlEvent::None);
        assert_eq!(line(&mut p, "%begin 1 1 1"), ControlEvent::None);
        assert_eq!(line(&mut p, META_SHELL), ControlEvent::None);
        assert_eq!(line(&mut p, "%end 1 1 1"), ControlEvent::None);
        assert_eq!(line(&mut p, "%begin 1 2 1"), ControlEvent::None);
        assert_eq!(line(&mut p, "no current target"), ControlEvent::None);
        let (ev, replay) = feed(&mut p, "%error 1 2 1");
        assert_eq!(ev, ControlEvent::Data, "expected modes-only replay");
        let text = String::from_utf8_lossy(&replay).into_owned();
        assert!(
            !text.contains("no current target"),
            "error text leaked: {text}"
        );
        assert!(
            text.ends_with("\x1b[3;8H"),
            "cursor restore missing: {text}"
        );
    }

    #[test]
    fn exit_notification_is_surfaced() {
        let mut p = ControlParser::new();
        assert_eq!(line(&mut p, "%exit"), ControlEvent::Exit);
        let mut p = ControlParser::new();
        assert_eq!(line(&mut p, "%exit detached"), ControlEvent::Exit);
    }

    #[test]
    fn foreign_pane_output_is_dropped_in_live_phase() {
        let mut p = ControlParser::new();
        drive_to_live(&mut p, META_SHELL, &["x"]);
        // Lead pane (%0 per META_SHELL) passes.
        assert_eq!(
            feed(&mut p, "%output %0 lead"),
            (ControlEvent::Data, b"lead".to_vec())
        );
        // A teammate pane from a foreign split-window must not reach xterm.
        assert_eq!(
            feed(&mut p, "%output %7 intruder"),
            (ControlEvent::None, Vec::new())
        );
        // Lead output still flows afterwards.
        assert_eq!(
            feed(&mut p, "%output %0 more"),
            (ControlEvent::Data, b"more".to_vec())
        );
    }

    #[test]
    fn unknown_lead_pane_forwards_all_output() {
        let mut p = ControlParser::new();
        // Meta reply errored: no pane id learned, filtering degrades off.
        assert_eq!(line(&mut p, "%begin 1 0 0"), ControlEvent::None);
        assert_eq!(line(&mut p, "%end 1 0 0"), ControlEvent::None);
        assert_eq!(line(&mut p, "%begin 1 1 1"), ControlEvent::None);
        assert_eq!(line(&mut p, "%error 1 1 1"), ControlEvent::None);
        assert_eq!(line(&mut p, "%begin 1 2 1"), ControlEvent::None);
        let _replay = line(&mut p, "%end 1 2 1");
        assert_eq!(
            feed(&mut p, "%output %3 data"),
            (ControlEvent::Data, b"data".to_vec())
        );
    }

    #[test]
    fn multi_pane_layout_change_surfaces_once() {
        let mut p = ControlParser::new();
        drive_to_live(&mut p, META_SHELL, &["x"]);
        // Single-pane layout change (raum's own resize-window): silent.
        assert_eq!(
            line(
                &mut p,
                "%layout-change @1 b25d,80x24,0,0,1 b25d,80x24,0,0,1 *"
            ),
            ControlEvent::None
        );
        // Split layout: surfaced once, then debounced.
        assert_eq!(
            line(
                &mut p,
                "%layout-change @1 c5bd,80x24,0,0{40x24,0,0,1,39x24,41,0,2} same *"
            ),
            ControlEvent::ForeignSplit
        );
        assert_eq!(
            line(
                &mut p,
                "%layout-change @1 c5bd,80x24,0,0{40x24,0,0,1,39x24,41,0,2} same *"
            ),
            ControlEvent::None
        );
    }

    #[test]
    fn live_blocks_become_command_replies_and_never_pane_output() {
        let mut p = ControlParser::new();
        drive_to_live(&mut p, META_SHELL, &["x"]);
        let (ev, out) = feed(&mut p, "%begin 2 3 1");
        assert_eq!(ev, ControlEvent::None);
        // A `%output`-looking content line inside a live command reply stays
        // block content — the hot path must not steal it.
        assert_eq!(line(&mut p, "%output %0 not-live"), ControlEvent::None);
        let (ev, out_end) = feed(&mut p, "%end 2 3 1");
        assert_eq!(
            ev,
            ControlEvent::Reply {
                lines: vec![b"%output %0 not-live".to_vec()],
                errored: false,
            }
        );
        // Reply content is the waiter's, never xterm's.
        assert!(
            out.is_empty() && out_end.is_empty(),
            "reply leaked to xterm"
        );
        assert_eq!(
            feed(&mut p, "%output %0 after"),
            (ControlEvent::Data, b"after".to_vec())
        );
        // `%error` terminates a reply block just the same.
        assert_eq!(line(&mut p, "%begin 2 4 1"), ControlEvent::None);
        assert_eq!(line(&mut p, "can't find window: nope"), ControlEvent::None);
        assert_eq!(
            line(&mut p, "%error 2 4 1"),
            ControlEvent::Reply {
                lines: vec![b"can't find window: nope".to_vec()],
                errored: true,
            }
        );
    }

    /// Register a waiter the way [`ControlBridgeHandle::issue`] does.
    fn wait_for(p: &mut Pending) -> Receiver<ReplyResult> {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let seq = p.issued();
        p.waiters.push_back((seq, tx));
        rx
    }

    /// tmux answers a control client's commands in order, so the Nth reply
    /// block belongs to the Nth command written — *including* the `send-keys`
    /// lines the keystroke path writes, which nobody waits on. Miscounting
    /// those hands a keystroke's empty reply to a resize waiter.
    #[test]
    fn replies_wake_the_command_that_asked_in_issue_order() {
        let mut p = Pending::default();
        assert_eq!(
            p.issued(),
            1,
            "a keystroke send-keys still consumes a reply"
        );
        let rx = wait_for(&mut p);
        let later = wait_for(&mut p);

        p.complete(Vec::new(), false); // the send-keys reply
        assert!(matches!(
            rx.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        p.complete(vec![b"80x24".to_vec()], false);
        assert_eq!(rx.try_recv().expect("reply"), Ok(vec![b"80x24".to_vec()]));
        assert!(matches!(
            later.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        p.complete(Vec::new(), false);
        assert_eq!(later.try_recv().expect("reply"), Ok(Vec::new()));
    }

    #[test]
    fn error_replies_carry_the_server_message() {
        let mut p = Pending::default();
        let rx = wait_for(&mut p);
        p.complete(vec![b"can't find window: nope".to_vec()], true);
        assert_eq!(
            rx.try_recv().expect("reply"),
            Err("can't find window: nope".to_string())
        );
        // An empty `%error` body must still read as a failure, never as Ok.
        let rx = wait_for(&mut p);
        p.complete(Vec::new(), true);
        assert!(rx.try_recv().expect("reply").is_err());
    }

    /// Teardown (reader EOF, `shutdown_silent`, drop) drops the senders, so a
    /// caller blocked in `recv_timeout` fails at once instead of hanging out
    /// the full `REPLY_TIMEOUT` while the app is quitting.
    #[test]
    fn teardown_fails_pending_waiters_immediately() {
        let mut p = Pending::default();
        let rx = wait_for(&mut p);
        p.waiters.clear();
        assert!(matches!(
            rx.recv_timeout(Duration::ZERO),
            Err(RecvTimeoutError::Disconnected)
        ));
    }

    /// `tmux` missing → the end-to-end tests below have nothing to talk to.
    fn no_tmux() -> bool {
        std::process::Command::new("tmux")
            .arg("-V")
            .output()
            .is_err()
    }

    /// A socket name no other test run can collide with.
    fn test_socket(tag: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        format!("raum-{tag}-{}-{nanos}", std::process::id())
    }

    /// `resize_window` doesn't wait for tmux's reply, so the new geometry
    /// lands a beat after the call returns — poll for it.
    fn wait_for_size(mgr: &TmuxManager, session: &str, want: (u32, u32)) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let size = mgr
                .list_sessions()
                .ok()
                .and_then(|s| s.into_iter().find(|s| s.id == session))
                .map(|s| (s.width, s.height));
            if size == Some(want) {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// The regression this guards: waiting for the `resize-window` reply puts
    /// resize latency behind the pane's *output* pipeline. The reply is parsed
    /// by the same reader thread that pushes `%output` downstream, so a
    /// consumer that stops draining wedges that thread in `forward_chunk`'s
    /// blocking send and *no* reply can be parsed until it moves — the resize
    /// then sat out the full [`REPLY_TIMEOUT`] with the caller's per-session
    /// lock held, and a divider drag next to a pane running `yes` visibly
    /// stopped following the pointer.
    ///
    /// The test stalls the sink for longer than [`REPLY_TIMEOUT`] while the
    /// pane floods, so the split is unambiguous: fire-and-forget returns in
    /// microseconds, waiting cannot return in under two seconds. Skipped
    /// without `tmux`.
    #[test]
    fn resize_does_not_wait_behind_a_stalled_output_consumer() {
        if no_tmux() {
            return;
        }
        let mgr = TmuxManager::with_socket(test_socket("ctlflood"));
        let session = "ctlflood-1";
        mgr.new_session(session, std::path::Path::new("/tmp"), None, Some((80, 24)))
            .expect("new_session");

        let received = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stall = Arc::new(AtomicBool::new(false));
        let (seen, stalling) = (received.clone(), stall.clone());
        let bridge = attach_via_control(
            &mgr,
            session,
            24,
            Box::new(move |b: Vec<u8>| {
                seen.fetch_add(b.len(), Ordering::Relaxed);
                // Chronically slow, then fully stalled on demand.
                let nap = if stalling.load(Ordering::Relaxed) {
                    REPLY_TIMEOUT * 2
                } else {
                    Duration::from_millis(50)
                };
                std::thread::sleep(nap);
                true
            }),
            Box::new(|_| {}),
        )
        .expect("attach_via_control");

        // Flood the pane, then wait for real throughput: bytes through a sink
        // this slow mean the reader is already blocking on the data channel.
        bridge
            .write_input(b"yes raum-flood\n")
            .expect("write_input");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while received.load(Ordering::Relaxed) < 1 << 20 {
            assert!(
                std::time::Instant::now() < deadline,
                "pane never produced enough output to back the reader up"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
        // Stop the drain entirely and let `yes` refill the 512-slot channel,
        // which pins the reader in `forward_chunk` for the next few seconds.
        stall.store(true, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(500));

        let started = std::time::Instant::now();
        bridge.resize_window(100, 30).expect("resize over control");
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_millis(500),
            "resize blocked {elapsed:?} behind the output backlog"
        );
        // tmux reads a client's stdin regardless of whether it reads its
        // stdout, so the command still lands with the reader wedged.
        assert!(
            wait_for_size(&mgr, session, (100, 30)),
            "fire-and-forget resize never applied"
        );

        drop(bridge);
        let _ = mgr.kill_server();
    }

    /// End-to-end against a real server: a `resize-window` issued over the
    /// live control connection must complete (no subprocess, no timeout),
    /// actually resize the window, and leave the pane streaming afterwards —
    /// the command path shares stdin with `send-keys` and the reply block
    /// shares the reader with `%output`. Skipped without `tmux`.
    #[test]
    fn resize_window_over_the_control_client_completes_and_keeps_streaming() {
        if no_tmux() {
            return;
        }
        let mgr = TmuxManager::with_socket(test_socket("ctlcmd"));
        let session = "ctlcmd-1";
        mgr.new_session(session, std::path::Path::new("/tmp"), None, Some((80, 24)))
            .expect("new_session");

        let received = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = received.clone();
        let bridge = attach_via_control(
            &mgr,
            session,
            24,
            Box::new(move |bytes| {
                sink.lock().unwrap().extend_from_slice(&bytes);
                true
            }),
            Box::new(|_| {}),
        )
        .expect("attach_via_control");

        bridge.resize_window(100, 30).expect("resize over control");
        assert!(
            wait_for_size(&mgr, session, (100, 30)),
            "resize-window did not apply"
        );

        // The reply block must not have disturbed the output path.
        bridge
            .write_input(b"printf 'RAUM_CTLCMD_OK\\n'\n")
            .expect("write_input");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut seen = false;
        while std::time::Instant::now() < deadline && !seen {
            std::thread::sleep(Duration::from_millis(25));
            seen = String::from_utf8_lossy(&received.lock().unwrap()).contains("RAUM_CTLCMD_OK");
        }
        assert!(seen, "pane stopped streaming after a control command");

        // A command tmux refuses maps to Err with its message, and the client
        // stays usable afterwards.
        let err = bridge
            .run_command("resize-window -t raum-no-such-session -x 10 -y 10")
            .expect_err("tmux should refuse an unknown target");
        assert!(err.contains("session") || err.contains("find"), "{err}");
        bridge.resize_window(90, 26).expect("client still usable");

        drop(bridge);
        let _ = mgr.kill_server();
    }
}
