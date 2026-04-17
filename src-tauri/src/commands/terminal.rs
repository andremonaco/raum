//! Terminal commands (§3.4). Owned by Wave 2A.
//!
//! Exposes the full tmux surface to the webview:
//!  - `terminal_spawn(project_slug, worktree_id, kind, on_data) -> String`
//!  - `terminal_kill(session_id)`
//!  - `terminal_resize(session_id, cols, rows)`
//!  - `terminal_list() -> Vec<TerminalListItem>`
//!  - `terminal_send_keys(session_id, keys)`
//!  - `terminal_reap_stale(threshold_days) -> Vec<String>`   (§3.7)
//!
//! xterm.js on the webview side keeps a 10 000-line scrollback (§3.8); the
//! underlying tmux `history-limit` is unlimited so the full log is recoverable
//! via copy-mode. The scrollback cap is exported as
//! [`raum_core::config::XTERM_SCROLLBACK_LINES`] and consumed by the frontend.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use raum_core::AgentKind;
use raum_core::config::XTERM_SCROLLBACK_LINES;
use raum_tmux::{
    COALESCE_BYTES, COALESCE_INTERVAL_MS, Coalescer, PipePaneHandle, TmuxManager, fifo_path_for,
    pipe_pane_to_fifo,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::state::AppHandleState;

/// Frontend uses this constant to size xterm.js scrollback (§3.8). Re-exported
/// from `raum-core` so the webview and backend stay in sync.
pub const XTERM_SCROLLBACK: u32 = XTERM_SCROLLBACK_LINES;

#[derive(Debug, Serialize)]
pub struct TerminalListItem {
    pub session_id: String,
    pub project_slug: Option<String>,
    pub worktree_id: Option<String>,
    pub kind: AgentKind,
    pub created_unix: u64,
}

/// In-memory tracking for every live terminal session. The registry is owned
/// by `AppHandleState::terminals` behind a `Mutex`.
#[derive(Default)]
pub struct TerminalRegistry {
    entries: HashMap<String, TerminalEntry>,
}

impl TerminalRegistry {
    pub fn insert(&mut self, entry: TerminalEntry) {
        self.entries.insert(entry.session_id.clone(), entry);
    }

    pub fn remove(&mut self, session_id: &str) -> Option<TerminalEntry> {
        self.entries.remove(session_id)
    }

    pub fn list(&self) -> Vec<TerminalListItem> {
        self.entries
            .values()
            .map(|e| TerminalListItem {
                session_id: e.session_id.clone(),
                project_slug: e.project_slug.clone(),
                worktree_id: e.worktree_id.clone(),
                kind: e.kind,
                created_unix: e.created_unix,
            })
            .collect()
    }
}

impl std::fmt::Debug for TerminalRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TerminalRegistry")
            .field("count", &self.entries.len())
            .finish()
    }
}

/// Per-session handles kept alive for the duration of the terminal. Drop order
/// matters: killing the `coalescer_task` first drains the mpsc pipeline, then
/// dropping `pipe` aborts the tail task and unlinks the FIFO (§3.9).
pub struct TerminalEntry {
    pub session_id: String,
    pub project_slug: Option<String>,
    pub worktree_id: Option<String>,
    pub kind: AgentKind,
    pub created_unix: u64,
    pub fifo_path: PathBuf,
    /// `Option` so we can `take()` during cleanup.
    pub pipe: Option<PipePaneHandle>,
    pub coalescer_task: Option<JoinHandle<()>>,
    pub deliver_task: Option<JoinHandle<()>>,
    /// Polls `pane_dead` every 300 ms and emits `terminal:process-exited` when
    /// the shell/harness exits naturally (Ctrl-D / Ctrl-C). Aborted by
    /// `terminal_kill` so a manual close never fires a spurious overlay event.
    pub monitor_task: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for TerminalEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TerminalEntry")
            .field("session_id", &self.session_id)
            .field("kind", &self.kind)
            .field("fifo_path", &self.fifo_path)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Deserialize)]
pub struct SpawnArgs {
    pub project_slug: Option<String>,
    pub worktree_id: Option<String>,
    pub kind: AgentKind,
    /// Working directory for the tmux session. Usually the worktree root.
    pub cwd: Option<PathBuf>,
    /// Initial pane width in columns, measured by the webview's fitted xterm.
    /// When both `cols` and `rows` are provided we size the tmux pane before
    /// spawning the harness so its first paint lands at the real dimensions.
    pub cols: Option<u32>,
    pub rows: Option<u32>,
}

