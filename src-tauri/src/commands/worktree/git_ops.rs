//! Per-file git plumbing called by the sidebar's stage / unstage / diff /
//! discard buttons. Each command is a thin wrapper around git on the
//! blocking pool — no shared state.

use std::process::Command;

/// Stage one or more files in the worktree at `worktree_path`.
/// Pass `files: ["."]` to stage everything.
#[tauri::command]
pub async fn git_stage(worktree_path: String, files: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new("git");
        cmd.args(["-C", &worktree_path, "add", "--"]);
        for f in &files {
            cmd.arg(f);
        }
        let out = cmd.output().map_err(|e| format!("git add: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
}

/// Unstage one or more files in the worktree at `worktree_path`.
/// Pass `files: ["."]` to unstage everything.
#[tauri::command]
pub async fn git_unstage(worktree_path: String, files: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new("git");
        cmd.args(["-C", &worktree_path, "reset", "HEAD", "--"]);
        for f in &files {
            cmd.arg(f);
        }
        let out = cmd.output().map_err(|e| format!("git reset: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
}

/// Discard unstaged changes for the listed files in `worktree_path`.
///
/// Per-file behaviour, driven by `git status --porcelain=v2 -- <file>`:
///   * tracked-modified → `git checkout -- <file>` (restore worktree to index).
///   * untracked        → `git clean -f -- <file>` (remove the file).
///   * purely staged    → skipped (discard only applies to unstaged changes).
///
/// Errors short-circuit: the first failing file stops the batch and surfaces
/// its stderr.
#[tauri::command]
pub async fn git_discard(worktree_path: String, files: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        for file in &files {
            let status_out = Command::new("git")
                .args([
                    "-C",
                    &worktree_path,
                    "status",
                    "--porcelain=v2",
                    "--untracked-files=all",
                    "--",
                    file,
                ])
                .output()
                .map_err(|e| format!("git status: {e}"))?;
            if !status_out.status.success() {
                return Err(String::from_utf8_lossy(&status_out.stderr)
                    .trim()
                    .to_string());
            }
            let status = String::from_utf8_lossy(&status_out.stdout);
            let first_line = status.lines().next().unwrap_or("");
            let is_untracked = first_line.starts_with("? ");
            // Porcelain v2 ordinary entries: "1 XY ..." where X is index status
            // and Y is worktree status. Worktree-modified means Y != '.'.
            let has_worktree_change = first_line
                .strip_prefix("1 ")
                .or_else(|| first_line.strip_prefix("2 "))
                .and_then(|rest| rest.chars().nth(1))
                .is_some_and(|c| c != '.');

            if is_untracked {
                let out = Command::new("git")
                    .args(["-C", &worktree_path, "clean", "-f", "--", file])
                    .output()
                    .map_err(|e| format!("git clean: {e}"))?;
                if !out.status.success() {
                    return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
                }
            } else if has_worktree_change {
                let out = Command::new("git")
                    .args(["-C", &worktree_path, "checkout", "--", file])
                    .output()
                    .map_err(|e| format!("git checkout: {e}"))?;
                if !out.status.success() {
                    return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
                }
            }
            // else: purely staged or clean — nothing to discard.
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
}

/// Discard every unstaged change in `worktree_path`.
///
/// Runs `git checkout -- .` (restore all tracked modifications) followed by
/// `git clean -fd` (remove untracked files + directories). The index is left
/// alone so anything already staged survives.
#[tauri::command]
pub async fn git_discard_all(worktree_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let out = Command::new("git")
            .args(["-C", &worktree_path, "checkout", "--", "."])
            .output()
            .map_err(|e| format!("git checkout: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        let out = Command::new("git")
            .args(["-C", &worktree_path, "clean", "-fd"])
            .output()
            .map_err(|e| format!("git clean: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
}

/// Return the unified diff for a single file in the worktree at `worktree_path`.
///
/// `staged = true`  → `git diff --cached -- <file>` (index vs HEAD).
/// `staged = false` → `git diff -- <file>` (worktree vs index). Falls back to
/// `git diff --no-index -- /dev/null <file>` when the tracked diff is empty,
/// which covers the untracked-file case so the viewer can still show the full
/// added content instead of an empty pane.
#[tauri::command]
pub async fn git_diff(worktree_path: String, file: String, staged: bool) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new("git");
        cmd.args(["-C", &worktree_path, "diff", "--no-color"]);
        if staged {
            cmd.arg("--cached");
        }
        cmd.arg("--").arg(&file);
        let out = cmd.output().map_err(|e| format!("git diff: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        let tracked = String::from_utf8_lossy(&out.stdout).to_string();
        if !staged && tracked.is_empty() {
            // Untracked file: synthesise a diff against /dev/null so the viewer
            // shows the whole file as added. `git diff --no-index` always exits
            // 1 when there are differences, so we don't treat that as an error.
            let untracked = Command::new("git")
                .args([
                    "-C",
                    &worktree_path,
                    "diff",
                    "--no-color",
                    "--no-index",
                    "--",
                    "/dev/null",
                    &file,
                ])
                .output()
                .map_err(|e| format!("git diff --no-index: {e}"))?;
            return Ok(String::from_utf8_lossy(&untracked.stdout).to_string());
        }
        Ok(tracked)
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
}
