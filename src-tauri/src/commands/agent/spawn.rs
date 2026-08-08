//! `agent_spawn` Tauri command + the underlying `prepare_harness_launch`
//! preflight (full version) and the background launch refresh helper.

use std::path::PathBuf;

use raum_core::agent::AgentKind;
use raum_core::harness::setup::{SetupContext, SetupExecutor, which_cached};
use raum_core::paths;
use raum_hydration::worktree_list as git_worktree_list;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tracing::{info, warn};

use super::helpers::resolve_project_dir;
use super::runtime::ensure_bridge_running;
use crate::state::AppHandleState;

#[derive(Debug, Serialize)]
pub struct AgentSpawnReport {
    pub session_id: String,
    pub binary_missing: bool,
    pub binary: String,
    pub version_ok: Option<bool>,
    pub version_raw: Option<String>,
    pub hook_fallback: bool,
    pub supports_native_events: bool,
}

pub(super) async fn prepare_harness_launch<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppHandleState,
    harness: AgentKind,
    project_slug: Option<&str>,
    project_dir: PathBuf,
) -> Result<AgentSpawnReport, String> {
    ensure_bridge_running(app, &state.agent_events);

    let adapter = {
        let registry = state
            .agents
            .lock()
            .map_err(|e| format!("agent registry lock: {e}"))?;
        registry
            .find_adapter(harness)
            .ok_or_else(|| format!("no adapter registered for {:?}", harness))?
    };

    let binary = adapter.binary_path().to_string();
    let binary_on_path = tokio::task::spawn_blocking(move || which_cached(&binary))
        .await
        .unwrap_or(false);
    if !binary_on_path {
        info!(
            binary = adapter.binary_path(),
            harness = ?harness,
            "prepare_harness_launch: binary missing on PATH"
        );
        emit_missing_binary_notification(app, adapter.binary_path(), harness);
        return Ok(AgentSpawnReport {
            session_id: String::new(),
            binary_missing: true,
            binary: adapter.binary_path().to_string(),
            version_ok: None,
            version_raw: None,
            hook_fallback: false,
            supports_native_events: adapter.supports_native_events(),
        });
    }

    let version = adapter.detect_version().await.ok();
    let (version_ok, version_raw) = match &version {
        Some(v) => {
            if matches!(v.at_or_above_minimum, Some(false) | None) {
                let _ = app.emit(
                    "version-warning",
                    serde_json::json!({
                        "harness": harness,
                        "raw": v.raw,
                        "parsed": v.parsed.as_ref().map(|p| format!("{}.{}.{}", p.major, p.minor, p.patch)),
                        "minimum": {
                            "major": adapter.minimum_version().major,
                            "minor": adapter.minimum_version().minor,
                            "patch": adapter.minimum_version().patch,
                        },
                    }),
                );
            }
            (v.at_or_above_minimum, Some(v.raw.clone()))
        }
        None => (None, None),
    };

    let mut hook_fallback = state
        .channel_event_tx
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .is_none();
    let hooks_dir = paths::hooks_dir();
    let event_sock = paths::event_socket_path();
    let home_dir = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    // Pre-declare every worktree + the project root as Codex-trusted so
    // the spawn-time managed-TOML regenerate does not wipe Codex's
    // per-path trust acceptance on each launch. `git worktree list`
    // errors (e.g. not a git repo) degrade to root-only trust.
    let worktree_paths: Vec<PathBuf> = if project_dir.as_os_str().is_empty() {
        Vec::new()
    } else {
        // `git worktree list` forks a subprocess — never on an async worker.
        let dir = project_dir.clone();
        tokio::task::spawn_blocking(move || match git_worktree_list(&dir) {
            Ok(entries) => entries.into_iter().map(|e| e.path).collect(),
            Err(e) => {
                warn!(
                    project_dir = %dir.display(),
                    error = %e,
                    "git worktree list failed; skipping worktree trust entries",
                );
                Vec::new()
            }
        })
        .await
        .unwrap_or_default()
    };
    let ctx = SetupContext::new(
        hooks_dir.clone(),
        event_sock.clone(),
        project_slug.unwrap_or_default().to_string(),
    )
    .with_project_dir(project_dir)
    .with_home_dir(home_dir)
    .with_worktree_paths(worktree_paths);

    if adapter.supports_native_events() {
        match state.harness_runtimes.plan(harness, &ctx).await {
            Ok(plan) => {
                // The executor writes + chmods files synchronously.
                let report = tokio::task::spawn_blocking(move || SetupExecutor::new().apply(&plan))
                    .await
                    .map_err(|e| format!("setup apply task failed: {e}"))?;
                state.harness_runtimes.invalidate_scan_cache();
                if !report.ok {
                    hook_fallback = true;
                    warn!(
                        harness = ?harness,
                        "setup plan has failed actions; falling back to silence heuristic",
                    );
                }
                if let Err(e) = app.emit("harness-setup-report", &report) {
                    warn!(error=%e, "harness-setup-report emit failed");
                }
            }
            Err(e) => {
                warn!(error=%e, "setup plan failed to build");
                hook_fallback = true;
                let _ = app.emit(
                    "harness-setup-report",
                    serde_json::json!({
                        "harness": harness,
                        "ok": false,
                        "actions": [],
                        "error": e.to_string(),
                    }),
                );
            }
        }

        let selftest = state.harness_runtimes.selftest(harness, &ctx).await;
        if let Err(e) = app.emit("harness-selftest-report", &selftest) {
            warn!(error=%e, "harness-selftest-report emit failed");
        }
    }

    Ok(AgentSpawnReport {
        session_id: String::new(),
        binary_missing: false,
        binary: adapter.binary_path().to_string(),
        version_ok,
        version_raw,
        hook_fallback,
        supports_native_events: adapter.supports_native_events(),
    })
}