/// Clamp webview-supplied dimensions into a sane range so a broken frontend
/// can't push tmux into a degenerate size. Matches what xterm.js will actually
/// use in practice.
const MIN_COLS: u32 = 20;
const MAX_COLS: u32 = 500;
const MIN_ROWS: u32 = 5;
const MAX_ROWS: u32 = 200;

fn sanitize_initial_size(cols: Option<u32>, rows: Option<u32>) -> Option<(u32, u32)> {
    match (cols, rows) {
        (Some(c), Some(r)) => Some((c.clamp(MIN_COLS, MAX_COLS), r.clamp(MIN_ROWS, MAX_ROWS))),
        _ => None,
    }
}

fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn generate_session_id(kind: AgentKind) -> String {
    // Monotonic-ish id: `<kind>-<unix_ms>-<pid>`. Unique enough for a tmux
    // session name on the raum socket.
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    format!("raum-{}-{}-{}", kind.binary_name(), ms, std::process::id())
}

/// §3.4 — spawn a new tmux session, wire its pipe-pane output into a coalescer,
/// and stream raw bytes to the webview via `on_data`. Returns the session id.
#[tauri::command]
pub async fn terminal_spawn<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    args: SpawnArgs,
    on_data: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    let tmux: Arc<TmuxManager> = state.tmux.clone();

    let session_id = generate_session_id(args.kind);
    let cwd = args.cwd.unwrap_or_else(|| PathBuf::from("."));

    // Pick the entrypoint for the session based on the requested kind. For a
    // harness we use the placeholder-then-respawn pattern so pipe-pane is
    // attached *before* the harness prints anything — otherwise the banner is
    // lost and the terminal looks empty. For a plain Shell we start the login
    // shell directly and warm its prompt with an Enter after pipe-pane is up.
    //
    // Per-harness extra_flags from the user's config are appended verbatim so
    // spawning `claude --verbose --model claude-opus-4-5` works as expected.
    let harness_cmd: Option<String> = {
        let base: Option<&str> = match args.kind {
            AgentKind::ClaudeCode => Some("claude"),
            AgentKind::Codex => Some("codex"),
            AgentKind::OpenCode => Some("opencode"),
            AgentKind::Shell => None,
        };
        base.map(|cmd| {
            let extra = {
                let store = state.config_store.lock().expect("config store poisoned");
                store
                    .read_config()
                    .ok()
                    .and_then(|cfg| match args.kind {
                        AgentKind::ClaudeCode => cfg.harnesses.claude_code.extra_flags,
                        AgentKind::Codex => cfg.harnesses.codex.extra_flags,
                        AgentKind::OpenCode => cfg.harnesses.opencode.extra_flags,
                        AgentKind::Shell => None,
                    })
                    .filter(|s| !s.trim().is_empty())
            };
            match extra {
                Some(flags) => format!("{cmd} {flags}"),
                None => cmd.to_string(),
            }
        })
    };

    let mgr_for_new = tmux.clone();
    let id_for_new = session_id.clone();
    let use_placeholder = harness_cmd.is_some();
    let initial_size = sanitize_initial_size(args.cols, args.rows);
    tokio::task::spawn_blocking(move || {
        mgr_for_new.new_session(
            &id_for_new,
            &cwd,
            use_placeholder.then_some("placeholder"),
            initial_size,
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
    .map_err(|e| format!("tmux new-session: {e}"))?;

    // Now that the session exists, boot the real process and wire the output
    // pipeline. Harnesses get spawned via `respawn-pane` so their banner +
    // prompt are fully captured. Shells get a kickstart Enter so the login-
    // shell prompt reprints through the pipe.
    attach_pipeline(
        app,
        &state,
        session_id.clone(),
        args.kind,
        args.project_slug,
        args.worktree_id,
        tmux,
        on_data,
        Some(BootPlan { harness_cmd }),
    )
    .await?;

    Ok(session_id)
}

/// How to initialise a fresh tmux session after `new-session`. Only used by
/// `terminal_spawn`; `terminal_reattach` passes `None` because the harness is
/// already running from the prior app instance.
struct BootPlan {
    /// `Some(cmd)` → respawn the pane with this harness command.
    /// `None` → plain shell, send a kickstart Enter so the prompt reprints
    /// through pipe-pane (which was attached after the original prompt).
    harness_cmd: Option<String>,
}

/// Shared post-`new_session` path: boot (if needed), attach pipe-pane → FIFO
/// → coalescer → delivery channel, start the monitor task, and register a
/// `TerminalEntry`. Called by both `terminal_spawn` (with `BootPlan::Some`)
/// and `terminal_reattach` (with `BootPlan::None`).
#[allow(clippy::too_many_arguments)]
async fn attach_pipeline<R: Runtime>(
    app: AppHandle<R>,
    state: &AppHandleState,
    session_id: String,
    kind: AgentKind,
    project_slug: Option<String>,
    worktree_id: Option<String>,
    tmux: Arc<TmuxManager>,
    on_data: Channel<InvokeResponseBody>,
    boot: Option<BootPlan>,
) -> Result<(), String> {
    // Wire pipe-pane -> FIFO -> coalescer -> Channel<InvokeResponseBody::Raw>.
    let fifo_path = fifo_path_for(&session_id);
    let mut pipe = pipe_pane_to_fifo(&tmux, &session_id, &fifo_path)
        .await
        .map_err(|e| format!("pipe-pane: {e}"))?;

    if let Some(plan) = boot {
        let tmux_for_boot = tmux.clone();
        let id_for_boot = session_id.clone();
        let harness = plan.harness_cmd;
        tokio::task::spawn_blocking(move || -> Result<(), raum_tmux::TmuxError> {
            if let Some(cmd) = harness {
                tmux_for_boot.respawn_with(&id_for_boot, &cmd)?;
            } else {
                tmux_for_boot.send_command(&id_for_boot, "")?;
            }
            Ok(())
        })
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
        .map_err(|e| format!("tmux boot: {e}"))?;
    }

    let source_rx = pipe.take_receiver().expect("receiver present after spawn");

    // Coalescer: input mpsc from the fifo tail, output mpsc into the delivery task.
    let (coal_tx, mut coal_rx) = mpsc::channel::<bytes::Bytes>(128);
    let coalescer = Coalescer::new(source_rx, coal_tx);
    let coalescer_task = tokio::spawn(coalescer.run());

    // Delivery task: drain the coalescer, send each chunk to the frontend.
    let channel_for_task = on_data.clone();
    let deliver_task = tokio::spawn(async move {
        while let Some(chunk) = coal_rx.recv().await {
            if let Err(err) = channel_for_task.send(InvokeResponseBody::Raw(chunk.to_vec())) {
                tracing::warn!(?err, "Channel send failed; terminating delivery task");
                break;
            }
        }
    });

    // Monitor task: polls tmux every 300 ms for natural process exit (Ctrl-D /
    // Ctrl-C). When the pane goes dead it emits `terminal:process-exited` to the
    // webview, then kills the tmux session. `terminal_kill` aborts this task
    // first so an explicit close never fires a spurious overlay.
    let monitor_tmux = tmux.clone();
    let monitor_id = session_id.clone();
    let monitor_app = app.clone();
    let monitor_handle = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(300)).await;
            let id = monitor_id.clone();
            let tmux = monitor_tmux.clone();
            match tokio::task::spawn_blocking(move || tmux.check_pane_dead(&id)).await {
                Ok(Ok(Some(exit_code))) => {
                    let _ = monitor_app.emit(
                        "terminal:process-exited",
                        serde_json::json!({ "sessionId": &monitor_id, "exitCode": exit_code }),
                    );
                    let id2 = monitor_id.clone();
                    let tmux2 = monitor_tmux.clone();
                    let _ = tokio::task::spawn_blocking(move || tmux2.kill_session(&id2)).await;
                    break;
                }
                Ok(Ok(None)) => { /* pane still alive — keep polling */ }
                _ => break, // session killed externally (terminal_kill) or I/O error
            }
        }
    });

    let entry = TerminalEntry {
        session_id: session_id.clone(),
        project_slug,
        worktree_id,
        kind,
        created_unix: now_unix_secs(),
        fifo_path,
        pipe: Some(pipe),
        coalescer_task: Some(coalescer_task),
        deliver_task: Some(deliver_task),
        monitor_task: Some(monitor_handle),
    };

    {
        let mut reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        reg.insert(entry);
    }

    tracing::info!(
        session_id = %session_id,
        coalesce_bytes = COALESCE_BYTES,
        coalesce_ms = COALESCE_INTERVAL_MS,
        xterm_scrollback = XTERM_SCROLLBACK,
        "attach_pipeline: session ready"
    );

    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct ReattachArgs {
    pub session_id: String,
    pub kind: AgentKind,
    pub project_slug: Option<String>,
    pub worktree_id: Option<String>,
}

