//! Read-only commit-history commands for the sidebar's History tab:
//! paginated `git_log`, per-commit changed files, and per-file commit diffs.
//! All subprocess output is consumed via `-z` (NUL-separated) formats parsed
//! in [`super::git_parse`].

use std::collections::HashSet;

use super::git_parse::{parse_log_z, parse_name_status_z, parse_numstat_z};
use super::types::{CommitFileChange, CommitInfo};
use crate::git::git_cmd;

/// Upper bound per `git_log` page. The frontend pages in chunks of 50; the
/// clamp keeps a buggy caller from serializing an entire monorepo history
/// across IPC.
const MAX_LOG_PAGE: u32 = 200;

/// Validate a user-supplied commit hash before interpolating it into a git
/// argument list. Rejecting non-hex strings prevents argument injection
/// (`--output=…` and friends).
fn is_valid_hash(s: &str) -> bool {
    (4..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `git log` page for the worktree at `worktree_path`.
///
/// Two parallel subprocesses: the log itself and `git rev-list
/// @{upstream}..HEAD` for the `unpushed` markers. No upstream / detached
/// HEAD → every commit reports `unpushed: false` (a no-remote repo shouldn't
/// render all-unpushed noise). Empty repo → `Ok(vec![])`.
#[tauri::command]
pub async fn git_log(
    worktree_path: String,
    skip: u32,
    limit: u32,
) -> Result<Vec<CommitInfo>, String> {
    let limit = limit.clamp(1, MAX_LOG_PAGE);
    let log_path = worktree_path.clone();
    let log_task = tokio::task::spawn_blocking(move || run_log(&log_path, skip, limit));
    let unpushed_task = tokio::task::spawn_blocking(move || run_unpushed_set(&worktree_path));
    let (log_res, unpushed_res) = tokio::join!(log_task, unpushed_task);

    let raw = log_res.map_err(|e| format!("spawn_blocking join: {e}"))??;
    let unpushed = unpushed_res.map_err(|e| format!("spawn_blocking join: {e}"))?;

    Ok(raw
        .into_iter()
        .map(|c| CommitInfo {
            unpushed: unpushed.contains(&c.hash),
            hash: c.hash,
            short_hash: c.short_hash,
            author: c.author,
            timestamp: c.timestamp,
            subject: c.subject,
        })
        .collect())
}

fn run_log(path: &str, skip: u32, limit: u32) -> Result<Vec<super::git_parse::RawCommit>, String> {
    let out = git_cmd(path)
        .args(["log", "-z", "--format=%H%x00%h%x00%an%x00%at%x00%s"])
        .arg(format!("--skip={skip}"))
        .arg(format!("-n{limit}"))
        .output()
        .map_err(|e| format!("git log: {e}"))?;
    if !out.status.success() {
        // Typically an unborn HEAD ("does not have any commits yet") on a
        // brand-new repo — an empty history, not an error.
        return Ok(Vec::new());
    }
    Ok(parse_log_z(&out.stdout))
}

/// Full hashes of commits reachable from HEAD but not from `@{upstream}`.
/// Empty when no upstream is configured (rev-list exits non-zero).
fn run_unpushed_set(path: &str) -> HashSet<String> {
    let out = git_cmd(path)
        .args(["rev-list", "@{upstream}..HEAD"])
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        _ => HashSet::new(),
    }
}

/// Changed files of one commit, with per-file `+/-` counts. Two parallel
/// `git show` passes (`--name-status` for kinds, `--numstat` for counts),
/// merged by path. `git show` diffs the root commit against the empty tree
/// natively; `-m --first-parent` makes merge commits show their first-parent
/// diff instead of the usually-empty condensed combined diff.
#[tauri::command]
pub async fn git_commit_files(
    worktree_path: String,
    hash: String,
) -> Result<Vec<CommitFileChange>, String> {
    if !is_valid_hash(&hash) {
        return Err("invalid commit hash".into());
    }
    let ns_path = worktree_path.clone();
    let ns_hash = hash.clone();
    let ns_task =
        tokio::task::spawn_blocking(move || run_show(&ns_path, &ns_hash, "--name-status"));
    let num_task =
        tokio::task::spawn_blocking(move || run_show(&worktree_path, &hash, "--numstat"));
    let (ns_res, num_res) = tokio::join!(ns_task, num_task);

    let entries = parse_name_status_z(&ns_res.map_err(|e| format!("spawn_blocking join: {e}"))??);
    let counts = parse_numstat_z(&num_res.map_err(|e| format!("spawn_blocking join: {e}"))??);

    Ok(entries
        .into_iter()
        .map(|(kind, path, orig_path)| {
            let (insertions, deletions) = counts.get(&path).copied().unwrap_or((None, None));
            CommitFileChange {
                path,
                orig_path,
                kind,
                insertions,
                deletions,
            }
        })
        .collect())
}

fn run_show(path: &str, hash: &str, mode: &str) -> Result<Vec<u8>, String> {
    let out = git_cmd(path)
        .args([
            "show",
            "-m",
            "--first-parent",
            "--format=",
            mode,
            "-z",
            "-M",
            hash,
        ])
        .output()
        .map_err(|e| format!("git show: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(out.stdout)
}

/// Unified diff of one file within one commit — consumed by the diff-viewer
/// modal's commit mode. Empty output (path untouched in that commit, e.g.
/// the old side of a rename) renders as "no changes" in the viewer.
#[tauri::command]
pub async fn git_diff_commit(
    worktree_path: String,
    hash: String,
    file: String,
) -> Result<String, String> {
    if !is_valid_hash(&hash) {
        return Err("invalid commit hash".into());
    }
    tokio::task::spawn_blocking(move || {
        let out = git_cmd(&worktree_path)
            .args([
                "show",
                "-m",
                "--first-parent",
                "--no-color",
                "--format=",
                "-M",
                &hash,
                "--",
                &file,
            ])
            .output()
            .map_err(|e| format!("git show: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::Command as StdCommand;

    use tempfile::tempdir;

    use super::super::types::FileChangeKind;
    use super::*;

    fn run_git(dir: &Path, args: &[&str]) {
        let s = StdCommand::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("git");
        assert!(
            s.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&s.stderr)
        );
    }

    fn init_repo(dir: &Path) {
        run_git(dir, &["init", "--initial-branch=main"]);
        run_git(dir, &["config", "user.email", "test@example.com"]);
        run_git(dir, &["config", "user.name", "Test"]);
        std::fs::write(dir.join("README.md"), "hi\n").unwrap();
        run_git(dir, &["add", "."]);
        run_git(dir, &["commit", "-m", "initial"]);
    }

    #[test]
    fn hash_validation() {
        assert!(is_valid_hash("abc123"));
        assert!(is_valid_hash(&"a".repeat(40)));
        assert!(!is_valid_hash("abc"));
        assert!(!is_valid_hash("--output=/tmp/pwn"));
        assert!(!is_valid_hash("abc1 23"));
        assert!(!is_valid_hash(&"a".repeat(65)));
    }

    #[test]
    fn log_pages_and_marks_nothing_unpushed_without_upstream() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        std::fs::write(dir.path().join("two.txt"), "2\n").unwrap();
        run_git(dir.path(), &["add", "."]);
        run_git(dir.path(), &["commit", "-m", "second"]);

        let rt = tokio::runtime::Runtime::new().unwrap();
        let path = dir.path().to_string_lossy().into_owned();

        let all = rt.block_on(git_log(path.clone(), 0, 50)).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].subject, "second");
        assert_eq!(all[1].subject, "initial");
        assert!(all.iter().all(|c| !c.unpushed), "no upstream → no markers");
        assert!(all.iter().all(|c| c.timestamp > 0));

        let page2 = rt.block_on(git_log(path.clone(), 1, 50)).unwrap();
        assert_eq!(page2.len(), 1);
        assert_eq!(page2[0].subject, "initial");

        // Unknown-directory failure degrades like an empty repo would.
        let empty = rt.block_on(git_log(format!("{path}/nope"), 0, 50)).unwrap();
        assert!(empty.is_empty());
    }

    #[test]
    fn commit_files_covers_root_commit_and_rename() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        run_git(dir.path(), &["mv", "README.md", "RENAMED.md"]);
        run_git(dir.path(), &["commit", "-m", "rename"]);

        let rt = tokio::runtime::Runtime::new().unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        let log = rt.block_on(git_log(path.clone(), 0, 50)).unwrap();

        // Root commit diffs against the empty tree.
        let root = rt
            .block_on(git_commit_files(path.clone(), log[1].hash.clone()))
            .unwrap();
        assert_eq!(root.len(), 1);
        assert_eq!(root[0].path, "README.md");
        assert_eq!(root[0].kind, FileChangeKind::Added);
        assert_eq!(root[0].insertions, Some(1));

        // Rename commit: new path + orig_path, kind Renamed.
        let rename = rt
            .block_on(git_commit_files(path.clone(), log[0].hash.clone()))
            .unwrap();
        assert_eq!(rename.len(), 1);
        assert_eq!(rename[0].path, "RENAMED.md");
        assert_eq!(rename[0].orig_path.as_deref(), Some("README.md"));
        assert_eq!(rename[0].kind, FileChangeKind::Renamed);

        // Diff of the root commit's file is a real unified diff.
        let diff = rt
            .block_on(git_diff_commit(
                path,
                log[1].hash.clone(),
                "README.md".into(),
            ))
            .unwrap();
        assert!(diff.contains("+hi"), "diff was: {diff}");
    }

    #[test]
    fn commit_files_rejects_bad_hash() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt
            .block_on(git_commit_files("/tmp".into(), "--not-a-hash".into()))
            .unwrap_err();
        assert!(err.contains("invalid commit hash"));
    }
}
