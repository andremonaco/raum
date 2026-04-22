//! Terminal commands. Owned by Wave 2A.
//!
//! Exposes the full tmux surface to the webview:
//!  - `terminal_spawn(project_slug, worktree_id, kind, on_data) -> String`
//!  - `terminal_kill(session_id)`
//!  - `terminal_resize(session_id, cols, rows)`
//!  - `terminal_list() -> Vec<TerminalListItem>`
//!  - `terminal_send_keys(session_id, keys)`
//!  - `terminal_reap_stale(threshold_days) -> Vec<String>`   (§3.7)
//!
//! Pane I/O runs through a Rust-owned PTY that hosts a child
//! `tmux attach-session`; xterm.js receives the attached client's rendered
//! viewport bytes verbatim. xterm.js on the webview side keeps a 10 000-line
//! scrollback (§3.8); the underlying tmux `history-limit` is set to match for
//! future copy-mode exposure. The scrollback cap is exported as
//! [`raum_core::config::XTERM_SCROLLBACK_LINES`] and consumed by the frontend.

use std::collections::HashMap;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use raum_core::AgentKind;
use raum_core::config::XTERM_SCROLLBACK_LINES;
use raum_core::harness::codex::{Osc9Parser, classify_osc9_payload};
use raum_core::harness::{NotificationKind, Reliability};
use raum_tmux::{PaneContext, PaneSnapshot, PtyBridgeHandle, TmuxManager, attach_via_pty};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::commands::agent::{
    RegisterOptions, cleanup_harness_session, infer_reattach_hook_fallback, prepare_harness_launch,
    register_harness_session_runtime, register_harness_session_runtime_opts, resolve_project_dir,
};
use crate::state::AppHandleState;

fn parse_opencode_port_arg(flags: &str) -> Option<u16> {
    let mut parts = flags.split_whitespace();
    while let Some(part) = parts.next() {
        if let Some(raw) = part.strip_prefix("--port=") {
            if let Ok(port) = raw.parse::<u16>() {
                return Some(port);
            }
        }
        if part == "--port"
            && let Some(raw) = parts.next()
            && let Ok(port) = raw.parse::<u16>()
        {
            return Some(port);
        }
    }
    None
}

fn reserve_localhost_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| e.to_string())
}

/// Frontend uses this constant to size xterm.js scrollback (§3.8). Re-exported
/// from `raum-core` so the webview and backend stay in sync.
pub const XTERM_SCROLLBACK: u32 = XTERM_SCROLLBACK_LINES;

const TERMINAL_SESSION_UPSERTED_EVENT: &str = "terminal-session-upserted";
const TERMINAL_SESSION_REMOVED_EVENT: &str = "terminal-session-removed";
const TERMINAL_PANE_CONTEXT_CHANGED_EVENT: &str = "terminal-pane-context-changed";
const AGENT_SESSION_REMOVED_EVENT: &str = "agent-session-removed";
const PANE_CONTEXT_DEBOUNCE_MS: u64 = 150;
const PANE_CONTEXT_IDLE_REFRESH_MS: u64 = 5_000;

#[derive(Debug, Clone, Serialize)]
pub struct TerminalListItem {
    pub session_id: String,
    pub project_slug: Option<String>,
    pub worktree_id: Option<String>,
    pub kind: AgentKind,
    pub created_unix: u64,
}

/// Identity-only terminal record. Populated by the startup rehydrate
/// bootstrap for tmux sessions that survived the previous app run but
/// have no PTY bridge yet; promoted to a full `TerminalEntry` when
/// `TerminalPane` mounts and `terminal_reattach` opens the bridge.
///
/// Kept in a separate map from real entries so `get_bridge` / resize /
/// input paths are untouched — they naturally return "not found" for a
/// ghost-only session, which is the correct behaviour until the bridge
/// is attached.
#[derive(Debug, Clone)]
pub struct GhostEntry {
    pub session_id: String,
    pub project_slug: Option<String>,
    pub worktree_id: Option<String>,
    pub kind: AgentKind,
    pub created_unix: u64,
}

impl GhostEntry {
    #[must_use]
    pub fn list_item(&self) -> TerminalListItem {
        TerminalListItem {
            session_id: self.session_id.clone(),
            project_slug: self.project_slug.clone(),
            worktree_id: self.worktree_id.clone(),
            kind: self.kind,
            created_unix: self.created_unix,
        }
    }
}

/// In-memory tracking for every live terminal session. The registry is owned
/// by `AppHandleState::terminals` behind a `Mutex`.
#[derive(Default)]
pub struct TerminalRegistry {
    entries: HashMap<String, TerminalEntry>,
    /// Identity-only rows for sessions whose tmux window is alive but
    /// whose PTY bridge hasn't been opened yet (populated by the
    /// startup rehydrate task). Promoted via `promote_ghost` at the
    /// start of `terminal_reattach`.
    ghosts: HashMap<String, GhostEntry>,
}

impl TerminalRegistry {
    pub fn insert(&mut self, entry: TerminalEntry) {
        // An entry always wins over a ghost for the same session id.
        self.ghosts.remove(&entry.session_id);
        self.entries.insert(entry.session_id.clone(), entry);
    }

    pub fn remove(&mut self, session_id: &str) -> Option<TerminalEntry> {
        // Drop any ghost too so we don't leak an identity row when the
        // caller is removing the entry because the session is gone.
        self.ghosts.remove(session_id);
        self.entries.remove(session_id)
    }

    pub fn get_bridge(&self, session_id: &str) -> Option<PtyBridgeHandle> {
        self.entries.get(session_id).map(|e| e.bridge.clone())
    }

    /// Fetch both the bridge and the last-known dims atomically under the
    /// registry lock. Used by `terminal_resize` to pick a resize ordering
    /// that avoids tmux's hatched "|..." pattern.
    pub fn get_bridge_and_size(&self, session_id: &str) -> Option<(PtyBridgeHandle, u16, u16)> {
        self.entries
            .get(session_id)
            .map(|e| (e.bridge.clone(), e.last_cols, e.last_rows))
    }

    /// Update the last-applied cols/rows after a successful resize.
    pub fn update_size(&mut self, session_id: &str, cols: u16, rows: u16) {
        if let Some(e) = self.entries.get_mut(session_id) {
            e.last_cols = cols;
            e.last_rows = rows;
        }
    }

    /// Tear down the stale bridge + monitor on an existing entry without
    /// removing the entry itself. The entry stays visible to
    /// `terminal_list` so the top-row counters don't flash to zero while
    /// `terminal_reattach` is mid-flight; a follow-up `replace_bridge`
    /// lands the fresh bridge. Returns `true` iff the entry existed.
    pub fn detach_bridge(&mut self, session_id: &str) -> bool {
        let Some(entry) = self.entries.get_mut(session_id) else {
            return false;
        };
        if let Some(m) = entry.monitor_task.take() {
            m.abort();
        }
        if let Some(context) = entry.context_task.take() {
            context.abort();
        }
        entry.bridge.shutdown_silent();
        true
    }

    /// Swap the live bridge/monitor/dims on an existing entry. Identity
    /// columns (`project_slug`, `worktree_id`, `kind`, `created_unix`)
    /// are preserved. Returns `true` iff the entry existed; when it
    /// returns `false` the caller's bridge + monitor are dropped.
    pub fn replace_bridge(
        &mut self,
        session_id: &str,
        bridge: PtyBridgeHandle,
        monitor_task: JoinHandle<()>,
        context_task: Option<JoinHandle<()>>,
        cols: u16,
        rows: u16,
    ) -> bool {
        let Some(entry) = self.entries.get_mut(session_id) else {
            monitor_task.abort();
            if let Some(context) = context_task {
                context.abort();
            }
            bridge.shutdown_silent();
            return false;
        };
        entry.bridge = bridge;
        entry.monitor_task = Some(monitor_task);
        entry.context_task = context_task;
        entry.last_cols = cols;
        entry.last_rows = rows;
        true
    }

    pub fn item(&self, session_id: &str) -> Option<TerminalListItem> {
        if let Some(e) = self.entries.get(session_id) {
            return Some(e.list_item());
        }
        self.ghosts.get(session_id).map(GhostEntry::list_item)
    }

