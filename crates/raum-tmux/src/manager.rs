//! TmuxManager — owns the `-L raum` socket.
//!
//! Covers §3.1/§3.6/§3.7 of the raum-bootstrap change:
//! - session CRUD over the `-L raum` socket
//! - launch-time recovery with eager concurrent attach
//! - stale-session reaper

use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use raum_core::config::SessionState;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const RAUM_TMUX_SOCKET: &str = "raum";

#[derive(Debug, Error)]
pub enum TmuxError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("tmux exited non-zero: {status} stderr={stderr}")]
    NonZero { status: i32, stderr: String },
    #[error("parse: {0}")]
    Parse(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxSession {
    pub id: String,
    pub created_unix: u64,
    pub width: u32,
    pub height: u32,
}

/// Snapshot of a pane suitable for restoring a fresh xterm.js instance before
/// the live tmux client reattaches.
#[derive(Debug, Clone, Default)]
pub struct PaneSnapshot {
    /// The durable normal-buffer history. When the pane is currently in
    /// alternate-screen, tmux exposes this via `capture-pane -a`.
    pub normal: Vec<u8>,
    /// Visible alternate-screen frame when one is active. `None` when the pane
    /// is currently in its normal buffer.
    pub alternate: Option<Vec<u8>>,
}

/// Plain-text capture of a pane used by the global search panel. Unlike
/// [`PaneSnapshot`] this is decoded UTF-8 with ANSI escapes stripped (we ask
/// tmux for plain output by omitting `-e`), so the frontend can split it on
/// `\n` and run regex / substring matches without parsing terminal escapes.
#[derive(Debug, Clone, Default)]
pub struct PaneTextSnapshot {
    /// The full normal-buffer history as plain text. When the pane is in
    /// alternate-screen this is sourced via `capture-pane -a`.
    pub normal: String,
    /// Current alternate-screen frame as plain text, when one is active.
    pub alternate: Option<String>,
}

/// Live per-pane context used to synthesize a tab label for shell panes.
/// Harness panes also read this so they can surface tmux pane/window titles
/// that the inner CLI publishes via terminal title escapes.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PaneContext {
    /// `#{pane_current_command}` — the foreground command tmux sees running in
    /// the pane (e.g. `zsh`, `vim`, `node`). Empty when tmux hasn't resolved
    /// it yet.
    pub current_command: String,
    /// `#{pane_current_path}` — absolute cwd of the foreground process. Empty
    /// when tmux hasn't resolved it yet.
    pub current_path: String,
    /// `#{pane_title}` — tmux pane title, typically set by the program inside
    /// the pane via OSC 0/2. Empty when the pane has not published a title.
    pub pane_title: String,
    /// `#{window_name}` — tmux window name. Harness CLIs sometimes still leave
    /// a useful hint here even when the pane title is empty.
    pub window_name: String,
}

/// Launch-time recovery summary (§3.6).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RecoveryReport {
    /// Sessions that are on the socket AND tracked in `state/sessions.toml`.
    pub reattached: Vec<String>,
    /// Sessions that are on the socket but NOT in `state/sessions.toml`.
    pub orphaned: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct TmuxManager {
    pub socket: String,
    pub binary: PathBuf,
}

impl Default for TmuxManager {
    fn default() -> Self {
        Self {
            socket: RAUM_TMUX_SOCKET.to_string(),
            binary: PathBuf::from("tmux"),
        }
    }
}

impl TmuxManager {
    /// Explicit socket + binary constructor (integration tests pass a unique socket).
    #[must_use]
    pub fn with_socket(socket: impl Into<String>) -> Self {
        Self {
            socket: socket.into(),
            binary: PathBuf::from("tmux"),
        }
    }

