//! `terminal_resize`: keeps the tmux window and PTY viewport in lock-step
//! while avoiding tmux's hatched "|..." pattern when the two layers
//! disagree on size momentarily.

use crate::state::AppHandleState;

use super::helpers::{clamp_pty_dims, resize_lock_for};

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