    pub fn list(&self) -> Vec<TerminalListItem> {
        let mut out: Vec<TerminalListItem> = self
            .entries
            .values()
            .map(|e| TerminalListItem {
                session_id: e.session_id.clone(),
                project_slug: e.project_slug.clone(),
                worktree_id: e.worktree_id.clone(),
                kind: e.kind,
                created_unix: e.created_unix,
            })
            .collect();
        // Only include ghosts whose id isn't already represented by a
        // real entry — a real entry always shadows a ghost (it means
        // reattach finished and the bridge is live).
        for g in self.ghosts.values() {
            if !self.entries.contains_key(&g.session_id) {
                out.push(g.list_item());
            }
        }
        out
    }

    /// Insert (or overwrite) a ghost identity row. If a real entry
    /// already exists for this session id the call is a no-op — the
    /// real entry is strictly more authoritative. Returns `true` when
    /// a ghost was newly inserted (or refreshed).
    pub fn upsert_ghost(&mut self, entry: GhostEntry) -> bool {
        if self.entries.contains_key(&entry.session_id) {
            return false;
        }
        self.ghosts.insert(entry.session_id.clone(), entry);
        true
    }

    /// Remove and return the ghost row for `session_id`, if any. Called
    /// by `terminal_reattach` before it constructs the real
    /// `TerminalEntry` so identity metadata (project_slug,
    /// worktree_id, created_unix) is carried forward. Returns `None`
    /// when no ghost exists — the caller should build the entry from
    /// its own arguments.
    pub fn promote_ghost(&mut self, session_id: &str) -> Option<GhostEntry> {
        self.ghosts.remove(session_id)
    }
}

impl std::fmt::Debug for TerminalRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TerminalRegistry")
            .field("count", &self.entries.len())
            .field("ghosts", &self.ghosts.len())
            .finish()
    }
}

/// Per-session handles kept alive for the duration of the terminal. Dropping
/// the entry kills the attached tmux client and frees its OS threads.
pub struct TerminalEntry {
    pub session_id: String,
    pub project_slug: Option<String>,
    pub worktree_id: Option<String>,
    pub kind: AgentKind,
    pub created_unix: u64,
    /// PTY-wrapped `tmux attach-session` client. Cloning the handle is cheap
    /// (Arc bump); the bridge tears down when the last clone drops.
    pub bridge: PtyBridgeHandle,
    /// Polls `pane_dead` every 300 ms and emits `terminal:process-exited` when
    /// the shell/harness exits naturally (Ctrl-D / Ctrl-C). Aborted by
    /// `terminal_kill` so a manual close never fires a spurious overlay event.
    pub monitor_task: Option<JoinHandle<()>>,
    /// Debounced tmux pane-context watcher for harness tabs. Emits
    /// `terminal-pane-context-changed` when the harness updates its pane or
    /// window title. Aborted alongside the bridge on explicit kill/remove and
    /// replaced on reattach so the PTY callback always talks to a live watcher.
    pub context_task: Option<JoinHandle<()>>,
    /// Last cols/rows applied by `terminal_resize` (or the initial attach).
    /// Consulted on the next resize so we can order the tmux-window and PTY
    /// operations in whichever direction keeps `window ≥ viewport` and avoids
    /// tmux's hatched "|..." pattern.
    pub last_cols: u16,
    pub last_rows: u16,
}

impl TerminalEntry {
    #[must_use]
    pub fn list_item(&self) -> TerminalListItem {
        TerminalListItem {
            session_id: self.session_id.clone(),
            project_slug: self.project_slug.clone(),
            worktree_id: self.worktree_id.clone(),
            kind: self.kind,
            created_unix: self.created_unix,
        }
    }
}

impl std::fmt::Debug for TerminalEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TerminalEntry")
            .field("session_id", &self.session_id)
            .field("kind", &self.kind)
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

fn clamp_pty_dims(cols: u32, rows: u32) -> (u16, u16) {
    let c = cols.clamp(MIN_COLS, MAX_COLS) as u16;
    let r = rows.clamp(MIN_ROWS, MAX_ROWS) as u16;
    (c, r)
}

fn forward_codex_osc9_event(
    session_id: &str,
    channel_tx: &mpsc::Sender<raum_hooks::HookEvent>,
    kind: NotificationKind,
    payload: String,
) {
    let wire = raum_hooks::HookEvent {
        harness: "codex".into(),
        event: kind.wire_event_name().into(),
        session_id: Some(session_id.to_string()),
        request_id: None,
        source: Some("osc9".into()),
        reliability: Some(Reliability::EventDriven.label().into()),
        payload: serde_json::Value::String(payload),
    };
    if let Err(err) = channel_tx.try_send(wire) {
        tracing::warn!(
            session_id = %session_id,
            error = %err,
            "terminal: dropping Codex OSC 9 event",
        );
    }
}

fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn contains_submit_input(keys: &str) -> bool {
    keys.contains('\r') || keys.contains('\n')
}

/// User signalled they want to abort the running turn.
///
/// Ctrl-C (0x03, SIGINT) always counts. ESC (0x1b) counts only when the
/// agent is currently `Waiting` — i.e. the harness has asked for input
/// (permission request or idle prompt). In `Working` ESC is overloaded
/// (menu-dismiss, vim, slash-menu cancel) and would cause constant false
/// demotions back to `Idle`, so it is forwarded to the harness unchanged.
fn contains_abort_input(keys: &str, state: Option<raum_core::agent::AgentState>) -> bool {
    if keys.contains('\x03') {
        return true;
    }
    matches!(state, Some(raum_core::agent::AgentState::Waiting)) && keys.contains('\x1b')
}

#[derive(Debug, Serialize)]
struct SessionRemovedPayload {
    session_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PaneContextChangedPayload {
    session_id: String,
    current_command: String,
    current_path: String,
    pane_title: String,
    window_name: String,
}

impl PaneContextChangedPayload {
    fn from_parts(session_id: &str, ctx: PaneContextPayload) -> Self {
        Self {
            session_id: session_id.to_string(),
            current_command: ctx.current_command,
            current_path: ctx.current_path,
            pane_title: ctx.pane_title,
            window_name: ctx.window_name,
        }
    }
}

pub(crate) fn emit_terminal_session_upserted<R: Runtime>(
    app: &AppHandle<R>,
    item: &TerminalListItem,
) {
    if let Err(e) = app.emit(TERMINAL_SESSION_UPSERTED_EVENT, item) {
        tracing::warn!(error = %e, session_id = %item.session_id, "terminal-session-upserted emit failed");
    }
}

fn emit_terminal_session_removed<R: Runtime>(app: &AppHandle<R>, session_id: &str) {
    let payload = SessionRemovedPayload {
        session_id: session_id.to_string(),
    };
    if let Err(e) = app.emit(TERMINAL_SESSION_REMOVED_EVENT, &payload) {
        tracing::warn!(error = %e, session_id = %session_id, "terminal-session-removed emit failed");
    }
}

fn emit_terminal_pane_context_changed<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    ctx: PaneContextPayload,
) {
    let payload = PaneContextChangedPayload::from_parts(session_id, ctx);
    if let Err(e) = app.emit(TERMINAL_PANE_CONTEXT_CHANGED_EVENT, &payload) {
        tracing::warn!(
            error = %e,
            session_id = %session_id,
            "terminal-pane-context-changed emit failed"
        );
    }
}

fn emit_agent_session_removed<R: Runtime>(app: &AppHandle<R>, session_id: &str) {
    let payload = SessionRemovedPayload {
        session_id: session_id.to_string(),
    };
    if let Err(e) = app.emit(AGENT_SESSION_REMOVED_EVENT, &payload) {
        tracing::warn!(error = %e, session_id = %session_id, "agent-session-removed emit failed");
    }
}

fn shutdown_removed_entry(mut entry: TerminalEntry, abort_monitor: bool) {
    if abort_monitor {
        if let Some(monitor) = entry.monitor_task.take() {
            monitor.abort();
        }
    } else {
        let _ = entry.monitor_task.take();
    }
    if let Some(context) = entry.context_task.take() {
        context.abort();
    }
    entry.bridge.shutdown_silent();
}

fn should_emit_pane_context_change(
    previous: Option<&PaneContextPayload>,
    next: &PaneContextPayload,
) -> bool {
    previous != Some(next)
}

