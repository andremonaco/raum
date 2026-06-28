//! `worktree_merge_preview` + `worktree_merge` — read-only conflict probe
//! and the actual merge → optional cleanup state machine.

use std::path::Path;
use std::process::Command;

use raum_hydration::{
    get_raum_base_branch, worktree_list as git_worktree_list,
    worktree_remove as git_worktree_remove,
};
use tauri::ipc::Channel;

use super::branches::ahead_behind;
use super::config_io::{blocking, load_effective, rescan_git_watcher};
use super::remove::{delete_local_branch, sessions_for_worktree_strs};
use super::status::is_dirty;
use super::status_service::trigger_status_refresh;
use super::types::WorktreeMergePreview;
use crate::commands::terminal::kill_session_inner;
use crate::commands::worktree_progress::{
    ProgressEvent, StepStatus, emit_counter, emit_done, emit_failed, emit_step, emit_step_detail,
};
use crate::state::AppHandleState;

/// Resolve the "sprouted-from" base branch for `source_branch` checked out at
/// `source_path`. Mirrors the FE's `resolveBaseBranchLabel` order so the
/// preview, label, and merge agree on the same target.
fn resolve_target_branch(
    repo_root: &str,
    source_path: &str,
    source_branch: &str,
    main_branch: Option<&str>,
) -> Option<String> {
    if let Some(b) = get_raum_base_branch(repo_root, source_branch) {
        if b != source_branch {
            return Some(b);
        }
    }
    // Upstream of source — read via `git -C <source_path> rev-parse`.
    let upstream = Command::new("git")
        .args([
            "-C",
            source_path,
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(up) = upstream {
        let stripped = up.trim_start_matches("origin/").to_string();
        if !stripped.is_empty() && stripped != source_branch {
            return Some(stripped);
        }
    }
    main_branch
        .filter(|b| !b.is_empty() && *b != source_branch)
        .map(|s| s.to_string())
}

/// Find the worktree path where `branch` is currently checked out. `None`
/// when the branch is dangling (no checkout) or git fails.
fn worktree_path_for_branch(repo_root: &Path, branch: &str) -> Option<String> {
    let entries = git_worktree_list(repo_root).ok()?;
    entries
        .into_iter()
        .find(|e| e.branch.as_deref() == Some(branch))
        .map(|e| e.path.to_string_lossy().into_owned())
}

/// Detect conflicts via `git merge-tree`. Modern syntax (git ≥ 2.38):
///   `git merge-tree --write-tree --name-only --no-messages <target> <source>`
/// On clean merge: exit 0, prints tree OID.
/// On conflict: exit 1, prints tree OID then a list of conflicting paths.
/// We split on newlines and discard the first line (always a 40-char hex OID
/// when output is non-empty).
fn detect_conflicts(repo: &str, target: &str, source: &str) -> Result<Vec<String>, String> {
    let out = Command::new("git")
        .args([
            "-C",
            repo,
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            target,
            source,
        ])
        .output()
        .map_err(|e| format!("git merge-tree: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let code = out.status.code().unwrap_or(-1);
    // Exit 0 → clean. Exit 1 → conflicts. Higher → real error.
    if code == 0 {
        return Ok(Vec::new());
    }
    if code != 1 {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("merge-tree exit {code}: {stderr}"));
    }
    let mut lines = stdout.lines();
    // First line is the (conflicted) tree OID — drop it.
    let _ = lines.next();
    Ok(lines
        .filter(|l| !l.is_empty())
        .map(|s| s.to_string())
        .collect())
}

/// True when `target` is reachable from `source` — i.e. fast-forwarding the
/// other direction is possible. Used to phrase the merge as "fast-forward" vs
/// "merge commit".
fn is_ancestor(repo: &str, ancestor: &str, descendant: &str) -> bool {
    Command::new("git")
        .args([
            "-C",
            repo,
            "merge-base",
            "--is-ancestor",
            ancestor,
            descendant,
        ])
        .status()
        .is_ok_and(|s| s.success())
}

#[tauri::command]
pub async fn worktree_merge_preview(
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
    path: String,
) -> Result<WorktreeMergePreview, String> {
    let effective = load_effective(&state, &project_slug)?;
    let repo_root = effective.root_path.clone();
    let repo_root_str = repo_root.to_string_lossy().into_owned();
    let source_path = path.clone();

    blocking("worktree_merge_preview", move || {
        let entries = match git_worktree_list(&repo_root) {
            Ok(e) => e,
            Err(e) => {
                return WorktreeMergePreview {
                    source_branch: None,
                    target_branch: None,
                    target_worktree_path: None,
                    target_checked_out: false,
                    source_dirty: false,
                    target_dirty: false,
                    ahead: 0,
                    behind: 0,
                    can_fast_forward: false,
                    conflicts: Vec::new(),
                    already_merged: false,
                    error: Some(format!("worktree list: {e}")),
                };
            }
        };

        let source_branch = entries
            .iter()
            .find(|e| e.path.to_string_lossy() == source_path)
            .and_then(|e| e.branch.clone());

        let main_branch = entries
            .iter()
            .find(|e| e.path == repo_root)
            .and_then(|e| e.branch.clone());

        let Some(source_branch) = source_branch else {
            return WorktreeMergePreview {
                source_branch: None,
                target_branch: None,
                target_worktree_path: None,
                target_checked_out: false,
                source_dirty: false,
                target_dirty: false,
                ahead: 0,
                behind: 0,
                can_fast_forward: false,
                conflicts: Vec::new(),
                already_merged: false,
                error: Some("Source worktree is detached — nothing to merge.".into()),
            };
        };

        let target_branch = resolve_target_branch(
            &repo_root_str,
            &source_path,
            &source_branch,
            main_branch.as_deref(),
        );

        let Some(target_branch) = target_branch else {
            return WorktreeMergePreview {
                source_branch: Some(source_branch),
                target_branch: None,
                target_worktree_path: None,
                target_checked_out: false,
                source_dirty: false,
                target_dirty: false,
                ahead: 0,
                behind: 0,
                can_fast_forward: false,
                conflicts: Vec::new(),
                already_merged: false,
                error: Some("No base branch configured for this worktree.".into()),
            };
        };

        let target_worktree_path = worktree_path_for_branch(&repo_root, &target_branch);
        let target_checked_out = target_worktree_path.is_some();

        let source_dirty = is_dirty(&source_path);
        let target_dirty = target_worktree_path.as_ref().is_some_and(|p| is_dirty(p));

        let (ahead, behind) = ahead_behind(&repo_root_str, &target_branch, &source_branch);
        let already_merged = ahead == 0;
        let can_fast_forward = is_ancestor(&repo_root_str, &target_branch, &source_branch);

        let conflicts = if already_merged {
            Vec::new()
        } else {
            detect_conflicts(&repo_root_str, &target_branch, &source_branch).unwrap_or_default()
        };

        WorktreeMergePreview {
            source_branch: Some(source_branch),
            target_branch: Some(target_branch),
            target_worktree_path,
            target_checked_out,
            source_dirty,
            target_dirty,
            ahead,
            behind,
            can_fast_forward,
            conflicts,
            already_merged,
            error: None,
        }
    })
    .await
}

/// Per-step labels emitted by [`worktree_merge`]. The FE step list keys off
/// these ids in the same way it does for the create/remove channels.
const MERGE_STEP_PRECHECK: (&str, &str) = ("precheck", "Checking merge readiness");
const MERGE_STEP_KILL: (&str, &str) = ("kill-terminals", "Stopping terminals");
const MERGE_STEP_MERGE: (&str, &str) = ("merge", "Merging branch");
const MERGE_STEP_REMOVE_WT: (&str, &str) = ("remove-worktree", "Removing worktree folder");
const MERGE_STEP_DELETE_BRANCH: (&str, &str) = ("delete-branch", "Deleting source branch");
const MERGE_STEP_RESCAN: (&str, &str) = ("rescan", "Refreshing git status");

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn worktree_merge<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
    path: String,
    delete_branch: Option<bool>,
    remove_worktree: Option<bool>,
    on_progress: Channel<ProgressEvent>,
) -> Result<(), String> {
    let effective = match load_effective(&state, &project_slug) {
        Ok(e) => e,
        Err(e) => {
            emit_step_detail(
                &on_progress,
                MERGE_STEP_PRECHECK.0,
                MERGE_STEP_PRECHECK.1,
                StepStatus::Failed,
                e.clone(),
            );
            emit_failed(&on_progress, e.clone());
            return Err(e);
        }
    };
    let repo_root = effective.root_path.clone();
    let repo_root_str = repo_root.to_string_lossy().into_owned();
    let delete_branch = delete_branch.unwrap_or(false);
    let remove_worktree = remove_worktree.unwrap_or(false);

    // ---- Step 1: precheck — re-derive target, verify clean & no conflicts.
    emit_step(
        &on_progress,
        MERGE_STEP_PRECHECK.0,
        MERGE_STEP_PRECHECK.1,
        StepStatus::Running,
    );
    let preview = {
        let repo = repo_root.clone();
        let p = path.clone();
        let root_str = repo_root_str.clone();
        match blocking("merge precheck", move || {
            let entries = git_worktree_list(&repo).map_err(|e| format!("worktree list: {e}"))?;
            let source_branch = entries
                .iter()
                .find(|e| e.path.to_string_lossy() == p)
                .and_then(|e| e.branch.clone())
                .ok_or_else(|| "source worktree is detached".to_string())?;
            let main_branch = entries
                .iter()
                .find(|e| e.path == repo)
                .and_then(|e| e.branch.clone());
            let target_branch =
                resolve_target_branch(&root_str, &p, &source_branch, main_branch.as_deref())
                    .ok_or_else(|| "no base branch configured for this worktree".to_string())?;
            let target_path = worktree_path_for_branch(&repo, &target_branch).ok_or_else(|| {
                format!("base branch `{target_branch}` is not checked out in any worktree")
            })?;
            Ok::<_, String>((source_branch, target_branch, target_path))
        })
        .await
        {
            Ok(Ok(t)) => t,
            Ok(Err(e)) | Err(e) => {
                emit_step_detail(
                    &on_progress,
                    MERGE_STEP_PRECHECK.0,
                    MERGE_STEP_PRECHECK.1,
                    StepStatus::Failed,
                    e.clone(),
                );
                emit_failed(&on_progress, e.clone());
                return Err(e);
            }
        }
    };
    let (source_branch, target_branch, target_path) = preview;

    // Re-verify clean state and no conflicts at the moment of merge — the
    // preview can be stale if the user edited files between opening the
    // dialog and clicking the button.
    {
        let p = path.clone();
        let tp = target_path.clone();
        let root_str = repo_root_str.clone();
        let tb = target_branch.clone();
        let sb = source_branch.clone();
        let res = blocking("merge guards", move || {
            if is_dirty(&p) {
                return Err("source worktree has uncommitted changes".to_string());
            }
            if is_dirty(&tp) {
                return Err(format!("target worktree (`{tb}`) has uncommitted changes"));
            }
            let conflicts = detect_conflicts(&root_str, &tb, &sb).unwrap_or_default();
            if !conflicts.is_empty() {
                return Err(format!(
                    "{} file{} would conflict — resolve manually first",
                    conflicts.len(),
                    if conflicts.len() == 1 { "" } else { "s" }
                ));
            }
            Ok(())
        })
        .await;
        match res {
            Ok(Ok(())) => emit_step(
                &on_progress,
                MERGE_STEP_PRECHECK.0,
                MERGE_STEP_PRECHECK.1,
                StepStatus::Completed,
            ),
            Ok(Err(e)) | Err(e) => {
                emit_step_detail(
                    &on_progress,
                    MERGE_STEP_PRECHECK.0,
                    MERGE_STEP_PRECHECK.1,
                    StepStatus::Failed,
                    e.clone(),
                );
                emit_failed(&on_progress, e.clone());
                return Err(e);
            }
        }
    }

    // ---- Step 2: kill terminals (only when we'll remove the source folder).
    let session_ids = if remove_worktree {
        sessions_for_worktree_strs(&state, &path)
    } else {
        Vec::new()
    };
    if session_ids.is_empty() {
        emit_step(
            &on_progress,
            MERGE_STEP_KILL.0,
            MERGE_STEP_KILL.1,
            StepStatus::Skipped,
        );
    } else {
        let label = format!(
            "Stopping {} terminal{}",
            session_ids.len(),
            if session_ids.len() == 1 { "" } else { "s" }
        );
        emit_step(&on_progress, MERGE_STEP_KILL.0, &label, StepStatus::Running);
        let total = session_ids.len() as u64;
        for (i, sid) in session_ids.iter().enumerate() {
            if let Err(e) = kill_session_inner(&app, &state, sid).await {
                tracing::warn!(session_id = %sid, error = %e, "worktree_merge: terminal kill failed");
            }
            emit_counter(&on_progress, MERGE_STEP_KILL.0, (i + 1) as u64, total);
        }
        emit_step(
            &on_progress,
            MERGE_STEP_KILL.0,
            &label,
            StepStatus::Completed,
        );
    }

    // ---- Step 3: actually merge in the target worktree --------------------
    emit_step(
        &on_progress,
        MERGE_STEP_MERGE.0,
        MERGE_STEP_MERGE.1,
        StepStatus::Running,
    );
    {
        let tp = target_path.clone();
        let sb = source_branch.clone();
        let tb = target_branch.clone();
        let res = blocking("git merge", move || {
            let msg = format!("Merge branch '{sb}' into {tb}");
            let out = Command::new("git")
                .args(["-C", &tp, "merge", "--no-edit", "-m", &msg, &sb])
                .output()
                .map_err(|e| format!("spawn git merge: {e}"))?;
            if out.status.success() {
                return Ok::<(), String>(());
            }
            // Best-effort abort so we don't leave the target in a half-merged state.
            let _ = Command::new("git")
                .args(["-C", &tp, "merge", "--abort"])
                .output();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if stderr.is_empty() {
                "git merge failed".into()
            } else {
                stderr
            })
        })
        .await;
        match res {
            Ok(Ok(())) => emit_step(
                &on_progress,
                MERGE_STEP_MERGE.0,
                MERGE_STEP_MERGE.1,
                StepStatus::Completed,
            ),
            Ok(Err(e)) | Err(e) => {
                emit_step_detail(
                    &on_progress,
                    MERGE_STEP_MERGE.0,
                    MERGE_STEP_MERGE.1,
                    StepStatus::Failed,
                    e.clone(),
                );
                emit_failed(&on_progress, e.clone());
                return Err(e);
            }
        }
    }

    // ---- Step 4: remove the source worktree folder (optional) -------------
    if remove_worktree {
        emit_step(
            &on_progress,
            MERGE_STEP_REMOVE_WT.0,
            MERGE_STEP_REMOVE_WT.1,
            StepStatus::Running,
        );
        let root = repo_root.clone();
        let p = path.clone();
        let res = blocking("git worktree remove", move || {
            git_worktree_remove(&root, Path::new(&p), false)
        })
        .await;
        match res {
            Ok(Ok(())) => emit_step(
                &on_progress,
                MERGE_STEP_REMOVE_WT.0,
                MERGE_STEP_REMOVE_WT.1,
                StepStatus::Completed,
            ),
            Ok(Err(e)) => {
                let msg = format!("remove: {e}");
                emit_step_detail(
                    &on_progress,
                    MERGE_STEP_REMOVE_WT.0,
                    MERGE_STEP_REMOVE_WT.1,
                    StepStatus::Failed,
                    msg.clone(),
                );
                emit_failed(&on_progress, msg.clone());
                return Err(msg);
            }
            Err(msg) => {
                emit_step_detail(
                    &on_progress,
                    MERGE_STEP_REMOVE_WT.0,
                    MERGE_STEP_REMOVE_WT.1,
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
            MERGE_STEP_REMOVE_WT.0,
            MERGE_STEP_REMOVE_WT.1,
            StepStatus::Skipped,
        );
    }

    // ---- Step 5: delete source branch (optional, only after a successful merge).
    if delete_branch {
        emit_step(
            &on_progress,
            MERGE_STEP_DELETE_BRANCH.0,
            MERGE_STEP_DELETE_BRANCH.1,
            StepStatus::Running,
        );
        let root = repo_root.clone();
        let sb = source_branch.clone();
        let res = blocking("delete_local_branch", move || {
            // `-d` (not `-D`): the branch was just merged so the safe form
            // succeeds. If something raced in to add unmerged commits we
            // surface the failure rather than silently force-deleting.
            delete_local_branch(&root, &sb, false)
        })
        .await;
        match res {
            Ok(Ok(())) => emit_step(
                &on_progress,
                MERGE_STEP_DELETE_BRANCH.0,
                MERGE_STEP_DELETE_BRANCH.1,
                StepStatus::Completed,
            ),
            Ok(Err(e)) => {
                let msg = format!("delete branch {source_branch}: {e}");
                emit_step_detail(
                    &on_progress,
                    MERGE_STEP_DELETE_BRANCH.0,
                    MERGE_STEP_DELETE_BRANCH.1,
                    StepStatus::Failed,
                    msg.clone(),
                );
                // Don't bail out — the merge itself succeeded; the branch
                // simply lingers. Continue to rescan so the FE refreshes.
            }
            Err(msg) => {
                emit_step_detail(
                    &on_progress,
                    MERGE_STEP_DELETE_BRANCH.0,
                    MERGE_STEP_DELETE_BRANCH.1,
                    StepStatus::Failed,
                    msg.clone(),
                );
            }
        }
    } else {
        emit_step(
            &on_progress,
            MERGE_STEP_DELETE_BRANCH.0,
            MERGE_STEP_DELETE_BRANCH.1,
            StepStatus::Skipped,
        );
    }

    // ---- Step 6: rescan watcher ------------------------------------------
    emit_step(
        &on_progress,
        MERGE_STEP_RESCAN.0,
        MERGE_STEP_RESCAN.1,
        StepStatus::Running,
    );
    rescan_git_watcher(&state, &project_slug, &repo_root);
    // The merge mutated the target worktree (and possibly removed the
    // source); nudge both so subscribed sidebar rows update immediately.
    trigger_status_refresh(&state, &target_path);
    trigger_status_refresh(&state, &path);
    emit_step(
        &on_progress,
        MERGE_STEP_RESCAN.0,
        MERGE_STEP_RESCAN.1,
        StepStatus::Completed,
    );

    emit_done(&on_progress);
    Ok(())
}
