//! §9.1 — `worktree_status` polling. Used by the sidebar to render the
//! dirty indicator and the Open/Staged file groups every 2 s.

use std::collections::HashMap;
use std::process::Command;

use super::types::WorktreeStatus;

/// §9.1 — poll `git status --porcelain=v2` for the worktree at `path`.
///
/// We parse the v2 format because it's stable across git versions and
/// unambiguously separates path fields (tab-separated for renames; the
/// pathname is always the last field on the line). The three buckets returned
/// map to the sidebar's display groups:
///
/// * `untracked` — lines beginning with `?`.
/// * `modified` — entries whose *worktree* status char (`XY`, Y) is non-`.`.
/// * `staged` — entries whose *index* status char (`XY`, X) is non-`.`.
///
/// A single path can appear in both `modified` and `staged` when it has both
/// index and worktree changes; the sidebar surfaces both buckets so the user
/// can see it in each.
pub(super) fn worktree_status_for_path(path: &str) -> Result<WorktreeStatus, String> {
    let output = Command::new("git")
        .args([
            "-C",
            path,
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
        ])
        .output()
        .map_err(|e| format!("git status: {e}"))?;
    if !output.status.success() {
        // Non-zero exit is usually "not a git repository" when a
        // worktree path was deleted out from under us. Treat as empty /
        // clean rather than poisoning the sidebar with an error row.
        return Ok(WorktreeStatus::default());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let (mut status, branch) = parse_porcelain_v2_with_branch(stdout.as_ref());

    // Also fetch line-level diff stats vs HEAD. `git diff --shortstat HEAD`
    // covers both staged and unstaged changes in the working tree.
    // On a brand-new repo with no commits, this will fail — treat as 0/0.
    let diff_out = Command::new("git")
        .args(["-C", path, "diff", "--shortstat", "HEAD"])
        .output();
    if let Ok(diff_out) = diff_out {
        if diff_out.status.success() {
            let diff_str = String::from_utf8_lossy(&diff_out.stdout);
            let (ins, del) = parse_shortstat(diff_str.as_ref());
            status.insertions = ins;
            status.deletions = del;
        }
    }

    if let Some(ref br) = branch {
        status.stash_count = count_stash_for_branch(path, br);
    }

    Ok(status)
}

#[tauri::command]
pub async fn worktree_status(path: String) -> Result<WorktreeStatus, String> {
    // `git status` shells out — offload to the blocking pool so a slow repo
    // (fsck-in-progress, cold cache) doesn't stall the tokio runtime the
    // webview IPC uses. The 2-second poll cadence means this is the hottest
    // blocking-pool customer in the sidebar.
    tokio::task::spawn_blocking(move || worktree_status_for_path(&path))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
}

#[tauri::command]
pub async fn worktree_status_batch(
    paths: Vec<String>,
) -> Result<HashMap<String, WorktreeStatus>, String> {
    let mut tasks = tokio::task::JoinSet::new();
    for path in paths {
        tasks.spawn_blocking(move || {
            let status = worktree_status_for_path(&path).unwrap_or_default();
            (path, status)
        });
    }

    let mut out = HashMap::new();
    while let Some(result) = tasks.join_next().await {
        let (path, status) = result.map_err(|e| format!("spawn_blocking join: {e}"))?;
        out.insert(path, status);
    }
    Ok(out)
}

/// Parse `git status --porcelain=v2` output into the three buckets the sidebar
/// renders. Split out for unit testing without a live repo.
#[cfg(test)]
pub(super) fn parse_porcelain_v2(stdout: &str) -> WorktreeStatus {
    parse_porcelain_v2_with_branch(stdout).0
}

fn parse_porcelain_v2_with_branch(stdout: &str) -> (WorktreeStatus, Option<String>) {
    let mut status = WorktreeStatus::default();
    let mut branch = None;
    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            if rest != "(detached)" {
                branch = Some(rest.to_string());
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            if !rest.is_empty() {
                status.upstream = Some(rest.to_string());
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+').and_then(|n| n.parse().ok()) {
                    status.ahead = n;
                } else if let Some(n) = part.strip_prefix('-').and_then(|n| n.parse().ok()) {
                    status.behind = n;
                }
            }
            continue;
        }
        let mut parts = line.splitn(2, ' ');
        let marker = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        match marker {
            // Untracked: "? <path>"
            "?" if !rest.is_empty() => {
                status.untracked.push(rest.to_string());
            }
            "1" => {
                // Ordinary changed entry:
                //   "1 XY sub <mH> <mI> <mW> <hH> <hI> <path>"
                push_changed_path("1", rest, &mut status);
            }
            "2" => {
                // Renamed / copied entry:
                //   "2 XY sub <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<orig>"
                push_changed_path("2", rest, &mut status);
            }
            // "u " (unmerged) and "#" (branch header) are ignored on purpose —
            // the sidebar only visualizes dirty vs clean at this layer.
            _ => {}
        }
    }
    status.dirty =
        !status.untracked.is_empty() || !status.modified.is_empty() || !status.staged.is_empty();
    (status, branch)
}

fn push_changed_path(marker: &str, rest: &str, out: &mut WorktreeStatus) {
    // `rest` begins with "XY ..." — split off the XY pair then walk to the path.
    let xy = rest.get(..2).unwrap_or("..");
    let index_char = xy.chars().next().unwrap_or('.');
    let worktree_char = xy.chars().nth(1).unwrap_or('.');

    // The path is the final whitespace-separated field for marker "1"; for
    // marker "2" it's the field before the TAB separator (then the original
    // path follows the TAB). We use `rsplit_once('\t')` to peel the TAB half
    // off first; whatever is left has the path as its final space-separated
    // field.
    let pre_tab = rest.rsplit_once('\t').map_or(rest, |(left, _)| left);
    let Some(path) = pre_tab.rsplit_once(' ').map(|(_, p)| p) else {
        return;
    };
    let path = path.to_string();

    // Rename entries (marker "2") always have an index change; guard just in
    // case a future git version breaks that invariant.
    if marker == "2" || index_char != '.' {
        out.staged.push(path.clone());
    }
    if worktree_char != '.' {
        out.modified.push(path);
    }
}

/// Count the stash entries whose `WIP on <branch>` / `On <branch>` header
/// matches `branch`. `git stash list` is repo-wide, but each entry records
/// the branch it was stashed from, so we filter client-side.
fn count_stash_for_branch(path: &str, branch: &str) -> u32 {
    let out = Command::new("git")
        .args(["-C", path, "stash", "list"])
        .output();
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

/// Parse `git diff --shortstat HEAD` output into `(insertions, deletions)`.
/// Example line: " 3 files changed, 12 insertions(+), 4 deletions(-)"
/// When only insertions or only deletions, one clause is absent.
fn parse_shortstat(s: &str) -> (u32, u32) {
    let mut ins: u32 = 0;
    let mut del: u32 = 0;
    for part in s.split(',') {
        let part = part.trim();
        if part.contains("insertion") {
            ins = part
                .split_whitespace()
                .next()
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
        } else if part.contains("deletion") {
            del = part
                .split_whitespace()
                .next()
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
        }
    }
    (ins, del)
}
