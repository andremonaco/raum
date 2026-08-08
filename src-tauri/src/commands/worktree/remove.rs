//! `worktree_remove` — kill terminals, drop stashes, then `git worktree
//! remove`. Owns the `delete_local_branch` / `drop_stashes_for_branch`
//! helpers reused by `worktree_merge`.

use std::path::Path;

use raum_hydration::worktree_remove as git_worktree_remove;
use tauri::ipc::Channel;

use super::branches::worktree_branch_at_path;
use super::config_io::{blocking, load_effective, rescan_git_watcher};
use crate::commands::terminal::kill_session_inner;
use crate::commands::worktree_progress::{
    ProgressEvent, StepStatus, emit_counter, emit_done, emit_failed, emit_step, emit_step_detail,
};
use crate::git::{git_bare, git_cmd};
use crate::state::AppHandleState;

/// Per-step labels emitted by [`worktree_remove`]. Same id contract as the
/// create-side constants — the FE step list keys off these.
const REMOVE_STEP_KILL: (&str, &str) = ("kill-terminals", "Stopping terminals");
const REMOVE_STEP_STASH: (&str, &str) = ("drop-stashes", "Dropping branch stashes");
const REMOVE_STEP_GIT_REMOVE: (&str, &str) = ("git-remove", "Removing git worktree");
const REMOVE_STEP_DELETE_BRANCH: (&str, &str) = ("delete-branch", "Deleting local branch");
const REMOVE_STEP_RESCAN: (&str, &str) = ("rescan", "Refreshing git status");

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn worktree_remove<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
    path: String,
    force: bool,
    delete_branch: Option<bool>,
    force_delete_branch: Option<bool>,
    clear_stash: Option<bool>,
    on_progress: Channel<ProgressEvent>,
) -> Result<(), String> {
    // Cheap synchronous prep — load config under the lock.
    let effective = match load_effective(&state, &project_slug) {
        Ok(e) => e,
        Err(e) => {
            emit_step_detail(
                &on_progress,
                REMOVE_STEP_KILL.0,
                REMOVE_STEP_KILL.1,
                StepStatus::Failed,
                e.clone(),
            );
            emit_failed(&on_progress, e.clone());
            return Err(e);
        }
    };
    let root_path = effective.root_path.clone();

    // ---- Step 1: kill any terminals attached to this worktree ------------
    let session_ids = sessions_for_worktree_strs(&state, &path);
    if session_ids.is_empty() {
        emit_step(
            &on_progress,
            REMOVE_STEP_KILL.0,
            REMOVE_STEP_KILL.1,
            StepStatus::Skipped,
        );
    } else {
        let label = format!(
            "Stopping {} terminal{}",
            session_ids.len(),
            if session_ids.len() == 1 { "" } else { "s" }
        );
        emit_step(
            &on_progress,
            REMOVE_STEP_KILL.0,
            &label,
            StepStatus::Running,
        );
        let total = session_ids.len() as u64;
        for (i, sid) in session_ids.iter().enumerate() {
            // Best-effort — a stuck kill shouldn't block worktree removal.
            if let Err(e) = kill_session_inner(&app, &state, sid).await {
                tracing::warn!(session_id = %sid, error = %e, "worktree_remove: terminal kill failed");
            }
            emit_counter(&on_progress, REMOVE_STEP_KILL.0, (i + 1) as u64, total);
        }
        emit_step(
            &on_progress,
            REMOVE_STEP_KILL.0,
            &label,
            StepStatus::Completed,
        );
    }

    // Resolve the branch name for the worktree before we blow it away —
    // after `git worktree remove`, the branch info is only reachable via the
    // bare repository.
    let branch_to_delete: Option<String> = if delete_branch.unwrap_or(false) {
        let root = root_path.clone();
        let p = path.clone();
        blocking("worktree_branch_at_path", move || {
            worktree_branch_at_path(&root, Path::new(&p))
        })
        .await
        .ok()
        .flatten()
    } else {
        None
    };

    // ---- Step 2: drop stashes for the branch -----------------------------
    if clear_stash.unwrap_or(false) {
        emit_step(
            &on_progress,
            REMOVE_STEP_STASH.0,
            REMOVE_STEP_STASH.1,
            StepStatus::Running,
        );
        let root = root_path.clone();
        let p = path.clone();
        let resolved_branch = blocking("resolve branch", move || {
            worktree_branch_at_path(&root, Path::new(&p))
        })
        .await
        .ok()
        .flatten();
        if let Some(branch) = resolved_branch {
            let p2 = path.clone();
            let _ = blocking("drop_stashes_for_branch", move || {
                drop_stashes_for_branch(&p2, &branch);
            })
            .await;
        }
        emit_step(
            &on_progress,
            REMOVE_STEP_STASH.0,
            REMOVE_STEP_STASH.1,
            StepStatus::Completed,
        );
    } else {
        emit_step(
            &on_progress,
            REMOVE_STEP_STASH.0,
            REMOVE_STEP_STASH.1,
            StepStatus::Skipped,
        );
    }

    // ---- Step 3: git worktree remove -------------------------------------
    emit_step(
        &on_progress,
        REMOVE_STEP_GIT_REMOVE.0,
        REMOVE_STEP_GIT_REMOVE.1,
        StepStatus::Running,
    );
    {
        let root = root_path.clone();
        let p = path.clone();
        let res = blocking("git worktree remove", move || {
            git_worktree_remove(&root, Path::new(&p), force)
        })
        .await;
        match res {
            Ok(Ok(())) => emit_step(
                &on_progress,
                REMOVE_STEP_GIT_REMOVE.0,
                REMOVE_STEP_GIT_REMOVE.1,
                StepStatus::Completed,
            ),
            Ok(Err(e)) => {
                let msg = format!("remove: {e}");
                emit_step_detail(
                    &on_progress,
                    REMOVE_STEP_GIT_REMOVE.0,
                    REMOVE_STEP_GIT_REMOVE.1,
                    StepStatus::Failed,
                    msg.clone(),
                );
                emit_failed(&on_progress, msg.clone());
                return Err(msg);
            }
            Err(msg) => {
                emit_step_detail(
                    &on_progress,
                    REMOVE_STEP_GIT_REMOVE.0,
                    REMOVE_STEP_GIT_REMOVE.1,
                    StepStatus::Failed,
                    msg.clone(),
                );
                emit_failed(&on_progress, msg.clone());
                return Err(msg);
            }
        }
    }

    // ---- Step 4: delete local branch -------------------------------------
    if let Some(branch) = branch_to_delete {
        emit_step(
            &on_progress,
            REMOVE_STEP_DELETE_BRANCH.0,
            REMOVE_STEP_DELETE_BRANCH.1,
            StepStatus::Running,
        );
        let force_branch = force_delete_branch.unwrap_or(false);
        let root = root_path.clone();
        let branch_for_call = branch.clone();
        let res = blocking("delete_local_branch", move || {
            delete_local_branch(&root, &branch_for_call, force_branch)
        })
        .await;
        match res {
            Ok(Ok(())) => emit_step(
                &on_progress,
                REMOVE_STEP_DELETE_BRANCH.0,
                REMOVE_STEP_DELETE_BRANCH.1,
                StepStatus::Completed,
            ),
            Ok(Err(e)) => {
                // Worktree is gone but the branch lingers — surface so the user
                // can clean up. Still rescan first.
                let msg = format!("delete branch {branch}: {e}");
                emit_step_detail(
                    &on_progress,
                    REMOVE_STEP_DELETE_BRANCH.0,
                    REMOVE_STEP_DELETE_BRANCH.1,
                    StepStatus::Failed,
                    msg.clone(),
                );
                emit_step(
                    &on_progress,
                    REMOVE_STEP_RESCAN.0,
                    REMOVE_STEP_RESCAN.1,
                    StepStatus::Running,
                );
                rescan_git_watcher(&state, &project_slug, &root_path);
                emit_step(
                    &on_progress,
                    REMOVE_STEP_RESCAN.0,
                    REMOVE_STEP_RESCAN.1,
                    StepStatus::Completed,
                );
                emit_failed(&on_progress, msg.clone());
                return Err(msg);
            }
            Err(msg) => {
                emit_step_detail(
                    &on_progress,
                    REMOVE_STEP_DELETE_BRANCH.0,
                    REMOVE_STEP_DELETE_BRANCH.1,
                    StepStatus::Failed,
                    msg.clone(),
                );
                emit_failed(&on_progress, msg.clone());
                return Err(msg);
            }
        }
    } else {
        emit_step(
            &on_progress,
            REMOVE_STEP_DELETE_BRANCH.0,
            REMOVE_STEP_DELETE_BRANCH.1,
            StepStatus::Skipped,
        );
    }

    // ---- Step 5: rescan watcher ------------------------------------------
    emit_step(
        &on_progress,
        REMOVE_STEP_RESCAN.0,
        REMOVE_STEP_RESCAN.1,
        StepStatus::Running,
    );
    rescan_git_watcher(&state, &project_slug, &root_path);
    emit_step(
        &on_progress,
        REMOVE_STEP_RESCAN.0,
        REMOVE_STEP_RESCAN.1,
        StepStatus::Completed,
    );

    emit_done(&on_progress);
    Ok(())
}

