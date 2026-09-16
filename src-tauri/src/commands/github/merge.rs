//! Repo merge policy and one-click merge.
//!
//! The policy lookup tells the merge sheet which methods the repo actually
//! allows, whether it deletes the head branch on merge, and whether auto-merge
//! is switched on — a sheet that offers a method GitHub will reject is worse
//! than no sheet at all.
//!
//! The merge itself is `gh pr merge`. A refusal (blocked by a review, a failing
//! required check, a conflict) comes back as `ok: false` with gh's own message
//! rather than as an error, so the UI can show the blocker verbatim instead of
//! paraphrasing it. On success both the PR chip and the worktree's ahead/behind
//! counters are nudged so neither waits for its next tick.
//!
//! `--delete-branch` is never passed to `gh pr merge`: when the cwd has the
//! PR's head branch checked out, gh checks out the base branch, pulls it and
//! deletes the local branch — several seconds of network I/O that silently
//! rewrites a raum-managed checkout. The remote branch is deleted with one
//! REST call instead, and the local branch is left alone.

use std::path::Path;

use tracing::{info, warn};

use super::gh;
use super::types::{MergeMethod, MergeOutcome, MergePolicy, RawRepo};
use crate::commands::worktree::{RefreshCause, service_handle as status_service_handle};
use crate::state::AppHandleState;

/// Which merge methods this repo allows, and what it defaults to.
#[tauri::command]
pub async fn github_merge_policy(path: String) -> Result<MergePolicy, String> {
    // REST rather than `gh repo view --json`: the latter has no auto-merge
    // field. `{owner}/{repo}` is expanded by gh from the cwd's origin remote.
    let raw: RawRepo = gh::json(Path::new(&path), &["api", "repos/{owner}/{repo}"])
        .await?
        .unwrap_or_default();
    Ok(raw.into_policy())
}

/// Merge pull request `number`. `auto` queues the merge for when the checks
/// pass (`gh pr merge --auto`) instead of merging now. `delete_branch` removes
/// the remote `head_ref` after an immediate merge; with `auto` the repo's own
/// delete-on-merge policy applies, exactly as with `gh pr merge --auto`.
#[tauri::command]
pub async fn github_pr_merge(
    state: tauri::State<'_, AppHandleState>,
    path: String,
    number: u64,
    method: MergeMethod,
    head_ref: String,
    delete_branch: bool,
    auto: bool,
) -> Result<MergeOutcome, String> {
    let number = number.to_string();
    let mut args = vec!["pr", "merge", &number, method.flag()];
    if auto {
        args.push("--auto");
    }
    let out = gh::run(Path::new(&path), &args).await?;
    // gh reports success on stderr ("✓ Merged pull request #12") and failures
    // there too; prefer whichever stream actually said something.
    let message = if out.stderr.is_empty() {
        out.stdout.trim().to_string()
    } else {
        out.stderr.clone()
    };
    if !out.ok {
        return Ok(MergeOutcome {
            ok: false,
            auto_merge_enabled: false,
            message,
        });
    }

    info!(path = %path, number = %number, auto, "github: merged pull request");
    if delete_branch && !auto {
        let git_ref = format!("repos/{{owner}}/{{repo}}/git/refs/heads/{head_ref}");
        let del = gh::run(Path::new(&path), &["api", "-X", "DELETE", &git_ref]).await?;
        // 422 "Reference does not exist": the repo's delete-on-merge policy
        // already removed it. Anything else is logged, not surfaced — the
        // merge itself has landed and a leftover branch is harmless.
        if !del.ok && !del.stderr.contains("Reference does not exist") {
            warn!(path = %path, head_ref, error = %del.stderr, "github: remote branch delete failed");
        }
    }
    // Both the chip and the sidebar's ahead/behind counters are now stale.
    if let Some(svc) = super::pr_service::service_handle(&state) {
        svc.trigger(&path);
    }
    if let Some(svc) = status_service_handle(&state) {
        svc.trigger(&path, RefreshCause::Mutation);
    }
    Ok(MergeOutcome {
        ok: true,
        auto_merge_enabled: auto,
        message,
    })
}