    /// §3.1 — starting the server is a no-op in practice: `tmux -L raum new-session -d`
    /// lazily spawns the server when the first session is created. Kept as a named API
    /// so callers can declare intent at launch time.
    pub fn start_server_if_needed(&self) -> Result<(), TmuxError> {
        // If `list-sessions` works, a server is already running. If it reports
        // "no server running", we treat that as the happy path — the next
        // `new_session` call will spawn one.
        match self.list_sessions() {
            Ok(_) => Ok(()),
            Err(TmuxError::Io(_)) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// §3.1 — tear down the entire `-L raum` tmux server. Returns Ok(()) if no
    /// server was running in the first place.
    pub fn kill_server(&self) -> Result<(), TmuxError> {
        let out = self.cmd().arg("kill-server").output()?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if stderr.contains("no server running") || stderr.contains("error connecting") {
                return Ok(());
            }
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: stderr.into_owned(),
            });
        }
        Ok(())
    }

    /// Apply the server-wide options that make every PTY-attached `tmux
    /// attach-session` client as transparent as possible without flattening
    /// tmux's normal and alternate buffers into one surface. We still disable
    /// the prefix, status bar, synthetic focus events, and title escapes so
    /// the attached client behaves like a plain terminal tab.
    ///
    /// Idempotent: tmux's `set` clobbers prior values, so calling this on
    /// every launch is safe even when the server is already running.
    pub fn apply_server_options(&self) -> Result<(), TmuxError> {
        // Disable the prefix key entirely. Without this, Ctrl-B (and any
        // re-bound prefix) would be swallowed by the attached client instead
        // of reaching the inner harness.
        let _ = self
            .cmd()
            .args(["set-option", "-g", "prefix", "None"])
            .status();
        // Drop every default key binding. Belt-and-suspenders for the prefix
        // override above — we don't want any tmux command to fire from a
        // user keystroke.
        let _ = self.cmd().args(["unbind-key", "-a"]).status();
        // Zero ESC delay. Ink/Codex/vim depend on fast Esc detection.
        let _ = self
            .cmd()
            .args(["set-option", "-s", "escape-time", "0"])
            .status();
        // Hide the status bar — we don't need it stealing a row of viewport.
        let _ = self
            .cmd()
            .args(["set-option", "-g", "status", "off"])
            .status();
        // Strip smcup/rmcup from the attached client's terminfo. Without this,
        // `tmux attach-session` emits the alt-screen enter sequence into
        // xterm.js on connect, which parks the webview in its alternate
        // buffer — where xterm.js keeps no scrollback. Wheel scroll then sees
        // an empty history and does nothing. Stripping these at the outer
        // (attached-client) layer keeps the inner pane's alt-screen handling
        // untouched, so TUIs running inside tmux still get their alt-screen
        // on the pane.
        let _ = self
            .cmd()
            .args([
                "set-option",
                "-s",
                "terminal-overrides",
                ",xterm-256color:smcup@:rmcup@",
            ])
            .status();
        // Don't synthesize focus reporting at the tmux layer. The inner
        // process can request `?1004h` directly if it cares.
        let _ = self
            .cmd()
            .args(["set-option", "-g", "focus-events", "off"])
            .status();
        // Don't emit DECSLRM / xterm title escapes from tmux.
        let _ = self
            .cmd()
            .args(["set-option", "-g", "set-titles", "off"])
            .status();
        Ok(())
    }

    pub fn list_sessions(&self) -> Result<Vec<TmuxSession>, TmuxError> {
        let out = self
            .cmd()
            .args([
                "list-sessions",
                "-F",
                "#{session_name}\t#{session_created}\t#{window_width}\t#{window_height}",
            ])
            .output()?;
        if !out.status.success() {
            // tmux returns 1 when no server is running — treat as empty.
            let stderr = String::from_utf8_lossy(&out.stderr);
            if stderr.contains("no server running") || stderr.contains("error connecting") {
                return Ok(vec![]);
            }
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: stderr.into_owned(),
            });
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        Ok(Self::parse_sessions(&stdout))
    }

    /// Defensive parser for the `list-sessions -F ...` output. Skips blank lines
    /// and lines missing the mandatory session name; fills in defaults for
    /// missing / unparsable numeric fields rather than erroring out. This keeps
    /// recovery resilient against tmux versions that occasionally emit extra
    /// warning lines on stdout.
    fn parse_sessions(stdout: &str) -> Vec<TmuxSession> {
        let mut out = Vec::new();
        for raw in stdout.lines() {
            let line = raw.trim_end_matches('\r');
            if line.trim().is_empty() {
                continue;
            }
            let mut parts = line.split('\t');
            let Some(id) = parts.next().map(str::trim).filter(|s| !s.is_empty()) else {
                continue;
            };
            let created = parts
                .next()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or_default();
            let width = parts
                .next()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(80);
            let height = parts
                .next()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(24);
            out.push(TmuxSession {
                id: id.to_string(),
                created_unix: created,
                width,
                height,
            });
        }
        out
    }

    /// Spawn a detached tmux session. If `initial_command` is `Some`, the
    /// session is created with a silent placeholder (`tail -f /dev/null`) — the
    /// caller is expected to call [`Self::respawn_with`] to launch the real
    /// process once the PTY bridge is attached. This guarantees the harness's
    /// banner is rendered into a viewport tmux already knows about, so the
    /// attached client picks it up on its first refresh.
    ///
    /// If `initial_command` is `None`, the user's default login shell runs.
    ///
    /// `initial_size` sets the pane dimensions before the harness boots, so a
    /// TUI sees the real cols/rows on its very first paint. Passing `None`
    /// falls back to a roomy 200×50 default; the attached client will resize
    /// the pane to match the PTY's true size as soon as the bridge attaches.
    pub fn new_session(
        &self,
        id: &str,
        cwd: &std::path::Path,
        initial_command: Option<&str>,
        initial_size: Option<(u32, u32)>,
    ) -> Result<(), TmuxError> {
        self.new_session_with_env(id, cwd, initial_command, initial_size, &[])
    }

    /// Variant of [`Self::new_session`] that injects additional environment
    /// variables into the spawned session via tmux's `-e KEY=VALUE` flag. Used
    /// by the harness notification wiring to export `RAUM_SESSION=<session_id>`
    /// so the hook script embeds the session id in every event.
    pub fn new_session_with_env(
        &self,
        id: &str,
        cwd: &std::path::Path,
        initial_command: Option<&str>,
        initial_size: Option<(u32, u32)>,
        env: &[(&str, &str)],
    ) -> Result<(), TmuxError> {
        // Pre-size the window via `new-session -x -y` so the harness's first
        // paint lands at the real geometry. This is the only point at which
        // tmux accepts an absolute window size without `window-size manual`
        // already being set, and it's required even when manual is set
        // because the post-creation `resize-window` then matches the existing
        // size (no-op, but consistent).
        let (init_cols, init_rows) = initial_size.unwrap_or((200, 50));
        let init_cols_str = init_cols.to_string();
        let init_rows_str = init_rows.to_string();

        let mut cmd = self.cmd();
        cmd.args([
            "new-session",
            "-d",
            "-s",
            id,
            "-c",
            cwd.to_string_lossy().as_ref(),
            "-x",
            &init_cols_str,
            "-y",
            &init_rows_str,
        ]);
        // Export TERM=xterm-256color to the session's processes. The PTY-
        // attached tmux client also runs with this TERM; matching them keeps
        // capability negotiation consistent end-to-end.
        cmd.arg("-e").arg("TERM=xterm-256color");
        for (k, v) in env {
            cmd.arg("-e").arg(format!("{k}={v}"));
        }
        if initial_command.is_some() {
            // Portable placeholder: produces no terminal output and never
            // exits, so tmux keeps the pane alive until `respawn-pane` swaps
            // in the real process. macOS's BSD `sleep` rejects `sleep
            // infinity`, so we can't use it here.
            cmd.arg("tail -f /dev/null");
        }
        let out = cmd.output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        // §3.8 — retain tmux scrollback as a safety net for future copy-mode
        // exposure. xterm.js's own 10 000-line scrollback is the visible
        // history surface today; keeping tmux's matches it in case we surface
        // copy-mode through a command palette entry later.
        let _ = self
            .cmd()
            .args(["set-option", "-t", id, "history-limit", "10000"])
            .status();
        let _ = self
            .cmd()
            .args(["set-option", "-t", id, "remain-on-exit", "on"])
            .status();
        // Pin the window size to whatever raum drives via `resize-window`,
        // regardless of attached-client geometry. tmux's auto modes
        // (`latest`/`largest`/etc.) don't fire reliably on every tmux build
        // when a single PTY-attached client connects, which left the window
        // pegged at 80×24 while the xterm viewport grew — tmux then filled
        // the difference with its hatched "viewport > pane" pattern. Manual
        // mode plus explicit `tmux resize-window` from the resize command
        // makes our intent the source of truth.
        let _ = self
            .cmd()
            .args(["set-option", "-t", id, "window-size", "manual"])
            .status();
        // Hide the status bar on this specific session. `apply_server_options`
        // sets `-g status off`, but that only sticks if the tmux server is
        // alive when it runs — on a clean launch the server may start just to
        // answer the `-g` set and then exit (no sessions yet), discarding the
        // global value. Setting it session-local here is race-free.
        let _ = self
            .cmd()
            .args(["set-option", "-t", id, "status", "off"])
            .status();
        // Re-apply the server-wide smcup/rmcup strip now that we know the
        // server is alive (the session we just created is keeping it up).
        // `terminal-overrides` is a server option, so it can't be mirrored
        // per-session the way `status off` is — but setting it with the
        // server guaranteed-alive here avoids the same cold-start race.
        let _ = self
            .cmd()
            .args([
                "set-option",
                "-s",
                "terminal-overrides",
                ",xterm-256color:smcup@:rmcup@",
            ])
            .status();
        Ok(())
    }

    /// Resize the tmux window to `cols`×`rows`. Required because we run with
    /// `window-size manual` per session — without an explicit
    /// `resize-window`, tmux pins the window at its creation size even as
    /// the attached client's viewport changes, leaving the harness rendered
    /// into a corner of the pane with hatched padding around it.
    pub fn resize(&self, id: &str, cols: u32, rows: u32) -> Result<(), TmuxError> {
        let out = self
            .cmd()
            .args([
                "resize-window",
                "-t",
                id,
                "-x",
                &cols.to_string(),
                "-y",
                &rows.to_string(),
            ])
            .output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(())
    }

    /// Replace the pane's process with `command`, killing whatever is running.
    /// Used after the PTY bridge attaches so the harness boots into a viewport
    /// the attached client is already rendering.
    pub fn respawn_with(&self, id: &str, command: &str) -> Result<(), TmuxError> {
        let out = self
            .cmd()
            .args(["respawn-pane", "-k", "-t", id, command])
            .output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(())
    }

    pub fn kill_session(&self, id: &str) -> Result<(), TmuxError> {
        let out = self.cmd().args(["kill-session", "-t", id]).output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(())
    }

    /// Check whether the pane's process has exited. Returns `Ok(Some(exit_code))`
    /// when the pane is dead, `Ok(None)` when it is still running, or `Err` if the
    /// session no longer exists (killed externally).
    ///
    /// Requires `remain-on-exit on` (set by [`Self::new_session`]) so that tmux
    /// keeps the dead pane alive long enough for us to read `pane_dead_status`.
    pub fn check_pane_dead(&self, id: &str) -> Result<Option<i32>, TmuxError> {
        let out = self
            .cmd()
            .args([
                "display-message",
                "-t",
                id,
                "-p",
                "#{pane_dead}:#{pane_dead_status}",
            ])
            .output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        let s = String::from_utf8_lossy(&out.stdout);
        let s = s.trim();
        if let Some(rest) = s.strip_prefix("1:") {
            let code = rest.trim().parse::<i32>().unwrap_or(-1);
            Ok(Some(code))
        } else {
            Ok(None)
        }
    }

    /// Capture the pane state needed to restore a fresh xterm.js instance
    /// before the live tmux client reattaches.
    ///
    /// tmux exposes the visible screen and the preserved normal history via two
    /// different `capture-pane` modes:
    /// - normal mode: plain `capture-pane ...` returns the currently visible
    ///   surface, which is the alternate-screen frame when one is active.
    /// - alternate mode: `capture-pane -a ...` returns the underlying normal
    ///   history while the pane is in alternate-screen; once alternate-screen
    ///   is inactive tmux reports `no alternate screen`.
    pub fn capture_pane_snapshot(&self, id: &str) -> Result<PaneSnapshot, TmuxError> {
        let alternate_on = self.is_alternate_on(id)?;
        if alternate_on {
            let alternate = self.capture_pane(id, false)?;
            let normal = self.capture_pane(id, true)?;
            return Ok(PaneSnapshot {
                normal,
                alternate: Some(alternate),
            });
        }

        Ok(PaneSnapshot {
            normal: self.capture_pane(id, false)?,
            alternate: None,
        })
    }

    /// Capture only the recent visible pane state needed for a fast reattach
    /// paint. This intentionally avoids walking the full tmux history because
    /// app restart may reattach many panes at once, and full-history replay
    /// delays the live PTY bridge.
    pub fn capture_pane_view_snapshot(
        &self,
        id: &str,
        line_count: u16,
    ) -> Result<PaneSnapshot, TmuxError> {
        let line_count = line_count.max(1);
        let alternate_on = self.is_alternate_on(id)?;
        if alternate_on {
            let alternate = self.capture_pane_recent(id, false, line_count)?;
            return Ok(PaneSnapshot {
                normal: Vec::new(),
                alternate: Some(alternate),
            });
        }

        Ok(PaneSnapshot {
            normal: self.capture_pane_recent(id, false, line_count)?,
            alternate: None,
        })
    }

    /// Plain-text variant of [`Self::capture_pane_snapshot`] for the global
    /// search panel. Returns the pane's full scrollback (and the alt-screen
    /// frame, if active) as decoded UTF-8 with no ANSI escapes — ready to
    /// split on `\n` and match against.
    pub fn capture_pane_text(&self, id: &str) -> Result<PaneTextSnapshot, TmuxError> {
        let alternate_on = self.is_alternate_on(id)?;
        if alternate_on {
            let alternate = self.capture_pane_plain(id, false)?;
            let normal = self.capture_pane_plain(id, true)?;
            return Ok(PaneTextSnapshot {
                normal,
                alternate: Some(alternate),
            });
        }

        Ok(PaneTextSnapshot {
            normal: self.capture_pane_plain(id, false)?,
            alternate: None,
        })
    }

    /// Return pane metadata used by the frontend tab strip in one
    /// `display-message` call.
    ///
    /// Output is
    /// `#{pane_current_command}<US>#{pane_current_path}<US>#{pane_title}<US>#{window_name}`.
    /// Any field may be empty when tmux hasn't resolved it yet — callers treat
    /// empty as "no useful label". Unit Separator is used as the delimiter so
    /// ordinary spaces in titles and paths do not need escaping.
    pub fn pane_context(&self, id: &str) -> Result<PaneContext, TmuxError> {
        let out = self
            .cmd()
            .args([
                "display-message",
                "-p",
                "-t",
                id,
                "#{pane_current_command}\u{1f}#{pane_current_path}\u{1f}#{pane_title}\u{1f}#{window_name}",
            ])
            .output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        let line = String::from_utf8_lossy(&out.stdout);
        Ok(parse_pane_context(&line))
    }

    fn is_alternate_on(&self, id: &str) -> Result<bool, TmuxError> {
        let out = self
            .cmd()
            .args(["display-message", "-p", "-t", id, "#{alternate_on}"])
            .output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim() == "1")
    }

    fn capture_pane(&self, id: &str, alternate_mode: bool) -> Result<Vec<u8>, TmuxError> {
        let mut cmd = self.cmd();
        cmd.args(["capture-pane", "-p", "-e"]);
        if alternate_mode {
            cmd.arg("-a");
        }
        cmd.args(["-S", "-", "-E", "-", "-t", id]);
        let out = cmd.output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(rewrite_lf_to_crlf(out.stdout))
    }

    fn capture_pane_recent(
        &self,
        id: &str,
        alternate_mode: bool,
        line_count: u16,
    ) -> Result<Vec<u8>, TmuxError> {
        let mut cmd = self.cmd();
        cmd.args(["capture-pane", "-p", "-e"]);
        if alternate_mode {
            cmd.arg("-a");
        }
        let start = format!("-{}", line_count.saturating_sub(1));
        cmd.args(["-S", &start, "-E", "-", "-t", id]);
        let out = cmd.output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(rewrite_lf_to_crlf(out.stdout))
    }

    fn capture_pane_plain(&self, id: &str, alternate_mode: bool) -> Result<String, TmuxError> {
        let mut cmd = self.cmd();
        cmd.args(["capture-pane", "-p"]);
        if alternate_mode {
            cmd.arg("-a");
        }
        cmd.args(["-S", "-", "-E", "-", "-t", id]);
        let out = cmd.output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Type `command` into the session's shell and hit Enter. Used to launch
    /// an agent harness like `claude` / `codex` / `opencode` without going
    /// through `respawn-pane` (e.g. plain Shell sessions where the user's
    /// login shell is the right entry point).
    pub fn send_command(&self, id: &str, command: &str) -> Result<(), TmuxError> {
        let mut cmd = self.cmd();
        cmd.args(["send-keys", "-t", id]);
        if !command.is_empty() {
            cmd.arg(command);
        }
        cmd.arg("Enter");
        let out = cmd.output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(())
    }

    /// Paste `payload` into the pane as if the user had pressed <kbd>Paste</kbd>
    /// in the host terminal. Implemented via `tmux load-buffer` +
    /// `tmux paste-buffer`, which is the only route that lets tmux wrap the
    /// bytes in bracketed-paste CSIs (`ESC[200~ … ESC[201~`) *conditionally*
    /// on the foreground app having enabled DECSET 2004. Harnesses like Claude
    /// Code / Codex / OpenCode use that wrap to recognise the payload as an
    /// attachment drop rather than a run of keystrokes; shells and `vim`
    /// insert-mode see the right thing too.
    ///
    /// When `bracketed` is true we pass `-p` to `paste-buffer`; when false we
    /// omit it (the inner app will never see CSI 200/201 even if it would
    /// accept them). `-d` deletes the named buffer on the way out so rapid
    /// drops don't leak entries into the tmux buffer stack.
    ///
    /// The buffer name is caller-supplied so the test harness can prove the
    /// round-trip without clashing with parallel drops on the same socket.
    pub fn paste_into_pane(
        &self,
        target: &str,
        buffer_name: &str,
        payload: &[u8],
        bracketed: bool,
    ) -> Result<(), TmuxError> {
        // Stage 1 — load-buffer reads from stdin when the final positional
        // argument is `-`. We override the default `stdin(Null)` from
        // `cmd()` so the child can read `payload` verbatim, byte-for-byte;
        // this is how we dodge any shell-escaping of the file path itself.
        let mut load = self.cmd();
        load.args(["load-buffer", "-b", buffer_name, "-"])
            .stdin(Stdio::piped());
        let mut child = load.spawn()?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(payload)?;
            // Dropping `stdin` here closes the pipe and lets tmux finish.
        }
        let status = child.wait()?;
        if !status.success() {
            return Err(TmuxError::NonZero {
                status: status.code().unwrap_or(-1),
                stderr: "load-buffer failed".to_string(),
            });
        }

        // Stage 2 — paste-buffer into the target pane. `-d` frees the buffer
        // after use; `-p` requests bracketed-paste wrapping when the pane's
        // foreground app has DECSET 2004 enabled.
        let mut paste = self.cmd();
        paste.args(["paste-buffer", "-b", buffer_name, "-d"]);
        if bracketed {
            paste.arg("-p");
        }
        paste.args(["-t", target]);
        let out = paste.output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(())
    }

    /// §3.6 — launch-time recovery: enumerate sessions on the socket, reconcile
    /// with `state/sessions.toml`, and fire an eager concurrent attach ping per
    /// session so the backend warms its per-pane mpsc/pipe-pane topology.
    ///
    /// The "attach ping" is a cheap `tmux has-session -t <id>` spawned on a tokio
    /// task. It lets the operating system schedule the socket handshake work in
    /// parallel; once all tasks resolve, the returned `RecoveryReport` is final.
    pub async fn recover_sessions(&self, state: &SessionState) -> RecoveryReport {
        let live = match self.list_sessions() {
            Ok(v) => v,
            Err(_) => return RecoveryReport::default(),
        };

        let tracked: HashSet<String> = state
            .sessions
            .iter()
            .map(|s| s.session_id.clone())
            .collect();

        let this = Arc::new(self.clone());
        let mut handles = Vec::with_capacity(live.len());
        for s in &live {
            let m = this.clone();
            let id = s.id.clone();
            handles.push(tokio::spawn(async move {
                let _ = tokio::task::spawn_blocking(move || {
                    let _ = m.cmd().args(["has-session", "-t", &id]).status();
                })
                .await;
            }));
        }
        for h in handles {
            let _ = h.await;
        }

        let mut reattached = Vec::new();
        let mut orphaned = Vec::new();
        for s in live {
            if tracked.contains(&s.id) {
                reattached.push(s.id);
            } else {
                orphaned.push(s.id);
            }
        }
        RecoveryReport {
            reattached,
            orphaned,
        }
    }

    /// §3.7 — stale-session reaper. Kills any session whose `session_created`
    /// timestamp is older than `threshold_days` and returns the ids that were
    /// killed. No CLI surface — only reachable via Tauri `terminal_reap_stale`.
    pub fn reap_stale(&self, threshold_days: u32) -> Vec<String> {
        let Ok(live) = self.list_sessions() else {
            return Vec::new();
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let threshold_secs = u64::from(threshold_days) * 24 * 60 * 60;
        let mut killed = Vec::new();
        for s in live {
            if s.created_unix == 0 {
                continue;
            }
            let age = now.saturating_sub(s.created_unix);
            if age > threshold_secs && self.kill_session(&s.id).is_ok() {
                killed.push(s.id);
            }
        }
        killed
    }

    fn cmd(&self) -> Command {
        let mut c = Command::new(&self.binary);
        c.arg("-L").arg(&self.socket);
        c.stdin(Stdio::null());
        c
    }
}