/// §3.6 — reattach to a pre-existing tmux session that survived a previous
/// raum run. Verifies the session still exists on the `-L raum` socket, then
/// wires pipe-pane + coalescer + delivery + monitor the same way
/// `terminal_spawn` does (minus `new-session` and harness boot).
///
/// The frontend invokes this when `TerminalPane` mounts with a persisted
/// `sessionId`. On `Err("not-found")` (or any other error) the caller should
/// fall back to `terminal_spawn` and create a fresh session.
#[tauri::command]
pub async fn terminal_reattach<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    args: ReattachArgs,
    on_data: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    let tmux: Arc<TmuxManager> = state.tmux.clone();
    let session_id = args.session_id.clone();

    // Idempotent early return if the registry already tracks this session.
    // Guards against double-reattach if a pane remounts mid-session.
    {
        let reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        if reg.list().iter().any(|e| e.session_id == session_id) {
            return Ok(session_id);
        }
    }

    // Verify the tmux session exists. Cheap: list_sessions hits the socket
    // once and returns every live session.
    let exists = {
        let tmux_for_check = tmux.clone();
        let target = session_id.clone();
        tokio::task::spawn_blocking(move || {
            tmux_for_check
                .list_sessions()
                .map(|sessions| sessions.iter().any(|s| s.id == target))
        })
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
        .map_err(|e| format!("tmux list-sessions: {e}"))?
    };
    if !exists {
        return Err("not-found".to_string());
    }

    attach_pipeline(
        app,
        &state,
        session_id.clone(),
        args.kind,
        args.project_slug,
        args.worktree_id,
        tmux,
        on_data,
        None,
    )
    .await?;

    Ok(session_id)
}