fn spawn_pane_context_monitor<R: Runtime>(
    app: AppHandle<R>,
    tmux: Arc<TmuxManager>,
    session_id: String,
) -> (tokio::sync::mpsc::Sender<()>, JoinHandle<()>) {
    let (dirty_tx, mut dirty_rx) = tokio::sync::mpsc::channel::<()>(1);
    let task = tokio::spawn(async move {
        let mut last_emitted: Option<PaneContextPayload> = None;
        let mut idle_tick = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_millis(PANE_CONTEXT_IDLE_REFRESH_MS),
            Duration::from_millis(PANE_CONTEXT_IDLE_REFRESH_MS),
        );
        idle_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                maybe_dirty = dirty_rx.recv() => {
                    if maybe_dirty.is_none() {
                        break;
                    }

                    let debounce_deadline =
                        tokio::time::Instant::now() + Duration::from_millis(PANE_CONTEXT_DEBOUNCE_MS);
                    let delay = tokio::time::sleep_until(debounce_deadline);
                    tokio::pin!(delay);
                    loop {
                        tokio::select! {
                            maybe_more = dirty_rx.recv() => {
                                if maybe_more.is_none() {
                                    return;
                                }
                                delay.as_mut().reset(
                                    tokio::time::Instant::now()
                                        + Duration::from_millis(PANE_CONTEXT_DEBOUNCE_MS),
                                );
                            }
                            _ = &mut delay => break,
                        }
                    }
                }
                _ = idle_tick.tick() => {}
            }

            let fetch_tmux = tmux.clone();
            let fetch_session_id = session_id.clone();
            let fetched =
                tokio::task::spawn_blocking(move || fetch_tmux.pane_context(&fetch_session_id))
                    .await;
            let Ok(Ok(ctx)) = fetched else {
                continue;
            };
            let next = PaneContextPayload::from(ctx);
            if !should_emit_pane_context_change(last_emitted.as_ref(), &next) {
                continue;
            }
            emit_terminal_pane_context_changed(&app, &session_id, next.clone());
            last_emitted = Some(next);
        }
    });
    (dirty_tx, task)
}

fn build_snapshot_replay(snapshot: PaneSnapshot) -> Vec<u8> {
    let mut replay = snapshot.normal;
    if let Some(alternate) = snapshot.alternate {
        // Restore the durable normal history first, then switch xterm into the
        // alternate buffer and paint the visible TUI frame. The live tmux
        // client that attaches immediately afterwards will redraw the current
        // screen again, but writing this first preserves the normal buffer for
        // history browsing while keeping the user-facing pane on the live TUI.
        replay.extend_from_slice(b"\x1b[?1049h\x1b[H\x1b[2J");
        replay.extend(alternate);
    }
    replay
}

/// Resolve the absolute directory a new tmux session should start in.
///
/// Preference order:
/// 1. Caller-supplied `cwd` (frontend override).
/// 2. The project's `root_path` from the config store, when a project slug is
///    provided and registered.
/// 3. `$HOME`.
/// 4. `/` — always absolute, never the Tauri process cwd (which would be
///    `src-tauri/` during `task dev`).
fn resolve_spawn_cwd(
    state: &tauri::State<'_, AppHandleState>,
    caller_cwd: Option<PathBuf>,
    project_slug: Option<&str>,
    worktree_id: Option<&str>,
) -> PathBuf {
    if let Some(cwd) = caller_cwd {
        return cwd;
    }
    let project_dir = resolve_project_dir(state, project_slug, worktree_id);
    if !project_dir.as_os_str().is_empty() {
        return project_dir;
    }
    std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from)
}

fn generate_session_id(kind: AgentKind) -> String {
    // Monotonic-ish id: `<kind>-<unix_ms>-<pid>`. Unique enough for a tmux
    // session name on the raum socket.
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    format!("raum-{}-{}-{}", kind.binary_name(), ms, std::process::id())
}

