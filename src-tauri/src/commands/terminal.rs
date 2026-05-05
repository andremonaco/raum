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
//! viewport bytes verbatim. xterm.js on the webview side keeps a 100 000-line
//! scrollback (§3.8); the underlying tmux `history-limit` is set to match for
//! future copy-mode exposure. The scrollback cap is exported as
//! [`raum_core::config::XTERM_SCROLLBACK_LINES`] and consumed by the frontend.

use std::collections::{HashMap, HashSet};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use raum_core::AgentKind;
use raum_core::config::XTERM_SCROLLBACK_LINES;
use raum_core::harness::codex::{Osc9Parser, classify_osc9_payload};
use raum_core::harness::{
    NotificationKind, Reliability, harness_launch_command, harness_launch_command_with_prompt,
    harness_resume_command, parse_opencode_port_arg,
};
use raum_core::review::{
    discover_session_id_by_prompt, harness_session_id_matches_cwd, inject_opencode_brief,
};
use raum_tmux::{
    PaneContext, PaneSnapshot, PtyBridgeHandle, TmuxError, TmuxManager, attach_via_pty,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::commands::agent::{
    RegisterOptions, cleanup_harness_session, infer_reattach_hook_fallback,
    prepare_harness_launch_fast, register_harness_session_runtime,
    register_harness_session_runtime_opts, resolve_project_dir, spawn_harness_launch_refresh,
};
use crate::state::AppHandleState;

pub(crate) fn reserve_localhost_port() -> Result<u16, String> {
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
    /// True when the rehydrate path detected this session's tmux pane
    /// is dead (`pane_dead == 1`) and could not auto-revive it — so the
    /// frontend should render the Recover overlay instead of attaching
    /// a PTY bridge. Skipped from the wire when false to keep the
    /// shape stable for the common case.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dead: bool,
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
    /// Carried into the emitted `TerminalListItem` so the sidebar can
    /// render a Recover affordance for dead panes that the rehydrate
    /// path couldn't auto-revive (Shell sessions, or harnesses where
    /// `respawn_with` failed).
    pub dead: bool,
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
            dead: self.dead,
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
    /// Session ids with a `terminal_reattach` currently opening a fresh PTY
    /// bridge. Guards against duplicate frontend surfaces repeatedly tearing
    /// down and replacing each other's bridge for the same tmux session.
    reattaching: HashSet<String>,
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

    fn set_monitor_task(&mut self, session_id: &str, monitor_task: JoinHandle<()>) -> bool {
        let Some(entry) = self.entries.get_mut(session_id) else {
            monitor_task.abort();
            return false;
        };
        if let Some(existing) = entry.monitor_task.replace(monitor_task) {
            existing.abort();
        }
        true
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
        entry.bridge_output_cancelled.store(true, Ordering::SeqCst);
        entry.bridge.shutdown_silent();
        true
    }

    /// Swap the live bridge/monitor/dims on an existing entry. Identity
    /// columns (`project_slug`, `worktree_id`, `kind`, `created_unix`)
    /// are preserved. Returns `true` iff the entry existed; when it
    /// returns `false` the caller's bridge + monitor are dropped.
    fn replace_bridge(
        &mut self,
        session_id: &str,
        runtime: BridgeRuntime,
        cols: u16,
        rows: u16,
    ) -> bool {
        let Some(entry) = self.entries.get_mut(session_id) else {
            if let Some(monitor) = runtime.monitor_task {
                monitor.abort();
            }
            if let Some(context) = runtime.context_task {
                context.abort();
            }
            runtime
                .bridge_output_cancelled
                .store(true, Ordering::SeqCst);
            runtime.bridge.shutdown_silent();
            return false;
        };
        entry.bridge_output_cancelled.store(true, Ordering::SeqCst);
        entry.bridge = runtime.bridge;
        entry.bridge_output_cancelled = runtime.bridge_output_cancelled;
        entry.monitor_task = runtime.monitor_task;
        entry.context_task = runtime.context_task;
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
                // Real entries are by definition live — the bridge is
                // attached. Dead-pane sessions stay as ghosts.
                dead: false,
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

    pub fn begin_reattach(&mut self, session_id: &str) -> bool {
        self.reattaching.insert(session_id.to_string())
    }

    pub fn finish_reattach(&mut self, session_id: &str) {
        self.reattaching.remove(session_id);
    }
}

impl std::fmt::Debug for TerminalRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TerminalRegistry")
            .field("count", &self.entries.len())
            .field("ghosts", &self.ghosts.len())
            .field("reattaching", &self.reattaching.len())
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
    /// Set before intentionally tearing down/replacing this PTY bridge.
    /// Reader/coalescer threads may still flush a short tail after
    /// `shutdown_silent`; this drops stale bytes before they hit xterm.
    pub bridge_output_cancelled: Arc<AtomicBool>,
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

struct BridgeRuntime {
    bridge: PtyBridgeHandle,
    bridge_output_cancelled: Arc<AtomicBool>,
    monitor_task: Option<JoinHandle<()>>,
    context_task: Option<JoinHandle<()>>,
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
            dead: false,
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
    /// Optional initial prompt appended to the harness launch command. Used
    /// only by the cross-harness review feature today; the frontend never
    /// passes this for user-driven spawns.
    #[serde(default)]
    pub initial_prompt: Option<String>,
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

fn now_unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
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
    entry.bridge_output_cancelled.store(true, Ordering::SeqCst);
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

/// Resolve the directory to pass to `tmux respawn-pane -c` for harness
/// resume/recovery. Prefer tmux's foreground process cwd because harnesses
/// like Claude key their local session storage by cwd; fall back to the
/// tracked project root if tmux has no usable path.
async fn resolve_harness_respawn_cwd(
    tmux: &Arc<TmuxManager>,
    state: &AppHandleState,
    session_id: &str,
) -> Option<String> {
    let pane_cwd = {
        let tmux_for_context = tmux.clone();
        let id_for_context = session_id.to_string();
        tokio::task::spawn_blocking(move || tmux_for_context.pane_context(&id_for_context))
            .await
            .ok()
            .and_then(Result::ok)
            .map(|ctx| ctx.current_path)
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty())
            .filter(|path| std::path::Path::new(path).is_dir())
    };
    if pane_cwd.is_some() {
        return pane_cwd;
    }

    let (project_slug, worktree_id) = tracked_session_context(state, session_id);
    let project_dir = resolve_project_dir(state, project_slug.as_deref(), worktree_id.as_deref());
    if project_dir.as_os_str().is_empty() || !project_dir.is_dir() {
        return None;
    }
    Some(project_dir.to_string_lossy().into_owned())
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
        let report = prepare_harness_launch_fast(
            &app,
            &state,
            args.kind,
            args.project_slug.as_deref(),
            project_dir.clone(),
        )?;
        if report.binary_missing {
            return Err(format!("binary `{}` not found on PATH", report.binary));
        }
        Some(report)
    };
    if launch_report.is_some() {
        spawn_harness_launch_refresh(
            app.clone(),
            args.kind,
            args.project_slug.clone(),
            project_dir.clone(),
        );
    }

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
    // Pick / reserve OpenCode port up front so we can both feed it to
    // `harness_launch_command` and persist it on the registered session.
    let opencode_port: Option<u16> = if matches!(args.kind, AgentKind::OpenCode) {
        Some(
            match extra_flags.as_deref().and_then(parse_opencode_port_arg) {
                Some(explicit) => explicit,
                None => reserve_localhost_port()?,
            },
        )
    } else {
        None
    };
    let harness_cmd = harness_launch_command_with_prompt(
        args.kind,
        extra_flags.as_deref(),
        opencode_port,
        args.initial_prompt.as_deref(),
    );

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
    let cwd_for_new = cwd.clone();
    tokio::task::spawn_blocking(move || {
        let mut env_pairs: Vec<(&str, &str)> =
            vec![(raum_hooks::RAUM_SESSION_ENV, raum_session_value.as_str())];
        if let Some(p) = raum_event_sock_value.as_deref() {
            env_pairs.push((raum_hooks::RAUM_EVENT_SOCK_ENV, p));
        }
        mgr_for_new.new_session_with_env(
            &id_for_new,
            &cwd_for_new,
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

    let (cols, rows) = match args.cols.zip(args.rows) {
        Some((c, r)) => clamp_pty_dims(c, r),
        None => (200, 50),
    };

    // Attach the PTY bridge before booting harness TUIs. Harness sessions were
    // created with a silent placeholder above; swapping in the real command
    // after the bridge is live guarantees xterm receives the first paint
    // instead of showing a blank pane while tmux already has content.
    if let Err(err) = attach_pipeline(
        app.clone(),
        &state,
        session_id.clone(),
        args.kind,
        args.project_slug,
        args.worktree_id,
        tmux.clone(),
        on_data,
        cols,
        rows,
        harness_cmd.is_none(),
    )
    .await
    {
        cleanup_harness_session(&state, &session_id);
        let tmux_cleanup = tmux.clone();
        let id_cleanup = session_id.clone();
        let _ = tokio::task::spawn_blocking(move || tmux_cleanup.kill_session(&id_cleanup)).await;
        return Err(err);
    }

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
            let removed = {
                let mut reg = state
                    .terminals
                    .lock()
                    .map_err(|e| format!("terminals lock: {e}"))?;
                reg.remove(&session_id)
            };
            if let Some(entry) = removed {
                shutdown_removed_entry(entry, true);
            }
            emit_terminal_session_removed(&app, &session_id);
            emit_agent_session_removed(&app, &session_id);
            return Err(err);
        }
        let monitor = spawn_pane_death_monitor(app.clone(), tmux.clone(), session_id.clone());
        if let Ok(mut reg) = state.terminals.lock() {
            let _ = reg.set_monitor_task(&session_id, monitor);
        }
    }

    // Cross-harness review: when an OpenCode reviewer is spawned with a
    // brief, deliver it via OpenCode's `/tui/append-prompt` +
    // `/tui/submit-prompt` HTTP endpoints once the TUI is up. This is
    // the documented IDE-integration path; the alternative
    // (`opencode run '<brief>'`) is one-shot non-interactive and would
    // exit immediately, killing the reviewer pane. Best-effort: every
    // failure inside `inject_opencode_brief` is logged and swallowed,
    // leaving the user with a usable interactive TUI.
    if matches!(args.kind, AgentKind::OpenCode)
        && let Some(brief) = args
            .initial_prompt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        && let Some(port) = opencode_port
    {
        let brief = brief.to_string();
        let cwd_for_inject = cwd.clone();
        tokio::spawn(async move {
            inject_opencode_brief("http://127.0.0.1", port, &cwd_for_inject, &brief).await;
        });
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
) -> Result<(PtyBridgeHandle, Arc<AtomicBool>), String> {
    let bridge_output_cancelled = Arc::new(AtomicBool::new(false));
    let output_cancel_for_data = bridge_output_cancelled.clone();
    let channel_for_data = on_data.clone();
    let data_app = app.clone();
    let data_session_id_for_lost = session_id.clone();
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
                if output_cancel_for_data.load(Ordering::SeqCst) {
                    return false;
                }
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
                // Fail-loud send: if the WebView's `Channel<Raw>` is gone
                // (component unmount, page reload, app shutdown), the
                // previous `.is_ok()` swallowed the byte and ground on
                // silently — making "lost output" reports impossible to
                // diagnose. Now we log + emit `terminal:bridge-lost`
                // (mirroring the on_exit path) and return false so the
                // PTY bridge tears down cleanly.
                if let Err(err) = channel_for_data.send(InvokeResponseBody::Raw(bytes)) {
                    tracing::warn!(
                        session_id = %data_session_id_for_lost,
                        error = %err,
                        "pty bridge: channel send failed, terminating",
                    );
                    let _ = data_app.emit(
                        "terminal:bridge-lost",
                        serde_json::json!({
                            "sessionId": &data_session_id_for_lost,
                            "exitCode": serde_json::Value::Null,
                        }),
                    );
                    return false;
                }
                true
            }),
            Box::new(move |exit_code| {
                // Attached client exited unexpectedly — the bridge wasn't
                // silenced via `shutdown_silent`, so this is an outer PTY /
                // tmux-client failure, not proof that the inner shell or
                // harness exited. Keep this distinct from
                // `terminal:process-exited`; the frontend can reattach this
                // pane in place when the tmux session is still alive.
                let _ = exit_app.emit(
                    "terminal:bridge-lost",
                    serde_json::json!({ "sessionId": &exit_id, "exitCode": exit_code }),
                );
            }),
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
    .map_err(|e| format!("pty attach: {e}"))?;

    Ok((bridge, bridge_output_cancelled))
}

/// Pane-death monitor: polls tmux every 300 ms for natural process exit so we
/// can emit `terminal:process-exited` even when the attached client is still
/// happily rendering an empty pane (remain-on-exit). Aborted by `terminal_kill`
/// so an explicit close never fires a spurious overlay.
fn spawn_pane_death_monitor<R: Runtime>(
    app: AppHandle<R>,
    tmux: Arc<TmuxManager>,
    session_id: String,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(300)).await;
            let id = session_id.clone();
            let tmux_for_check = tmux.clone();
            match tokio::task::spawn_blocking(move || tmux_for_check.check_pane_dead(&id)).await {
                Ok(Ok(Some(exit_code))) => {
                    let _ = app.emit(
                        "terminal:process-exited",
                        serde_json::json!({ "sessionId": &session_id, "exitCode": exit_code }),
                    );
                    let id2 = session_id.clone();
                    let tmux_for_kill = tmux.clone();
                    let _ =
                        tokio::task::spawn_blocking(move || tmux_for_kill.kill_session(&id2)).await;
                    let state: tauri::State<'_, AppHandleState> = app.state();
                    let removed = match state.terminals.lock() {
                        Ok(mut reg) => reg.remove(&session_id),
                        Err(e) => {
                            tracing::warn!(
                                session_id = %session_id,
                                error = %e,
                                "terminal monitor: terminals lock poisoned during cleanup"
                            );
                            None
                        }
                    };
                    if let Some(entry) = removed {
                        shutdown_removed_entry(entry, false);
                    }
                    cleanup_harness_session(&state, &session_id);
                    emit_terminal_session_removed(&app, &session_id);
                    emit_agent_session_removed(&app, &session_id);
                    break;
                }
                Ok(Ok(None)) => { /* pane still alive — keep polling */ }
                _ => break, // session killed externally (terminal_kill) or I/O error
            }
        }
    })
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
    start_monitor: bool,
) -> Result<(), String> {
    let app_handle = app.clone();
    let (pane_context_dirty_tx, context_task) = if matches!(kind, AgentKind::Shell) {
        (None, None)
    } else {
        let (dirty_tx, task) =
            spawn_pane_context_monitor(app.clone(), tmux.clone(), session_id.clone());
        (Some(dirty_tx), Some(task))
    };
    let (bridge, bridge_output_cancelled) = open_bridge_and_monitor(
        app,
        tmux.clone(),
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

    let monitor_task = start_monitor
        .then(|| spawn_pane_death_monitor(app_handle.clone(), tmux, session_id.clone()));
    let entry = TerminalEntry {
        session_id: session_id.clone(),
        project_slug,
        worktree_id,
        kind,
        created_unix: now_unix_secs(),
        bridge,
        bridge_output_cancelled,
        monitor_task,
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

#[derive(Debug, Clone, Deserialize)]
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
    /// Compatibility-only repair mode. Public frontend reattach calls leave
    /// this false so `terminal_reattach` is bridge-only; recovery wrappers set
    /// it while routing through the shared attach-then-provider-replay path.
    #[serde(default)]
    pub resume_after_attach: bool,
    /// Optional override for resume-after-attach snapshot replay. `None`
    /// means use the backend's per-harness default. Cmd+R sets this false
    /// because the current xterm instance already owns the best scrollback;
    /// startup Codex reattach leaves it unset so tmux scrollback is replayed
    /// into the new xterm before `codex resume` starts.
    #[serde(default)]
    pub replay_before_resume: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[allow(dead_code)]
#[serde(rename_all = "kebab-case")]
pub enum ReconnectHistoryStatus {
    LiveBridge,
    ProviderReplay,
    DeferredProviderReplay,
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconnectResult {
    pub session_id: String,
    pub history_status: ReconnectHistoryStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl ReconnectResult {
    fn live_bridge(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            history_status: ReconnectHistoryStatus::LiveBridge,
            message: None,
        }
    }

    fn provider_replay(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            history_status: ReconnectHistoryStatus::ProviderReplay,
            message: None,
        }
    }

    fn unavailable(session_id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            history_status: ReconnectHistoryStatus::Unavailable,
            message: Some(message.into()),
        }
    }
}

#[derive(Debug, Clone)]
struct ResumeTarget {
    command: String,
    cwd: Option<String>,
    harness_session_id: String,
    opencode_port: Option<u16>,
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

fn tracked_session_harness_id(state: &AppHandleState, session_id: &str) -> Option<String> {
    state
        .config_store
        .lock()
        .ok()
        .and_then(|store| store.last_session_harness_id(session_id))
}

fn tracked_session_last_prompt(state: &AppHandleState, session_id: &str) -> Option<String> {
    state
        .config_store
        .lock()
        .ok()
        .and_then(|store| store.last_session_prompt(session_id))
        .map(|(prompt, _)| prompt)
}

fn resolve_harness_extra_flags(state: &AppHandleState, kind: AgentKind) -> Option<String> {
    let store = state.config_store.lock().expect("config store poisoned");
    store
        .read_config()
        .ok()
        .and_then(|cfg| match kind {
            AgentKind::ClaudeCode => cfg.harnesses.claude_code.extra_flags,
            AgentKind::Codex => cfg.harnesses.codex.extra_flags,
            AgentKind::OpenCode => cfg.harnesses.opencode.extra_flags,
            AgentKind::Shell => None,
        })
        .filter(|s| !s.trim().is_empty())
}

async fn resolve_resume_target(
    state: &AppHandleState,
    tmux: &Arc<TmuxManager>,
    session_id: &str,
    kind: AgentKind,
    extra_flags: Option<&str>,
) -> Result<ResumeTarget, String> {
    if matches!(kind, AgentKind::Shell) {
        return Err("shell panes do not support provider resume".to_string());
    }

    let persisted_port = tracked_session_opencode_port(state, session_id);
    let opencode_port: Option<u16> = if matches!(kind, AgentKind::OpenCode) {
        Some(match extra_flags.and_then(parse_opencode_port_arg) {
            Some(explicit) => explicit,
            None => persisted_port.unwrap_or(reserve_localhost_port()?),
        })
    } else {
        None
    };

    let respawn_cwd = resolve_harness_respawn_cwd(tmux, state, session_id).await;
    let resume_id = match tracked_session_harness_id(state, session_id) {
        Some(id) => id,
        None => {
            let cwd = respawn_cwd
                .as_deref()
                .map(PathBuf::from)
                .ok_or_else(|| format!("no provider resume id persisted for {kind:?}"))?;
            let prompt = tracked_session_last_prompt(state, session_id)
                .ok_or_else(|| format!("no provider resume id or prompt persisted for {kind:?}"))?;
            let home_dir = dirs::home_dir()
                .ok_or_else(|| "cannot discover provider resume id without HOME".to_string())?;
            let discovered = discover_session_id_by_prompt(kind, &cwd, &home_dir, &prompt)
                .ok_or_else(|| {
                    format!(
                        "no provider resume id persisted for {kind:?}, and no transcript matched this pane's last prompt"
                    )
                })?;
            if let Ok(store) = state.config_store.lock()
                && let Err(e) = store.update_session_harness_id(
                    session_id,
                    kind,
                    &discovered,
                    now_unix_millis(),
                )
            {
                tracing::warn!(
                    session_id = %session_id,
                    kind = ?kind,
                    error = %e,
                    "resolve_resume_target: failed to persist discovered provider resume id",
                );
            }
            tracing::info!(
                session_id = %session_id,
                kind = ?kind,
                harness_session_id = %discovered,
                cwd = %cwd.display(),
                "resolve_resume_target: discovered provider resume id from last prompt",
            );
            discovered
        }
    };
    if matches!(kind, AgentKind::ClaudeCode | AgentKind::Codex)
        && let Some(cwd) = respawn_cwd.as_deref().map(PathBuf::from)
        && let Some(home_dir) = dirs::home_dir()
        && !harness_session_id_matches_cwd(kind, &cwd, &home_dir, &resume_id)
    {
        return Err(format!(
            "persisted provider resume id for {kind:?} does not match this pane cwd {}; refusing to resume the wrong session",
            cwd.display()
        ));
    }

    let command = harness_resume_command(kind, extra_flags, opencode_port, &resume_id)
        .ok_or_else(|| format!("no provider resume command available for {kind:?}"))?;

    Ok(ResumeTarget {
        command,
        cwd: respawn_cwd,
        harness_session_id: resume_id,
        opencode_port,
    })
}

struct ReattachInFlightGuard<'a> {
    terminals: &'a Mutex<TerminalRegistry>,
    session_id: String,
}

impl Drop for ReattachInFlightGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut reg) = self.terminals.lock() {
            reg.finish_reattach(&self.session_id);
        }
    }
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
) -> Result<ReconnectResult, String> {
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
        if !args.resume_after_attach {
            return Ok(ReconnectResult::unavailable(
                session_id,
                "tmux session is missing; no provider replay was requested",
            ));
        }
        if matches!(args.kind, AgentKind::Shell) {
            return Ok(ReconnectResult::unavailable(
                session_id,
                "shell history is unavailable because the tmux session is missing",
            ));
        }

        let extra_flags = resolve_harness_extra_flags(&state, args.kind);
        if let Err(err) = resolve_resume_target(
            &state,
            &tmux,
            &session_id,
            args.kind,
            extra_flags.as_deref(),
        )
        .await
        {
            return Ok(ReconnectResult::unavailable(session_id, err));
        }

        let (tracked_project_slug, tracked_worktree_id) =
            tracked_session_context(&state, &session_id);
        let (spawn_project_slug, spawn_worktree_id) = resolve_reattach_context(
            (args.project_slug.as_deref(), args.worktree_id.as_deref()),
            (None, None),
            (None, None),
            (
                tracked_project_slug.as_deref(),
                tracked_worktree_id.as_deref(),
            ),
        );
        let cwd = resolve_spawn_cwd(
            &state,
            None,
            spawn_project_slug.as_deref(),
            spawn_worktree_id.as_deref(),
        );
        let initial_size = sanitize_initial_size(args.cols, args.rows);
        let raum_session_value = session_id.clone();
        let raum_event_sock_value: Option<String> = state
            .event_socket
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|h| h.path.to_string_lossy().into_owned()));
        let tmux_for_new = tmux.clone();
        let id_for_new = session_id.clone();
        tokio::task::spawn_blocking(move || {
            let mut env_pairs: Vec<(&str, &str)> =
                vec![(raum_hooks::RAUM_SESSION_ENV, raum_session_value.as_str())];
            if let Some(p) = raum_event_sock_value.as_deref() {
                env_pairs.push((raum_hooks::RAUM_EVENT_SOCK_ENV, p));
            }
            tmux_for_new.new_session_with_env(
                &id_for_new,
                &cwd,
                Some("placeholder"),
                initial_size,
                &env_pairs,
            )
        })
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
        .map_err(|e| format!("tmux new-session: {e}"))?;
    }

    let provider_replay_requested =
        args.resume_after_attach && !matches!(args.kind, AgentKind::Shell);
    if provider_replay_requested {
        let extra_flags = resolve_harness_extra_flags(&state, args.kind);
        if let Err(err) = resolve_resume_target(
            &state,
            &tmux,
            &session_id,
            args.kind,
            extra_flags.as_deref(),
        )
        .await
        {
            return Ok(ReconnectResult::unavailable(session_id, err));
        }
    }

    {
        let tmux_for_history = tmux.clone();
        let id_for_history = session_id.clone();
        tokio::task::spawn_blocking(move || {
            tmux_for_history.set_history_limit(&id_for_history, XTERM_SCROLLBACK_LINES);
        })
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?;
    }

    let _reattach_guard = {
        let mut reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        if !reg.begin_reattach(&session_id) {
            tracing::debug!(
                session_id = %session_id,
                "terminal_reattach: duplicate request ignored while attach is in flight"
            );
            return Err("reattach-in-flight".to_string());
        }
        ReattachInFlightGuard {
            terminals: &state.terminals,
            session_id: session_id.clone(),
        }
    };

    // Shut down the stale bridge on the existing registry entry WITHOUT
    // removing it. The entry stays visible to `terminal_list` for the
    // duration of the reattach, so the top-row counters don't flash to
    // zero during webview reload. Webview-reload path: Rust survives; the old reader
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
    let resume_after_attach = provider_replay_requested;

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

    // Resize tmux before replaying a snapshot. Otherwise a restart into a
    // larger window first paints the old, smaller tmux surface and only fixes
    // itself once the live attached client catches up.
    {
        let tmux_for_resize = tmux.clone();
        let id_for_resize = session_id.clone();
        match tokio::task::spawn_blocking(move || {
            tmux_for_resize.resize(&id_for_resize, u32::from(cols), u32::from(rows))
        })
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!(
                session_id = %session_id,
                error = %e,
                "terminal_reattach: pre-snapshot resize failed"
            ),
            Err(e) => tracing::warn!(
                session_id = %session_id,
                error = %e,
                "terminal_reattach: pre-snapshot resize task failed"
            ),
        }
    }

    if resume_after_attach {
        let cmd = match respawn_harness_pane_in_place(&tmux, &state, &session_id, args.kind, true)
            .await
        {
            Ok(cmd) => cmd,
            Err(err) => {
                if let Some(task) = context_task.as_ref() {
                    task.abort();
                }
                return Err(err);
            }
        };
        tracing::info!(
            session_id = %session_id,
            kind = ?args.kind,
            cmd = %cmd,
            "terminal_reattach: resumed harness before bridge attach",
        );
    }

    // Replay tmux state into xterm.js before the live client attaches.
    // Sending here (before `open_bridge_and_monitor` opens the live PTY
    // bridge) preserves ordering on the same `Channel<Raw>`: replay bytes
    // always land before any live bytes for this reattach.
    //
    // The capture mode depends on `kind × is_alternate_on`:
    //
    // - Shell panes → full snapshot (capped at `history-limit`, currently
    //   matching `frontend/src/lib/scrollbackConfig.ts SCROLLBACK_MAX`).
    //   Plain command output makes a clean scrollback record.
    //
    // - Codex and alt-screen TUIs (`vim`, `htop`, …) → full snapshot. Codex
    //   runs with `--no-alt-screen` under raum specifically so its chat can
    //   live in normal scrollback; replaying only the viewport would discard
    //   the history Cmd+R/startup are trying to preserve. For true alt-screen
    //   panes, `capture_pane_snapshot` cleanly separates the visible alt frame
    //   from underlying normal scrollback.
    //
    // - Provider replay (`resume_after_attach`) → full snapshot. The harness
    //   has just rendered its provider-owned transcript into tmux while no
    //   xterm bridge was attached, so this capture becomes the deterministic
    //   first frame for xterm scrollback before the live client attaches.
    //
    // - Non-alt-screen Ink-style TUIs during bridge-only attach (Claude Code,
    //   OpenCode rendering without alt-screen) → viewport snapshot. Provider
    //   replay is the only supported full-history path for these harnesses, but
    //   a fresh xterm still needs the current tmux frame immediately after app
    //   restart; otherwise the pane stays blank until the TUI happens to redraw.
    {
        let tmux_for_capture = tmux.clone();
        let id_for_capture = session_id.clone();
        let viewport_rows = rows;
        let reattach_kind = args.kind;
        match tokio::task::spawn_blocking(move || {
            let alt_on = tmux_for_capture
                .is_alternate_on(&id_for_capture)
                .unwrap_or(false);
            let prefer_full = resume_after_attach
                || matches!(reattach_kind, AgentKind::Shell | AgentKind::Codex)
                || alt_on;
            if prefer_full {
                tmux_for_capture.capture_pane_snapshot(&id_for_capture)
            } else {
                tmux_for_capture.capture_pane_view_snapshot(&id_for_capture, viewport_rows)
            }
        })
        .await
        {
            Ok(Ok(snapshot)) => {
                let replay = build_snapshot_replay(snapshot);
                if replay.is_empty() {
                    // Nothing to restore.
                } else if on_data.send(InvokeResponseBody::Raw(replay)).is_err() {
                    tracing::warn!(
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
    let (bridge, bridge_output_cancelled) = match open_bridge_and_monitor(
        app,
        tmux.clone(),
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
    let monitor_task = Some(spawn_pane_death_monitor(
        app_handle.clone(),
        tmux.clone(),
        session_id.clone(),
    ));

    // Land the fresh handles: replace on the existing entry (webview reload)
    // or insert a brand-new one (full app restart — the
    // backend started empty so `detach_bridge` returned false).
    let item = {
        let mut reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        if had_entry {
            let runtime = BridgeRuntime {
                bridge,
                bridge_output_cancelled,
                monitor_task,
                context_task,
            };
            if !reg.replace_bridge(&session_id, runtime, cols, rows) {
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
                bridge_output_cancelled,
                monitor_task,
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

    if resume_after_attach {
        Ok(ReconnectResult::provider_replay(session_id))
    } else {
        Ok(ReconnectResult::live_bridge(session_id))
    }
}

/// Build the launch command for a harness respawn and run
/// `tmux respawn-pane -k` against the pane. Caller MUST have already
/// confirmed the pane is dead (or actively wants to kill what's there —
/// only `terminal_self_heal` does that).
///
/// When `prefer_resume` is true and a `harness_session_id` is persisted,
/// we first try `<harness> --resume <id>` so the harness rehydrates its
/// own conversation state from the on-disk session log. After the
/// `respawn-pane -k` returns, we wait briefly and verify the new pane
/// is still alive — if `--resume` exits during the grace window (stale id,
/// auto-update prompt, MCP server failure, version mismatch, etc.), we
/// return an explicit error and keep the pane identity for retry. We only use
/// the fresh-launch branch when the caller did not request provider resume.
///
/// Returns the command that was actually used, for logging.
async fn respawn_harness_pane_in_place(
    tmux: &Arc<TmuxManager>,
    state: &tauri::State<'_, AppHandleState>,
    session_id: &str,
    kind: AgentKind,
    prefer_resume: bool,
) -> Result<String, String> {
    let extra_flags = resolve_harness_extra_flags(state, kind);
    let fresh_cmd = harness_launch_command(kind, extra_flags.as_deref(), None)
        .ok_or_else(|| "no launch command derivable for this kind".to_string())?;
    let resume_target = if prefer_resume {
        Some(resolve_resume_target(state, tmux, session_id, kind, extra_flags.as_deref()).await?)
    } else {
        None
    };

    // Try --resume first if available; verify the pane survives a brief
    // grace window. If it doesn't, return an explicit error. We do not
    // silently substitute a fresh harness because that creates an empty chat
    // under the same raum pane identity and hides the history failure.
    if let Some(target) = resume_target {
        let cmd = target.command.clone();
        tracing::info!(
            session_id = %session_id,
            kind = ?kind,
            cmd = %cmd,
            cwd = target.cwd.as_deref().unwrap_or("<tmux-default>"),
            harness_session_id = %target.harness_session_id,
            opencode_port = ?target.opencode_port,
            "respawn_harness_pane_in_place: attempting --resume",
        );
        let tmux_for_respawn = tmux.clone();
        let id_for_respawn = session_id.to_string();
        let cmd_for_respawn = cmd.clone();
        let cwd_for_respawn = target.cwd.clone();
        tokio::task::spawn_blocking(move || {
            tmux_for_respawn.respawn_with_cwd(
                &id_for_respawn,
                &cmd_for_respawn,
                cwd_for_respawn.as_deref(),
            )
        })
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
        .map_err(|e| format!("tmux respawn-pane: {e}"))?;

        // Grace window. The new harness needs a moment to parse args,
        // fork its MCP children, open its session log, etc. Anything
        // that exits during this window is almost certainly a startup
        // failure (stale id, version mismatch, auto-update prompt,
        // missing config) — bail out and try fresh instead of leaving
        // the user with a `[lost tty]` corpse.
        //
        // We poll every 100 ms up to 1500 ms total: detects a quick
        // exit within ~100 ms while still committing fast for a
        // healthy --resume that took longer than expected to settle.
        const GRACE_TOTAL_MS: u64 = 1500;
        const GRACE_POLL_MS: u64 = 100;
        let grace_start = std::time::Instant::now();
        let grace_total = std::time::Duration::from_millis(GRACE_TOTAL_MS);
        let grace_poll = std::time::Duration::from_millis(GRACE_POLL_MS);
        let resume_died: Option<i32>;
        loop {
            let dead = {
                let tmux_for_check = tmux.clone();
                let id_for_check = session_id.to_string();
                tokio::task::spawn_blocking(move || tmux_for_check.check_pane_dead(&id_for_check))
                    .await
                    .map_err(|e| format!("spawn_blocking join: {e}"))?
            };
            match dead {
                Ok(Some(exit_code)) => {
                    resume_died = Some(exit_code);
                    break;
                }
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!(
                        session_id = %session_id,
                        error = %e,
                        "respawn_harness_pane_in_place: pane-dead probe failed during --resume grace, assuming alive",
                    );
                    return Ok(cmd);
                }
            }
            if grace_start.elapsed() >= grace_total {
                // Survived the full window — commit.
                tracing::info!(
                    session_id = %session_id,
                    kind = ?kind,
                    elapsed_ms = grace_start.elapsed().as_millis() as u64,
                    "respawn_harness_pane_in_place: --resume pane alive after grace, committing",
                );
                return Ok(cmd);
            }
            tokio::time::sleep(grace_poll).await;
        }
        if let Some(exit_code) = resume_died {
            tracing::error!(
                session_id = %session_id,
                kind = ?kind,
                exit_code,
                cmd = %cmd,
                elapsed_ms = grace_start.elapsed().as_millis() as u64,
                "respawn_harness_pane_in_place: --resume exited during grace window",
            );
            return Err(format!(
                "provider resume exited early (code {exit_code}); pane kept on the same session for retry"
            ));
        }
    }

    let respawn_cwd = resolve_harness_respawn_cwd(tmux, state, session_id).await;
    // Fresh-launch path: either no resume id was available, or --resume
    // failed and we're falling back. Do the respawn-pane -k with the
    // fresh command and verify the pane survives a brief grace window
    // — if even fresh launch dies on us (binary missing, malformed
    // config, etc.), return Err so the caller can surface this through
    // the dead-pane overlay rather than letting tmux print `[lost tty]`
    // into the user's xterm.
    tracing::info!(
        session_id = %session_id,
        kind = ?kind,
        cmd = %fresh_cmd,
        cwd = respawn_cwd.as_deref().unwrap_or("<tmux-default>"),
        "respawn_harness_pane_in_place: respawning with fresh launch",
    );
    let tmux_for_respawn = tmux.clone();
    let id_for_respawn = session_id.to_string();
    let cmd_for_respawn = fresh_cmd.clone();
    let cwd_for_respawn = respawn_cwd.clone();
    tokio::task::spawn_blocking(move || {
        tmux_for_respawn.respawn_with_cwd(
            &id_for_respawn,
            &cmd_for_respawn,
            cwd_for_respawn.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
    .map_err(|e| format!("tmux respawn-pane: {e}"))?;

    // Same active poll as the --resume path, shorter window since fresh
    // launch should come up quickly.
    const FRESH_GRACE_MS: u64 = 800;
    const FRESH_POLL_MS: u64 = 100;
    let grace_start = std::time::Instant::now();
    let grace_total = std::time::Duration::from_millis(FRESH_GRACE_MS);
    let grace_poll = std::time::Duration::from_millis(FRESH_POLL_MS);
    loop {
        let dead = {
            let tmux_for_check = tmux.clone();
            let id_for_check = session_id.to_string();
            tokio::task::spawn_blocking(move || tmux_for_check.check_pane_dead(&id_for_check))
                .await
                .map_err(|e| format!("spawn_blocking join: {e}"))?
        };
        match dead {
            Ok(Some(exit_code)) => {
                tracing::error!(
                    session_id = %session_id,
                    kind = ?kind,
                    exit_code,
                    cmd = %fresh_cmd,
                    "respawn_harness_pane_in_place: fresh launch ALSO exited during grace window — likely missing binary or config issue",
                );
                return Err(format!(
                    "fresh respawn died (code {exit_code}); run `{fresh_cmd}` manually to see why"
                ));
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(
                    session_id = %session_id,
                    error = %e,
                    "respawn_harness_pane_in_place: pane-dead probe failed during fresh grace, assuming alive",
                );
                break;
            }
        }
        if grace_start.elapsed() >= grace_total {
            break;
        }
        tokio::time::sleep(grace_poll).await;
    }
    Ok(fresh_cmd)
}

/// Revive a dead tmux pane in place: re-run the harness command in the
/// same session id, then attach a fresh PTY bridge.
///
/// The frontend invokes this from the Recover overlay shown on a
/// `dead: true` ghost (rehydrated dead pane) or after a
/// `terminal:process-exited` event for a harness session. The command:
///
/// 1. Verifies the tmux pane really is dead via `check_pane_dead`
///    (otherwise the user's still-live harness would be replaced).
/// 2. Hands off to `terminal_reattach` in attach-then-resume mode.
///    The PTY bridge is opened first, then `tmux respawn-pane -k`
///    runs the harness resume command so xterm captures the full
///    history repaint.
#[tauri::command]
pub async fn terminal_respawn_dead<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    mut args: ReattachArgs,
    on_data: Channel<InvokeResponseBody>,
) -> Result<ReconnectResult, String> {
    let tmux: Arc<TmuxManager> = state.tmux.clone();
    let session_id = args.session_id.clone();

    // Step 1 — verify the pane really is dead. If the harness happens
    // to be alive (race after the frontend last looked) we bail out so
    // the user's existing process isn't kill-respawned.
    let pane_dead = {
        let tmux_for_check = tmux.clone();
        let id_for_check = session_id.clone();
        tokio::task::spawn_blocking(move || tmux_for_check.check_pane_dead(&id_for_check))
            .await
            .map_err(|e| format!("spawn_blocking join: {e}"))?
    };
    let pane_dead = match pane_dead {
        Ok(status) => status,
        Err(e) if !matches!(args.kind, AgentKind::Shell) => {
            tracing::warn!(
                session_id = %session_id,
                error = %e,
                "terminal_respawn_dead: pane check failed; trying provider replay recovery",
            );
            args.resume_after_attach = true;
            args.replay_before_resume = Some(false);
            return terminal_reattach(app, state, args, on_data).await;
        }
        Err(e) => return Err(format!("tmux check pane: {e}")),
    };
    if pane_dead.is_none() && !matches!(args.kind, AgentKind::Shell) {
        // Pane is alive but the frontend asked us to respawn — pass
        // through to reattach so the user's pane keeps working.
        return terminal_reattach(app, state, args, on_data).await;
    }

    // Shells have no command — fall through to reattach so the
    // existing exit overlay surfaces the dead-pane state.
    if matches!(args.kind, AgentKind::Shell) {
        return terminal_reattach(app, state, args, on_data).await;
    }

    // Step 2 — hand off to the standard reattach path in attach-then-resume
    // mode. The bridge must be streaming before the resume command starts;
    // otherwise the harness reconstructs its chat history into tmux while
    // xterm is not listening, and the frontend only sees the final viewport.
    args.resume_after_attach = true;
    terminal_reattach(app, state, args, on_data).await
}

/// Force-repair a live harness pane (the Cmd+R "self-heal" path).
///
/// Cmd+R keeps the raum/tmux session id stable. The frontend tab, terminal
/// store, hook state, and tmux window all use that id as their identity; making
/// refresh allocate a replacement id leaves too many windows where one layer
/// has switched while another is still writing to the old channel. The repair
/// flow is therefore:
///
/// 1. Validate the harness can launch in the tracked project context.
/// 2. Reattach through the standard `terminal_reattach` path in
///    attach-then-resume mode.
/// 3. Skip tmux snapshot replay, open a fresh PTY bridge, then run
///    `respawn-pane -k` with the persisted harness resume id when available.
#[tauri::command]
pub async fn terminal_self_heal<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    mut args: ReattachArgs,
    on_data: Channel<InvokeResponseBody>,
) -> Result<ReconnectResult, String> {
    if matches!(args.kind, AgentKind::Shell) {
        return terminal_reattach(app, state, args, on_data).await;
    }

    let session_id = args.session_id.clone();

    let (cols, rows) = match args.cols.zip(args.rows) {
        Some((c, r)) => clamp_pty_dims(c, r),
        None => (200, 50),
    };

    let (tracked_project_slug, tracked_worktree_id) = tracked_session_context(&state, &session_id);
    let (effective_project_slug, effective_worktree_id) = resolve_reattach_context(
        (args.project_slug.as_deref(), args.worktree_id.as_deref()),
        (None, None),
        (None, None),
        (
            tracked_project_slug.as_deref(),
            tracked_worktree_id.as_deref(),
        ),
    );
    let project_dir = resolve_project_dir(
        &state,
        effective_project_slug.as_deref(),
        effective_worktree_id.as_deref(),
    );
    if effective_project_slug.is_none() || project_dir.as_os_str().is_empty() {
        return Err("harness self-heal requires a registered project".to_string());
    }

    let launch_report = prepare_harness_launch_fast(
        &app,
        &state,
        args.kind,
        effective_project_slug.as_deref(),
        project_dir.clone(),
    )?;
    if launch_report.binary_missing {
        return Err(format!(
            "binary `{}` not found on PATH",
            launch_report.binary
        ));
    }
    spawn_harness_launch_refresh(
        app.clone(),
        args.kind,
        effective_project_slug.clone(),
        project_dir.clone(),
    );

    tracing::info!(
        session_id = %session_id,
        kind = ?args.kind,
        cols,
        rows,
        "terminal_self_heal: reattaching bridge before harness resume",
    );

    args.resume_after_attach = true;
    args.replay_before_resume = Some(false);
    terminal_reattach(app, state, args, on_data).await
}

/// Replay provider-owned history for a harness pane without changing its raum
/// session id. This is the explicit recovery path used after a bridge-only
/// reconnect once the pane is known not to be Working/Waiting.
#[tauri::command]
pub async fn terminal_provider_replay<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    mut args: ReattachArgs,
    on_data: Channel<InvokeResponseBody>,
) -> Result<ReconnectResult, String> {
    if matches!(args.kind, AgentKind::Shell) {
        return Ok(ReconnectResult::unavailable(
            args.session_id,
            "shell panes do not support provider replay",
        ));
    }
    args.resume_after_attach = true;
    args.replay_before_resume = Some(false);
    terminal_reattach(app, state, args, on_data).await
}

/// Look up the persisted OpenCode port for a session, if any. Used by
/// the revival path to prefer the previous port when respawning.
fn tracked_session_opencode_port(state: &AppHandleState, session_id: &str) -> Option<u16> {
    let store = state.config_store.lock().ok()?;
    let sessions = store.read_sessions().ok()?;
    sessions
        .sessions
        .iter()
        .find(|s| s.session_id == session_id)
        .and_then(|s| s.opencode_port)
}

#[tauri::command]
pub async fn terminal_kill<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    session_id: String,
) -> Result<(), String> {
    kill_session_interactive(&app, &state, &session_id)
}

/// Interactive pane/tab close path. The UI must become usable immediately even
/// if tmux or an attached client is slow to die, so raum's own registries are
/// detached synchronously and the tmux kill runs in the background.
fn kill_session_interactive<R: Runtime>(
    app: &AppHandle<R>,
    state: &tauri::State<'_, AppHandleState>,
    session_id: &str,
) -> Result<(), String> {
    let removed = {
        let mut reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        reg.remove(session_id)
    };
    if let Some(entry) = removed {
        shutdown_removed_entry(entry, true);
    }

    cleanup_harness_session(state, session_id);
    emit_terminal_session_removed(app, session_id);
    emit_agent_session_removed(app, session_id);

    let tmux = state.tmux.clone();
    let id = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        let kill_id = id.clone();
        let kill_res = tokio::task::spawn_blocking(move || tmux.kill_session(&kill_id)).await;
        match kill_res {
            Ok(Ok(())) => {}
            Ok(Err(TmuxError::NonZero { stderr, .. })) if is_session_not_found(&stderr) => {}
            Ok(Err(e)) => {
                tracing::warn!(session_id = %id, error = %e, "terminal_kill: background tmux kill failed");
            }
            Err(e) => {
                tracing::warn!(session_id = %id, error = %e, "terminal_kill: background tmux kill join failed");
            }
        }
    });

    Ok(())
}

/// Shared implementation of [`terminal_kill`] usable from other commands
/// (`worktree_remove`, `project_remove`) that need to fold the per-session
/// kill loop into a single backend call so they can stream progress over a
/// `Channel<ProgressEvent>` instead of round-tripping through the FE.
pub(crate) async fn kill_session_inner<R: Runtime>(
    app: &AppHandle<R>,
    state: &tauri::State<'_, AppHandleState>,
    session_id: &str,
) -> Result<(), String> {
    let tmux = state.tmux.clone();
    let id = session_id.to_string();
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
        reg.remove(session_id)
    };
    if let Some(entry) = removed {
        // Abort the monitor first so it can't fire a spurious process-exited
        // event after an explicit kill.
        shutdown_removed_entry(entry, true);
    }

    cleanup_harness_session(state, session_id);
    emit_terminal_session_removed(app, session_id);
    emit_agent_session_removed(app, session_id);

    // Idempotent: callers (Cmd+R, X-button) can race the pane-death monitor or
    // each other. If tmux already reaped the session, treat it as success — we
    // already cleaned up our side above.
    match kill_res {
        Ok(()) => Ok(()),
        Err(TmuxError::NonZero { stderr, .. }) if is_session_not_found(&stderr) => {
            tracing::debug!(
                session_id = %session_id,
                "terminal_kill: session already gone in tmux, treating as success"
            );
            Ok(())
        }
        Err(e) => Err(format!("tmux kill-session: {e}")),
    }
}

/// Snapshot the live + ghost session ids whose `worktree_id` matches `path`.
/// Returns an empty Vec on lock errors so callers degrade to "delete the
/// worktree anyway"; the FE used to do the same loop best-effort.
pub(crate) fn sessions_for_worktree(
    state: &tauri::State<'_, AppHandleState>,
    worktree_path: &str,
) -> Vec<String> {
    state
        .terminals
        .lock()
        .map(|reg| {
            reg.list()
                .into_iter()
                .filter(|t| t.worktree_id.as_deref() == Some(worktree_path))
                .map(|t| t.session_id)
                .collect()
        })
        .unwrap_or_default()
}

/// Snapshot the session ids tagged with `project_slug`. Sibling of
/// [`sessions_for_worktree`] used by `project_remove`.
pub(crate) fn sessions_for_project(
    state: &tauri::State<'_, AppHandleState>,
    project_slug: &str,
) -> Vec<String> {
    state
        .terminals
        .lock()
        .map(|reg| {
            reg.list()
                .into_iter()
                .filter(|t| t.project_slug.as_deref() == Some(project_slug))
                .map(|t| t.session_id)
                .collect()
        })
        .unwrap_or_default()
}

/// tmux's `kill-session` exits non-zero when the target session doesn't exist.
/// Different tmux versions phrase the error slightly differently — match the
/// substrings we've observed in the wild rather than an exact string.
fn is_session_not_found(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("can't find session")
        || s.contains("session not found")
        || s.contains("no such session")
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
            dead: false,
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

#[tauri::command]
pub async fn terminal_pane_context_batch(
    state: tauri::State<'_, AppHandleState>,
    session_ids: Vec<String>,
) -> Result<HashMap<String, PaneContextPayload>, String> {
    let tmux = state.tmux.clone();
    let res = tokio::task::spawn_blocking(move || {
        let mut out = HashMap::with_capacity(session_ids.len());
        for session_id in session_ids {
            let ctx = tmux.pane_context(&session_id).unwrap_or_default();
            out.insert(session_id, ctx.into());
        }
        out
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?;
    Ok(res)
}

/// One-shot orphan reaper: kills any tmux session on the `-L raum` socket
/// that is NOT in the live `TerminalRegistry` AND NOT in `sessions.toml`,
/// provided it has aged past a 30-second floor (so we can't race a
/// freshly-spawned session whose registry insert / config debounce hasn't
/// completed yet). Surfaces the user's "23 idle harnesses while I see 8"
/// case: pre-fix Cmd+R could leak tmux windows, and the only way to recover
/// without restarting was to hand-run `tmux -L raum kill-session`.
///
/// Returns the list of session ids that were killed.
#[tauri::command]
pub async fn terminal_kill_orphans(
    state: tauri::State<'_, AppHandleState>,
) -> Result<Vec<String>, String> {
    kill_orphans_inner(&state).await
}

/// Shared body for [`terminal_kill_orphans`]. Lives here so the boot-time
/// reap, the periodic sweep, and the window-focus trigger in `lib.rs` can
/// run the same code path as the manual UI button without needing an IPC
/// round-trip. Each leaked tmux session holds ~10–20 fds (PTY master +
/// client pipes + hook IPC), so under load this is the main lever we have
/// to keep `EMFILE` from breaking the git watcher and other background
/// IO.
pub(crate) async fn kill_orphans_inner(
    state: &tauri::State<'_, AppHandleState>,
) -> Result<Vec<String>, String> {
    const ORPHAN_AGE_FLOOR_SECS: u64 = 30;

    let tmux = state.tmux.clone();
    let live = {
        let tmux = tmux.clone();
        tokio::task::spawn_blocking(move || tmux.list_sessions())
            .await
            .map_err(|e| format!("spawn_blocking join: {e}"))?
            .map_err(|e| format!("tmux list-sessions: {e}"))?
    };

    let mut tracked: HashSet<String> = HashSet::new();
    {
        let reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        for item in reg.list() {
            tracked.insert(item.session_id);
        }
    }
    {
        let store = state
            .config_store
            .lock()
            .map_err(|e| format!("config_store lock: {e}"))?;
        if let Ok(persisted) = store.read_sessions() {
            for row in persisted.sessions {
                tracked.insert(row.session_id);
            }
        }
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());

    let mut killed = Vec::new();
    for s in live {
        if tracked.contains(&s.id) {
            continue;
        }
        if s.created_unix == 0 {
            // tmux didn't report a creation timestamp — be conservative.
            continue;
        }
        let age = now.saturating_sub(s.created_unix);
        if age < ORPHAN_AGE_FLOOR_SECS {
            continue;
        }
        let kill_id = s.id.clone();
        let kill_tmux = tmux.clone();
        let kill_res = tokio::task::spawn_blocking(move || kill_tmux.kill_session(&kill_id))
            .await
            .map_err(|e| format!("spawn_blocking join: {e}"))?;
        if kill_res.is_ok() {
            tracing::info!(session_id = %s.id, age_secs = age, "killed orphan tmux session");
            killed.push(s.id);
        } else if let Err(e) = kill_res {
            tracing::warn!(session_id = %s.id, error = %e, "orphan kill failed");
        }
    }

    Ok(killed)
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