pub fn spawn_harness_launch_refresh<R: Runtime + 'static>(
    app: AppHandle<R>,
    harness: AgentKind,
    project_slug: Option<String>,
    project_dir: PathBuf,
) {
    tauri::async_runtime::spawn(async move {
        let state: tauri::State<'_, AppHandleState> = app.state();
        if let Err(e) =
            prepare_harness_launch(&app, &state, harness, project_slug.as_deref(), project_dir)
                .await
        {
            warn!(
                harness = ?harness,
                error = %e,
                "background harness launch refresh failed"
            );
        }
    });
}

#[tauri::command]
pub async fn agent_spawn<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
    worktree_id: String,
    harness: AgentKind,
) -> Result<AgentSpawnReport, String> {
    let project_dir = resolve_project_dir(&state, Some(&project_slug), Some(&worktree_id));
    prepare_harness_launch(&app, &state, harness, Some(&project_slug), project_dir).await
}

pub(super) fn emit_missing_binary_notification<R: Runtime>(
    app: &AppHandle<R>,
    binary: &str,
    harness: AgentKind,
) {
    // §7.9 — non-blocking. We emit a webview event carrying the install hint;
    // the frontend renders this as a toast via `tauri-plugin-notification` (or
    // an inline banner, if the user denied OS notifications earlier, per §11.4).
    let install_hint = install_hint_for(harness);
    let payload = serde_json::json!({
        "harness": harness,
        "binary": binary,
        "install_hint": install_hint,
        "title": "raum: harness not installed",
        "body": format!("`{binary}` is not on $PATH.\n{install_hint}"),
    });
    if let Err(e) = app.emit("agent-binary-missing", &payload) {
        warn!(error=%e, "agent-binary-missing emit failed");
    }
}

fn install_hint_for(harness: AgentKind) -> &'static str {
    match harness {
        AgentKind::ClaudeCode => "Install Claude Code: https://docs.claude.com/en/docs/claude-code",
        AgentKind::Codex => "Install Codex: https://github.com/openai/codex",
        AgentKind::OpenCode => "Install OpenCode: https://opencode.ai",
        AgentKind::Shell => "Install a POSIX shell (sh)",
    }
}