/// §3.4 — spawn a new tmux session, wire its output through a PTY-attached
/// client, and stream rendered bytes to the webview via `on_data`. Returns the
/// session id.
#[tauri::command]
pub async fn terminal_spawn<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    args: SpawnArgs,
    on_data: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    let tmux: Arc<TmuxManager> = state.tmux.clone();

    let session_id = generate_session_id(args.kind);
    let project_dir = resolve_project_dir(
        &state,
        args.project_slug.as_deref(),
        args.worktree_id.as_deref(),
    );
    if args.kind != AgentKind::Shell
        && (args.project_slug.as_deref().is_none() || project_dir.as_os_str().is_empty())
    {
        tracing::warn!(
            kind = ?args.kind,
            project_slug = ?args.project_slug,
            worktree_id = ?args.worktree_id,
            project_dir = %project_dir.display(),
            config_root = %raum_core::paths::config_root().display(),
            "terminal_spawn: rejecting — no registered project resolved"
        );
        return Err("harness spawns require a registered project".to_string());
    }
    let cwd = resolve_spawn_cwd(
        &state,
        args.cwd.clone(),
        args.project_slug.as_deref(),
        args.worktree_id.as_deref(),
    );
    let launch_report = if args.kind == AgentKind::Shell {
        None
    } else {
        let report = prepare_harness_launch(
            &app,
            &state,
            args.kind,
            args.project_slug.as_deref(),
            project_dir.clone(),
        )
        .await?;
        if report.binary_missing {
            return Err(format!("binary `{}` not found on PATH", report.binary));
        }
        Some(report)
    };

    // Pick the entrypoint for the session based on the requested kind. For a
    // harness we use the placeholder-then-respawn pattern so the PTY bridge
    // attaches before the harness paints anything. For a plain Shell we start
    // the user's login shell directly.
    //
    // Per-harness extra_flags from the user's config are appended verbatim so
    // spawning `claude --verbose --model claude-opus-4-5` works as expected.
    let extra_flags = {
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
    let mut opencode_port: Option<u16> = None;
    let harness_cmd: Option<String> = match args.kind {
        AgentKind::ClaudeCode => Some(match extra_flags.as_deref() {
            Some(flags) => format!("claude {flags}"),
            None => "claude".to_string(),
        }),
        AgentKind::Codex => Some(match extra_flags.as_deref() {
            Some(flags) => format!("codex {flags}"),
            None => "codex".to_string(),
        }),
        AgentKind::OpenCode => {
            let explicit_port = extra_flags.as_deref().and_then(parse_opencode_port_arg);
            let port = match explicit_port {
                Some(port) => port,
                None => reserve_localhost_port()?,
            };
            opencode_port = Some(port);
            Some(match extra_flags.as_deref() {
                Some(flags) if explicit_port.is_some() => format!("opencode {flags}"),
                Some(flags) => format!("opencode --port {port} {flags}"),
                None => format!("opencode --port {port}"),
            })
        }
        AgentKind::Shell => None,
    };

    let mgr_for_new = tmux.clone();
    let id_for_new = session_id.clone();
    let use_placeholder = harness_cmd.is_some();
    let initial_size = sanitize_initial_size(args.cols, args.rows);
    // Phase 2 — export RAUM_SESSION into the new tmux session's env so
    // the hook script embeds the session id in every event. The wire
    // name mirrors `raum_hooks::RAUM_SESSION_ENV`.
    //
    // RAUM_EVENT_SOCK is injected via the same `-e` channel so hook
    // scripts always see the current socket path, regardless of whether
    // the `-L raum` tmux server inherited raum's process env (it does
    // not, if the server was already running from a prior launch).
    let raum_session_value = session_id.clone();
    let raum_event_sock_value: Option<String> = state
        .event_socket
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|h| h.path.to_string_lossy().into_owned()));
    tokio::task::spawn_blocking(move || {
        let mut env_pairs: Vec<(&str, &str)> =
            vec![(raum_hooks::RAUM_SESSION_ENV, raum_session_value.as_str())];
        if let Some(p) = raum_event_sock_value.as_deref() {
            env_pairs.push((raum_hooks::RAUM_EVENT_SOCK_ENV, p));
        }
        mgr_for_new.new_session_with_env(
            &id_for_new,
            &cwd,
            use_placeholder.then_some("placeholder"),
            initial_size,
            &env_pairs,
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
    .map_err(|e| format!("tmux new-session: {e}"))?;

    if let Some(report) = launch_report.as_ref() {
        let register_result = if opencode_port.is_some() {
            register_harness_session_runtime_opts(
                &app,
                &state,
                args.kind,
                &session_id,
                args.project_slug.as_deref(),
                args.worktree_id.as_deref(),
                project_dir.clone(),
                report.hook_fallback,
                RegisterOptions {
                    opencode_port,
                    ..RegisterOptions::default()
                },
            )
        } else {
            register_harness_session_runtime(
                &app,
                &state,
                args.kind,
                &session_id,
                args.project_slug.as_deref(),
                args.worktree_id.as_deref(),
                project_dir.clone(),
                report.hook_fallback,
            )
        };
        if let Err(err) = register_result {
            let tmux_cleanup = tmux.clone();
            let id_cleanup = session_id.clone();
            let _ =
                tokio::task::spawn_blocking(move || tmux_cleanup.kill_session(&id_cleanup)).await;
            return Err(err);
        }
    }

    // Boot the harness (or warm the shell), then attach the PTY bridge so
    // xterm receives the attached client's first frame already including the
    // process's banner.
    if let Some(cmd) = harness_cmd {
        let tmux_for_boot = tmux.clone();
        let id_for_boot = session_id.clone();
        if let Err(err) =
            tokio::task::spawn_blocking(move || tmux_for_boot.respawn_with(&id_for_boot, &cmd))
                .await
                .map_err(|e| format!("spawn_blocking join: {e}"))?
                .map_err(|e| format!("tmux respawn: {e}"))
        {
            cleanup_harness_session(&state, &session_id);
            let tmux_cleanup = tmux.clone();
            let id_cleanup = session_id.clone();
            let _ =
                tokio::task::spawn_blocking(move || tmux_cleanup.kill_session(&id_cleanup)).await;
            return Err(err);
        }
    }

    let (cols, rows) = match args.cols.zip(args.rows) {
        Some((c, r)) => clamp_pty_dims(c, r),
        None => (200, 50),
    };

    if let Err(err) = attach_pipeline(
        app,
        &state,
        session_id.clone(),
        args.kind,
        args.project_slug,
        args.worktree_id,
        tmux.clone(),
        on_data,
        cols,
        rows,
    )
    .await
    {
        cleanup_harness_session(&state, &session_id);
        let tmux_cleanup = tmux.clone();
        let id_cleanup = session_id.clone();
        let _ = tokio::task::spawn_blocking(move || tmux_cleanup.kill_session(&id_cleanup)).await;
        return Err(err);
    }

    Ok(session_id)
}

/// Open a PTY-attached `tmux attach-session` client and spawn the
/// pane-death monitor. Does NOT touch [`TerminalRegistry`] — the caller
/// decides whether the returned handles become a fresh entry (insert)
/// or replace the live fields of an existing one
/// ([`TerminalRegistry::replace_bridge`]). Shared between
/// [`terminal_spawn`] and [`terminal_reattach`].
#[allow(clippy::too_many_arguments)]
async fn open_bridge_and_monitor<R: Runtime>(
    app: AppHandle<R>,
    tmux: Arc<TmuxManager>,
    session_id: String,
    kind: AgentKind,
    on_data: Channel<InvokeResponseBody>,
    cols: u16,
    rows: u16,
    session_activity: Arc<Mutex<HashMap<String, Instant>>>,
    channel_event_tx: Option<mpsc::Sender<raum_hooks::HookEvent>>,
    pane_context_dirty_tx: Option<tokio::sync::mpsc::Sender<()>>,
) -> Result<(PtyBridgeHandle, JoinHandle<()>), String> {
    let channel_for_data = on_data.clone();
    let exit_app = app.clone();
    let exit_id = session_id.clone();
    let activity_for_data = session_activity.clone();
    let activity_session_id = session_id.clone();
    let mut osc9_parser = (kind == AgentKind::Codex).then(Osc9Parser::new);
    let pane_context_dirty_for_data = pane_context_dirty_tx;

    // Sync the tmux window to the size the PTY is about to open at. With
    // `window-size manual` per session, tmux only resizes on explicit
    // `resize-window`; on reattach (or the first attach for a brand-new
    // session that we just created with a different `-x -y` than the user's
    // current xterm) the window can be stale. Fire-and-forget — failures
    // here just mean we'll see the hatched padding until the next user
    // resize event corrects it.
    {
        let tmux_for_sync = tmux.clone();
        let id_for_sync = session_id.clone();
        let _ = tokio::task::spawn_blocking(move || {
            tmux_for_sync.resize(&id_for_sync, u32::from(cols), u32::from(rows))
        })
        .await;
    }

    let mgr_for_attach = tmux.clone();
    let id_for_attach = session_id.clone();
    let bridge = tokio::task::spawn_blocking(move || {
        attach_via_pty(
            &mgr_for_attach,
            &id_for_attach,
            cols,
            rows,
            Box::new(move |bytes| {
                if let (Some(parser), Some(tx)) = (osc9_parser.as_mut(), channel_event_tx.as_ref())
                {
                    for payload in parser.feed(&bytes) {
                        if let Some(kind) = classify_osc9_payload(&payload) {
                            forward_codex_osc9_event(&activity_session_id, tx, kind, payload);
                        }
                    }
                }
                // Tap the output stream so the silence-heuristic tick
                // (commands::agent::spawn_silence_tick) can flip a
                // `Working` machine to `Waiting` after the coalesced
                // stream goes quiet, even when hooks never fire.
                if let Ok(mut map) = activity_for_data.lock() {
                    map.insert(activity_session_id.clone(), Instant::now());
                }
                if let Some(tx) = pane_context_dirty_for_data.as_ref() {
                    let _ = tx.try_send(());
                }
                channel_for_data
                    .send(InvokeResponseBody::Raw(bytes))
                    .is_ok()
            }),
            Box::new(move |exit_code| {
                // Attached client exited unexpectedly — the bridge wasn't
                // silenced via `shutdown_silent`, so this is e.g. tmux
                // crashing or someone killing the client process directly.
                // Forward the event so the frontend can show its overlay.
                // The pane-death monitor task is still the canonical path
                // for "inner process exited" (with remain-on-exit holding
                // the client alive), so we don't kill the session from here
                // — that would race the monitor.
                let _ = exit_app.emit(
                    "terminal:process-exited",
                    serde_json::json!({ "sessionId": &exit_id, "exitCode": exit_code }),
                );
            }),
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
    .map_err(|e| format!("pty attach: {e}"))?;

    // Pane-death monitor: polls tmux every 300 ms for natural process exit so
    // we can emit `terminal:process-exited` even when the attached client is
    // still happily rendering an empty pane (remain-on-exit). Aborted by
    // `terminal_kill` so an explicit close never fires a spurious overlay.
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
                    let state: tauri::State<'_, AppHandleState> = monitor_app.state();
                    let removed = match state.terminals.lock() {
                        Ok(mut reg) => reg.remove(&monitor_id),
                        Err(e) => {
                            tracing::warn!(
                                session_id = %monitor_id,
                                error = %e,
                                "terminal monitor: terminals lock poisoned during cleanup"
                            );
                            None
                        }
                    };
                    if let Some(entry) = removed {
                        shutdown_removed_entry(entry, false);
                    }
                    cleanup_harness_session(&state, &monitor_id);
                    emit_terminal_session_removed(&monitor_app, &monitor_id);
                    emit_agent_session_removed(&monitor_app, &monitor_id);
                    break;
                }
                Ok(Ok(None)) => { /* pane still alive — keep polling */ }
                _ => break, // session killed externally (terminal_kill) or I/O error
            }
        }
    });

    Ok((bridge, monitor_handle))
}

