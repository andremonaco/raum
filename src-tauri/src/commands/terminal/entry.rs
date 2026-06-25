//! Per-session [`TerminalEntry`] handle, IPC argument types, and the
//! event emitters that broadcast registry changes to the webview.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use raum_core::AgentKind;
use raum_core::harness::ModelOverride;
use raum_tmux::{PaneContext, TerminalBridge};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::task::JoinHandle;

use super::registry::TerminalListItem;
use super::{
    AGENT_SESSION_REMOVED_EVENT, TERMINAL_PANE_CONTEXT_CHANGED_EVENT,
    TERMINAL_SESSION_REMOVED_EVENT, TERMINAL_SESSION_REPLACED_EVENT,
    TERMINAL_SESSION_UPSERTED_EVENT,
};

/// Per-session handles kept alive for the duration of the terminal. Dropping
/// the entry kills the attached tmux client and frees its OS threads.
pub struct TerminalEntry {
    pub session_id: String,
    pub project_slug: Option<String>,
    pub worktree_id: Option<String>,
    pub kind: AgentKind,
    pub created_unix: u64,
    /// Attached tmux client (control-mode by default, PTY-wrapped legacy
    /// fallback). Cloning the handle is cheap (Arc bump); the bridge tears
    /// down when the last clone drops.
    pub bridge: TerminalBridge,
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
            recoverable_after_reboot: false,
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
    /// Optional one-shot model + effort override layered on top of the
    /// user's global `extra_flags`. Only set by the cross-review picker.
    /// User-pinned conflicting flags in `extra_flags` win.
    #[serde(default)]
    pub model_override: Option<ModelOverride>,
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
    /// it to attach/register a fresh PTY bridge first, then run the harness
    /// provider resume command through the live bridge.
    #[serde(default)]
    pub resume_after_attach: bool,
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
    pub replaced_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// True only on the `Unavailable` path when the session still has a
    /// tracked row carrying harness resume state (i.e. the conversation
    /// could be recovered later via the Recover overlay), but this attempt
    /// could not bring it back right now. The frontend uses this to render
    /// the Recover overlay + replay the disk snapshot instead of falling
    /// through to a fresh spawn that would abandon the `harness_session_id`.
    /// Skipped from the wire when false to keep the shape stable for the
    /// common live-bridge / provider-replay cases.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub recoverable: bool,
}

impl ReconnectResult {
    pub(super) fn live_bridge(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            history_status: ReconnectHistoryStatus::LiveBridge,
            replaced_session_id: None,
            message: None,
            recoverable: false,
        }
    }

    pub(super) fn provider_replay(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            history_status: ReconnectHistoryStatus::ProviderReplay,
            replaced_session_id: None,
            message: None,
            recoverable: false,
        }
    }

    pub(super) fn unavailable(session_id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            history_status: ReconnectHistoryStatus::Unavailable,
            replaced_session_id: None,
            message: Some(message.into()),
            recoverable: false,
        }
    }

    /// Structured "unavailable, but the conversation is still recoverable"
    /// result. Returned instead of a bare `Err` when a tracked session's
    /// in-place resume could not commit (stale/pruned harness id, resume
    /// command exited during the grace window) so the frontend keeps the
    /// recoverable ghost + replays the disk snapshot rather than spawning a
    /// fresh empty chat that abandons the persisted `harness_session_id`.
    pub(super) fn unavailable_recoverable(
        session_id: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            history_status: ReconnectHistoryStatus::Unavailable,
            replaced_session_id: None,
            message: Some(message.into()),
            recoverable: true,
        }
    }

    pub(super) fn provider_replacement(
        session_id: impl Into<String>,
        replaced_session_id: impl Into<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            history_status: ReconnectHistoryStatus::ProviderReplay,
            replaced_session_id: Some(replaced_session_id.into()),
            message: None,
            recoverable: false,
        }
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

#[derive(Debug, Serialize)]
pub(super) struct SessionRemovedPayload {
    pub(super) session_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct PaneContextChangedPayload {
    pub(super) session_id: String,
    pub(super) current_command: String,
    pub(super) current_path: String,
    pub(super) pane_title: String,
    pub(super) window_name: String,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TerminalSessionReplaced {
    pub(super) old_session_id: String,
    pub(super) new_session_id: String,
}

pub(crate) fn emit_terminal_session_upserted<R: Runtime>(
    app: &AppHandle<R>,
    item: &TerminalListItem,
) {
    if let Err(e) = app.emit(TERMINAL_SESSION_UPSERTED_EVENT, item) {
        tracing::warn!(error = %e, session_id = %item.session_id, "terminal-session-upserted emit failed");
    }
}

pub(super) fn emit_terminal_session_removed<R: Runtime>(app: &AppHandle<R>, session_id: &str) {
    let payload = SessionRemovedPayload {
        session_id: session_id.to_string(),
    };
    if let Err(e) = app.emit(TERMINAL_SESSION_REMOVED_EVENT, &payload) {
        tracing::warn!(error = %e, session_id = %session_id, "terminal-session-removed emit failed");
    }
}

pub(super) fn emit_terminal_session_replaced<R: Runtime>(
    app: &AppHandle<R>,
    old_session_id: &str,
    new_session_id: &str,
) {
    let payload = TerminalSessionReplaced {
        old_session_id: old_session_id.to_string(),
        new_session_id: new_session_id.to_string(),
    };
    if let Err(e) = app.emit(TERMINAL_SESSION_REPLACED_EVENT, &payload) {
        tracing::warn!(
            error = %e,
            old_session_id,
            new_session_id,
            "terminal-session-replaced emit failed"
        );
    }
}

pub(super) fn emit_terminal_pane_context_changed<R: Runtime>(
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

pub(super) fn emit_agent_session_removed<R: Runtime>(app: &AppHandle<R>, session_id: &str) {
    let payload = SessionRemovedPayload {
        session_id: session_id.to_string(),
    };
    if let Err(e) = app.emit(AGENT_SESSION_REMOVED_EVENT, &payload) {
        tracing::warn!(error = %e, session_id = %session_id, "agent-session-removed emit failed");
    }
}

pub(super) fn shutdown_removed_entry(mut entry: TerminalEntry, abort_monitor: bool) {
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
