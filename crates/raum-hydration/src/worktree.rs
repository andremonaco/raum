//! `git worktree` CLI wrapper (§6.5).
//!
//! Thin, testable wrapper around `git worktree {add,list,remove}` that exposes
//! an explicit distinction between the worktree's **target branch** and the
//! optional **from ref** (commit-ish) it should be created from:
//!
//! * `CreateOptions::branch` — the branch the worktree will check out. When
//!   `create_branch` is true, `git worktree add -b <branch> <target> [<from_ref>]`
//!   creates a brand-new branch rooted at `from_ref` (or `HEAD` if absent).
//!   When `create_branch` is false, the branch is expected to already exist
//!   and `git worktree add <target> <branch>` checks it out; in that mode
//!   `from_ref` is ignored.
//!
//! Consumers: Tauri command layer (`worktree_create`) and integration tests.
//! The `Command` dispatch is injectable so tests can intercept shell calls
//! without spawning `git` when useful; most tests in this module go through
//! real `git` against a `tempfile::tempdir()` repo to catch CLI drift.

use std::path::{Path, PathBuf};
use std::process::Command;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorktreeCliError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("git exited non-zero: {status} stderr={stderr}")]
    NonZero { status: i32, stderr: String },
    #[error("parse: {0}")]
    Parse(String),
}

/// One `git worktree list --porcelain` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeEntry {
    pub path: PathBuf,
    /// `refs/heads/<name>` stripped to `<name>` for convenience.
    pub branch: Option<String>,
    pub head: Option<String>,
    pub locked: bool,
    pub detached: bool,
}

/// Options for [`worktree_create`]. See module docs for the `branch` vs
/// `from_ref` semantics.
#[derive(Debug, Clone)]
pub struct CreateOptions {
    /// The branch the worktree checks out.
    pub branch: String,
    /// If true, pass `-b <branch>` so git creates a new branch.
    /// If false, `<branch>` must already exist.
    pub create_branch: bool,
    /// Commit-ish to root a newly-created branch at. Ignored when
    /// `create_branch` is false.
    pub from_ref: Option<String>,
}

/// `git -C <repo> worktree add ...`.
///
/// Mode table:
///
/// | create_branch | from_ref   | Command                                                |
/// | ------------- | ---------- | ------------------------------------------------------ |
/// | true          | Some(r)    | `git worktree add -b <branch> <target> <r>`            |
/// | true          | None       | `git worktree add -b <branch> <target>`                |
/// | false         | (ignored)  | `git worktree add <target> <branch>`                   |
pub fn worktree_create(
    repo: &Path,
    target: &Path,
    opts: &CreateOptions,
) -> Result<(), WorktreeCliError> {
    let mut cmd = Command::new("git");
    cmd.current_dir(repo).arg("worktree").arg("add");
    if opts.create_branch {
        cmd.arg("-b").arg(&opts.branch);
        cmd.arg(target);
        if let Some(r) = &opts.from_ref {
            cmd.arg(r);
        }
    } else {
        cmd.arg(target).arg(&opts.branch);
    }
    run_checked(cmd)
}

/// `git -C <repo> worktree list --porcelain`, parsed into entries.
pub fn worktree_list(repo: &Path) -> Result<Vec<WorktreeEntry>, WorktreeCliError> {
    let out = Command::new("git")
        .current_dir(repo)
        .args(["worktree", "list", "--porcelain"])
        .output()?;
    if !out.status.success() {
        return Err(WorktreeCliError::NonZero {
            status: out.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        });
    }
    parse_worktree_porcelain(&String::from_utf8_lossy(&out.stdout))
}

/// `git -C <repo> worktree remove [--force] <path>`.
pub fn worktree_remove(repo: &Path, path: &Path, force: bool) -> Result<(), WorktreeCliError> {
    let mut cmd = Command::new("git");
    cmd.current_dir(repo).args(["worktree", "remove"]);
    if force {
        cmd.arg("--force");
    }
    cmd.arg(path);
    run_checked(cmd)
}

fn run_checked(mut cmd: Command) -> Result<(), WorktreeCliError> {
    let out = cmd.output()?;
    if !out.status.success() {
        return Err(WorktreeCliError::NonZero {
            status: out.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        });
    }
    Ok(())
}

