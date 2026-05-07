//! Reattach to an existing tmux session, plus the two provider-replay
//! command wrappers (`terminal_provider_replay`, `terminal_provider_replace`).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use raum_core::AgentKind;
use raum_core::config::XTERM_SCROLLBACK_LINES;
use raum_tmux::TmuxManager;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Runtime};

use crate::commands::agent::{
    RegisterOptions, cleanup_harness_session, infer_reattach_hook_fallback,
    prepare_harness_launch_fast, register_harness_session_runtime_opts, resolve_project_dir,
    spawn_harness_launch_refresh,
};
use crate::state::AppHandleState;

use super::XTERM_SCROLLBACK;
use super::bridge::{
    attach_pipeline, build_snapshot_replay, open_bridge_and_monitor, send_snapshot_replay_chunks,
    spawn_pane_context_monitor, spawn_pane_death_monitor,
};
use super::entry::{
    ReattachArgs, ReconnectResult, TerminalEntry, emit_agent_session_removed,
    emit_terminal_session_removed, emit_terminal_session_replaced, emit_terminal_session_upserted,
    shutdown_removed_entry,
};
use super::helpers::{
    clamp_pty_dims, generate_session_id, harness_session_env_pairs, now_unix_millis, now_unix_secs,
    resize_lock_for, resolve_harness_extra_flags, resolve_reattach_context, resolve_spawn_cwd,
    sanitize_initial_size, tracked_session_context,
};
use super::registry::{BridgeRuntime, TerminalRegistry};
use super::respawn::{resolve_resume_target, respawn_harness_pane_in_place};

