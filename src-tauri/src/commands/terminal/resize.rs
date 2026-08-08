//! `terminal_resize`: keeps the tmux window and PTY viewport in lock-step
//! while avoiding tmux's hatched "|..." pattern when the two layers
//! disagree on size momentarily.

use std::sync::Arc;

use raum_tmux::{TerminalBridge, TmuxManager};

use crate::state::AppHandleState;

use super::helpers::{clamp_pty_dims, resize_lock_for};

/// `resize-window` for one pane, over the pane's live control client when it
/// has one.
///
/// A divider drag fires `terminal_resize` at pointer-move rate and each call
/// runs one to three of these — as subprocesses that was a `tmux` fork plus a
/// socket handshake apiece. The control client is already attached and tmux
/// applies its commands in stdin order, so the same `resize-window` costs a
/// line on an open pipe (and doesn't wait for the reply — see
/// `ControlBridgeHandle::resize_window`). Any control-path failure (PTY
/// transport, torn-down client, dead stdin) falls back to the subprocess.
async fn resize_window(
    tmux: &Arc<TmuxManager>,
    bridge: &TerminalBridge,
    session_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let tmux = tmux.clone();
    let bridge = bridge.clone();
    let id = session_id.to_string();
    tokio::task::spawn_blocking(move || {
        if let TerminalBridge::Control(control) = &bridge {
            match control.resize_window(u32::from(cols), u32::from(rows)) {
                Ok(()) => return Ok(()),
                Err(e) => tracing::debug!(
                    session_id = %id,
                    error = %e,
                    "control-mode resize-window failed; falling back to the tmux CLI",
                ),
            }
        }
        tmux.resize(&id, u32::from(cols), u32::from(rows))
            .map_err(|e| format!("tmux resize: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
}

/// The PTY transport's viewport resize (a no-op on the control transport,
/// which is sizeless — the server owns pane geometry).
async fn resize_viewport(bridge: &TerminalBridge, cols: u16, rows: u16) -> Result<(), String> {
    let bridge = bridge.clone();
    tokio::task::spawn_blocking(move || bridge.resize(cols, rows))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
        .map_err(|e| format!("pty resize: {e}"))
}

#[tauri::command]
pub async fn terminal_resize(
    state: tauri::State<'_, AppHandleState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let resize_lock = resize_lock_for(&state, &session_id)?;
    let _resize_guard = resize_lock.lock().await;
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
    //
    // None of that applies to the control transport: that client is sizeless,
    // so `resize_viewport` is a no-op and there is no viewport to keep the
    // window ahead of. One `resize-window` is the whole operation — the mixed
    // case in particular drops from three round trips to one.
    let growing = c >= prev_cols && r >= prev_rows;
    let shrinking = c <= prev_cols && r <= prev_rows;
    if matches!(bridge, TerminalBridge::Control(_)) {
        resize_window(&tmux, &bridge, &session_id, c, r).await?;
    } else if growing {
        // window first → PTY
        resize_window(&tmux, &bridge, &session_id, c, r).await?;
        resize_viewport(&bridge, c, r).await?;
    } else if shrinking {
        // PTY first → window
        resize_viewport(&bridge, c, r).await?;
        resize_window(&tmux, &bridge, &session_id, c, r).await?;
    } else {
        // Mixed: grow window to max-of-both, resize PTY, shrink window.
        let max_c = c.max(prev_cols);
        let max_r = r.max(prev_rows);
        resize_window(&tmux, &bridge, &session_id, max_c, max_r).await?;
        resize_viewport(&bridge, c, r).await?;
        resize_window(&tmux, &bridge, &session_id, c, r).await?;
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
