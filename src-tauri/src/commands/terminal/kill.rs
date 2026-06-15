//! Pane shutdown commands: explicit kill, cross-module helpers used by
//! `worktree::remove` / `project::remove`, the orphan reaper, and the
//! stale-session reaper.

use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use raum_tmux::TmuxError;
use tauri::{AppHandle, Runtime};

use crate::commands::agent::cleanup_harness_session;
use crate::state::AppHandleState;

use super::entry::{
    emit_agent_session_removed, emit_terminal_session_removed, shutdown_removed_entry,
};
use super::helpers::is_session_not_found;

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
    if let Err(e) = raum_core::snapshot_store::delete_for_session(session_id) {
        tracing::warn!(
            session_id = %session_id,
            error = %e,
            "terminal_kill: failed to delete terminal snapshot"
        );
    }
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
    if let Err(e) = raum_core::snapshot_store::delete_for_session(session_id) {
        tracing::warn!(
            session_id = %session_id,
            error = %e,
            "kill_session_inner: failed to delete terminal snapshot"
        );
    }
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

/// Session ids that must never be auto-reaped as orphans or stale: every id
/// the registry knows (live bridges + rehydrate/adopt ghosts) and every row
/// tracked in `state/sessions.toml`.
///
/// `active-layout.toml` is deliberately NOT consulted. It is a frontend-owned
/// geometry cache written on a 500 ms debounce; a crash or Cmd+R within that
/// window leaves a dead tab id behind, and reading it here used to *re-protect
/// a corpse* on the next launch — a stale tab kept a long-dead session id in
/// the protected set forever, so the counter never drained. The single
/// authority for "which sessions exist" is now `state/sessions.toml` (S2),
/// which every spawn/reattach writes and every kill prunes; the boot reconcile
/// (`terminal::reconcile`) guarantees every live tmux session has an S2 row
/// (adopting orphans), so layout-based protection is both redundant and
/// harmful. Shells are tracked in S2 too (see `terminal_spawn`), so the old
/// "shell panes come back black" case is covered by the registry/S2 union.
///
/// Lock failures are errors (callers must not kill with an incomplete set);
/// unreadable/missing TOML files are tolerated so a fresh install with no
/// state files doesn't brick the reapers.
pub(crate) fn protected_session_ids(state: &AppHandleState) -> Result<HashSet<String>, String> {
    let mut protected: HashSet<String> = HashSet::new();
    {
        let reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        for item in reg.list() {
            protected.insert(item.session_id);
        }
    }
    {
        let store = state
            .config_store
            .lock()
            .map_err(|e| format!("config_store lock: {e}"))?;
        if let Ok(persisted) = store.read_sessions() {
            for row in persisted.sessions {
                protected.insert(row.session_id);
            }
        }
    }
    Ok(protected)
}

/// One-shot orphan reaper: kills any tmux session on the `-L raum` socket
/// that is NOT protected (see [`protected_session_ids`]: live registry,
/// `sessions.toml`, persisted active layout), provided it has aged past a
/// 30-second floor (so we can't race a freshly-spawned session whose
/// registry insert / config debounce hasn't completed yet). Surfaces the
/// user's "23 idle harnesses while I see 8" case: pre-fix Cmd+R could leak
/// tmux windows, and the only way to recover without restarting was to
/// hand-run `tmux -L raum kill-session`.
///
/// Returns the list of session ids that were killed.
#[tauri::command]
pub async fn terminal_kill_orphans<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
) -> Result<Vec<String>, String> {
    kill_orphans_inner(&app, &state).await
}

/// Shared body for [`terminal_kill_orphans`]. Lives here so the boot-time
/// reap, the periodic sweep, and the window-focus trigger in `lib.rs` can
/// run the same code path as the manual UI button without needing an IPC
/// round-trip. Each leaked tmux session holds ~10–20 fds (PTY master +
/// client pipes + hook IPC), so under load this is the main lever we have
/// to keep `EMFILE` from breaking the git watcher and other background
/// IO.
pub(crate) async fn kill_orphans_inner<R: Runtime>(
    app: &AppHandle<R>,
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

    let tracked = protected_session_ids(state)?;

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
        match kill_res {
            Ok(()) => {
                tracing::info!(session_id = %s.id, age_secs = age, "killed orphan tmux session");
                // Drop every local record of the session so the counter
                // settles without waiting for a relaunch, and so a stale S2
                // row can't re-protect the now-dead id on the next boot.
                finalize_session_removal(app, state, &s.id);
                killed.push(s.id);
            }
            Err(TmuxError::NonZero { stderr, .. }) if is_session_not_found(&stderr) => {
                // Already gone in tmux — still reclaim our local records.
                finalize_session_removal(app, state, &s.id);
                killed.push(s.id);
            }
            Err(e) => {
                tracing::warn!(session_id = %s.id, error = %e, "orphan kill failed");
            }
        }
    }

    Ok(killed)
}

/// Reclaim every local record of `session_id` after its tmux session is gone:
/// the in-memory registry entry/ghost, the harness runtime + state machine,
/// its `state/sessions.toml` row (so a dead id can't re-protect itself next
/// boot), and its terminal snapshot — then tell the frontend to drop the row
/// so the counter moves immediately. Used by every reaper path; the
/// interactive `terminal_kill` does the same sequence inline.
fn finalize_session_removal<R: Runtime>(
    app: &AppHandle<R>,
    state: &tauri::State<'_, AppHandleState>,
    session_id: &str,
) {
    if let Ok(mut reg) = state.terminals.lock() {
        if let Some(entry) = reg.remove(session_id) {
            shutdown_removed_entry(entry, true);
        }
    }
    cleanup_harness_session(state, session_id);
    if let Err(e) = raum_core::snapshot_store::delete_for_session(session_id) {
        tracing::warn!(
            session_id = %session_id,
            error = %e,
            "finalize_session_removal: failed to delete terminal snapshot"
        );
    }
    emit_terminal_session_removed(app, session_id);
    emit_agent_session_removed(app, session_id);
}

/// §3.7 — stale-session reaper, invoked from the in-app "Orphaned sessions"
/// group. No CLI surface. Protected sessions (live registry + `sessions.toml`
/// — see [`protected_session_ids`]) are exempt; only untracked leftovers older
/// than `threshold_days` are age-reaped. After killing, every local record is
/// reclaimed and a removal event is emitted so the counter settles without a
/// relaunch.
#[tauri::command]
pub async fn terminal_reap_stale<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    threshold_days: u32,
) -> Result<Vec<String>, String> {
    let tmux = state.tmux.clone();
    let keep = protected_session_ids(&state)?;
    let killed = tokio::task::spawn_blocking(move || tmux.reap_stale(threshold_days, &keep))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?;

    for id in &killed {
        finalize_session_removal(&app, &state, id);
    }
    Ok(killed)
}