/// `terminal_spawn` path: open a bridge + monitor and insert a fresh
/// entry into the registry. See [`open_bridge_and_monitor`] for the
/// shared pty/monitor setup.
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
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let app_handle = app.clone();
    let (pane_context_dirty_tx, context_task) = if matches!(kind, AgentKind::Shell) {
        (None, None)
    } else {
        let (dirty_tx, task) =
            spawn_pane_context_monitor(app.clone(), tmux.clone(), session_id.clone());
        (Some(dirty_tx), Some(task))
    };
    let (bridge, monitor_handle) = open_bridge_and_monitor(
        app,
        tmux,
        session_id.clone(),
        kind,
        on_data,
        cols,
        rows,
        state.session_activity.clone(),
        state.channel_event_tx.lock().ok().and_then(|g| g.clone()),
        pane_context_dirty_tx,
    )
    .await
    .inspect_err(|_| {
        if let Some(task) = context_task.as_ref() {
            task.abort();
        }
    })?;

    let entry = TerminalEntry {
        session_id: session_id.clone(),
        project_slug,
        worktree_id,
        kind,
        created_unix: now_unix_secs(),
        bridge,
        monitor_task: Some(monitor_handle),
        context_task,
        last_cols: cols,
        last_rows: rows,
    };
    let item = entry.list_item();

    {
        let mut reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        reg.insert(entry);
    }
    emit_terminal_session_upserted(&app_handle, &item);

    tracing::info!(
        session_id = %session_id,
        cols, rows,
        xterm_scrollback = XTERM_SCROLLBACK,
        "attach_pipeline: pty bridge ready"
    );

    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct ReattachArgs {
    pub session_id: String,
    pub kind: AgentKind,
    pub project_slug: Option<String>,
    pub worktree_id: Option<String>,
    /// Current xterm dimensions — we open the PTY at this size so tmux's
    /// attached client redraws the viewport at the real geometry on its very
    /// first frame. Mandatory for clean reattach without a follow-up SIGWINCH
    /// cascade.
    pub cols: Option<u32>,
    pub rows: Option<u32>,
}

fn preferred_context_value(values: [Option<&str>; 4]) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .find(|value| !value.is_empty())
        .map(str::to_string)
}

type ContextPair<'a> = (Option<&'a str>, Option<&'a str>);

fn resolve_reattach_context(
    from_args: ContextPair<'_>,
    from_registry: ContextPair<'_>,
    from_ghost: ContextPair<'_>,
    from_tracked: ContextPair<'_>,
) -> (Option<String>, Option<String>) {
    (
        preferred_context_value([from_args.0, from_registry.0, from_ghost.0, from_tracked.0]),
        preferred_context_value([from_args.1, from_registry.1, from_ghost.1, from_tracked.1]),
    )
}

fn tracked_session_context(
    state: &AppHandleState,
    session_id: &str,
) -> (Option<String>, Option<String>) {
    let Ok(store) = state.config_store.lock() else {
        return (None, None);
    };
    let Ok(sessions) = store.read_sessions() else {
        return (None, None);
    };
    sessions
        .sessions
        .into_iter()
        .find(|row| row.session_id == session_id)
        .map_or((None, None), |row| (row.project_slug, row.worktree_id))
}

/// §3.6 — reattach to a pre-existing tmux session that survived a previous
/// raum run. Verifies the session still exists on the `-L raum` socket, then
/// opens a fresh PTY-attached client the same way `terminal_spawn` does (minus
/// `new-session` and harness boot). tmux owns the redraw on attach, so xterm
/// sees the current pane viewport with no manual replay logic.
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
    let app_handle = app.clone();

    // Verify the tmux session exists FIRST. If it's gone we want the
    // `"not-found"` fallback to be side-effect free with respect to the
    // user's other panes — removing a stale registry entry or tearing
    // down a still-live bridge before we've even looked at tmux would
    // cause the top-row counters to briefly flash zero.
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
        // Reap any stale registry entry that still references this
        // session (reattach across a `tmux kill-server`, or across a
        // stale-reap window).
        let stale = {
            let mut reg = state
                .terminals
                .lock()
                .map_err(|e| format!("terminals lock: {e}"))?;
            reg.remove(&session_id)
        };
        if let Some(entry) = stale {
            shutdown_removed_entry(entry, true);
        }
        cleanup_harness_session(&state, &session_id);
        emit_terminal_session_removed(&app_handle, &session_id);
        emit_agent_session_removed(&app_handle, &session_id);
        return Err("not-found".to_string());
    }

    // Shut down the stale bridge on the existing registry entry WITHOUT
    // removing it. The entry stays visible to `terminal_list` for the
    // duration of the reattach, so the top-row counters don't flash to
    // zero on Cmd+R. Webview-reload path: Rust survives; the old reader
    // thread is still pumping bytes into an orphaned channel and must
    // be torn down before we wire the new one. Full-restart path: no
    // prior entry exists, `had_entry == false` tells us to insert
    // fresh below.
    //
    // `promoted_ghost` catches the separate case where the startup
    // rehydrate task registered an identity-only row; we remove it from
    // the ghost map so the subsequent `reg.insert(TerminalEntry { … })`
    // lands a real bridged entry instead of duplicating the session id.
    let (existing_item, had_entry, promoted_ghost) = {
        let mut reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        let existing = reg.item(&session_id);
        let detached = reg.detach_bridge(&session_id);
        let ghost = reg.promote_ghost(&session_id);
        (existing, detached, ghost)
    };
    if had_entry {
        tracing::info!(session_id = %session_id, "terminal_reattach: tearing down stale bridge");
    }
    if promoted_ghost.is_some() {
        tracing::info!(session_id = %session_id, "terminal_reattach: promoted rehydrate ghost");
    }

    let (tracked_project_slug, tracked_worktree_id) = tracked_session_context(&state, &session_id);
    let (effective_project_slug, effective_worktree_id) = resolve_reattach_context(
        (args.project_slug.as_deref(), args.worktree_id.as_deref()),
        (
            existing_item
                .as_ref()
                .and_then(|item| item.project_slug.as_deref()),
            existing_item
                .as_ref()
                .and_then(|item| item.worktree_id.as_deref()),
        ),
        (
            promoted_ghost
                .as_ref()
                .and_then(|ghost| ghost.project_slug.as_deref()),
            promoted_ghost
                .as_ref()
                .and_then(|ghost| ghost.worktree_id.as_deref()),
        ),
        (
            tracked_project_slug.as_deref(),
            tracked_worktree_id.as_deref(),
        ),
    );
    let (cols, rows) = match args.cols.zip(args.rows) {
        Some((c, r)) => clamp_pty_dims(c, r),
        None => (200, 50),
    };
    let project_dir = resolve_project_dir(
        &state,
        effective_project_slug.as_deref(),
        effective_worktree_id.as_deref(),
    );

    if !matches!(args.kind, AgentKind::Shell) {
        crate::commands::agent::ensure_bridge_running(&app, &state.agent_events);
        let hook_fallback = infer_reattach_hook_fallback(
            &state,
            args.kind,
            effective_project_slug.as_deref(),
            project_dir.clone(),
        );
        // Skip both channel re-registration and the seed emit so any
        // state-machine + channel subscriptions the startup rehydrate
        // task set up are preserved. The frontend's
        // `hydrateHarnessStateAfterReattach` pulls the current state
        // via `agent_state(session_id)` right after this resolves, so a
        // suppressed seed emit is harmless.
        register_harness_session_runtime_opts(
            &app,
            &state,
            args.kind,
            &session_id,
            effective_project_slug.as_deref(),
            effective_worktree_id.as_deref(),
            project_dir.clone(),
            hook_fallback,
            RegisterOptions {
                skip_channels_if_present: true,
                skip_seed_emit: true,
                ..RegisterOptions::default()
            },
        )?;
    }

    let (pane_context_dirty_tx, context_task) = if matches!(args.kind, AgentKind::Shell) {
        (None, None)
    } else {
        let (dirty_tx, task) =
            spawn_pane_context_monitor(app.clone(), state.tmux.clone(), session_id.clone());
        (Some(dirty_tx), Some(task))
    };

    // Replay the pane snapshot into xterm.js before the live client attaches.
    // The fresh xterm instance has no local history of its own; without this
    // replay the user loses both durable shell history and the last visible
    // TUI frame on every app reload.
    //
    // tmux exposes these two surfaces separately:
    // - the visible pane surface (plain `capture-pane`) which is the active
    //   alternate-screen frame when one is live
    // - the underlying durable normal-buffer history (`capture-pane -a`) while
    //   alternate-screen is active
    //
    // We write the normal history first, then switch xterm into alt-screen and
    // paint the captured live frame when present. The subsequent live attach
    // overwrites the viewport again but leaves the recovered normal buffer in
    // place for dedicated history browsing.
    {
        let tmux_for_capture = tmux.clone();
        let id_for_capture = session_id.clone();
        match tokio::task::spawn_blocking(move || {
            tmux_for_capture.capture_pane_snapshot(&id_for_capture)
        })
        .await
        {
            Ok(Ok(snapshot)) => {
                let replay = build_snapshot_replay(snapshot);
                if replay.is_empty() {
                    // Nothing to restore.
                } else if on_data.send(InvokeResponseBody::Raw(replay)).is_err() {
                    tracing::debug!(
                        session_id = %session_id,
                        "terminal_reattach: snapshot replay dropped (channel closed)"
                    );
                }
            }
            Ok(Err(e)) => {
                tracing::warn!(
                    session_id = %session_id,
                    error = %e,
                    "terminal_reattach: pane snapshot failed, continuing without replay"
                );
            }
            Err(e) => {
                tracing::warn!(
                    session_id = %session_id,
                    error = %e,
                    "terminal_reattach: pane snapshot task join failed, continuing without replay"
                );
            }
        }
    }

    // Open the fresh PTY bridge + monitor. This is the only long-running
    // work, and we hold no registry lock across it.
    let (bridge, monitor_handle) = match open_bridge_and_monitor(
        app,
        tmux,
        session_id.clone(),
        args.kind,
        on_data,
        cols,
        rows,
        state.session_activity.clone(),
        state.channel_event_tx.lock().ok().and_then(|g| g.clone()),
        pane_context_dirty_tx,
    )
    .await
    {
        Ok(handles) => handles,
        Err(err) => {
            if let Some(task) = context_task.as_ref() {
                task.abort();
            }
            cleanup_harness_session(&state, &session_id);
            if had_entry
                && let Ok(mut reg) = state.terminals.lock()
                && let Some(entry) = reg.remove(&session_id)
            {
                shutdown_removed_entry(entry, true);
            }
            emit_terminal_session_removed(&app_handle, &session_id);
            emit_agent_session_removed(&app_handle, &session_id);
            return Err(err);
        }
    };

    // Land the fresh handles: replace on the existing entry (Cmd+R /
    // webview reload) or insert a brand-new one (full app restart — the
    // backend started empty so `detach_bridge` returned false).
    let item = {
        let mut reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        if had_entry {
            if !reg.replace_bridge(
                &session_id,
                bridge,
                monitor_handle,
                context_task,
                cols,
                rows,
            ) {
                // The entry was removed concurrently (a `terminal_kill`
                // raced the reattach). The bridge and monitor we just
                // built are dropped here — the pane will stay blank
                // until it re-spawns on the next mount.
                tracing::warn!(
                    session_id = %session_id,
                    "terminal_reattach: entry vanished between detach and replace"
                );
            }
        } else {
            // Prefer the rehydrated ghost's `created_unix` so the
            // session timestamp survives a restart. Args (from the
            // frontend) supersede the ghost for project/worktree —
            // the frontend knows the active project context — but
            // fall back to the ghost when args are None (happens
            // when the reattach came from a TerminalPane that didn't
            // receive project context, e.g. an orphaned cell).
            let (created_unix, ghost_project, ghost_worktree) = match promoted_ghost {
                Some(g) => (g.created_unix, g.project_slug, g.worktree_id),
                None => (now_unix_secs(), None, None),
            };
            reg.insert(TerminalEntry {
                session_id: session_id.clone(),
                project_slug: effective_project_slug.clone().or(ghost_project),
                worktree_id: effective_worktree_id.clone().or(ghost_worktree),
                kind: args.kind,
                created_unix,
                bridge,
                monitor_task: Some(monitor_handle),
                context_task,
                last_cols: cols,
                last_rows: rows,
            });
        }
        reg.item(&session_id)
    };
    if let Some(item) = item {
        emit_terminal_session_upserted(&app_handle, &item);
    }

    tracing::info!(
        session_id = %session_id,
        cols, rows,
        had_entry,
        xterm_scrollback = XTERM_SCROLLBACK,
        "terminal_reattach: pty bridge ready"
    );

    Ok(session_id)
}