fn parse_worktree_porcelain(stdout: &str) -> Result<Vec<WorktreeEntry>, WorktreeCliError> {
    let mut entries = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(prev) = current.take() {
                entries.push(prev);
            }
            current = Some(WorktreeEntry {
                path: PathBuf::from(path),
                branch: None,
                head: None,
                locked: false,
                detached: false,
            });
        } else if let Some(b) = line.strip_prefix("branch ") {
            if let Some(c) = current.as_mut() {
                c.branch = Some(b.trim_start_matches("refs/heads/").to_string());
            }
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            if let Some(c) = current.as_mut() {
                c.head = Some(h.to_string());
            }
        } else if line == "detached" {
            if let Some(c) = current.as_mut() {
                c.detached = true;
            }
        } else if line == "locked" || line.starts_with("locked ") {
            if let Some(c) = current.as_mut() {
                c.locked = true;
            }
        }
        // empty line / unknown tokens: ignore.
    }
    if let Some(prev) = current {
        entries.push(prev);
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::tempdir;

    /// Minimal repo: `git init`, commit one file. Returns the repo root.
    fn init_repo_with_commit() -> Option<tempfile::TempDir> {
        let dir = tempdir().ok()?;
        let repo = dir.path();

        // Fail-soft: if `git` isn't available we skip the test silently.
        if Command::new("git").arg("--version").output().is_err() {
            return None;
        }

        let init = Command::new("git")
            .current_dir(repo)
            .args(["init", "-q", "-b", "main"])
            .status()
            .ok()?;
        if !init.success() {
            return None;
        }
        // Set local author so `git commit` works without global config.
        for (k, v) in [("user.email", "raum@example.com"), ("user.name", "raum")] {
            let s = Command::new("git")
                .current_dir(repo)
                .args(["config", "--local", k, v])
                .status()
                .ok()?;
            if !s.success() {
                return None;
            }
        }
        std::fs::write(repo.join("README.md"), "hi\n").ok()?;
        let add = Command::new("git")
            .current_dir(repo)
            .args(["add", "README.md"])
            .status()
            .ok()?;
        if !add.success() {
            return None;
        }
        let commit = Command::new("git")
            .current_dir(repo)
            .args(["commit", "-q", "-m", "init"])
            .status()
            .ok()?;
        if !commit.success() {
            return None;
        }
        Some(dir)
    }

    #[test]
    fn parse_porcelain_basic() {
        let raw = "\
worktree /repo
HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
branch refs/heads/main

worktree /repo-wt
HEAD cafebabecafebabecafebabecafebabecafebabe
branch refs/heads/feature/x
locked

";
        let got = parse_worktree_porcelain(raw).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].branch.as_deref(), Some("main"));
        assert!(!got[0].locked);
        assert_eq!(got[1].branch.as_deref(), Some("feature/x"));
        assert!(got[1].locked);
    }

    #[test]
    fn parse_porcelain_detached_head() {
        let raw = "\
worktree /repo
HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
detached

";
        let got = parse_worktree_porcelain(raw).unwrap();
        assert_eq!(got.len(), 1);
        assert!(got[0].detached);
        assert!(got[0].branch.is_none());
    }

    #[test]
    fn create_options_debug_clone() {
        // Smoke: derive impls exist and `CreateOptions` is cloneable/debuggable
        // so callers (Tauri cmd layer, tests) can serialize / log it.
        let o = CreateOptions {
            branch: "feat/x".into(),
            create_branch: true,
            from_ref: Some("main".into()),
        };
        let _clone = o.clone();
        assert!(format!("{o:?}").contains("feat/x"));
    }

    /// Real-`git` integration: init a repo, create a worktree, list + remove it.
    /// Tries to run by default; if `git` isn't available the `init_repo_with_commit`
    /// helper returns None and the test silently passes.
    #[test]
    fn create_list_remove_roundtrip_with_real_git() {
        let Some(repo_dir) = init_repo_with_commit() else {
            eprintln!("skipping: no git available");
            return;
        };
        let repo = repo_dir.path();

        // Target must NOT exist before `worktree add`.
        let outside = tempdir().unwrap();
        let target = outside.path().join("wt-feat-x");

        worktree_create(
            repo,
            &target,
            &CreateOptions {
                branch: "feat/x".into(),
                create_branch: true,
                from_ref: None,
            },
        )
        .expect("create");

        assert!(target.join("README.md").is_file(), "worktree hydrated");

        let list = worktree_list(repo).expect("list");
        let branches: Vec<_> = list.iter().filter_map(|e| e.branch.clone()).collect();
        assert!(
            branches.iter().any(|b| b == "feat/x"),
            "new branch in list: {branches:?}"
        );

        worktree_remove(repo, &target, true).expect("remove");

        let after = worktree_list(repo).expect("list after");
        let branches: Vec<_> = after.iter().filter_map(|e| e.branch.clone()).collect();
        assert!(
            !branches.iter().any(|b| b == "feat/x"),
            "branch removed: {branches:?}"
        );
    }

    #[test]
    fn create_from_ref_passes_through_to_git() {
        // Task 6.5: explicit `branch` vs `from_ref` — verify git honours from_ref by
        // rooting the new branch at it.
        let Some(repo_dir) = init_repo_with_commit() else {
            eprintln!("skipping: no git available");
            return;
        };
        let repo = repo_dir.path();

        // Record the current HEAD as the `from_ref` we'll use.
        let head = Command::new("git")
            .current_dir(repo)
            .args(["rev-parse", "HEAD"])
            .output()
            .expect("rev-parse");
        let head_sha = String::from_utf8_lossy(&head.stdout).trim().to_string();
        assert!(!head_sha.is_empty());

        // Make an extra commit so HEAD moves forward; `from_ref` should still
        // pin the new branch to the original HEAD SHA.
        std::fs::write(repo.join("b.txt"), "b\n").unwrap();
        let steps: [&[&str]; 2] = [&["add", "b.txt"], &["commit", "-q", "-m", "b"]];
        for args in steps {
            assert!(
                Command::new("git")
                    .current_dir(repo)
                    .args(args)
                    .status()
                    .unwrap()
                    .success()
            );
        }

        let outside = tempdir().unwrap();
        let target = outside.path().join("wt-feat-y");

        worktree_create(
            repo,
            &target,
            &CreateOptions {
                branch: "feat/y".into(),
                create_branch: true,
                from_ref: Some(head_sha.clone()),
            },
        )
        .expect("create from_ref");

        // New branch's HEAD should equal the original from_ref, not the latest
        // repo HEAD.
        let y_head = Command::new("git")
            .current_dir(&target)
            .args(["rev-parse", "HEAD"])
            .output()
            .expect("rev-parse y");
        let y_sha = String::from_utf8_lossy(&y_head.stdout).trim().to_string();
        assert_eq!(y_sha, head_sha, "worktree rooted at from_ref");

        worktree_remove(repo, &target, true).ok();
    }

    #[test]
    fn create_existing_branch_without_b_flag() {
        // Task 6.5: `create_branch = false` checks out an EXISTING branch.
        let Some(repo_dir) = init_repo_with_commit() else {
            eprintln!("skipping: no git available");
            return;
        };
        let repo = repo_dir.path();

        // Create a branch `existing` at HEAD but do NOT check it out yet.
        assert!(
            Command::new("git")
                .current_dir(repo)
                .args(["branch", "existing"])
                .status()
                .unwrap()
                .success()
        );

        let outside = tempdir().unwrap();
        let target = outside.path().join("wt-existing");

        worktree_create(
            repo,
            &target,
            &CreateOptions {
                branch: "existing".into(),
                create_branch: false,
                from_ref: None,
            },
        )
        .expect("checkout existing branch");

        let list = worktree_list(repo).expect("list");
        assert!(
            list.iter().any(|e| e.branch.as_deref() == Some("existing")),
            "existing branch appears in list"
        );

        worktree_remove(repo, &target, true).ok();
    }

    #[test]
    fn remove_nonexistent_worktree_errors() {
        let Some(repo_dir) = init_repo_with_commit() else {
            eprintln!("skipping: no git available");
            return;
        };
        let repo = repo_dir.path();
        let outside = tempdir().unwrap();
        let target = outside.path().join("never-created");
        let err = worktree_remove(repo, &target, false).unwrap_err();
        assert!(matches!(err, WorktreeCliError::NonZero { .. }));
    }
}
