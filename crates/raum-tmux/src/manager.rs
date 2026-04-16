//! TmuxManager — owns the `-L raum` socket.
//!
//! Covers §3.1/§3.4/§3.6/§3.7 of the raum-bootstrap change:
//! - session CRUD over the `-L raum` socket
//! - launch-time recovery with eager concurrent attach
//! - stale-session reaper

use std::collections::HashSet;
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
    /// session is created with a silent placeholder (`sleep infinity`) — the
    /// caller is expected to attach `pipe-pane` and then call
    /// [`Self::respawn_with`] to launch the real command. That two-step dance
    /// is the only race-free way to guarantee the command's output is fully
    /// captured by `pipe-pane` (tmux does NOT replay bytes produced between
    /// `new-session` and `pipe-pane`).
    ///
    /// If `initial_command` is `None`, the user's default login shell runs
    /// — the caller should still warm the pane with a fresh prompt after
    /// attaching `pipe-pane` (see `send_command(id, "")`).
    ///
    /// `initial_size` sets the pane dimensions before the pipe-pane / respawn
    /// dance, so a harness sees its correct cols/rows on the very first paint.
    /// Passing `None` falls back to a roomy 200×50 default (the webview will
    /// correct it on the first `terminal_resize`).
    pub fn new_session(
        &self,
        id: &str,
        cwd: &std::path::Path,
        initial_command: Option<&str>,
        initial_size: Option<(u32, u32)>,
    ) -> Result<(), TmuxError> {
        let mut cmd = self.cmd();
        cmd.args([
            "new-session",
            "-d",
            "-s",
            id,
            "-c",
            cwd.to_string_lossy().as_ref(),
        ]);
        if initial_command.is_some() {
            // Portable placeholder: produces no terminal output and never
            // exits, so `pipe-pane` can attach without missing bytes and the
            // session stays alive until `respawn-pane` swaps in the real
            // process. macOS's BSD `sleep` rejects `sleep infinity`, so we
            // can't use it here.
            cmd.arg("tail -f /dev/null");
        }
        let out = cmd.output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        // §3.8 — unlimited tmux scrollback (xterm.js caps at 10 000 lines; the
        // full history stays recoverable via tmux copy-mode).
        let _ = self
            .cmd()
            .args(["set-option", "-t", id, "history-limit", "0"])
            .status();
        // raum drives pane dimensions from the webview via `resize-window`.
        // Without `window-size manual` tmux keeps the detached session at the
        // default 80×24, so `resize-window` becomes a silent no-op and every
        // harness renders into the top-left corner of the real pane. Setting
        // this per-session makes our explicit resizes authoritative.
        let _ = self
            .cmd()
            .args(["set-option", "-t", id, "window-size", "manual"])
            .status();
        let _ = self
            .cmd()
            .args(["set-option", "-t", id, "remain-on-exit", "on"])
            .status();
        // Size the pane before pipe-pane / respawn so the harness's very first
        // paint lands at the real dimensions and we don't get a post-spawn
        // SIGWINCH-triggered second banner. When the caller can't measure yet
        // we fall back to a roomy 200×50; the webview corrects it on the next
        // `terminal_resize`.
        let (init_cols, init_rows) = initial_size.unwrap_or((200, 50));
        let _ = self
            .cmd()
            .args([
                "resize-window",
                "-t",
                id,
                "-x",
                &init_cols.to_string(),
                "-y",
                &init_rows.to_string(),
            ])
            .status();
        Ok(())
    }

    /// Replace the pane's process with `command`, killing whatever is running.
    /// Used after `pipe-pane` is attached so the new process's output is
    /// captured from the first byte (see [`Self::new_session`] docs).
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

    /// §3.4 — `terminal_send_keys` delegates here. One keystroke per call:
    /// latency-optimized, not throughput-optimized.
    pub fn send_keys(&self, id: &str, keys: &str) -> Result<(), TmuxError> {
        // `-l` disables key-name lookup; tmux sends the literal bytes. This is
        // what we want for xterm.js `onData` input.
        let out = self
            .cmd()
            .args(["send-keys", "-t", id, "-l", keys])
            .output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(())
    }

    /// Type `command` into the session's shell and hit Enter. Built on top of
    /// `send-keys` (without `-l` so `Enter` is parsed as a key name). Used to
    /// (a) warm up the shell prompt after `pipe-pane` attaches and (b) launch
    /// an agent harness like `claude` / `codex` / `opencode` into a freshly
    /// spawned session.
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
            .map(|d| d.as_secs())
            .unwrap_or(0);
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
        // Four sessions with a valid name; the purely-empty row is skipped.
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
}
