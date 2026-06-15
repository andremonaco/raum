//! Pane input plumbing: keystrokes from the webview and drag-and-drop
//! paste payloads.

use tauri::{AppHandle, Emitter, Runtime};

use crate::state::AppHandleState;

use super::helpers::{contains_abort_input, contains_submit_input};

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

/// Paste arbitrary clipboard text into a pane as a *paste event*.
///
/// The frontend routes Cmd+V here instead of letting xterm.js synthesize the
/// bytes itself: xterm only wraps pastes in bracketed-paste markers when it
/// has seen DECSET 2004 — state it can lose across reloads/reattaches —
/// whereas tmux always knows whether the inner application requested
/// bracketing. `paste-buffer -p` emits the CSIs exactly when the pane opted
/// in, so multi-line pastes into harnesses arrive as one paste instead of a
/// burst of Enter-submitted lines, and plain shells still see ordinary text.
#[tauri::command]
pub async fn terminal_paste_text(
    state: tauri::State<'_, AppHandleState>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
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
    let tmux = state.tmux.clone();
    let buffer_name = format!("raum-paste-{session_id}");
    let target = session_id.clone();
    tokio::task::spawn_blocking(move || {
        tmux.paste_into_pane(&target, &buffer_name, text.as_bytes(), true)
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