#[tauri::command]
pub async fn terminal_kill(
    state: tauri::State<'_, AppHandleState>,
    session_id: String,
) -> Result<(), String> {
    let tmux = state.tmux.clone();
    let id = session_id.clone();
    let kill_res = tokio::task::spawn_blocking(move || tmux.kill_session(&id))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?;

    // Drop the entry regardless of tmux's kill result — if the session is
    // already dead we still want to reclaim the FIFO + tasks.
    let removed = {
        let mut reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        reg.remove(&session_id)
    };
    if let Some(mut e) = removed {
        // Abort the monitor first so it can't fire a spurious process-exited event
        // after an explicit kill.
        if let Some(m) = e.monitor_task.take() {
            m.abort();
        }
        if let Some(c) = e.coalescer_task.take() {
            c.abort();
        }
        if let Some(d) = e.deliver_task.take() {
            d.abort();
        }
        // Dropping `pipe` unlinks the FIFO (§3.9).
        drop(e.pipe.take());
    }

    kill_res.map_err(|e| format!("tmux kill-session: {e}"))
}

#[tauri::command]
pub async fn terminal_resize(
    state: tauri::State<'_, AppHandleState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let tmux = state.tmux.clone();
    tokio::task::spawn_blocking(move || tmux.resize(&session_id, cols, rows))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
        .map_err(|e| format!("tmux resize: {e}"))
}

#[tauri::command]
pub fn terminal_list(
    state: tauri::State<'_, AppHandleState>,
) -> Result<Vec<TerminalListItem>, String> {
    let reg = state
        .terminals
        .lock()
        .map_err(|e| format!("terminals lock: {e}"))?;
    Ok(reg.list())
}

#[tauri::command]
pub async fn terminal_send_keys(
    state: tauri::State<'_, AppHandleState>,
    session_id: String,
    keys: String,
) -> Result<(), String> {
    // One keystroke per invoke by design (latency over throughput). We still
    // offload to the blocking pool — `tmux send-keys` spawns a subprocess.
    let tmux = state.tmux.clone();
    tokio::task::spawn_blocking(move || tmux.send_keys(&session_id, &keys))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
        .map_err(|e| format!("tmux send-keys: {e}"))
}

/// §3.7 — stale-session reaper, invoked from the in-app "Orphaned sessions"
/// group. No CLI surface.
#[tauri::command]
pub async fn terminal_reap_stale(
    state: tauri::State<'_, AppHandleState>,
    threshold_days: u32,
) -> Result<Vec<String>, String> {
    let tmux = state.tmux.clone();
    let killed = tokio::task::spawn_blocking(move || tmux.reap_stale(threshold_days))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?;

    // Clean up registry entries for any session we reaped.
    {
        let mut reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        for id in &killed {
            if let Some(mut e) = reg.remove(id) {
                if let Some(m) = e.monitor_task.take() {
                    m.abort();
                }
                if let Some(c) = e.coalescer_task.take() {
                    c.abort();
                }
                if let Some(d) = e.deliver_task.take() {
                    d.abort();
                }
                drop(e.pipe.take());
            }
        }
    }
    Ok(killed)
}
