//! TmuxManager — owns the `-L raum` socket.
//!
//! Covers §3.1/§3.6/§3.7 of the raum-bootstrap change:
//! - session CRUD over the `-L raum` socket
//! - launch-time recovery with eager concurrent attach
//! - stale-session reaper

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use raum_core::config::XTERM_SCROLLBACK_LINES;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::warn;

pub const RAUM_TMUX_SOCKET: &str = "raum";

/// Default tmux socket name for the running instance.
///
/// An explicit `RAUM_TMUX_SOCKET` wins (used by integration tests and power
/// users). Otherwise the socket follows the active instance namespace
/// (`raum`, `raum-dev`, …) so a `task dev` build and a release install never
/// share a tmux server — and therefore never fight over each other's agent
/// sessions. See [`raum_core::paths::instance_name`].
#[must_use]
pub fn default_socket_name() -> String {
    if let Ok(explicit) = std::env::var("RAUM_TMUX_SOCKET") {
        if !explicit.is_empty() {
            return explicit;
        }
    }
    raum_core::paths::instance_name()
}

/// True when a tmux command's stderr means "there is no live server on this
/// socket" — the cold-socket condition the boot recovery path treats as an
/// empty session list rather than a hard error.
///
/// tmux phrases this several ways depending on *when* the client notices the
/// server is gone:
/// - `no server running on <socket>` — the socket file is absent (clean cold start).
/// - `error connecting to <socket> (...)` — the socket file exists but nothing
///   is listening (stale socket, e.g. after a crash).
/// - `server exited unexpectedly` / `lost server` — the client connected to a
///   socket whose server is dying/just died and the connection dropped mid-
///   command. This is a race seen right after `kill-server`, and notably on
///   slower runners (observed on Linux arm64 CI) where the window between the
///   server's exit and the socket teardown is wide enough to hit.
///
/// All four are functionally "no live sessions" for recovery purposes.
/// True when a tmux server's argv is the pre-0.1.13 disclaimed birth.
///
/// tmux servers carry the argv of the client that forked them, so the birthing
/// command is readable off the running process. Only the legacy form is a bare
/// `start-server`; every other birth raum performs chains further commands
/// after a `;`. Split out from
/// [`TmuxManager::server_born_legacy_disclaimed`] so both directions are
/// testable — the positive case cannot be staged against a live server, because
/// a bare `start-server` reaps itself under `exit-empty` before anything can
/// observe it (which is exactly why the legacy birth was unreliable).
fn is_legacy_birth_argv(argv: &str) -> bool {
    let argv = argv.trim();
    !argv.contains(';') && argv.ends_with("start-server")
}

fn is_no_server_stderr(stderr: &str) -> bool {
    stderr.contains("no server running")
        || stderr.contains("error connecting")
        || stderr.contains("server exited unexpectedly")
        || stderr.contains("lost server")
}

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

/// How long a batched pane-death listing stays usable for
/// [`TmuxManager::check_pane_dead_polled`]. Deliberately shorter than the
/// 300 ms monitor tick, so a single pane still gets a fresh answer every tick
/// while N panes on independent timers collapse to ~1–2 tmux forks per tick
/// instead of N.
const DEAD_POLL_CACHE_TTL: Duration = Duration::from_millis(200);

/// `list-panes -a` format backing [`TmuxManager::check_pane_dead_polled`].
const DEAD_POLL_FORMAT: &str = "#{session_name}\u{1f}#{pane_dead}\u{1f}#{pane_dead_status}";

/// A batched pane-death listing plus the instant it was taken. `None` inside
/// the map means the pane is still running.
type DeadCache = Mutex<Option<(Instant, HashMap<String, Option<i32>>)>>;

#[derive(Debug, Clone)]
pub struct TmuxManager {
    pub socket: String,
    pub binary: PathBuf,
    /// macOS TCC policy for the server birth — see
    /// [`set_disclaim_tcc`](Self::set_disclaim_tcc). Shared across clones so
    /// the startup sync reaches every holder of the manager; only consulted at
    /// the moment the server is born.
    disclaim_tcc: Arc<AtomicBool>,
    /// Last batched pane-death listing + when it was taken. Shared across
    /// clones so every pane-death monitor draws from one refresh.
    dead_cache: Arc<DeadCache>,
}

impl Default for TmuxManager {
    fn default() -> Self {
        Self {
            socket: default_socket_name(),
            binary: PathBuf::from("tmux"),
            disclaim_tcc: Arc::new(AtomicBool::new(false)),
            dead_cache: Arc::new(Mutex::new(None)),
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
            disclaim_tcc: Arc::new(AtomicBool::new(false)),
            dead_cache: Arc::new(Mutex::new(None)),
        }
    }