#[tauri::command]
pub async fn terminal_kill<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    session_id: String,
) -> Result<(), String> {
    let tmux = state.tmux.clone();
    let id = session_id.clone();
    let kill_res = tokio::task::spawn_blocking(move || tmux.kill_session(&id))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?;

    // Drop the entry regardless of tmux's kill result — if the session is
    // already dead we still want to reclaim the PTY bridge + tasks.
    let removed = {
        let mut reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        reg.remove(&session_id)
    };
    if let Some(entry) = removed {
        // Abort the monitor first so it can't fire a spurious process-exited
        // event after an explicit kill.
        shutdown_removed_entry(entry, true);
    }

    cleanup_harness_session(&state, &session_id);
    emit_terminal_session_removed(&app, &session_id);
    emit_agent_session_removed(&app, &session_id);

    kill_res.map_err(|e| format!("tmux kill-session: {e}"))
}

#[tauri::command]
pub async fn terminal_resize(
    state: tauri::State<'_, AppHandleState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let bridge_and_size = {
        let reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        reg.get_bridge_and_size(&session_id)
    };
    let Some((bridge, prev_cols, prev_rows)) = bridge_and_size else {
        return Err("not-found".to_string());
    };
    let (c, r) = clamp_pty_dims(cols, rows);
    if c == prev_cols && r == prev_rows {
        // No-op resize; skip the tmux round-trip entirely.
        return Ok(());
    }
    let tmux = state.tmux.clone();
    let id = session_id.clone();
    // Resize ordering matters: tmux renders a hatched "|..." pattern when
    // the attached client's viewport is larger than the tmux window. The
    // old parallel `tokio::join!` raced the two operations — half the time
    // the PTY resize (viewport) landed first and the user saw the hatch
    // flash for a frame or two.
    //
    // Fix: keep `window ≥ viewport` at every intermediate state. That means
    // we pick the operation order per-direction:
    //
    //   * Growing (new ≥ old on both dims): resize the tmux window FIRST to
    //     the new dims, then resize the PTY viewport. Intermediate state:
    //     window=new (bigger), viewport=old (smaller) → window > viewport,
    //     no hatch.
    //   * Shrinking (new ≤ old on both dims): resize the PTY viewport first,
    //     then shrink the tmux window. Intermediate state: window=old
    //     (bigger), viewport=new (smaller) → window > viewport, no hatch.
    //   * Mixed (e.g. grow cols, shrink rows): run a three-step sequence —
    //     grow tmux window to max-of-old-and-new on each dim, resize the
    //     PTY, shrink tmux window to new dims. Keeps window ≥ viewport the
    //     whole time, at the cost of one extra tmux round-trip.
    let growing = c >= prev_cols && r >= prev_rows;
    let shrinking = c <= prev_cols && r <= prev_rows;
    if growing {
        // window first → PTY
        let tmux_grow = tmux.clone();
        let id_grow = id.clone();
        tokio::task::spawn_blocking(move || tmux_grow.resize(&id_grow, u32::from(c), u32::from(r)))
            .await
            .map_err(|e| format!("spawn_blocking join: {e}"))?
            .map_err(|e| format!("tmux resize: {e}"))?;
        tokio::task::spawn_blocking(move || bridge.resize(c, r))
            .await
            .map_err(|e| format!("spawn_blocking join: {e}"))?
            .map_err(|e| format!("pty resize: {e}"))?;
    } else if shrinking {
        // PTY first → window
        let bridge_for_shrink = bridge.clone();
        tokio::task::spawn_blocking(move || bridge_for_shrink.resize(c, r))
            .await
            .map_err(|e| format!("spawn_blocking join: {e}"))?
            .map_err(|e| format!("pty resize: {e}"))?;
        tokio::task::spawn_blocking(move || tmux.resize(&id, u32::from(c), u32::from(r)))
            .await
            .map_err(|e| format!("spawn_blocking join: {e}"))?
            .map_err(|e| format!("tmux resize: {e}"))?;
    } else {
        // Mixed: grow window to max-of-both, resize PTY, shrink window.
        let max_c = c.max(prev_cols);
        let max_r = r.max(prev_rows);
        let tmux_up = tmux.clone();
        let id_up = id.clone();
        tokio::task::spawn_blocking(move || {
            tmux_up.resize(&id_up, u32::from(max_c), u32::from(max_r))
        })
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
        .map_err(|e| format!("tmux resize (grow): {e}"))?;
        tokio::task::spawn_blocking(move || bridge.resize(c, r))
            .await
            .map_err(|e| format!("spawn_blocking join: {e}"))?
            .map_err(|e| format!("pty resize: {e}"))?;
        tokio::task::spawn_blocking(move || tmux.resize(&id, u32::from(c), u32::from(r)))
            .await
            .map_err(|e| format!("spawn_blocking join: {e}"))?
            .map_err(|e| format!("tmux resize (finalize): {e}"))?;
    }

    // Record the new dims so the next resize picks the right ordering.
    {
        let mut reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        reg.update_size(&session_id, c, r);
    }
    Ok(())
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
pub async fn terminal_send_keys<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    session_id: String,
    keys: String,
) -> Result<(), String> {
    if contains_submit_input(&keys) {
        let mut agents = state
            .agents
            .lock()
            .map_err(|e| format!("agent registry lock: {e}"))?;
        let _ = agents.arm_activity_for_submit(&session_id);
        drop(agents);
    }
    let current_state = {
        let agents = state
            .agents
            .lock()
            .map_err(|e| format!("agent registry lock: {e}"))?;
        agents.state_for(&session_id)
    };
    if contains_abort_input(&keys, current_state) {
        let change = {
            let mut agents = state
                .agents
                .lock()
                .map_err(|e| format!("agent registry lock: {e}"))?;
            agents.abort_session(&session_id)
        };
        if let Some(change) = change {
            // Evict any parked permission writers for this session so a
            // stale `PendingRequest` can't match a future reply.
            if let Ok(slot) = state.event_socket.lock()
                && let Some(handle) = slot.as_ref()
            {
                let evicted = handle.pending.drop_session(&session_id);
                if evicted > 0 {
                    tracing::debug!(
                        session_id = %session_id,
                        evicted,
                        "drop_session on abort evicted parked permission writers",
                    );
                }
            }
            if let Err(e) = app.emit("agent-state-changed", &change) {
                tracing::warn!(error = %e, "agent-state-changed emit on abort failed");
            }
        }
    }
    let bridge = {
        let reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        reg.get_bridge(&session_id)
    };
    let Some(bridge) = bridge else {
        return Err("not-found".to_string());
    };
    let bytes = keys.into_bytes();
    tokio::task::spawn_blocking(move || bridge.write_input(&bytes))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
        .map_err(|e| format!("pty write: {e}"))
}

