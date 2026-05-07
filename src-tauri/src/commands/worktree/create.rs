//! `worktree_create` plus its branch-metadata helpers and hook-execution
//! glue. The command runs the seven-step state machine that the FE
//! progress modal listens to.

use std::path::Path;
use std::process::Command;

use raum_hydration::{
    CreateOptions, HookContext, HookError, HookPhase, PatternInputs, PrefixContext,
    apply_branch_prefix, apply_hydration_async_with_progress, preview_path_pattern,
    resolve_hook_path, run_hook, validate_path_pattern, worktree_create as git_worktree_create,
};
use tauri::ipc::Channel;

use super::config_io::{
    apply_strategy_override, blocking, ensure_raum_gitignored, load_effective, os_username,
    rescan_git_watcher, target_is_inside_raum_dir,
};
use super::types::{WorktreeCreateOptions, WorktreeCreated};
use crate::commands::worktree_progress::{
    ProgressEvent, StepStatus, emit_counter, emit_done, emit_failed, emit_step, emit_step_detail,
};
use crate::state::AppHandleState;

/// Per-step labels emitted by [`worktree_create`]. Kept here (not in
/// `worktree_progress`) because they're command-specific. The frontend's
/// progress modal uses the same `id` strings as the source of truth.
const STEP_VALIDATE: (&str, &str) = ("validate", "Validating settings");
const STEP_PRE_HOOK: (&str, &str) = ("pre-hook", "Running preCreate hook");
const STEP_GIT_ADD: (&str, &str) = ("git-add", "Creating git worktree");
const STEP_BASE_META: (&str, &str) = ("base-meta", "Recording base branch");
const STEP_HYDRATE: (&str, &str) = ("hydrate", "Hydrating files");
const STEP_POST_HOOK: (&str, &str) = ("post-hook", "Running postCreate hook");
const STEP_RESCAN: (&str, &str) = ("rescan", "Refreshing git status");

