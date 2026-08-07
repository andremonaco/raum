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
//!    so keystroke bytes reach the pane unmodified.
//! 4. A waiter thread polls the child for exit and signals `on_exit` unless
//!    the bridge was torn down deliberately (`shutdown_silent`).
//!
//! Pane geometry is owned server-side: every session runs `window-size
//! manual` and raum drives `resize-window`, so the (sizeless) control client
//! never participates in size negotiation and `resize` on this handle is a
//! no-op.

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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
/// Keystrokes are a handful of bytes; only large pastes ever chunk. Kept
/// comfortably under tmux's command-line limits.
const INPUT_CHUNK_BYTES: usize = 256;

/// Poll interval for the child-exit waiter thread. The control child has no
/// PTY we can block on, and `Child::wait` would hold the kill mutex forever,
/// so the waiter polls `try_wait` instead.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(150);

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
        let mut guard = self.inner.stdin.lock().expect("control stdin poisoned");
        let Some(stdin) = guard.as_mut() else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "control client stdin closed",
            ));
        };
        for chunk in bytes.chunks(INPUT_CHUNK_BYTES) {
            let mut cmd = String::with_capacity(20 + self.inner.session_id.len() + chunk.len() * 3);
            cmd.push_str("send-keys -t ");
            cmd.push_str(&self.inner.session_id);
            cmd.push_str(" -H");
            for b in chunk {
                let _ = write!(cmd, " {b:02x}");
            }
            cmd.push('\n');
            stdin.write_all(cmd.as_bytes())?;
        }
        stdin.flush()
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
        self.kill();
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
    /// Bytes for xterm: either the assembled initial replay or live,
    /// unescaped `%output` data.
    Data(Vec<u8>),
    /// The control client announced it is exiting (`%exit`).
    Exit,
    /// A `%layout-change` reported more than one pane in the window: some
    /// outside tool split our one-pane session. Surfaced once so the bridge
    /// can log it; foreign panes' output is dropped either way.
    ForeignSplit,
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

    /// Feed one wire line (trailing `\n`/`\r` already stripped).
    fn feed_line(&mut self, line: &[u8]) -> ControlEvent {
        if self.block.is_some() {
            if is_block_terminator(line, b"%end ") || is_block_terminator(line, b"%error ") {
                let lines = self.block.take().unwrap_or_default();
                let errored = line.starts_with(b"%error ");
                return self.finish_block(lines, errored);
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
        if let Some(rest) = line.strip_prefix(b"%output ") {
            // `%output %<pane-id> <escaped-data>`.
            let (pane, data) = match rest.iter().position(|&b| b == b' ') {
                Some(idx) => (&rest[..idx], &rest[idx + 1..]),
                None => return ControlEvent::None,
            };
            if self.phase == SyncPhase::Live {
                // Foreign panes (see `lead_pane`) never reach xterm. Unknown
                // lead (meta reply errored) degrades to forwarding everything.
                if self.lead_pane.as_deref().is_some_and(|lead| lead != pane) {
                    return ControlEvent::None;
                }
                return ControlEvent::Data(unescape_output(data));
            }
            // Pre-sync output is already contained in the capture the server
            // will answer next (single ordered stream), so dropping it here
            // is what makes the initial paint exact instead of duplicated.
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

    fn finish_block(&mut self, lines: Vec<Vec<u8>>, errored: bool) -> ControlEvent {
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
                    ControlEvent::Data(replay)
                }
            }
            SyncPhase::Live => ControlEvent::None,
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
fn unescape_output(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        let b = data[i];
        if b != b'\\' {
            out.push(b);
            i += 1;
            continue;
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
    out
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
    let reader_session = session_id.to_string();
    std::thread::Builder::new()
        .name(format!("raum-ctl-reader-{session_id}"))
        .spawn(move || {
            let mut parser = ControlParser::new();
            let mut reader = BufReader::with_capacity(128 * 1024, stdout);
            let mut line: Vec<u8> = Vec::with_capacity(4096);
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        while line.last().is_some_and(|&b| b == b'\n' || b == b'\r') {
                            line.pop();
                        }
                        match parser.feed_line(&line) {
                            ControlEvent::Data(bytes) => {
                                if !forward_chunk(&data_tx, bytes, &reader_session) {
                                    break;
                                }
                            }
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
                            ControlEvent::None => {}
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
fn forward_chunk(
    tx: &std::sync::mpsc::SyncSender<Vec<u8>>,
    bytes: Vec<u8>,
    session_id: &str,
) -> bool {
    match tx.try_send(bytes) {
        Ok(()) => true,
        Err(std::sync::mpsc::TrySendError::Full(bytes)) => {
            let waited_at = std::time::Instant::now();
            if tx.send(bytes).is_err() {
                return false;
            }
            let waited = waited_at.elapsed().as_millis();
            if waited >= 50 {
                tracing::warn!(
                    session_id = %session_id,
                    waited_ms = waited as u64,
                    "control bridge: reader blocked on send (IPC drain bottleneck)",
                );
            }
            true
        }
        Err(std::sync::mpsc::TrySendError::Disconnected(_)) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(parser: &mut ControlParser, s: &str) -> ControlEvent {
        parser.feed_line(s.as_bytes())
    }

    fn drive_to_live(
        parser: &mut ControlParser,
        meta: &str,
        capture: &[&str],
    ) -> Vec<ControlEvent> {
        let mut events = vec![
            line(parser, "%begin 100 0 0"),
            line(parser, "%end 100 0 0"),
            line(parser, "%begin 100 1 1"),
            line(parser, meta),
            line(parser, "%end 100 1 1"),
            line(parser, "%begin 100 2 1"),
        ];
        for l in capture {
            events.push(line(parser, l));
        }
        events.push(line(parser, "%end 100 2 1"));
        events
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
        let replay = line(&mut p, "%end 1 2 1");
        // Empty capture still assembles modes + cursor for a fresh pane.
        let ControlEvent::Data(replay) = replay else {
            panic!("expected replay frame, got {replay:?}");
        };
        assert!(replay.ends_with(b"\x1b[3;8H"), "cursor restore missing");
        match line(&mut p, "%output %0 live\\033[0m") {
            ControlEvent::Data(bytes) => assert_eq!(bytes, b"live\x1b[0m"),
            other => panic!("expected live output, got {other:?}"),
        }
    }

    #[test]
    fn capture_content_lines_are_not_misread_as_notifications() {
        let mut p = ControlParser::new();
        let events = drive_to_live(
            &mut p,
            META_SHELL,
            &["%output %0 fake", "$ echo done", "done"],
        );
        let replay = events
            .into_iter()
            .find_map(|e| match e {
                ControlEvent::Data(bytes) => Some(bytes),
                _ => None,
            })
            .expect("replay frame");
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
        let events = drive_to_live(&mut p, meta, &["┌ TUI ┐", "└─────┘"]);
        let replay = events
            .into_iter()
            .find_map(|e| match e {
                ControlEvent::Data(bytes) => Some(bytes),
                _ => None,
            })
            .expect("replay frame");
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
        let events = drive_to_live(&mut p, META_SHELL, &["$ ls", "", "", ""]);
        let replay = events
            .into_iter()
            .find_map(|e| match e {
                ControlEvent::Data(bytes) => Some(bytes),
                _ => None,
            })
            .expect("replay frame");
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
        let ev = line(&mut p, "%error 1 2 1");
        let ControlEvent::Data(replay) = ev else {
            panic!("expected modes-only replay, got {ev:?}");
        };
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
        match line(&mut p, "%output %0 lead") {
            ControlEvent::Data(bytes) => assert_eq!(bytes, b"lead"),
            other => panic!("expected lead output, got {other:?}"),
        }
        // A teammate pane from a foreign split-window must not reach xterm.
        assert_eq!(line(&mut p, "%output %7 intruder"), ControlEvent::None);
        // Lead output still flows afterwards.
        match line(&mut p, "%output %0 more") {
            ControlEvent::Data(bytes) => assert_eq!(bytes, b"more"),
            other => panic!("expected lead output, got {other:?}"),
        }
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
        match line(&mut p, "%output %3 data") {
            ControlEvent::Data(bytes) => assert_eq!(bytes, b"data"),
            other => panic!("expected forwarded output, got {other:?}"),
        }
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
    fn late_blocks_are_swallowed_in_live_phase() {
        let mut p = ControlParser::new();
        drive_to_live(&mut p, META_SHELL, &["x"]);
        // Reply to a send-keys command: bookkeeping only.
        assert_eq!(line(&mut p, "%begin 2 3 1"), ControlEvent::None);
        assert_eq!(line(&mut p, "%end 2 3 1"), ControlEvent::None);
        match line(&mut p, "%output %0 after") {
            ControlEvent::Data(bytes) => assert_eq!(bytes, b"after"),
            other => panic!("expected forwarded output, got {other:?}"),
        }
    }
}
