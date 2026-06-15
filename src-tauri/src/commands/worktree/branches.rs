//! Branch-level queries and the in-place branch switch for the root worktree.

use std::path::Path;
use std::process::Command;

use raum_hydration::worktree_list as git_worktree_list;

use super::config_io::{load_effective, rescan_git_watcher};
use super::status_service::trigger_status_refresh;
use super::types::{BranchMergeStatus, WorktreeBranchList};
use crate::state::AppHandleState;

#[tauri::command]
pub fn worktree_branches(
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
) -> Result<WorktreeBranchList, String> {
    let effective = load_effective(&state, &project_slug)?;
    let root = effective.root_path.to_string_lossy().into_owned();

    // Current branch in root worktree (empty in detached-HEAD).
    let current = Command::new("git")
        .args(["-C", &root, "branch", "--show-current"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if s.is_empty() { None } else { Some(s) }
            } else {
                None
            }
        });

    // All local branch names.
    let branches_out = Command::new("git")
        .args(["-C", &root, "branch", "--format=%(refname:short)"])
        .output()
        .map_err(|e| format!("git branch: {e}"))?;
    let mut branches: Vec<String> = String::from_utf8_lossy(&branches_out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    branches.sort();

    Ok(WorktreeBranchList { branches, current })
}

/// Switch the root worktree to `branch`. Refuses the switch if the tree has
/// any staged/unstaged/untracked changes — surfaces the first few dirty
/// paths so the UI can show them. A no-op if `branch` is already checked
/// out. On success the `GitHeadWatcher` will fire and refresh the sidebar;
/// we also rescan eagerly for parity with `worktree_create`.
#[tauri::command]
pub fn git_checkout_branch(
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
    branch: String,
) -> Result<(), String> {
    let effective = load_effective(&state, &project_slug)?;
    let root = effective.root_path.to_string_lossy().into_owned();

    // No-op if already on this branch — don't surface a git error to the UI.
    let current = Command::new("git")
        .args(["-C", &root, "branch", "--show-current"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if s.is_empty() { None } else { Some(s) }
            } else {
                None
            }
        });
    if current.as_deref() == Some(branch.as_str()) {
        return Ok(());
    }

    // Refuse with a readable error if the working tree has any changes —
    // avoids the "would be overwritten" git checkout surprise and means we
    // never lose the user's in-flight edits.
    let status_out = Command::new("git")
        .args(["-C", &root, "status", "--porcelain"])
        .output()
        .map_err(|e| format!("git status: {e}"))?;
    if !status_out.status.success() {
        return Err(format!(
            "git status: {}",
            String::from_utf8_lossy(&status_out.stderr).trim()
        ));
    }
    let dirty: Vec<String> = String::from_utf8_lossy(&status_out.stdout)
        .lines()
        .map(|l| l.get(3..).unwrap_or("").to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if !dirty.is_empty() {
        let shown = dirty
            .iter()
            .take(3)
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join(", ");
        let more = if dirty.len() > 3 {
            format!(" (+{} more)", dirty.len() - 3)
        } else {
            String::new()
        };
        return Err(format!(
            "Working tree has uncommitted changes: {shown}{more}. Commit, stash, or discard before switching branch."
        ));
    }

    let out = Command::new("git")
        .args(["-C", &root, "checkout", &branch])
        .output()
        .map_err(|e| format!("git checkout: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git checkout {branch} failed")
        } else {
            stderr
        });
    }

    rescan_git_watcher(&state, &project_slug, &effective.root_path);
    trigger_status_refresh(&state, &root);
    Ok(())
}

/// Read the configured upstream/merge branch for `branch` in the worktree at
/// `path`. Returns `None` if git is unavailable, the branch is untracked, or
/// the worktree is in detached-HEAD state.
pub(super) fn fetch_upstream_branch(path: &str, branch: &str) -> Option<String> {
    // Try `git rev-parse --abbrev-ref --symbolic-full-name @{u}` first — this
    // gives "origin/main" or "main" depending on tracking setup.
    let output = Command::new("git")
        .args([
            "-C",
            path,
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{u}",
        ])
        .output()
        .ok()?;
    if output.status.success() {
        let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !s.is_empty() && s != "HEAD" {
            return Some(s);
        }
    }
    // Fallback: read `branch.<name>.merge` from git config, stripping the
    // `refs/heads/` prefix so the UI sees a short name.
    let key = format!("branch.{branch}.merge");
    let out2 = Command::new("git")
        .args(["-C", path, "config", "--get", &key])
        .output()
        .ok()?;
    if out2.status.success() {
        let s = String::from_utf8_lossy(&out2.stdout).trim().to_string();
        if !s.is_empty() {
            return Some(s.trim_start_matches("refs/heads/").to_string());
        }
    }
    None
}

/// Return the list of local branches that already contain the tip of `branch`
/// (excluding `branch` itself). Used by the delete-worktree dialog to warn
/// the user when deleting a branch would drop unmerged commits.
#[tauri::command]
pub fn worktree_branch_merged(
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
    branch: String,
) -> Result<BranchMergeStatus, String> {
    let effective = load_effective(&state, &project_slug)?;
    let root = effective.root_path.to_string_lossy().into_owned();
    // `git branch --contains <branch>` lists every local branch whose tip is
    // on the commit graph reachable from `branch`'s tip — i.e. the branches
    // that have `branch` merged into them.
    let output = Command::new("git")
        .args([
            "-C",
            &root,
            "branch",
            "--format=%(refname:short)",
            "--contains",
            &branch,
        ])
        .output()
        .map_err(|e| format!("git branch --contains: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let merged_into: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().trim_start_matches('*').trim().to_string())
        .filter(|l| !l.is_empty() && l != &branch)
        .collect();
    Ok(BranchMergeStatus { merged_into })
}

/// Find the branch checked out at `path`, looked up against the main repo's
/// `git worktree list --porcelain`. Returns `None` for detached HEADs or
/// paths that aren't registered as worktrees.
pub(super) fn worktree_branch_at_path(repo: &Path, path: &Path) -> Option<String> {
    let entries = git_worktree_list(repo).ok()?;
    entries
        .into_iter()
        .find(|e| e.path == path)
        .and_then(|e| e.branch)
}

/// Read ahead/behind counts: how many commits `source` is ahead of `target`,
/// and how many commits behind. `(0, 0)` on any error.
pub(super) fn ahead_behind(repo: &str, target: &str, source: &str) -> (u32, u32) {
    let spec = format!("{target}...{source}");
    let out = Command::new("git")
        .args(["-C", repo, "rev-list", "--left-right", "--count", &spec])
        .output();
    let Ok(out) = out else { return (0, 0) };
    if !out.status.success() {
        return (0, 0);
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let mut parts = s.split_whitespace();
    let behind: u32 = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let ahead: u32 = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    (ahead, behind)
}