    /// Set the macOS TCC responsibility policy applied when the tmux server is
    /// born (`config.toml` → `terminals.disclaim_tcc_responsibility`).
    ///
    /// `false` (default) leaves raum.app as the TCC "responsible process" for
    /// every shell under the server, so App Data prompts name raum — a
    /// Developer-ID-signed identity TCC can pin a decision to, and one that
    /// Full Disk Access can silence for good. `true` disclaims, making the
    /// server its own responsible process (prompts name `tmux`).
    ///
    /// Consulted only at server birth, so this has no effect on a server that
    /// is already running — the socket has to go cold first. A no-op off macOS.
    pub fn set_disclaim_tcc(&self, on: bool) {
        self.disclaim_tcc.store(on, Ordering::Relaxed);
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

    /// True when the live server on this socket was born by the *legacy*
    /// disclaimed spawn — the pre-0.1.13 `birth_server`, which ran a bare
    /// `start-server` and left the server as its own TCC responsible process.
    ///
    /// Such a server makes macOS attribute every pane's app-data access to
    /// `tmux` rather than raum.app, and no amount of updating raum fixes it:
    /// responsibility is fixed at birth and the server outlives the app. The
    /// only cure is a cold server, which costs the user their live sessions —
    /// so raum has to *find* these and ask, never assume.
    ///
    /// Detection is the server's own argv, which tmux inherits from whichever
    /// client forked it:
    ///
    /// | Born by                         | argv                                          |
    /// |---------------------------------|-----------------------------------------------|
    /// | legacy disclaim (pre-0.1.13)    | `tmux -L raum start-server`                   |
    /// | current disclaim (opt-in)       | `… start-server ; set-option -s exit-empty …` |
    /// | normal lazy birth               | `… start-server ; set-option … ; new-session …`|
    ///
    /// So "no `;` and ends with `start-server`" identifies exactly the legacy
    /// shape. Any error — no server, no `ps`, unparsable pid — answers `false`:
    /// this drives a prompt to destroy sessions, so it must never fire on a
    /// guess.
    ///
    /// macOS-only. The disclaim was always a no-op elsewhere, so no Linux
    /// server can be in this state.
    #[must_use]
    pub fn server_born_legacy_disclaimed(&self) -> bool {
        if !cfg!(target_os = "macos") {
            return false;
        }
        let Some(pid) = self.server_pid() else {
            return false;
        };
        let Ok(out) = Command::new("ps")
            .args(["-o", "command=", "-p", &pid.to_string()])
            .output()
        else {
            return false;
        };
        if !out.status.success() {
            return false;
        }
        is_legacy_birth_argv(&String::from_utf8_lossy(&out.stdout))
    }

    /// PID of the server currently listening on this socket, or `None` when
    /// nothing is (or tmux answered something unparsable).
    fn server_pid(&self) -> Option<u32> {
        let out = self
            .cmd()
            .args(["display-message", "-p", "#{pid}"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    }

    /// Version of the server currently listening on this socket (`#{version}`:
    /// `3.6a`, `3.7b`, `next-3.8`), or `None` when nothing is. Distinct from
    /// [`Self::client_version`] — after a package upgrade the two diverge
    /// until the server is reborn.
    #[must_use]
    pub fn server_version(&self) -> Option<String> {
        let out = self
            .cmd()
            .args(["display-message", "-p", "#{version}"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!v.is_empty()).then_some(v)
    }

    /// Version of the tmux binary itself (`tmux -V`, prefix stripped) — what a
    /// freshly born server would run.
    #[must_use]
    pub fn client_version(&self) -> Option<String> {
        let out = Command::new(&self.binary).arg("-V").output().ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout);
        let s = s.trim();
        let v = s.strip_prefix("tmux ").unwrap_or(s).to_string();
        (!v.is_empty()).then_some(v)
    }

    /// §3.1 — tear down the entire `-L raum` tmux server. Returns Ok(()) if no
    /// server was running in the first place.
    pub fn kill_server(&self) -> Result<(), TmuxError> {
        let out = self.cmd().arg("kill-server").output()?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if is_no_server_stderr(&stderr) {
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
    /// the prefix, status bar, and title escapes so the attached client
    /// behaves like a plain terminal tab.
    ///
    /// Idempotent: tmux's `set` clobbers prior values, so calling this on
    /// every launch is safe even when the server is already running.
    pub fn apply_server_options(&self) -> Result<(), TmuxError> {
        // One chained invocation: six separate `tmux set-option` spawns cost
        // six process launches and six socket handshakes on every launch.
        self.run_quiet(&[
            // `set-option -g prefix None` is sufficient on its own: with no
            // prefix key, no key-table binding can fire from a user
            // keystroke. We deliberately do NOT follow up with `unbind-key
            // -a` — that deletes the `prefix` and `root` key-tables
            // entirely, after which any later tmux op (including ones inside
            // `attach-session`'s key-dispatch path) that touches a missing
            // table emits `table prefix doesn't exist` on the parent's
            // stderr.
            "set-option",
            "-g",
            "prefix",
            "None",
            ";",
            // Zero ESC delay. Ink/Codex/vim depend on fast Esc detection.
            "set-option",
            "-s",
            "escape-time",
            "0",
            ";",
            // Hide the status bar — we don't need it stealing a row of
            // viewport.
            "set-option",
            "-g",
            "status",
            "off",
            ";",
            // Strip smcup/rmcup from the attached client's terminfo. Without
            // this, `tmux attach-session` emits the alt-screen enter sequence
            // into xterm.js on connect, which parks the webview in its
            // alternate buffer — where xterm.js keeps no scrollback. Wheel
            // scroll then sees an empty history and does nothing. Stripping
            // these at the outer (attached-client) layer keeps the inner
            // pane's alt-screen handling untouched, so TUIs running inside
            // tmux still get their alt-screen on the pane.
            "set-option",
            "-s",
            "terminal-overrides",
            ",xterm-256color:smcup@:rmcup@",
            ";",
            // Forward `\e[I` / `\e[O` from the attached client through to the
            // inner process when it has requested DECSET 1004. With this off,
            // tmux silently drops those bytes and harnesses (Claude Code,
            // Codex, vim's `:set autoread`, etc.) never see focus
            // transitions — and `claude doctor` flags the misconfiguration.
            "set-option",
            "-g",
            "focus-events",
            "on",
            ";",
            // Don't emit DECSLRM / xterm title escapes from tmux.
            "set-option",
            "-g",
            "set-titles",
            "off",
        ]);
        Ok(())
    }

    /// Fire-and-forget tmux invocation used for idempotent option setters.
    /// Captures stderr and routes any unexpected output through `tracing::warn!`
    /// keyed by the subcommand, instead of inheriting it onto the parent
    /// process's stderr (where it would surface in the dev console).
    /// Cold-socket / dead-server lines (see [`is_no_server_stderr`]) are
    /// expected during early bootstrap and are swallowed silently.
    fn run_quiet(&self, args: &[&str]) {
        let out = match self.cmd().args(args).output() {
            Ok(o) => o,
            Err(e) => {
                warn!(args = ?args, error = %e, "tmux invocation failed to spawn");
                return;
            }
        };
        if out.status.success() {
            return;
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        let trimmed = stderr.trim();
        if trimmed.is_empty() || is_no_server_stderr(trimmed) {
            return;
        }
        warn!(args = ?args, stderr = %trimmed, "tmux invocation reported error");
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
            if is_no_server_stderr(&stderr) {
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
        // macOS, opt-in: birth the tmux server with its TCC responsibility
        // disclaimed *before* the `new-session` below can lazily fork a
        // non-disclaimed one. Sequoia charges a pane's foreign app-data reads
        // (`docker`, `pulumi`, …) to the responsible process of the server that
        // parents every shell; disclaiming moves that from raum.app to `tmux`.
        //
        // Off by default because the Homebrew `tmux` is ad-hoc signed, so TCC
        // has no durable identity to pin an "Allow" to and re-prompts forever —
        // whereas raum.app is Developer-ID signed and can simply be granted
        // Full Disk Access once. See `terminals.disclaim_tcc_responsibility`.
        //
        // No-op if a server is already running, and on non-macOS. Best-effort:
        // on failure we fall through to the inline `start-server` below
        // (inherited responsibility) rather than block pane creation.
        if self.disclaim_tcc.load(Ordering::Relaxed) {
            if let Err(e) = crate::disclaim::birth_server(&self.binary, &self.socket) {
                warn!(
                    error = %e,
                    "disclaimed tmux server birth failed; TCC prompts may still appear"
                );
            }
        }

        let (init_cols, init_rows) = initial_size.unwrap_or((200, 50));
        let init_cols_str = init_cols.to_string();
        let init_rows_str = init_rows.to_string();
        let history_limit_str = XTERM_SCROLLBACK_LINES.to_string();

        let mut cmd = self.cmd();
        cmd.args([
            "start-server",
            ";",
            "set-option",
            "-g",
            "history-limit",
            &history_limit_str,
            ";",
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
        // Post-creation options, chained into one invocation instead of four
        // separate spawns. The per-window history-limit that used to run here
        // is gone: the `set-option -g history-limit` above executes in the
        // same chain *before* `new-session`, so the fresh window inherits it.
        //
        // ponytail: kept as a second tmux call rather than folded into the
        // creation chain above. tmux aborts a command list at the first
        // failure, so an option this build doesn't know (e.g. `window-size`
        // on tmux < 2.9) would both skip the rest and turn a successful
        // session creation into an `Err` — leaving an untracked live session.
        // `run_quiet` keeps these best-effort, which is the existing contract.
        self.run_quiet(&[
            "set-option",
            "-t",
            id,
            "remain-on-exit",
            "on",
            ";",
            // Pin the window size to whatever raum drives via `resize-window`,
            // regardless of attached-client geometry. tmux's auto modes
            // (`latest`/`largest`/etc.) don't fire reliably on every tmux build
            // when a single PTY-attached client connects, which left the window
            // pegged at 80×24 while the xterm viewport grew — tmux then filled
            // the difference with its hatched "viewport > pane" pattern. Manual
            // mode plus explicit `tmux resize-window` from the resize command
            // makes our intent the source of truth.
            "set-option",
            "-t",
            id,
            "window-size",
            "manual",
            ";",
            // Hide the status bar on this specific session.
            // `apply_server_options` sets `-g status off`, but that only
            // sticks if the tmux server is alive when it runs — on a clean
            // launch the server may start just to answer the `-g` set and then
            // exit (no sessions yet), discarding the global value. Setting it
            // session-local here is race-free.
            "set-option",
            "-t",
            id,
            "status",
            "off",
            ";",
            // Re-apply the server-wide smcup/rmcup strip now that we know the
            // server is alive (the session we just created is keeping it up).
            // `terminal-overrides` is a server option, so it can't be mirrored
            // per-session the way `status off` is — but setting it with the
            // server guaranteed-alive here avoids the same cold-start race.
            "set-option",
            "-s",
            "terminal-overrides",
            ",xterm-256color:smcup@:rmcup@",
        ]);
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
        self.respawn_with_cwd(id, command, None)
    }

    /// Like [`Self::respawn_with`], but pins the new process to a start
    /// directory with tmux's `respawn-pane -c`.
    pub fn respawn_with_cwd(
        &self,
        id: &str,
        command: &str,
        cwd: Option<&str>,
    ) -> Result<(), TmuxError> {
        let mut cmd = self.cmd();
        cmd.args(["respawn-pane", "-k"]);
        if let Some(cwd) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
            cmd.args(["-c", cwd]);
        }
        cmd.args(["-t", id, command]);
        let out = cmd.output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(())
    }

    /// Keep tmux's retained pane history aligned with xterm.js. This is called
    /// for both newly-created sessions and already-existing sessions during
    /// reattach so old panes stop clipping future Codex resume output at a
    /// previous smaller limit.
    pub fn set_history_limit(&self, id: &str, limit: u32) {
        let limit = limit.to_string();
        self.run_quiet(&["set-option", "-w", "-t", id, "history-limit", &limit]);
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

    /// [`Self::check_pane_dead`] for the 300 ms pane-death poll: answers from a
    /// single `list-panes -a` covering every pane on the socket, cached for
    /// [`DEAD_POLL_CACHE_TTL`]. The per-session `display-message` cost one tmux
    /// fork per live pane per tick; this is one fork per tick for all of them.
    ///
    /// Semantics match `check_pane_dead` exactly — `Ok(Some(code))` dead,
    /// `Ok(None)` alive, `Err` when the session is not on the server (killed
    /// externally, or the server itself is gone). Only for the polling monitor:
    /// callers that act on the answer immediately (respawn, rehydrate probes)
    /// must keep using `check_pane_dead` so they never read a stale tick.
    pub fn check_pane_dead_polled(&self, id: &str) -> Result<Option<i32>, TmuxError> {
        let mut guard = self
            .dead_cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let fresh = guard
            .as_ref()
            .is_some_and(|(at, _)| at.elapsed() < DEAD_POLL_CACHE_TTL);
        if !fresh {
            // A dead server lists no panes (Ok, empty) and every id below reads
            // as gone — same as the per-session probe. A *failed* listing is a
            // different thing and must never be cached: the map is shared by
            // every monitor, so one transient fork failure would report every
            // pane gone at once and each monitor would exit for good. Fall back
            // to the per-session probe for this tick and leave the cache alone.
            match self.list_panes_all(DEAD_POLL_FORMAT) {
                Ok(listing) => *guard = Some((Instant::now(), parse_panes_dead(&listing))),
                Err(_) => {
                    drop(guard);
                    return self.check_pane_dead(id);
                }
            }
        }
        guard
            .as_ref()
            .and_then(|(_, panes)| panes.get(id).copied())
            .ok_or_else(|| TmuxError::NonZero {
                status: 1,
                stderr: format!("can't find pane: {id}"),
            })
    }

    /// `tmux list-panes -a -F <format>` — one line per session on the whole
    /// server. A cold socket yields an empty listing rather than an error,
    /// matching [`Self::list_sessions`].
    ///
    /// The filter narrows each session to the pane `display-message -t
    /// <session>` would report: the active pane of the active window. Callers
    /// key the rows by `#{session_name}`, and raum's own sessions hold one
    /// pane — but a harness that runs `tmux split-window` inside raum's window
    /// (see `ControlEvent::ForeignSplit`) adds panes we must not confuse with
    /// the lead one. Without the filter a foreign pane's row would overwrite
    /// the lead pane's, and a helper that exits would read as the session
    /// itself dying.
    fn list_panes_all(&self, format: &str) -> Result<String, TmuxError> {
        let out = self
            .cmd()
            .args([
                "list-panes",
                "-a",
                "-f",
                "#{&&:#{pane_active},#{window_active}}",
                "-F",
                format,
            ])
            .output()?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if is_no_server_stderr(&stderr) {
                return Ok(String::new());
            }
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: stderr.into_owned(),
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
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
        let (alternate_on, visible) = self.alternate_and_capture(id, "-", true)?;
        if alternate_on {
            return Ok(PaneSnapshot {
                normal: self.capture_pane_alt(id)?,
                alternate: Some(rewrite_lf_to_crlf(visible)),
            });
        }

        Ok(PaneSnapshot {
            normal: rewrite_lf_to_crlf(visible),
            alternate: None,
        })
    }

    /// Capture only the recent visible pane state. Required because non-
    /// alt-screen Ink-style TUIs (Claude Code, OpenCode) do cursor-positioned
    /// in-place updates: tmux's scrollback faithfully records every
    /// intermediate redraw frame as rows scroll off, plus mixed widths from
    /// any pane resize. Replaying that into xterm produces visible
    /// corruption (overlapping rules, ghost prompts, mismatched widths).
    /// Capturing only the bottom `line_count` lines yields the latest clean
    /// frame the user already sees in normal use; the live tmux client
    /// repaints the visible area immediately on attach.
    pub fn capture_pane_view_snapshot(
        &self,
        id: &str,
        line_count: u16,
    ) -> Result<PaneSnapshot, TmuxError> {
        let start = format!("-{}", line_count.max(1).saturating_sub(1));
        // Both branches want the same visible capture — only which field it
        // lands in differs — so this path is a single tmux invocation.
        let (alternate_on, visible) = self.alternate_and_capture(id, &start, true)?;
        let visible = rewrite_lf_to_crlf(visible);
        if alternate_on {
            return Ok(PaneSnapshot {
                normal: Vec::new(),
                alternate: Some(visible),
            });
        }

        Ok(PaneSnapshot {
            normal: visible,
            alternate: None,
        })
    }

    /// Plain-text variant of [`Self::capture_pane_snapshot`] for the global
    /// search panel. Returns the pane's full scrollback (and the alt-screen
    /// frame, if active) as decoded UTF-8 with no ANSI escapes — ready to
    /// split on `\n` and match against.
    pub fn capture_pane_text(&self, id: &str) -> Result<PaneTextSnapshot, TmuxError> {
        let (alternate_on, visible) = self.alternate_and_capture(id, "-", false)?;
        if alternate_on {
            return Ok(PaneTextSnapshot {
                normal: self.capture_pane_alt_plain(id)?,
                alternate: Some(decode_lossy(visible)),
            });
        }

        Ok(PaneTextSnapshot {
            normal: decode_lossy(visible),
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

    /// [`Self::pane_context`] for every pane on the socket in ONE invocation,
    /// keyed by session name. The tab strip refreshes context for all panes at
    /// once, which as per-session `display-message` calls cost one tmux fork
    /// per pane per refresh.
    ///
    /// [`Self::list_panes_all`] narrows each session to the same pane
    /// `display-message -t <session>` reports, so the session name is a unique
    /// key even when a harness split the window.
    pub fn pane_context_all(&self) -> Result<HashMap<String, PaneContext>, TmuxError> {
        let listing = self.list_panes_all(
            "#{session_name}\u{1f}#{pane_current_command}\u{1f}#{pane_current_path}\u{1f}#{pane_title}\u{1f}#{window_name}",
        )?;
        let mut out = HashMap::new();
        for raw in listing.lines() {
            let line = raw.trim_end_matches('\r');
            let Some((name, rest)) = line.split_once('\u{1f}') else {
                continue;
            };
            let name = name.trim();
            if name.is_empty() {
                continue;
            }
            out.insert(name.to_string(), parse_pane_context(rest));
        }
        Ok(out)
    }

    /// Whether the pane currently has the alternate screen buffer active
    /// (TUIs like `vim`, `htop`, Codex). Callers need this to choose between
    /// full-history capture (alt-screen apps cleanly separate the alt frame
    /// from the underlying normal scrollback) and viewport-only capture
    /// (non-alt TUIs corrupt scrollback with in-place redraws).
    pub fn is_alternate_on(&self, id: &str) -> Result<bool, TmuxError> {
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

    /// Answer `#{alternate_on}` AND capture the visible surface from `start` to
    /// the end of the pane, in ONE tmux invocation. Every snapshot path needs
    /// both, and two spawns cost two process launches plus two socket
    /// handshakes per pane — on quit-flush that runs for every open pane.
    ///
    /// `escapes` selects `capture-pane -e -J` (a replayable capture, see
    /// [`Self::capture_pane_alt`]) over the plain-text form used by search.
    /// Returns the capture bytes verbatim; CRLF rewriting is the caller's.
    fn alternate_and_capture(
        &self,
        id: &str,
        start: &str,
        escapes: bool,
    ) -> Result<(bool, Vec<u8>), TmuxError> {
        let mut cmd = self.cmd();
        cmd.args([
            "display-message",
            "-p",
            "-t",
            id,
            "#{alternate_on}",
            ";",
            "capture-pane",
            "-p",
        ]);
        if escapes {
            cmd.args(["-e", "-J"]);
        }
        cmd.args(["-S", start, "-E", "-", "-t", id]);
        let out = cmd.output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        // `display-message -p` emits exactly one line, so the first newline
        // separates the flag from the capture that follows it.
        let split = out.stdout.iter().position(|&b| b == b'\n');
        let alternate_on = out.stdout[..split.unwrap_or(out.stdout.len())].trim_ascii() == b"1";
        let mut capture = out.stdout;
        capture.drain(..split.map_or(capture.len(), |i| i + 1));
        Ok((alternate_on, capture))
    }

    /// `capture-pane -a`: the normal-buffer history preserved underneath a live
    /// alternate screen. Only meaningful while `#{alternate_on}` is 1 — tmux
    /// answers `no alternate screen` otherwise.
    fn capture_pane_alt(&self, id: &str) -> Result<Vec<u8>, TmuxError> {
        // `-J` joins lines tmux marked as hard-wrapped when they were stored
        // in scrollback. Without it, replaying this capture into xterm.js
        // paints old rows at the pane's previous (narrower) width — tmux
        // never reflows stored history on resize.
        let out = self
            .cmd()
            .args([
                "capture-pane",
                "-p",
                "-e",
                "-J",
                "-a",
                "-S",
                "-",
                "-E",
                "-",
                "-t",
                id,
            ])
            .output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(rewrite_lf_to_crlf(out.stdout))
    }

    /// Plain-text [`Self::capture_pane_alt`] for the search index.
    fn capture_pane_alt_plain(&self, id: &str) -> Result<String, TmuxError> {
        let out = self
            .cmd()
            .args(["capture-pane", "-p", "-a", "-S", "-", "-E", "-", "-t", id])
            .output()?;
        if !out.status.success() {
            return Err(TmuxError::NonZero {
                status: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(decode_lossy(out.stdout))
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

    /// §3.7 — stale-session reaper. Kills any session whose `session_created`
    /// timestamp is older than `threshold_days` and returns the ids that were
    /// killed. Sessions in `keep` are never reaped regardless of age — callers
    /// pass the ids tracked in `state/sessions.toml` so panes the user still
    /// has in their layout (shells included) survive arbitrarily long gaps
    /// between app runs. Only genuinely untracked leftovers are age-reaped.
    pub fn reap_stale(&self, threshold_days: u32, keep: &HashSet<String>) -> Vec<String> {
        let Ok(live) = self.list_sessions() else {
            return Vec::new();
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let threshold_secs = u64::from(threshold_days) * 24 * 60 * 60;
        let mut killed = Vec::new();
        for s in live {
            if s.created_unix == 0 || keep.contains(&s.id) {
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

/// Turn every `\n` into `\r\n` so a capture replays into xterm.js with the
/// carriage returns a real terminal would have seen. Copies the runs between
/// newlines wholesale instead of pushing byte by byte, and sizes the output
/// exactly — a full-scrollback capture is megabytes.
fn rewrite_lf_to_crlf(bytes: Vec<u8>) -> Vec<u8> {
    // ponytail: clippy's fix for this scan is the `bytecount` crate — a whole
    // dependency for a pass that costs less than the copy right below it.
    #[allow(clippy::naive_bytecount)]
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count();
    if newlines == 0 {
        return bytes;
    }
    let mut crlf = Vec::with_capacity(bytes.len() + newlines);
    let mut rest = bytes.as_slice();
    while let Some(i) = rest.iter().position(|&b| b == b'\n') {
        crlf.extend_from_slice(&rest[..i]);
        crlf.extend_from_slice(b"\r\n");
        rest = &rest[i + 1..];
    }
    crlf.extend_from_slice(rest);
    crlf
}

/// Captures are almost always valid UTF-8; take ownership of the buffer
/// instead of copying it, and only pay for the lossy rewrite when the pane
/// really did emit invalid bytes.
fn decode_lossy(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Parse [`DEAD_POLL_FORMAT`] rows into `session name -> exit code`, where
/// `None` means the pane is still running. Mirrors the per-session
/// [`TmuxManager::check_pane_dead`] parse: only `pane_dead == 1` counts as
/// dead, and an unparsable `pane_dead_status` degrades to `-1`.
fn parse_panes_dead(stdout: &str) -> HashMap<String, Option<i32>> {
    let mut out = HashMap::new();
    for raw in stdout.lines() {
        let mut parts = raw.trim_end_matches('\r').split('\u{1f}');
        let Some(name) = parts.next().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        let dead = parts.next().is_some_and(|s| s.trim() == "1");
        let code = dead.then(|| {
            parts
                .next()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(-1)
        });
        out.insert(name.to_string(), code);
    }
    out
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

    /// The disclaim is opt-in, and the flag is shared across clones — the
    /// startup sync sets it on the managed `Arc<TmuxManager>` while the spawn
    /// paths hold their own clones, so a per-instance copy would silently
    /// ignore the user's setting.
    #[test]
    fn tcc_disclaim_is_off_by_default_and_shared_across_clones() {
        assert!(!TmuxManager::default().disclaim_tcc.load(Ordering::Relaxed));

        let mgr = TmuxManager::with_socket("raum-tcc-flag-test");
        assert!(!mgr.disclaim_tcc.load(Ordering::Relaxed));

        let clone = mgr.clone();
        mgr.set_disclaim_tcc(true);
        assert!(clone.disclaim_tcc.load(Ordering::Relaxed));
        clone.set_disclaim_tcc(false);
        assert!(!mgr.disclaim_tcc.load(Ordering::Relaxed));
    }

    /// The batched `list-panes -a` calls replace per-session `display-message`
    /// forks, so their format strings are the whole contract — a typo'd
    /// `#{...}` yields empty tab labels and a permanently-alive dead poll
    /// without failing anything. Only a live server can prove them, so this
    /// stages two real sessions and reads them back. Skipped without `tmux`.
    #[test]
    fn batched_pane_queries_read_back_from_a_live_server() {
        if Command::new("tmux").arg("-V").output().is_err() {
            return;
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let mgr = TmuxManager::with_socket(format!("raum-batch-{}-{nanos}", std::process::id()));
        for id in ["batch-a", "batch-b"] {
            mgr.new_session(id, std::path::Path::new("/tmp"), None, Some((80, 24)))
                .expect("new_session");
        }

        let ctx = mgr.pane_context_all().expect("pane_context_all");
        assert_eq!(ctx.len(), 2, "one row per live session, got {ctx:?}");
        for id in ["batch-a", "batch-b"] {
            let pane = ctx.get(id).expect("session present in the batch");
            // tmux resolves the login shell here; the field must not be the
            // empty string a wrongly keyed format would produce.
            assert!(!pane.current_command.is_empty(), "{id}: {pane:?}");
            // macOS resolves `/tmp` to `/private/tmp`, hence the suffix match.
            assert!(pane.current_path.ends_with("/tmp"), "{id}: {pane:?}");
        }
        // Same values the per-session call reports.
        assert_eq!(
            mgr.pane_context("batch-a")
                .expect("pane_context")
                .pane_title,
            ctx["batch-a"].pane_title
        );

        let alive = mgr.check_pane_dead_polled("batch-a");
        assert!(matches!(alive, Ok(None)), "live pane, got {alive:?}");
        // A session that was never created is "gone", not "alive".
        assert!(mgr.check_pane_dead_polled("batch-nope").is_err());

        // A harness teammate pane that exits must not read as the session
        // dying — the monitor would kill the user's live pane and delete its
        // snapshot. `remain-on-exit` is already on from `new_session`.
        mgr.cmd()
            .args(["split-window", "-t", "batch-a", "-d", "sh", "-c", "exit 3"])
            .output()
            .expect("split-window");
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(mgr.check_pane_dead("batch-a").expect("probe"), None);
        let mgr2 = TmuxManager::with_socket(mgr.socket.clone());
        let polled = mgr2.check_pane_dead_polled("batch-a");
        assert!(
            matches!(polled, Ok(None)),
            "dead teammate pane leaked into the session's verdict: {polled:?}"
        );

        let _ = mgr.kill_server();
    }

    /// The legacy detector drives a prompt that destroys the user's live
    /// sessions, so a false positive is expensive. These are argv strings
    /// captured verbatim from real tmux servers born each of the three ways.
    #[test]
    fn legacy_birth_argv_matches_only_the_bare_start_server_form() {
        // Pre-0.1.13 disclaimed birth — the one that needs a restart.
        assert!(is_legacy_birth_argv("tmux -L raum start-server"));
        assert!(is_legacy_birth_argv("tmux -L raum start-server\n"));
        assert!(is_legacy_birth_argv(
            "/opt/homebrew/bin/tmux -L raum-dev start-server"
        ));

        // Current disclaimed birth — already correct, must not be flagged.
        assert!(!is_legacy_birth_argv(
            "tmux -L raum start-server ; set-option -s exit-empty off"
        ));
        // Normal lazy birth via `new_session`.
        assert!(!is_legacy_birth_argv(
            "tmux -L raum start-server ; set-option -g history-limit 100000 ; \
             new-session -d -s raum-sh-1 -c /tmp"
        ));
        // A plain client, and noise, must never read as a server birth.
        assert!(!is_legacy_birth_argv("tmux -L raum attach-session -t x"));
        assert!(!is_legacy_birth_argv(""));
    }

    /// The live-server side of the same check: no server, and a normally-born
    /// server, must both answer `false`. (The positive case can't be staged —
    /// see [`is_legacy_birth_argv`].)
    #[cfg(target_os = "macos")]
    #[test]
    fn a_normally_born_server_is_never_flagged_as_legacy() {
        if std::process::Command::new("tmux")
            .arg("-V")
            .output()
            .is_err()
        {
            return;
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let stamp = format!("{}-{}", std::process::id(), nanos);

        // Cold socket: nothing to flag.
        let cold = TmuxManager::with_socket(format!("raum-legacy-cold-{stamp}"));
        assert!(!cold.server_born_legacy_disclaimed());

        let normal = TmuxManager::with_socket(format!("raum-legacy-new-{stamp}"));
        normal
            .new_session("norm-1", std::path::Path::new("/tmp"), None, Some((80, 24)))
            .expect("new_session");
        assert!(!normal.server_born_legacy_disclaimed());
        let _ = normal.kill_server();
    }

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

    /// The batched dead-poll replaces a per-session `display-message`, so it
    /// has to classify the same rows the same way — a false "dead" tears the
    /// user's pane down and deletes its snapshot.
    #[test]
    fn parse_panes_dead_matches_per_session_semantics() {
        let stdout = "\
alive\u{1f}0\u{1f}
clean\u{1f}1\u{1f}0
failed\u{1f}1\u{1f}130
nostatus\u{1f}1\u{1f}
garbage\u{1f}1\u{1f}nope
crlf\u{1f}0\u{1f}\r
\u{1f}1\u{1f}0
";
        let parsed = parse_panes_dead(stdout);
        assert_eq!(parsed.get("alive"), Some(&None));
        assert_eq!(parsed.get("clean"), Some(&Some(0)));
        assert_eq!(parsed.get("failed"), Some(&Some(130)));
        // Missing / unparsable status still means dead, code unknown.
        assert_eq!(parsed.get("nostatus"), Some(&Some(-1)));
        assert_eq!(parsed.get("garbage"), Some(&Some(-1)));
        assert_eq!(parsed.get("crlf"), Some(&None));
        // A nameless row is unusable as a key, and an absent key reads as
        // "session gone" — so it must be dropped, not inserted under "".
        assert_eq!(parsed.len(), 6);
    }

    #[test]
    fn parse_pane_context_defaults_missing_fields_to_empty() {
        let parsed = parse_pane_context("/tmp/raum");
        assert_eq!(parsed.current_command, "/tmp/raum");
        assert_eq!(parsed.current_path, "");
        assert_eq!(parsed.pane_title, "");
        assert_eq!(parsed.window_name, "");
    }

    #[test]
    fn cold_socket_stderr_variants_classify_as_no_server() {
        // Every phrasing tmux uses for "no live server on this socket" — the
        // boot recovery path must treat all of these as an empty session list.
        // `server exited unexpectedly` is the race seen on slower CI runners
        // (Linux arm64) right after `kill-server`.
        assert!(is_no_server_stderr("no server running on /tmp/tmux-raum\n"));
        assert!(is_no_server_stderr(
            "error connecting to /tmp/tmux-raum (No such file or directory)\n"
        ));
        assert!(is_no_server_stderr("server exited unexpectedly\n"));
        assert!(is_no_server_stderr("lost server\n"));
        // A genuine error (e.g. a bad session name) must NOT be swallowed.
        assert!(!is_no_server_stderr("can't find session: nope\n"));
        assert!(!is_no_server_stderr(""));
    }

    /// Guards the raw `posix_spawn` FFI in [`crate::disclaim`] AND the property
    /// that makes it worth anything: the session must be hosted by *the server
    /// the disclaimed spawn birthed*.
    ///
    /// TCC responsibility isn't observable from a test, but the failure mode
    /// that silently voids it is: under tmux's default `exit-empty on` a
    /// session-less server exits as soon as the birthing client detaches, so
    /// the disclaimed server dies in the gap before `new-session` and the
    /// session lands on a second, non-disclaimed server. Every assertion below
    /// still passed in that state — sessions existed, they were just parented
    /// by the wrong server — so we pin the server PID across the gap instead.
    /// macOS-only (the disclaim is a no-op elsewhere); skipped without `tmux`.
    #[cfg(target_os = "macos")]
    #[test]
    fn disclaimed_birth_survives_to_host_the_first_session() {
        if std::process::Command::new("tmux")
            .arg("-V")
            .output()
            .is_err()
        {
            return;
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let mgr = TmuxManager::with_socket(format!(
            "raum-disclaim-test-{}-{}",
            std::process::id(),
            nanos
        ));
        // The PID tmux reports for the server currently on this socket, or
        // `None` when nothing is listening.
        let server_pid = |mgr: &TmuxManager| -> Option<String> {
            let out = mgr
                .cmd()
                .args(["display-message", "-p", "#{pid}"])
                .output()
                .ok()?;
            let pid = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (out.status.success() && !pid.is_empty()).then_some(pid)
        };

        crate::disclaim::birth_server(&mgr.binary, &mgr.socket).expect("disclaimed birth");

        // Sleep past the window in which an `exit-empty on` server reaps
        // itself, so a regression fails deterministically rather than racing.
        std::thread::sleep(std::time::Duration::from_millis(250));
        let born = server_pid(&mgr).expect(
            "the disclaimed server must still be alive when `new-session` arrives — \
             otherwise the session is hosted by a non-disclaimed server and TCC \
             responsibility stays with raum.app",
        );

        mgr.new_session("disc-1", std::path::Path::new("/tmp"), None, Some((80, 24)))
            .expect("new_session on the disclaimed server");
        let sessions = mgr.list_sessions().expect("list on a live server");
        assert!(sessions.iter().any(|s| s.id == "disc-1"));

        assert_eq!(
            server_pid(&mgr).as_deref(),
            Some(born.as_str()),
            "the session must be hosted by the disclaimed server, not a replacement",
        );

        let _ = mgr.kill_server();
    }
}
