//! `terminal_spawn`: create a new tmux session, wire its output through a
//! PTY-attached client, and stream rendered bytes to the webview.

use std::sync::Arc;

use raum_core::AgentKind;
use raum_core::harness::{
    harness_launch_command_with_prompt_and_override, parse_opencode_port_arg,
};
use raum_core::review::inject_opencode_brief;
use raum_tmux::TmuxManager;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Runtime};

use crate::commands::agent::{
    RegisterOptions, cleanup_harness_session, prepare_harness_launch_fast,
    register_harness_session_runtime, register_harness_session_runtime_opts, resolve_project_dir,
    spawn_harness_launch_refresh,
};
use crate::state::AppHandleState;

use super::bridge::{attach_pipeline, spawn_pane_death_monitor};
use super::entry::{
    SpawnArgs, emit_agent_session_removed, emit_terminal_session_removed, shutdown_removed_entry,
};
use super::helpers::{
    clamp_pty_dims, generate_session_id, harness_session_env_pairs, now_unix_millis,
    reserve_localhost_port, resolve_spawn_cwd, sanitize_initial_size,
};

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
    let harness_cmd = harness_launch_command_with_prompt_and_override(
        args.kind,
        extra_flags.as_deref(),
        opencode_port,
        args.initial_prompt.as_deref(),
        args.model_override.as_ref(),
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
    // Project context for the `raum` CLI running inside this pane. The project
    // root is the *main* repo (not the per-worktree `cwd`), so the CLI creates
    // new worktrees against the right repo.
    let raum_project_slug_value = args.project_slug.clone();
    let raum_project_root_value: Option<String> =
        (!project_dir.as_os_str().is_empty()).then(|| project_dir.to_string_lossy().into_owned());
    let raum_worktree_id_value = args.worktree_id.clone();
    let harness_env: Vec<(String, String)> = harness_session_env_pairs(&state, args.kind);
    let cwd_for_new = cwd.clone();
    tokio::task::spawn_blocking(move || {
        let mut env_pairs: Vec<(&str, &str)> =
            vec![(raum_hooks::RAUM_SESSION_ENV, raum_session_value.as_str())];
        if let Some(p) = raum_event_sock_value.as_deref() {
            env_pairs.push((raum_hooks::RAUM_EVENT_SOCK_ENV, p));
        }
        if let Some(s) = raum_project_slug_value.as_deref() {
            env_pairs.push((raum_hooks::RAUM_PROJECT_SLUG_ENV, s));
        }
        if let Some(r) = raum_project_root_value.as_deref() {
            env_pairs.push((raum_hooks::RAUM_PROJECT_ROOT_ENV, r));
        }
        if let Some(w) = raum_worktree_id_value.as_deref() {
            env_pairs.push((raum_hooks::RAUM_WORKTREE_ID_ENV, w));
        }
        for (k, v) in &harness_env {
            env_pairs.push((k.as_str(), v.as_str()));
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

    // Track shell sessions in `state/sessions.toml` exactly like harness
    // sessions (whose tracking happens inside the register path below).
    // Without a tracked row, a shell session that survives an app restart
    // looks like a leak to the orphan reaper — the window-focus reap fires
    // the moment the relaunched window appears and kills it before the
    // frontend can reattach, which is why shell panes came back black.
    // Every kill path runs `cleanup_harness_session` → `forget_session`,
    // so rows can't outlive their pane.
    if args.kind == AgentKind::Shell
        && let Ok(store) = state.config_store.lock()
        && let Err(e) = store.upsert_tracked_session(
            &session_id,
            AgentKind::Shell,
            args.project_slug.as_deref(),
            args.worktree_id.as_deref(),
            None,
            now_unix_millis(),
        )
    {
        tracing::warn!(
            error = %e,
            session_id = %session_id,
            "terminal_spawn: tracking shell session failed"
        );
    }

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