#[cfg(test)]
mod ghost_tests {
    use super::{GhostEntry, TerminalRegistry};
    use raum_core::AgentKind;

    fn ghost(id: &str, slug: Option<&str>) -> GhostEntry {
        GhostEntry {
            session_id: id.to_string(),
            project_slug: slug.map(str::to_string),
            worktree_id: None,
            kind: AgentKind::ClaudeCode,
            created_unix: 42,
        }
    }

    #[test]
    fn upsert_ghost_exposes_session_in_list() {
        let mut reg = TerminalRegistry::default();
        assert!(reg.upsert_ghost(ghost("raum-a", Some("acme"))));
        let listed = reg.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, "raum-a");
        assert_eq!(listed[0].project_slug.as_deref(), Some("acme"));
        assert_eq!(listed[0].kind, AgentKind::ClaudeCode);
    }

    #[test]
    fn upsert_ghost_is_idempotent() {
        let mut reg = TerminalRegistry::default();
        assert!(reg.upsert_ghost(ghost("raum-a", Some("acme"))));
        // Re-upserting overwrites (for instance, if the rehydrate
        // bootstrap re-runs — shouldn't happen today, but defensive).
        assert!(reg.upsert_ghost(ghost("raum-a", Some("other"))));
        let listed = reg.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].project_slug.as_deref(), Some("other"));
    }

    #[test]
    fn promote_ghost_removes_from_map_and_returns_metadata() {
        let mut reg = TerminalRegistry::default();
        reg.upsert_ghost(ghost("raum-a", Some("acme")));
        let promoted = reg.promote_ghost("raum-a");
        assert!(promoted.is_some(), "promote returns the ghost");
        assert!(reg.list().is_empty(), "ghost is removed from list");
        assert!(
            reg.promote_ghost("raum-a").is_none(),
            "second promote is None"
        );
    }

    #[test]
    fn ghost_is_not_returned_by_get_bridge() {
        let mut reg = TerminalRegistry::default();
        reg.upsert_ghost(ghost("raum-a", Some("acme")));
        // Ghosts intentionally lack a PTY bridge — `get_bridge`
        // returns None so `terminal_send_keys` / `terminal_resize`
        // short-circuit with `"not-found"` until reattach promotes
        // the ghost.
        assert!(reg.get_bridge("raum-a").is_none());
        assert!(reg.get_bridge_and_size("raum-a").is_none());
    }

    #[test]
    fn remove_drops_ghost_rows_too() {
        let mut reg = TerminalRegistry::default();
        reg.upsert_ghost(ghost("raum-a", Some("acme")));
        // No real entry to remove, but the method should still clear
        // the ghost so a subsequent `list` is empty.
        assert!(reg.remove("raum-a").is_none());
        assert!(reg.list().is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::{
        PaneContextPayload, contains_abort_input, contains_submit_input, resolve_reattach_context,
        should_emit_pane_context_change,
    };
    use raum_core::agent::AgentState;

    #[test]
    fn submit_input_detector_ignores_plain_typing() {
        assert!(!contains_submit_input("hello world"));
        assert!(!contains_submit_input("abc\tdef"));
    }

    #[test]
    fn submit_input_detector_matches_return_and_newline() {
        assert!(contains_submit_input("\r"));
        assert!(contains_submit_input("\n"));
        assert!(contains_submit_input("hello\r"));
        assert!(contains_submit_input("hello\nworld"));
    }

    #[test]
    fn abort_input_ctrl_c_fires_regardless_of_state() {
        assert!(contains_abort_input("\x03", None));
        assert!(contains_abort_input("\x03", Some(AgentState::Working)));
        assert!(contains_abort_input("\x03", Some(AgentState::Waiting)));
        assert!(contains_abort_input("\x03", Some(AgentState::Idle)));
    }

    #[test]
    fn abort_input_esc_fires_only_when_waiting() {
        assert!(contains_abort_input("\x1b", Some(AgentState::Waiting)));
        assert!(!contains_abort_input("\x1b", Some(AgentState::Working)));
        assert!(!contains_abort_input("\x1b", Some(AgentState::Idle)));
        assert!(!contains_abort_input("\x1b", None));
    }

    #[test]
    fn abort_input_plain_keys_never_fire() {
        assert!(!contains_abort_input("", Some(AgentState::Waiting)));
        assert!(!contains_abort_input("hello", Some(AgentState::Waiting)));
        assert!(!contains_abort_input("a\tb", Some(AgentState::Working)));
    }

    #[test]
    fn pane_context_change_emits_first_snapshot_once() {
        let next = PaneContextPayload {
            current_command: "node".into(),
            current_path: "/tmp/raum".into(),
            pane_title: "Investigating flake".into(),
            window_name: "node".into(),
        };
        assert!(should_emit_pane_context_change(None, &next));
        assert!(!should_emit_pane_context_change(Some(&next), &next));
    }

    #[test]
    fn pane_context_change_dedupes_identical_snapshots() {
        let previous = PaneContextPayload {
            current_command: "node".into(),
            current_path: "/tmp/raum".into(),
            pane_title: "Investigating flake".into(),
            window_name: "node".into(),
        };
        let next = previous.clone();
        assert!(!should_emit_pane_context_change(Some(&previous), &next));
    }

    #[test]
    fn pane_context_change_emits_when_titles_change() {
        let previous = PaneContextPayload {
            current_command: "node".into(),
            current_path: "/tmp/raum".into(),
            pane_title: "Investigating flake".into(),
            window_name: "node".into(),
        };
        let renamed_pane = PaneContextPayload {
            pane_title: "Reviewing fixes".into(),
            ..previous.clone()
        };
        let renamed_window = PaneContextPayload {
            window_name: "branch/fix-title".into(),
            ..previous.clone()
        };
        assert!(should_emit_pane_context_change(
            Some(&previous),
            &renamed_pane
        ));
        assert!(should_emit_pane_context_change(
            Some(&previous),
            &renamed_window
        ));
    }

    #[test]
    fn reattach_context_prefers_args_then_registry_then_ghost_then_tracked() {
        let (project, worktree) = resolve_reattach_context(
            (Some("args-project"), Some("args-worktree")),
            (Some("registry-project"), Some("registry-worktree")),
            (Some("ghost-project"), Some("ghost-worktree")),
            (Some("tracked-project"), Some("tracked-worktree")),
        );
        assert_eq!(project.as_deref(), Some("args-project"));
        assert_eq!(worktree.as_deref(), Some("args-worktree"));

        let (project, worktree) = resolve_reattach_context(
            (None, None),
            (Some("registry-project"), Some("registry-worktree")),
            (Some("ghost-project"), Some("ghost-worktree")),
            (Some("tracked-project"), Some("tracked-worktree")),
        );
        assert_eq!(project.as_deref(), Some("registry-project"));
        assert_eq!(worktree.as_deref(), Some("registry-worktree"));

        let (project, worktree) = resolve_reattach_context(
            (None, None),
            (None, None),
            (Some("ghost-project"), Some("ghost-worktree")),
            (Some("tracked-project"), Some("tracked-worktree")),
        );
        assert_eq!(project.as_deref(), Some("ghost-project"));
        assert_eq!(worktree.as_deref(), Some("ghost-worktree"));

        let (project, worktree) = resolve_reattach_context(
            (None, None),
            (None, None),
            (None, None),
            (Some("tracked-project"), Some("tracked-worktree")),
        );
        assert_eq!(project.as_deref(), Some("tracked-project"));
        assert_eq!(worktree.as_deref(), Some("tracked-worktree"));
    }
}

/// Insert one or more file paths into a pane as a *paste event*, not a run of
/// keystrokes. This is how drag-and-drop lands — harnesses like Claude Code /
/// Codex / OpenCode detect the bracketed-paste envelope tmux wraps around the
/// payload and materialise an attachment (or `@path` reference); plain shells
/// still see ordinary characters they can edit before pressing Enter.
///
/// `mode`:
///   * `"harness"` — caller reports the pane is running a harness that treats
///     bracketed pastes specially (Claude Code, Codex, OpenCode). We send the
///     raw absolute paths space-joined, no shell quoting, no trailing space:
///     the harness re-parses the paste as an attachment list and backslash /
///     quote escapes would be inserted literally (anthropics/claude-code
///     #16532, #4705).
///   * `"shell"` — plain shell prompt. POSIX single-quote each path + trailing
///     space so the user can hit Enter safely.
///
/// In both cases we request bracketed-paste wrapping from tmux via
/// `paste-buffer -p`; tmux only actually emits the CSIs when the inner app
/// has enabled DECSET 2004, so this is a no-op for a shell that hasn't
/// opted in.
#[tauri::command]
pub async fn terminal_paste_paths(
    state: tauri::State<'_, AppHandleState>,
    session_id: String,
    paths: Vec<String>,
    mode: String,
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    // Look up the pane under the registry lock without holding it across the
    // blocking tmux fork+exec.
    let exists = {
        let reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        reg.get_bridge(&session_id).is_some()
    };
    if !exists {
        return Err("not-found".to_string());
    }
    let payload = format_paste_payload(&paths, &mode);
    let tmux = state.tmux.clone();
    let buffer_name = format!("raum-drop-{session_id}");
    let target = session_id.clone();
    tokio::task::spawn_blocking(move || {
        tmux.paste_into_pane(&target, &buffer_name, payload.as_bytes(), true)
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
    .map_err(|e| format!("tmux paste: {e}"))
}

/// Render the drop payload according to the active pane's paste mode. The
/// logic is pulled out for unit-testability — no tmux calls involved.
#[must_use]
pub(crate) fn format_paste_payload(paths: &[String], mode: &str) -> String {
    match mode {
        "harness" => paths.join(" "),
        // Default to POSIX single-quote wrapping for anything else. Unknown
        // modes fall through to shell semantics — the safer of the two, since
        // dropping a backslash-escaped path into a shell is always fine.
        _ => {
            let mut out = String::new();
            for (i, p) in paths.iter().enumerate() {
                if i > 0 {
                    out.push(' ');
                }
                out.push('\'');
                // Close-quote, backslash-quote, reopen-quote — canonical POSIX
                // single-quote escape that survives re-parsing by bash/zsh/sh.
                for ch in p.chars() {
                    if ch == '\'' {
                        out.push_str("'\\''");
                    } else {
                        out.push(ch);
                    }
                }
                out.push('\'');
            }
            // Trailing space so the user's next keystroke doesn't glue onto
            // the path.
            out.push(' ');
            out
        }
    }
}

#[cfg(test)]
mod opencode_port_tests {
    use super::parse_opencode_port_arg;

    #[test]
    fn parses_space_separated_port_flag() {
        assert_eq!(
            parse_opencode_port_arg("--port 5123 --agent build"),
            Some(5123)
        );
    }

    #[test]
    fn parses_equals_port_flag() {
        assert_eq!(
            parse_opencode_port_arg("--agent build --port=5123"),
            Some(5123)
        );
    }

    #[test]
    fn ignores_missing_or_invalid_port_flag() {
        assert_eq!(parse_opencode_port_arg("--agent build"), None);
        assert_eq!(parse_opencode_port_arg("--port nope"), None);
    }
}

#[cfg(test)]
mod paste_payload_tests {
    use super::format_paste_payload;

    #[test]
    fn harness_mode_joins_raw_paths_without_quoting() {
        let paths = vec![
            "/tmp/hello world.md".to_string(),
            "/tmp/a'b.txt".to_string(),
        ];
        let got = format_paste_payload(&paths, "harness");
        // Exactly as dropped — no backslashes, no quotes, no trailing space.
        assert_eq!(got, "/tmp/hello world.md /tmp/a'b.txt");
    }

    #[test]
    fn shell_mode_posix_quotes_with_trailing_space() {
        let paths = vec!["/tmp/hello world.md".to_string()];
        let got = format_paste_payload(&paths, "shell");
        assert_eq!(got, "'/tmp/hello world.md' ");
    }

    #[test]
    fn shell_mode_escapes_embedded_single_quotes() {
        let paths = vec!["/tmp/it's.md".to_string()];
        let got = format_paste_payload(&paths, "shell");
        assert_eq!(got, "'/tmp/it'\\''s.md' ");
    }

    #[test]
    fn unknown_mode_falls_through_to_shell_semantics() {
        let paths = vec!["/tmp/a.txt".to_string()];
        let got = format_paste_payload(&paths, "wat");
        assert_eq!(got, "'/tmp/a.txt' ");
    }
}

/// Return the pane metadata the frontend uses to derive tab labels. Shell
/// tabs care about `current_command` + `current_path`; harness tabs also use
/// tmux's `pane_title` / `window_name` when the inner CLI publishes them.
/// Errors resolve to empty fields so a transient tmux hiccup doesn't wipe the
/// displayed label.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PaneContextPayload {
    pub current_command: String,
    pub current_path: String,
    pub pane_title: String,
    pub window_name: String,
}

impl From<PaneContext> for PaneContextPayload {
    fn from(ctx: PaneContext) -> Self {
        Self {
            current_command: ctx.current_command,
            current_path: ctx.current_path,
            pane_title: ctx.pane_title,
            window_name: ctx.window_name,
        }
    }
}

#[tauri::command]
pub async fn terminal_pane_context(
    state: tauri::State<'_, AppHandleState>,
    session_id: String,
) -> Result<PaneContextPayload, String> {
    let tmux = state.tmux.clone();
    let res = tokio::task::spawn_blocking(move || tmux.pane_context(&session_id))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?;
    Ok(res.unwrap_or_default().into())
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
                e.bridge.shutdown_silent();
                drop(e);
            }
        }
    }
    Ok(killed)
}
