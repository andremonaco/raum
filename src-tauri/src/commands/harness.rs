//! On-demand harness setup commands (Phase 7).
//!
//! The Harness Health panel in Settings needs to render install-state
//! without waiting for the user to spawn an agent first. Two Tauri
//! commands sit in front of the adapter trio for this panel:
//!
//! * [`harness_scan_install_state`] — pure, read-only scan. Reads the
//!   managed config files for every harness and reports whether they
//!   exist + carry the `<raum-managed>` sentinel. Does not spawn any
//!   subprocesses (no version probes here — the existing
//!   `harnesses_check` already handles those).
//! * [`harness_install`] — on-demand install. Runs `plan()` +
//!   `SetupExecutor::apply()` + `selftest()` for a single harness and
//!   emits the same `harness-setup-report` + `harness-selftest-report`
//!   events as `agent_spawn`, so the frontend store updates via one
//!   code path.
//!
//! Concurrency: [`HarnessRuntimeRegistry::install`] delegates to
//! [`raum_core::harness::SetupExecutor`], which uses a tempfile +
//! atomic rename per action. A racing spawn installing the same plan
//! is therefore idempotent — worst case the rename lands twice with the
//! same bytes. No per-harness mutex is required.

use std::path::PathBuf;

use raum_core::agent::AgentKind;
use raum_core::harness::ScanReport;
use raum_core::harness::setup::{SetupContext, SetupReport};
use raum_core::paths;
use tauri::{AppHandle, Emitter, Runtime};
use tracing::warn;

use crate::commands::agent::resolve_project_dir;
use crate::state::AppHandleState;

const HARNESS_KINDS: [AgentKind; 3] =
    [AgentKind::ClaudeCode, AgentKind::OpenCode, AgentKind::Codex];

const HOME_UNSET_ERROR: &str = "could not resolve home directory ($HOME unset)";

fn resolve_home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| HOME_UNSET_ERROR.to_string())
}

fn build_context(
    _state: &tauri::State<'_, AppHandleState>,
    project_dir: &str,
) -> Result<SetupContext, String> {
    let home_dir = resolve_home_dir()?;
    let project_buf = if project_dir.is_empty() {
        PathBuf::new()
    } else {
        PathBuf::from(project_dir)
    };
    // Project slug is unused by every scan path today — the plan's only
    // slug consumer is Claude Code's settings write (driven by
    // project_dir, not slug). Pass an empty string to keep the
    // signature compact.
    Ok(SetupContext::new(
        paths::hooks_dir(),
        paths::event_socket_path(),
        String::new(),
    )
    .with_project_dir(project_buf)
    .with_home_dir(home_dir))
}

/// Scan the install state of every supported harness against
/// `project_dir`. Returns one [`ScanReport`] per harness in the
/// canonical order (Claude Code, OpenCode, Codex).
#[tauri::command]
pub fn harness_scan_install_state(
    state: tauri::State<'_, AppHandleState>,
    project_dir: Option<String>,
) -> Result<Vec<ScanReport>, String> {
    let dir = project_dir.unwrap_or_default();
    let ctx = build_context(&state, &dir)?;
    Ok(HARNESS_KINDS
        .iter()
        .map(|k| state.harness_runtimes.scan(*k, &ctx))
        .collect())
}

/// Run the setup plan for a single harness on demand. Emits
/// `harness-setup-report` and `harness-selftest-report` events so the
/// frontend store converges on the same state as a spawn install.
#[tauri::command]
pub async fn harness_install<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    harness: AgentKind,
    project_slug: Option<String>,
    worktree_id: Option<String>,
) -> Result<SetupReport, String> {
    // Resolve the project directory the same way `agent_spawn` does so
    // the install lands under the correct `.claude/` / `.codex/` tree.
    let project_dir = resolve_project_dir(&state, project_slug.as_deref(), worktree_id.as_deref());
    let home_dir = resolve_home_dir()?;
    let slug = project_slug.clone().unwrap_or_default();
    let ctx = SetupContext::new(paths::hooks_dir(), paths::event_socket_path(), slug)
        .with_project_dir(project_dir)
        .with_home_dir(home_dir);

    let report = state
        .harness_runtimes
        .install(harness, &ctx)
        .await
        .map_err(|e| e.to_string())?;
    if let Err(e) = app.emit("harness-setup-report", &report) {
        warn!(error = %e, "harness-setup-report emit failed");
    }

    // Selftest afterwards so the UI can pick up a fresh pass/fail on
    // the just-written plan.
    let selftest = state.harness_runtimes.selftest(harness, &ctx).await;
    if let Err(e) = app.emit("harness-selftest-report", &selftest) {
        warn!(error = %e, "harness-selftest-report emit failed");
    }

    Ok(report)
}