pub(super) struct ReattachInFlightGuard<'a> {
    pub(super) terminals: &'a Mutex<TerminalRegistry>,
    pub(super) session_id: String,
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
            return Err("not-found".to_string());
        }
        if matches!(args.kind, AgentKind::Shell) {
            return Err("not-found".to_string());
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
        let harness_env: Vec<(String, String)> = harness_session_env_pairs(&state, args.kind);
        let tmux_for_new = tmux.clone();
        let id_for_new = session_id.clone();
        tokio::task::spawn_blocking(move || {
            let mut env_pairs: Vec<(&str, &str)> =
                vec![(raum_hooks::RAUM_SESSION_ENV, raum_session_value.as_str())];
            if let Some(p) = raum_event_sock_value.as_deref() {
                env_pairs.push((raum_hooks::RAUM_EVENT_SOCK_ENV, p));
            }
            for (k, v) in &harness_env {
                env_pairs.push((k.as_str(), v.as_str()));
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
    let resize_lock = resize_lock_for(&state, &session_id)?;
    let _resize_guard = resize_lock.lock().await;

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

    // Reattach is per-pane-mode. We branch on the pane's *runtime* alt-screen
    // state rather than on harness kind so the path adapts to e.g. Codex's
    // `--no-alt-screen` flag or Claude Code with `CLAUDE_CODE_NO_FLICKER=0`.
    //
    // * Alt-screen TUIs (Codex/OpenCode default, Claude Code in fullscreen):
    //   the harness owns the entire viewport and repaints from source on
    //   every SIGWINCH. We skip snapshot replay (replaying serialized alt
    //   bytes into the normal buffer corrupts scrollback with stale frames)
    //   and instead force a clean repaint via a +1/-1 column resize bounce.
    //   The tmux attach repaint plus the harness's own SIGWINCH handler
    //   produce a current frame at the live width.
    //
    // * Inline / soft-wrap panes (Claude Code legacy inline, shell):
    //   the pane has true scrollback that the user wants to see. We keep
    //   the single pre-snapshot resize and use `capture_pane_view_snapshot`
    //   to capture only the recent visible viewport — full-history replay
    //   here would ship tmux's mixed-width scrollback into a fresh xterm
    //   and reproduce the "1 char per line" artefact. Cross-restart
    //   scrollback restore is handled separately by the disk-backed
    //   frontend snapshot, replayed by the frontend before the bridge bytes
    //   start arriving.
    //
    // Provider replay (`resume_after_attach`) intentionally skips both
    // paths: the fresh PTY bridge must be consuming bytes before
    // `respawn-pane` starts the harness resume command, otherwise a large
    // transcript repaint can be rendered only into tmux while the webview
    // misses part of the stream.
    let pane_alt_screen = if resume_after_attach {
        // Provider replay forces a brand-new resume command into the pane;
        // the alt-screen state we'd read here is about to be replaced.
        false
    } else {
        let tmux_for_alt = tmux.clone();
        let id_for_alt = session_id.clone();
        tokio::task::spawn_blocking(move || tmux_for_alt.is_alternate_on(&id_for_alt))
            .await
            .map_err(|e| format!("spawn_blocking join: {e}"))?
            .unwrap_or(false)
    };

    if pane_alt_screen {
        // SIGWINCH bounce: resize to one less column and back. tmux's own
        // attach repaint handles the visible frame; the bounce guarantees
        // the inner harness fires its SIGWINCH handler even when the
        // post-resize geometry equals the pre-resize geometry (raum
        // restart at identical window size).
        let bounce_cols = cols.saturating_sub(1).max(1);
        let tmux_for_bounce = tmux.clone();
        let id_for_bounce = session_id.clone();
        let _ = tokio::task::spawn_blocking(move || {
            tmux_for_bounce.resize(&id_for_bounce, u32::from(bounce_cols), u32::from(rows))
        })
        .await;
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
                "terminal_reattach: alt-screen resize bounce failed"
            ),
            Err(e) => tracing::warn!(
                session_id = %session_id,
                error = %e,
                "terminal_reattach: alt-screen resize bounce task failed"
            ),
        }
    } else {
        // Inline / shell: single resize before snapshot replay. Otherwise
        // a restart into a larger window first paints the old, smaller
        // tmux surface and only fixes itself once the live attached client
        // catches up.
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

        if !resume_after_attach {
            // View-only capture: only the recent visible viewport at the
            // current width. Full-history replay would ship tmux's
            // mixed-width scrollback into the fresh xterm.
            let tmux_for_capture = tmux.clone();
            let id_for_capture = session_id.clone();
            let view_rows = rows;
            match tokio::task::spawn_blocking(move || {
                tmux_for_capture.capture_pane_view_snapshot(&id_for_capture, view_rows)
            })
            .await
            {
                Ok(Ok(snapshot)) => {
                    let replay = build_snapshot_replay(snapshot);
                    let _ = send_snapshot_replay_chunks(&on_data, &session_id, replay);
                }
                Ok(Err(e)) => {
                    tracing::warn!(
                        session_id = %session_id,
                        error = %e,
                        "terminal_reattach: pane view-snapshot failed, continuing without replay"
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        session_id = %session_id,
                        error = %e,
                        "terminal_reattach: pane view-snapshot task join failed, continuing without replay"
                    );
                }
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
    let monitor_task = if resume_after_attach {
        None
    } else {
        Some(spawn_pane_death_monitor(
            app_handle.clone(),
            tmux.clone(),
            session_id.clone(),
        ))
    };

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

    if resume_after_attach {
        let respawn_result =
            respawn_harness_pane_in_place(&tmux, &state, &session_id, args.kind, true).await;
        let monitor =
            spawn_pane_death_monitor(app_handle.clone(), tmux.clone(), session_id.clone());
        match state.terminals.lock() {
            Ok(mut reg) => {
                let _ = reg.set_monitor_task(&session_id, monitor);
            }
            Err(e) => {
                monitor.abort();
                tracing::warn!(
                    session_id = %session_id,
                    error = %e,
                    "terminal_reattach: failed to install post-resume pane monitor"
                );
            }
        }
        let cmd = respawn_result?;
        tracing::info!(
            session_id = %session_id,
            kind = ?args.kind,
            cmd = %cmd,
            "terminal_reattach: resumed harness after bridge attach",
        );
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
    terminal_reattach(app, state, args, on_data).await
}

/// Replace a recovered harness tmux session with a fresh provider-resume
/// session. This is the app-restart recovery path for Codex / Claude Code:
/// keep the old tmux session alive while raum is down, start a new pane using
/// the provider's native `resume` command so it reconstructs the full
/// transcript into a clean xterm, then silently retire the old tmux session.
#[tauri::command]
pub async fn terminal_provider_replace<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    args: ReattachArgs,
    on_data: Channel<InvokeResponseBody>,
) -> Result<ReconnectResult, String> {
    if matches!(args.kind, AgentKind::Shell) {
        return Ok(ReconnectResult::unavailable(
            args.session_id,
            "shell panes do not support provider replacement",
        ));
    }

    let tmux: Arc<TmuxManager> = state.tmux.clone();
    let old_session_id = args.session_id.clone();
    let new_session_id = generate_session_id(args.kind);
    let app_handle = app.clone();

    let extra_flags = resolve_harness_extra_flags(&state, args.kind);
    let resume_target = match resolve_resume_target(
        &state,
        &tmux,
        &old_session_id,
        args.kind,
        extra_flags.as_deref(),
    )
    .await
    {
        Ok(target) => target,
        Err(err) => return Ok(ReconnectResult::unavailable(old_session_id, err)),
    };

    let existing_item = {
        let reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        reg.item(&old_session_id)
    };
    let (tracked_project_slug, tracked_worktree_id) =
        tracked_session_context(&state, &old_session_id);
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
        return Ok(ReconnectResult::unavailable(
            old_session_id,
            "provider replacement requires a registered project",
        ));
    }

    let launch_report = prepare_harness_launch_fast(
        &app,
        &state,
        args.kind,
        effective_project_slug.as_deref(),
        project_dir.clone(),
    )?;
    if launch_report.binary_missing {
        return Ok(ReconnectResult::unavailable(
            old_session_id,
            format!("binary `{}` not found on PATH", launch_report.binary),
        ));
    }
    spawn_harness_launch_refresh(
        app.clone(),
        args.kind,
        effective_project_slug.clone(),
        project_dir.clone(),
    );

    let (cols, rows) = match args.cols.zip(args.rows) {
        Some((c, r)) => clamp_pty_dims(c, r),
        None => (200, 50),
    };
    let initial_size = Some((u32::from(cols), u32::from(rows)));
    let cwd_path: PathBuf = resume_target
        .cwd
        .clone()
        .map_or_else(|| project_dir.clone(), PathBuf::from);
    let raum_session_value = new_session_id.clone();
    let raum_event_sock_value: Option<String> = state
        .event_socket
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|h| h.path.to_string_lossy().into_owned()));
    let harness_env: Vec<(String, String)> = harness_session_env_pairs(&state, args.kind);
    {
        let tmux_for_new = tmux.clone();
        let id_for_new = new_session_id.clone();
        let cwd_for_new = cwd_path.clone();
        tokio::task::spawn_blocking(move || {
            let mut env_pairs: Vec<(&str, &str)> =
                vec![(raum_hooks::RAUM_SESSION_ENV, raum_session_value.as_str())];
            if let Some(p) = raum_event_sock_value.as_deref() {
                env_pairs.push((raum_hooks::RAUM_EVENT_SOCK_ENV, p));
            }
            for (k, v) in &harness_env {
                env_pairs.push((k.as_str(), v.as_str()));
            }
            tmux_for_new.new_session_with_env(
                &id_for_new,
                &cwd_for_new,
                Some("placeholder"),
                initial_size,
                &env_pairs,
            )
        })
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
        .map_err(|e| format!("tmux new-session: {e}"))?;
    }

    let cleanup_new_session = |state: &tauri::State<'_, AppHandleState>,
                               tmux: Arc<TmuxManager>,
                               app: &AppHandle<R>,
                               session_id: String| {
        cleanup_harness_session(state, &session_id);
        if let Ok(mut reg) = state.terminals.lock()
            && let Some(entry) = reg.remove(&session_id)
        {
            shutdown_removed_entry(entry, true);
        }
        emit_terminal_session_removed(app, &session_id);
        tokio::spawn(async move {
            let _ = tokio::task::spawn_blocking(move || tmux.kill_session(&session_id)).await;
        });
    };

    if let Err(err) = register_harness_session_runtime_opts(
        &app,
        &state,
        args.kind,
        &new_session_id,
        effective_project_slug.as_deref(),
        effective_worktree_id.as_deref(),
        project_dir.clone(),
        launch_report.hook_fallback,
        RegisterOptions {
            opencode_port: resume_target.opencode_port,
            ..RegisterOptions::default()
        },
    ) {
        let tmux_cleanup = tmux.clone();
        let id_cleanup = new_session_id.clone();
        let _ = tokio::task::spawn_blocking(move || tmux_cleanup.kill_session(&id_cleanup)).await;
        return Err(err);
    }
    if let Ok(store) = state.config_store.lock() {
        let _ = store.update_session_harness_id(
            &new_session_id,
            args.kind,
            &resume_target.harness_session_id,
            now_unix_millis(),
        );
    }

    if let Err(err) = attach_pipeline(
        app.clone(),
        &state,
        new_session_id.clone(),
        args.kind,
        effective_project_slug.clone(),
        effective_worktree_id.clone(),
        tmux.clone(),
        on_data,
        cols,
        rows,
        false,
    )
    .await
    {
        cleanup_new_session(&state, tmux.clone(), &app, new_session_id);
        return Err(err);
    }

    let cmd = resume_target.command.clone();
    let cwd_for_respawn = resume_target.cwd.clone();
    {
        let tmux_for_respawn = tmux.clone();
        let id_for_respawn = new_session_id.clone();
        let cmd_for_respawn = cmd.clone();
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
    }

    const RESUME_GRACE_TOTAL_MS: u64 = 1500;
    const RESUME_GRACE_POLL_MS: u64 = 100;
    let grace_start = std::time::Instant::now();
    let grace_total = std::time::Duration::from_millis(RESUME_GRACE_TOTAL_MS);
    let grace_poll = std::time::Duration::from_millis(RESUME_GRACE_POLL_MS);
    loop {
        let dead = {
            let tmux_for_check = tmux.clone();
            let id_for_check = new_session_id.clone();
            tokio::task::spawn_blocking(move || tmux_for_check.check_pane_dead(&id_for_check))
                .await
                .map_err(|e| format!("spawn_blocking join: {e}"))?
        };
        match dead {
            Ok(Some(exit_code)) => {
                cleanup_new_session(&state, tmux.clone(), &app, new_session_id);
                return Ok(ReconnectResult::unavailable(
                    old_session_id,
                    format!("provider resume exited early (code {exit_code})"),
                ));
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(
                    session_id = %new_session_id,
                    error = %e,
                    "terminal_provider_replace: pane-dead probe failed during resume grace, assuming alive",
                );
                break;
            }
        }
        if grace_start.elapsed() >= grace_total {
            break;
        }
        tokio::time::sleep(grace_poll).await;
    }

    let monitor = spawn_pane_death_monitor(app.clone(), tmux.clone(), new_session_id.clone());
    if let Ok(mut reg) = state.terminals.lock() {
        let _ = reg.set_monitor_task(&new_session_id, monitor);
    }

    if let Ok(store) = state.config_store.lock() {
        let _ = store.forget_session(&old_session_id);
    }
    cleanup_harness_session(&state, &old_session_id);
    if let Ok(mut reg) = state.terminals.lock()
        && let Some(entry) = reg.remove(&old_session_id)
    {
        shutdown_removed_entry(entry, true);
    }
    {
        let tmux_for_old = tmux.clone();
        let id_for_old = old_session_id.clone();
        tokio::spawn(async move {
            let _ =
                tokio::task::spawn_blocking(move || tmux_for_old.kill_session(&id_for_old)).await;
        });
    }
    emit_terminal_session_replaced(&app_handle, &old_session_id, &new_session_id);
    emit_agent_session_removed(&app_handle, &old_session_id);

    tracing::info!(
        old_session_id = %old_session_id,
        new_session_id = %new_session_id,
        kind = ?args.kind,
        cmd = %cmd,
        "terminal_provider_replace: recovered harness into provider-resume session",
    );

    Ok(ReconnectResult::provider_replacement(
        new_session_id,
        old_session_id,
    ))
}
