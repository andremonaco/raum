//! Small utility helpers shared across the spawn / reattach / resize /
//! kill code paths. Pure functions and lock primitives only — no
//! command handlers, no Tauri emits.

use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Arc;

use raum_core::AgentKind;

use crate::commands::agent::resolve_project_dir;
use crate::state::AppHandleState;

/// Clamp webview-supplied dimensions into a sane range so a broken frontend
/// can't push tmux into a degenerate size. Matches what xterm.js will actually
/// use in practice.
pub(super) const MIN_COLS: u32 = 20;
pub(super) const MAX_COLS: u32 = 500;
pub(super) const MIN_ROWS: u32 = 5;
pub(super) const MAX_ROWS: u32 = 200;

pub(super) fn sanitize_initial_size(cols: Option<u32>, rows: Option<u32>) -> Option<(u32, u32)> {
    match (cols, rows) {
        (Some(c), Some(r)) => Some((c.clamp(MIN_COLS, MAX_COLS), r.clamp(MIN_ROWS, MAX_ROWS))),
        _ => None,
    }
}

pub(super) fn clamp_pty_dims(cols: u32, rows: u32) -> (u16, u16) {
    let c = cols.clamp(MIN_COLS, MAX_COLS) as u16;
    let r = rows.clamp(MIN_ROWS, MAX_ROWS) as u16;
    (c, r)
}

pub(super) fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

pub(super) fn now_unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

pub(super) fn contains_submit_input(keys: &str) -> bool {
    keys.contains('\r') || keys.contains('\n')
}

/// User signalled they want to abort the running turn.
///
/// Ctrl-C (0x03, SIGINT) always counts. ESC (0x1b) counts only when the
/// agent is currently `Waiting` — i.e. the harness has asked for input
/// (permission request or idle prompt). In `Working` ESC is overloaded
/// (menu-dismiss, vim, slash-menu cancel) and would cause constant false
/// demotions back to `Idle`, so it is forwarded to the harness unchanged.
pub(super) fn contains_abort_input(
    keys: &str,
    state: Option<raum_core::agent::AgentState>,
) -> bool {
    if keys.contains('\x03') {
        return true;
    }
    matches!(state, Some(raum_core::agent::AgentState::Waiting)) && keys.contains('\x1b')
}

/// tmux's `kill-session` exits non-zero when the target session doesn't exist.
/// Different tmux versions phrase the error slightly differently — match the
/// substrings we've observed in the wild rather than an exact string.
pub(super) fn is_session_not_found(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("can't find session")
        || s.contains("session not found")
        || s.contains("no such session")
}

pub(crate) fn reserve_localhost_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| e.to_string())
}

pub(super) fn generate_session_id(kind: AgentKind) -> String {
    // Monotonic-ish id: `<kind>-<unix_ms>-<pid>`. Unique enough for a tmux
    // session name on the raum socket.
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    format!("raum-{}-{}-{}", kind.binary_name(), ms, std::process::id())
}

pub(super) fn resize_lock_for(
    state: &AppHandleState,
    session_id: &str,
) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    let mut locks = state
        .terminal_resize_locks
        .lock()
        .map_err(|e| format!("terminal resize lock map: {e}"))?;
    Ok(locks
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone())
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
pub(super) fn resolve_spawn_cwd(
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

pub(super) fn preferred_context_value(values: [Option<&str>; 4]) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .find(|value| !value.is_empty())
        .map(str::to_string)
}

pub(super) type ContextPair<'a> = (Option<&'a str>, Option<&'a str>);

pub(super) fn resolve_reattach_context(
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

pub(super) fn tracked_session_context(
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

pub(super) fn tracked_session_harness_id(
    state: &AppHandleState,
    session_id: &str,
) -> Option<String> {
    state
        .config_store
        .lock()
        .ok()
        .and_then(|store| store.last_session_harness_id(session_id))
}

pub(super) fn tracked_session_last_prompt(
    state: &AppHandleState,
    session_id: &str,
) -> Option<String> {
    state
        .config_store
        .lock()
        .ok()
        .and_then(|store| store.last_session_prompt(session_id))
        .map(|(prompt, _)| prompt)
}

/// Look up the persisted OpenCode port for a session, if any. Used by
/// the revival path to prefer the previous port when respawning.
pub(super) fn tracked_session_opencode_port(
    state: &AppHandleState,
    session_id: &str,
) -> Option<u16> {
    let store = state.config_store.lock().ok()?;
    let sessions = store.read_sessions().ok()?;
    sessions
        .sessions
        .iter()
        .find(|s| s.session_id == session_id)
        .and_then(|s| s.opencode_port)
}

pub(super) fn resolve_harness_extra_flags(
    state: &AppHandleState,
    kind: AgentKind,
) -> Option<String> {
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

/// `true` when raum should launch Claude Code in fullscreen (alt-screen) mode,
/// switching it from inline scrollback to a self-contained alt-screen TUI. We
/// inject `CLAUDE_CODE_NO_FLICKER=1` into the spawned env to enable this — the
/// env var is honoured by Claude 2.1.89+ and avoids Ink's hard-wrap-into-
/// scrollback corruption that occurs in inline mode on resize/restart.
///
/// Default is `true`; users can opt back into inline mode in settings, in
/// which case raum falls back to snapshot-replay restore semantics.
pub(super) fn resolve_claude_fullscreen(state: &AppHandleState) -> bool {
    let store = state.config_store.lock().expect("config store poisoned");
    store
        .read_config()
        .ok()
        .is_none_or(|cfg| cfg.harnesses.claude_code.fullscreen)
}

/// Build the per-harness env-var pairs to inject into a fresh tmux session via
/// `tmux new-session -e KEY=VALUE`. Currently this exists for one purpose:
/// putting Claude Code into a robust alt-screen render, via the pair
/// `CLAUDE_CODE_NO_FLICKER=1` (switch inline → alt-screen) and
/// `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1` (repaint every cell each frame). The
/// returned vec owns its strings so the caller can build a `&[(&str, &str)]`
/// slice without lifetime gymnastics.
pub(super) fn harness_session_env_pairs(
    state: &AppHandleState,
    kind: AgentKind,
) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    if matches!(kind, AgentKind::ClaudeCode) && resolve_claude_fullscreen(state) {
        pairs.push(("CLAUDE_CODE_NO_FLICKER".to_string(), "1".to_string()));
        // Force full-frame repaints so Claude's incremental alt-screen updates
        // can't drift out of sync with the real screen — the failure mode
        // behind agent-teams / FleetView corruption (floating panels layered
        // over stale scrollback) under heavy nested-subagent repaint load.
        // Claude auto-enables this only for Windows agent-view/background
        // sessions, never on macOS/Linux, so raum must opt in explicitly.
        // Unrecognized by older Claude builds → harmlessly ignored. See
        // anthropics/claude-code#69619.
        pairs.push((
            "CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT".to_string(),
            "1".to_string(),
        ));
    }
    pairs
}

/// Type alias used by [`super::bridge::open_bridge_and_monitor`] to pass
/// the shared per-session activity clock without naming the concrete type
/// across module boundaries.
pub(super) type SessionActivityMap = Arc<crate::state::SessionActivity>;
