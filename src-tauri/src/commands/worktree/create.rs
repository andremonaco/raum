//! `worktree_create` — the Tauri command wrapper around the shared
//! [`raum_hydration::create_worktree`] orchestrator. The orchestrator runs the
//! validate → preCreate → git add → base-meta → hydrate → postCreate sequence
//! on the blocking pool; this wrapper resolves the effective config, forwards
//! progress onto the per-invocation IPC `Channel`, and appends the app-specific
//! `rescan` step (git-watcher refresh).

use raum_hydration::{CreateParams, Progress, create_worktree as run_create_worktree};
use tauri::ipc::Channel;

use super::config_io::{
    apply_strategy_override, blocking, load_effective, os_username, rescan_git_watcher,
};
use super::types::{WorktreeCreateOptions, WorktreeCreated};
use crate::commands::worktree_progress::{
    ProgressEvent, StepStatus, emit_counter, emit_done, emit_failed, emit_step, emit_step_detail,
};
use crate::state::AppHandleState;

/// First/last steps owned by the wrapper. `validate` is also emitted by the
/// orchestrator; we only emit it here for a config-load failure (which happens
/// before the orchestrator runs). `rescan` is app-specific and always ours.
const STEP_VALIDATE: (&str, &str) = ("validate", "Validating settings");
const STEP_RESCAN: (&str, &str) = ("rescan", "Refreshing git status");

/// Translate the orchestrator's transport-agnostic [`Progress`] into IPC events.
fn forward(channel: &Channel<ProgressEvent>, p: Progress) {
    match p {
        Progress::Step {
            id,
            label,
            status,
            detail,
        } => {
            let st = map_status(status);
            match detail {
                Some(d) => emit_step_detail(channel, id, label, st, d),
                None => emit_step(channel, id, label, st),
            }
        }
        Progress::Counter { id, current, total } => emit_counter(channel, id, current, total),
    }
}

fn map_status(s: raum_hydration::StepStatus) -> StepStatus {
    match s {
        raum_hydration::StepStatus::Running => StepStatus::Running,
        raum_hydration::StepStatus::Completed => StepStatus::Completed,
        raum_hydration::StepStatus::Skipped => StepStatus::Skipped,
        raum_hydration::StepStatus::Failed => StepStatus::Failed,
    }
}

#[tauri::command]
pub async fn worktree_create(
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
    branch: String,
    options: Option<WorktreeCreateOptions>,
    on_progress: Channel<ProgressEvent>,
) -> Result<WorktreeCreated, String> {
    let opts = options.unwrap_or(WorktreeCreateOptions {
        create_branch: true,
        from_ref: None,
        base_branch: None,
        skip_hydration: false,
        path_strategy: None,
        path_pattern_override: None,
    });

    // Resolve the effective config (needs the ConfigStore, so it stays on the
    // async side). A config-load failure surfaces as a failed "validate" step.
    let mut effective = match load_effective(&state, &project_slug) {
        Ok(e) => e,
        Err(e) => {
            emit_step_detail(
                &on_progress,
                STEP_VALIDATE.0,
                STEP_VALIDATE.1,
                StepStatus::Failed,
                e.clone(),
            );
            emit_failed(&on_progress, e.clone());
            return Err(e);
        }
    };
    apply_strategy_override(
        &mut effective.worktree,
        opts.path_strategy,
        opts.path_pattern_override.as_deref(),
    );

    let params = CreateParams {
        branch,
        create_branch: opts.create_branch,
        from_ref: opts.from_ref,
        base_branch: opts.base_branch,
        skip_hydration: opts.skip_hydration,
        username: os_username(),
    };
    let worktree_cfg = effective.worktree.clone();
    let manifest = effective.hydration.clone();
    let root = effective.root_path.clone();
    let root_for_rescan = effective.root_path.clone();
    let slug = effective.slug.clone();

    let channel = on_progress.clone();
    let outcome = blocking("worktree create", move || {
        let mut cb = |p: Progress| forward(&channel, p);
        run_create_worktree(&slug, &root, &worktree_cfg, &manifest, &params, &mut cb)
    })
    .await;

    match outcome {
        Ok(Ok(report)) => {
            emit_step(
                &on_progress,
                STEP_RESCAN.0,
                STEP_RESCAN.1,
                StepStatus::Running,
            );
            rescan_git_watcher(&state, &project_slug, &root_for_rescan);
            emit_step(
                &on_progress,
                STEP_RESCAN.0,
                STEP_RESCAN.1,
                StepStatus::Completed,
            );
            emit_done(&on_progress);
            Ok(WorktreeCreated {
                path: report.path.to_string_lossy().into_owned(),
                branch: report.branch,
                copied: report.copied,
                symlinked: report.symlinked,
                skipped: report.skipped,
                hooks_ran: report.hooks_ran,
            })
        }
        Ok(Err(err)) => {
            // The orchestrator already emitted the failed step event. Rescan
            // only when the worktree exists on disk (postCreate hook failure).
            if err.worktree_created() {
                emit_step(
                    &on_progress,
                    STEP_RESCAN.0,
                    STEP_RESCAN.1,
                    StepStatus::Running,
                );
                rescan_git_watcher(&state, &project_slug, &root_for_rescan);
                emit_step(
                    &on_progress,
                    STEP_RESCAN.0,
                    STEP_RESCAN.1,
                    StepStatus::Completed,
                );
            }
            let msg = err.message().to_string();
            emit_failed(&on_progress, msg.clone());
            Err(msg)
        }
        Err(join_msg) => {
            emit_failed(&on_progress, join_msg.clone());
            Err(join_msg)
        }
    }
}