/// Mark a step Failed (with detail), push a terminal `Failed` event, and
/// return the same message as the command's error string.
fn fail_step(
    channel: &Channel<ProgressEvent>,
    step: (&str, &str),
    msg: String,
) -> Result<WorktreeCreated, String> {
    emit_step_detail(channel, step.0, step.1, StepStatus::Failed, msg.clone());
    emit_failed(channel, msg.clone());
    Err(msg)
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

    // ---- Step 1: validate (synchronous, very cheap) -----------------------
    emit_step(
        &on_progress,
        STEP_VALIDATE.0,
        STEP_VALIDATE.1,
        StepStatus::Running,
    );
    let mut effective = match load_effective(&state, &project_slug) {
        Ok(e) => e,
        Err(e) => return fail_step(&on_progress, STEP_VALIDATE, e),
    };
    apply_strategy_override(
        &mut effective.worktree,
        opts.path_strategy,
        opts.path_pattern_override.as_deref(),
    );
    // Reject typos (e.g. `{root}` instead of `{repo-root}`) before we mkdir a
    // literal-token folder on disk. Preset patterns are valid by construction;
    // this really guards Custom.
    if let Err(e) = validate_path_pattern(&effective.worktree.path_pattern) {
        return fail_step(&on_progress, STEP_VALIDATE, e.to_string());
    }
    let prefix_ctx = PrefixContext {
        username: &os_username(),
    };
    let prefixed = apply_branch_prefix(&branch, &effective.worktree, &prefix_ctx);
    let project = raum_core::config::ProjectConfig {
        slug: effective.slug.clone(),
        name: effective.name.clone(),
        root_path: effective.root_path.clone(),
        worktree: effective.worktree.clone(),
        hydration: effective.hydration.clone(),
        ..raum_core::config::ProjectConfig::default()
    };
    let target = preview_path_pattern(
        &effective.worktree.path_pattern,
        &PatternInputs {
            project: &project,
            branch: &prefixed,
        },
    );
    // If the user picked the inside-project preset (target lives under
    // `<root>/.raum/…`), make sure the directory is gitignored so the worktree
    // doesn't show up in the main repo's index. Failure is never fatal — a
    // read-only repo or a project without git should still be able to create
    // worktrees.
    if target_is_inside_raum_dir(&effective.root_path, &target) {
        if let Err(e) = ensure_raum_gitignored(&effective.root_path) {
            tracing::warn!(
                root = %effective.root_path.display(),
                error = %e,
                "worktree_create: failed to update .gitignore for .raum/"
            );
        }
    }
    if let Some(parent) = target.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return fail_step(&on_progress, STEP_VALIDATE, format!("mkdir parent: {e}"));
        }
    }
    emit_step(
        &on_progress,
        STEP_VALIDATE.0,
        STEP_VALIDATE.1,
        StepStatus::Completed,
    );

    // Snapshot data we need across spawn_blocking boundaries.
    let root_path = effective.root_path.clone();
    let slug = effective.slug.clone();
    let hooks = effective.worktree.hooks.clone();
    let manifest = effective.hydration.clone();
    let timeout_secs = hooks.timeout_secs;
    let mut hooks_ran: Vec<String> = Vec::new();

    // ---- Step 2: preCreate hook ------------------------------------------
    if let Some(raw) = hooks.pre_create.as_deref() {
        emit_step(
            &on_progress,
            STEP_PRE_HOOK.0,
            STEP_PRE_HOOK.1,
            StepStatus::Running,
        );
        let script = resolve_hook_path(&root_path, raw);
        let root_for_hook = root_path.clone();
        let target_for_hook = target.clone();
        let prefixed_for_hook = prefixed.clone();
        let slug_for_hook = slug.clone();
        let res = blocking("preCreate", move || {
            let ctx = HookContext {
                project_slug: &slug_for_hook,
                project_root: &root_for_hook,
                worktree_path: &target_for_hook,
                branch: &prefixed_for_hook,
            };
            run_hook(HookPhase::PreCreate, &script, &ctx, timeout_secs)
        })
        .await;
        match res {
            Ok(Ok(_report)) => {
                emit_step(
                    &on_progress,
                    STEP_PRE_HOOK.0,
                    STEP_PRE_HOOK.1,
                    StepStatus::Completed,
                );
                hooks_ran.push("preCreate".into());
            }
            Ok(Err(hook_err)) => {
                return fail_step(
                    &on_progress,
                    STEP_PRE_HOOK,
                    format_hook_error("preCreate", &hook_err),
                );
            }
            Err(msg) => return fail_step(&on_progress, STEP_PRE_HOOK, msg),
        }
    } else {
        emit_step(
            &on_progress,
            STEP_PRE_HOOK.0,
            STEP_PRE_HOOK.1,
            StepStatus::Skipped,
        );
    }

    // ---- Step 3: git worktree add ----------------------------------------
    emit_step(
        &on_progress,
        STEP_GIT_ADD.0,
        STEP_GIT_ADD.1,
        StepStatus::Running,
    );
    {
        let root_for_git = root_path.clone();
        let target_for_git = target.clone();
        let prefixed_for_git = prefixed.clone();
        let create_branch = opts.create_branch;
        let from_ref = opts.from_ref.clone();
        let res = blocking("git worktree add", move || {
            git_worktree_create(
                &root_for_git,
                &target_for_git,
                &CreateOptions {
                    branch: prefixed_for_git,
                    create_branch,
                    from_ref,
                },
            )
        })
        .await;
        match res {
            Ok(Ok(())) => {
                emit_step(
                    &on_progress,
                    STEP_GIT_ADD.0,
                    STEP_GIT_ADD.1,
                    StepStatus::Completed,
                );
            }
            Ok(Err(e)) => {
                return fail_step(&on_progress, STEP_GIT_ADD, format!("worktree add: {e}"));
            }
            Err(msg) => return fail_step(&on_progress, STEP_GIT_ADD, msg),
        }
    }

    // ---- Step 4: persist base-branch metadata ----------------------------
    let base = opts
        .base_branch
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if opts.create_branch && base.is_some() {
        emit_step(
            &on_progress,
            STEP_BASE_META.0,
            STEP_BASE_META.1,
            StepStatus::Running,
        );
        let base_owned = base.clone().unwrap();
        let prefixed_for_meta = prefixed.clone();
        let root_for_meta = root_path.clone();
        let res = blocking("set raumBase", move || {
            set_raum_base_branch(&root_for_meta, &prefixed_for_meta, &base_owned)
        })
        .await;
        match res {
            Ok(Ok(())) => emit_step(
                &on_progress,
                STEP_BASE_META.0,
                STEP_BASE_META.1,
                StepStatus::Completed,
            ),
            Ok(Err(e)) => {
                tracing::warn!(
                    branch = %prefixed,
                    base = %base.as_deref().unwrap_or(""),
                    error = %e,
                    "worktree_create: failed to persist raumBase",
                );
                // Non-fatal — the worktree exists, sidebar falls back to upstream.
                emit_step_detail(
                    &on_progress,
                    STEP_BASE_META.0,
                    STEP_BASE_META.1,
                    StepStatus::Skipped,
                    format!("warn: {e}"),
                );
            }
            Err(msg) => {
                tracing::warn!(error = %msg, "worktree_create: set_raum_base_branch join failed");
                emit_step_detail(
                    &on_progress,
                    STEP_BASE_META.0,
                    STEP_BASE_META.1,
                    StepStatus::Skipped,
                    format!("warn: {msg}"),
                );
            }
        }
    } else {
        emit_step(
            &on_progress,
            STEP_BASE_META.0,
            STEP_BASE_META.1,
            StepStatus::Skipped,
        );
    }

    // ---- Step 5: hydrate (per-rule counter) ------------------------------
    let mut copied = 0usize;
    let mut symlinked = 0usize;
    let mut skipped = 0usize;
    if opts.skip_hydration {
        emit_step(
            &on_progress,
            STEP_HYDRATE.0,
            STEP_HYDRATE.1,
            StepStatus::Skipped,
        );
    } else {
        emit_step(
            &on_progress,
            STEP_HYDRATE.0,
            STEP_HYDRATE.1,
            StepStatus::Running,
        );
        let progress_clone = on_progress.clone();
        let res = apply_hydration_async_with_progress(
            root_path.clone(),
            target.clone(),
            manifest,
            move |cur, tot| emit_counter(&progress_clone, STEP_HYDRATE.0, cur, tot),
        )
        .await;
        match res {
            Ok(report) => {
                copied = report.copied.len();
                symlinked = report.symlinked.len();
                skipped = report.skipped.len();
                emit_step(
                    &on_progress,
                    STEP_HYDRATE.0,
                    STEP_HYDRATE.1,
                    StepStatus::Completed,
                );
            }
            Err(e) => {
                return fail_step(&on_progress, STEP_HYDRATE, format!("hydration: {e}"));
            }
        }
    }

    // ---- Step 6: postCreate hook -----------------------------------------
    if let Some(raw) = hooks.post_create.as_deref() {
        emit_step(
            &on_progress,
            STEP_POST_HOOK.0,
            STEP_POST_HOOK.1,
            StepStatus::Running,
        );
        let script = resolve_hook_path(&root_path, raw);
        let root_for_hook = root_path.clone();
        let target_for_hook = target.clone();
        let prefixed_for_hook = prefixed.clone();
        let slug_for_hook = slug.clone();
        let res = blocking("postCreate", move || {
            let ctx = HookContext {
                project_slug: &slug_for_hook,
                project_root: &root_for_hook,
                worktree_path: &target_for_hook,
                branch: &prefixed_for_hook,
            };
            run_hook(HookPhase::PostCreate, &script, &ctx, timeout_secs)
        })
        .await;
        match res {
            Ok(Ok(_report)) => {
                emit_step(
                    &on_progress,
                    STEP_POST_HOOK.0,
                    STEP_POST_HOOK.1,
                    StepStatus::Completed,
                );
                hooks_ran.push("postCreate".into());
            }
            Ok(Err(hook_err)) => {
                let msg = format!(
                    "{} (worktree was created at {} — inspect or remove manually)",
                    format_hook_error("postCreate", &hook_err),
                    target.display()
                );
                emit_step_detail(
                    &on_progress,
                    STEP_POST_HOOK.0,
                    STEP_POST_HOOK.1,
                    StepStatus::Failed,
                    msg.clone(),
                );
                // Still rescan so the watcher knows about the partial worktree.
                emit_step(
                    &on_progress,
                    STEP_RESCAN.0,
                    STEP_RESCAN.1,
                    StepStatus::Running,
                );
                rescan_git_watcher(&state, &project_slug, &root_path);
                emit_step(
                    &on_progress,
                    STEP_RESCAN.0,
                    STEP_RESCAN.1,
                    StepStatus::Completed,
                );
                emit_failed(&on_progress, msg.clone());
                return Err(msg);
            }
            Err(msg) => {
                emit_step_detail(
                    &on_progress,
                    STEP_POST_HOOK.0,
                    STEP_POST_HOOK.1,
                    StepStatus::Failed,
                    msg.clone(),
                );
                rescan_git_watcher(&state, &project_slug, &root_path);
                emit_failed(&on_progress, msg.clone());
                return Err(msg);
            }
        }
    } else {
        emit_step(
            &on_progress,
            STEP_POST_HOOK.0,
            STEP_POST_HOOK.1,
            StepStatus::Skipped,
        );
    }

    // ---- Step 7: rescan watcher ------------------------------------------
    emit_step(
        &on_progress,
        STEP_RESCAN.0,
        STEP_RESCAN.1,
        StepStatus::Running,
    );
    rescan_git_watcher(&state, &project_slug, &root_path);
    emit_step(
        &on_progress,
        STEP_RESCAN.0,
        STEP_RESCAN.1,
        StepStatus::Completed,
    );

    emit_done(&on_progress);
    Ok(WorktreeCreated {
        path: target.to_string_lossy().into_owned(),
        branch: prefixed,
        copied,
        symlinked,
        skipped,
        hooks_ran,
    })
}

pub(super) fn format_hook_error(phase: &str, err: &HookError) -> String {
    format!("hook:{phase}: {err}")
}

/// Write `branch.<name>.raumBase = <base>` in the repo's local git config so
/// the worktree list can reconstruct "sprouted from" after a restart.
pub(super) fn set_raum_base_branch(repo: &Path, branch: &str, base: &str) -> Result<(), String> {
    let key = format!("branch.{branch}.raumBase");
    let out = Command::new("git")
        .current_dir(repo)
        .args(["config", "--local", &key, base])
        .output()
        .map_err(|e| format!("spawn git config: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Read a previously-persisted `branch.<name>.raumBase` value. `None` when
/// unset, the repo is missing, or git is unavailable.
pub(super) fn get_raum_base_branch(repo: &str, branch: &str) -> Option<String> {
    let key = format!("branch.{branch}.raumBase");
    let out = Command::new("git")
        .args(["-C", repo, "config", "--local", "--get", &key])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}