fn rewrite_lf_to_crlf(bytes: Vec<u8>) -> Vec<u8> {
    let mut crlf = Vec::with_capacity(bytes.len() + 32);
    for b in bytes {
        if b == b'\n' {
            crlf.push(b'\r');
            crlf.push(b'\n');
        } else {
            crlf.push(b);
        }
    }
    crlf
}

fn parse_pane_context(stdout: &str) -> PaneContext {
    let trimmed = stdout.trim_end_matches(['\r', '\n']);
    let mut parts = trimmed.splitn(4, '\u{1f}');
    let current_command = parts.next().unwrap_or("").trim().to_string();
    let current_path = parts.next().unwrap_or("").trim().to_string();
    let pane_title = parts.next().unwrap_or("").trim().to_string();
    let window_name = parts.next().unwrap_or("").trim().to_string();
    PaneContext {
        current_command,
        current_path,
        pane_title,
        window_name,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_sessions_handles_missing_fields() {
        let stdout = "\
sess-1\t1700000000\t200\t50
sess-partial\t1700000001\t\t
sess-namebad\t\t\t
\t\t\t
sess-only
sess-windows-crlf\t1700000002\t100\t30\r
";
        let parsed = TmuxManager::parse_sessions(stdout);
        // Five rows with a valid name; the purely-empty row is skipped.
        assert_eq!(parsed.len(), 5);
        assert_eq!(parsed[0].id, "sess-1");
        assert_eq!(parsed[0].width, 200);
        assert_eq!(parsed[0].height, 50);
        assert_eq!(parsed[1].id, "sess-partial");
        // Missing numeric fields default to 80x24.
        assert_eq!(parsed[1].width, 80);
        assert_eq!(parsed[1].height, 24);
        assert_eq!(parsed[2].id, "sess-namebad");
        assert_eq!(parsed[2].created_unix, 0);
        assert_eq!(parsed[3].id, "sess-only");
        assert_eq!(parsed[4].id, "sess-windows-crlf");
        assert_eq!(parsed[4].width, 100);
        assert_eq!(parsed[4].height, 30);
    }

    #[test]
    fn parse_pane_context_handles_extended_fields() {
        let stdout = "node\u{1f}/tmp/raum\u{1f}⠋ raum\u{1f}node\r\n";
        let parsed = parse_pane_context(stdout);
        assert_eq!(parsed.current_command, "node");
        assert_eq!(parsed.current_path, "/tmp/raum");
        assert_eq!(parsed.pane_title, "⠋ raum");
        assert_eq!(parsed.window_name, "node");
    }

    #[test]
    fn parse_pane_context_defaults_missing_fields_to_empty() {
        let parsed = parse_pane_context("/tmp/raum");
        assert_eq!(parsed.current_command, "/tmp/raum");
        assert_eq!(parsed.current_path, "");
        assert_eq!(parsed.pane_title, "");
        assert_eq!(parsed.window_name, "");
    }
}