/// Thin wrapper so callers don't have to think about owned Strings vs the
/// Vec returned by [`crate::commands::terminal::sessions_for_worktree`].
pub(super) fn sessions_for_worktree_strs(
    state: &tauri::State<'_, AppHandleState>,
    worktree_path: &str,
) -> Vec<String> {
    crate::commands::terminal::sessions_for_worktree(state, worktree_path)
}

/// Drop every stash entry whose recorded branch matches `branch`. We scan
/// `git stash list` top-to-bottom to get stable `stash@{N}` refs, then drop
/// the matching entries from the bottom up so indexes stay valid. Best-
/// effort: errors are ignored (worst case the stash stays; no data loss).
pub(super) fn drop_stashes_for_branch(worktree_path: &str, branch: &str) {
    let Ok(out) = git_cmd(worktree_path).args(["stash", "list"]).output() else {
        return;
    };
    if !out.status.success() {
        return;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let wip_tag = format!("WIP on {branch}:");
    let on_tag = format!("On {branch}:");
    let mut indexes: Vec<usize> = Vec::new();
    for (idx, line) in s.lines().enumerate() {
        if line.contains(&wip_tag) || line.contains(&on_tag) {
            indexes.push(idx);
        }
    }
    // Drop from the highest index down so each `stash@{N}` stays valid.
    for idx in indexes.into_iter().rev() {
        let reference = format!("stash@{{{idx}}}");
        let _ = git_cmd(worktree_path)
            .args(["stash", "drop", &reference])
            .output();
    }
}

/// Delete a local branch in the main repo. `force = true` maps to
/// `git branch -D`; otherwise `git branch -d` (which refuses unmerged
/// branches).
pub(super) fn delete_local_branch(repo: &Path, branch: &str, force: bool) -> Result<(), String> {
    let flag = if force { "-D" } else { "-d" };
    let out = git_bare()
        .current_dir(repo)
        .args(["branch", flag, branch])
        .output()
        .map_err(|e| format!("spawn git branch: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}
