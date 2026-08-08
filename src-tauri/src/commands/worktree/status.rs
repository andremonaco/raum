//! §9.1 — worktree status compute. One status pass = two *parallel* git
//! subprocesses (`git status --porcelain=v2 -z` + `git diff --numstat -z`),
//! parsed by the pure functions in [`super::git_parse`]. Recomputes are
//! driven by the backend status service (`super::status_service`) on
//! subscribe/mutation/watcher/focus triggers plus a slow fallback tick — the
//! frontend no longer polls.
//!
//! Every invocation sets `GIT_OPTIONAL_LOCKS=0`: without it `git status`
//! opportunistically rewrites `.git/index` (stat-cache refresh), which would
//! feed back into the index watcher that triggers recomputes — a perfect
//! self-oscillator — and can contend on `index.lock` with the user's own git
//! commands running in a pane.
//!
//! `--untracked-files=all` is kept deliberately: the sidebar needs individual
//! untracked paths, and with event-driven recomputes (instead of the old
//! 2 s × N-rows poll storm) the full-scan cost is paid rarely.

use std::collections::HashMap;

use super::git_parse::{assemble_status, parse_numstat_z, parse_porcelain_v2_z};
use super::types::WorktreeStatus;
/// Every git subprocess in raum goes through [`crate::git::git_cmd`], which
/// disables optional locks (see that module for why the flag is load-bearing).
use crate::git::git_cmd;

/// Run + parse the porcelain status. `Ok(None)` means git exited non-zero —
/// usually "not a git repository" because the worktree dir was deleted out
/// from under us; callers degrade to a clean default rather than poisoning
/// the sidebar with an error row.
fn run_porcelain_status(path: &str) -> Result<Option<super::git_parse::PorcelainStatus>, String> {
    let output = git_cmd(path)
        .args([
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "-z",
        ])
        .output()
        .map_err(|e| format!("git status: {e}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(parse_porcelain_v2_z(&output.stdout)))
}

/// Run + parse `git diff --numstat HEAD`. Failure (unborn HEAD on a brand-new
/// repo) degrades to an empty map → totals 0/0, per-file counts `None`.
fn run_numstat(path: &str) -> HashMap<String, (Option<u32>, Option<u32>)> {
    let output = git_cmd(path)
        .args(["diff", "--numstat", "-z", "-M", "HEAD"])
        .output();
    match output {
        Ok(out) if out.status.success() => parse_numstat_z(&out.stdout),
        _ => HashMap::new(),
    }
}

/// One full status computation for the worktree at `path`.
///
/// `cached_stash`: pass a cached count to skip the `git stash list`
/// subprocess (the status service holds one with a TTL); `None` recounts.
pub(super) async fn compute_status(
    path: String,
    cached_stash: Option<u32>,
) -> Result<WorktreeStatus, String> {
    let status_path = path.clone();
    let status_task = tokio::task::spawn_blocking(move || run_porcelain_status(&status_path));
    let numstat_path = path.clone();
    let numstat_task = tokio::task::spawn_blocking(move || run_numstat(&numstat_path));
    let (status_res, numstat_res) = tokio::join!(status_task, numstat_task);

    let porcelain = status_res.map_err(|e| format!("spawn_blocking join: {e}"))??;
    let Some(porcelain) = porcelain else {
        return Ok(WorktreeStatus::default());
    };
    let numstat = numstat_res.map_err(|e| format!("spawn_blocking join: {e}"))?;

    let stash_count = if let Some(n) = cached_stash {
        n
    } else if let Some(branch) = porcelain.branch.clone() {
        let stash_path = path.clone();
        tokio::task::spawn_blocking(move || count_stash_for_branch(&stash_path, &branch))
            .await
            .unwrap_or(0)
    } else {
        0
    };

    Ok(assemble_status(porcelain, &numstat, stash_count))
}

/// Cheap dirty probe for merge guards: porcelain v1 emptiness. Includes
/// untracked files (default mode), matching what the full status reports as
/// `dirty`. Synchronous — call from the blocking pool.
pub(super) fn is_dirty(path: &str) -> bool {
    git_cmd(path)
        .args(["status", "--porcelain", "-z"])
        .output()
        .is_ok_and(|o| o.status.success() && !o.stdout.is_empty())
}

/// One-shot status fetch. Kept for consumers that need a fresh value outside
/// the subscription stream (delete-worktree modal, startup pre-warm).
#[tauri::command]
pub async fn worktree_status(path: String) -> Result<WorktreeStatus, String> {
    compute_status(path, None).await
}

/// Batch variant of [`worktree_status`]. Off the hot path since the status
/// service took over live updates — used by the startup pre-warm only.
#[tauri::command]
pub async fn worktree_status_batch(
    paths: Vec<String>,
) -> Result<HashMap<String, WorktreeStatus>, String> {
    let mut tasks = tokio::task::JoinSet::new();
    for path in paths {
        tasks.spawn(async move {
            let status = compute_status(path.clone(), None).await.unwrap_or_default();
            (path, status)
        });
    }

    let mut out = HashMap::new();
    while let Some(result) = tasks.join_next().await {
        let (path, status) = result.map_err(|e| format!("join: {e}"))?;
        out.insert(path, status);
    }
    Ok(out)
}

/// Count the stash entries whose `WIP on <branch>` / `On <branch>` header
/// matches `branch`. `git stash list` is repo-wide, but each entry records
/// the branch it was stashed from, so we filter client-side.
pub(super) fn count_stash_for_branch(path: &str, branch: &str) -> u32 {
    let out = git_cmd(path).args(["stash", "list"]).output();
    let Ok(out) = out else { return 0 };
    if !out.status.success() {
        return 0;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let wip_tag = format!("WIP on {branch}:");
    let on_tag = format!("On {branch}:");
    s.lines()
        .filter(|l| l.contains(&wip_tag) || l.contains(&on_tag))
        .count() as u32
}
