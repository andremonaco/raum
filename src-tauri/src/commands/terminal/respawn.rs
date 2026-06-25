//! Harness pane revival: in-place respawn (`terminal_self_heal`,
//! `terminal_respawn_dead`) plus the resume-target resolver shared with
//! `terminal_reattach` / `terminal_provider_replace`.

use std::path::PathBuf;
use std::sync::Arc;

use raum_core::AgentKind;
use raum_core::harness::{harness_launch_command, harness_resume_command, parse_opencode_port_arg};
use raum_core::review::{
    discover_opencode_session_id_via_cli, discover_session_id_by_prompt,
    harness_session_id_matches_cwd,
};
use raum_tmux::TmuxManager;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Runtime};

use crate::commands::agent::{
    prepare_harness_launch_fast, resolve_project_dir, spawn_harness_launch_refresh,
};
use crate::state::AppHandleState;

use super::entry::{ReattachArgs, ReconnectResult};
use super::helpers::{
    clamp_pty_dims, now_unix_millis, reserve_localhost_port, resolve_harness_extra_flags,
    resolve_reattach_context, tracked_session_context, tracked_session_harness_id,
    tracked_session_last_prompt, tracked_session_opencode_port,
};
use super::reattach::terminal_reattach;

#[derive(Debug, Clone)]
pub(super) struct ResumeTarget {
    pub(super) command: String,
    pub(super) cwd: Option<String>,
    pub(super) harness_session_id: String,
    pub(super) opencode_port: Option<u16>,
}

/// How [`respawn_harness_pane_in_place`] should pick the command it runs.
/// (Every current caller prefers provider resume; a fresh launch is still
/// reached internally as the fallback when `--resume` fails its grace window.)
pub(super) enum ResumePreference {
    /// Prefer provider resume; resolve the [`ResumeTarget`] internally.
    ResolveResume,
    /// Prefer provider resume using this **pre-resolved** target — the caller
    /// already reserved/persisted any OpenCode port, so do NOT re-resolve and
    /// risk binding a divergent ephemeral port (Theme 7).
    PreResolved(ResumeTarget),
}

/// Resolve the directory to pass to `tmux respawn-pane -c` for harness
/// resume/recovery. Prefer tmux's foreground process cwd because harnesses
/// like Claude key their local session storage by cwd; fall back to the
/// tracked project root if tmux has no usable path.
pub(super) async fn resolve_harness_respawn_cwd(
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

pub(super) async fn resolve_resume_target(
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
            let discovered = if matches!(kind, AgentKind::OpenCode) {
                discover_opencode_session_id_via_cli(&cwd)
                    .await
                    .ok_or_else(|| {
                        format!(
                            "no provider resume id persisted for OpenCode, and `opencode session list --format json` found no session for cwd {}",
                            cwd.display()
                        )
                    })?
            } else {
                let prompt = tracked_session_last_prompt(state, session_id).ok_or_else(|| {
                    format!("no provider resume id or prompt persisted for {kind:?}")
                })?;
                let home_dir = dirs::home_dir()
                    .ok_or_else(|| "cannot discover provider resume id without HOME".to_string())?;
                discover_session_id_by_prompt(kind, &cwd, &home_dir, &prompt).ok_or_else(|| {
                    format!(
                        "no provider resume id persisted for {kind:?}, and no transcript matched this pane's last prompt"
                    )
                })?
            };
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
/// `prefer_resume` ([`ResumePreference`]) selects fresh-launch vs provider
/// resume. `PreResolved` threads a [`ResumeTarget`] the caller (the reboot
/// path in `terminal_reattach`) already resolved — including reserving and
/// persisting the OpenCode port — so we do NOT re-`resolve_resume_target` and
/// bind yet another ephemeral port that diverges from the one raum registered
/// (Theme 7).
///
/// Returns the command that was actually used, for logging.
pub(super) async fn respawn_harness_pane_in_place(
    tmux: &Arc<TmuxManager>,
    state: &tauri::State<'_, AppHandleState>,
    session_id: &str,
    kind: AgentKind,
    prefer_resume: ResumePreference,
) -> Result<String, String> {
    let extra_flags = resolve_harness_extra_flags(state, kind);
    let fresh_cmd = harness_launch_command(kind, extra_flags.as_deref(), None)
        .ok_or_else(|| "no launch command derivable for this kind".to_string())?;
    let resume_target = match prefer_resume {
        ResumePreference::PreResolved(pre_resolved) => Some(pre_resolved),
        ResumePreference::ResolveResume => Some(
            resolve_resume_target(state, tmux, session_id, kind, extra_flags.as_deref()).await?,
        ),
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
    terminal_reattach(app, state, args, on_data).await
}
