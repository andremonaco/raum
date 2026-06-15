//! Directory listing for the sidebar's per-worktree file browser. One level
//! per call (the tree lazy-expands), plain `read_dir` — the browser shows
//! what's on disk, including gitignored files like `.env` that users
//! regularly want to open. `.git` (dir *or* file — linked worktrees carry a
//! `.git` pointer file) and OS noise are always hidden.
//!
//! `project_list_dir` is deliberately not reused: it's keyed by project slug
//! and rooted at the project root, while worktrees regularly live *outside*
//! the root (sibling-group path strategy).
//!
//! Future refinement: dim gitignored entries via a lazy
//! `git check-ignore --stdin -z` pass.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::commands::project::is_noise_filename;

/// One entry of a lazily-expanded worktree directory level.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDirEntry {
    pub name: String,
    /// Worktree-root-relative path, forward-slashed.
    pub rel_path: String,
    pub is_dir: bool,
}

/// Join `rel` onto `root`, rejecting anything that could escape it: absolute
/// paths, `..` components, and path prefixes. A naive
/// `root.join(rel).starts_with(root)` check does NOT catch `../x` —
/// `Path::starts_with` compares components without normalizing, so
/// `root/../x` still "starts with" `root`.
pub(crate) fn resolve_inside_root(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    let escapes = rel_path.is_absolute()
        || rel_path.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        });
    if escapes {
        return Err(format!("path escapes root: {rel}"));
    }
    Ok(root.join(rel_path))
}

/// Pure core of [`worktree_list_dir`] — testable against tempdirs without
/// Tauri state. Missing/non-dir targets return an empty list (the worktree
/// may have been deleted out from under an open browser).
pub(super) fn list_dir_in(root: &Path, rel_path: &str) -> Result<Vec<WorktreeDirEntry>, String> {
    let target = resolve_inside_root(root, rel_path)?;
    if !target.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<WorktreeDirEntry> = std::fs::read_dir(&target)
        .map_err(|e| format!("read_dir: {e}"))?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if name == ".git" || is_noise_filename(&name) {
                return None;
            }
            let is_dir = entry.path().is_dir();
            let rel = if rel_path.is_empty() {
                name.clone()
            } else {
                format!("{}/{name}", rel_path.trim_end_matches('/'))
            };
            Some(WorktreeDirEntry {
                name,
                rel_path: rel,
                is_dir,
            })
        })
        .collect();
    // Directories first, then files; both groups alphabetical.
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(entries)
}

/// List the immediate children of `rel_path` inside the worktree at
/// `worktree_path`. Root level is `rel_path: ""`.
#[tauri::command]
pub fn worktree_list_dir(
    worktree_path: String,
    rel_path: String,
) -> Result<Vec<WorktreeDirEntry>, String> {
    list_dir_in(Path::new(&worktree_path), &rel_path)
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn resolve_rejects_traversal_and_absolute() {
        let root = Path::new("/projects/demo");
        assert!(resolve_inside_root(root, "../sibling").is_err());
        assert!(resolve_inside_root(root, "ok/../../escape").is_err());
        assert!(resolve_inside_root(root, "/etc/passwd").is_err());
        assert_eq!(
            resolve_inside_root(root, "src/app.rs").unwrap(),
            root.join("src/app.rs")
        );
        assert_eq!(resolve_inside_root(root, "").unwrap(), root);
    }

    #[test]
    fn list_dir_hides_git_and_noise_and_sorts_dirs_first() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(root.join("zzz.txt"), "").unwrap();
        std::fs::write(root.join("Cargo.toml"), "").unwrap();
        std::fs::write(root.join(".DS_Store"), "").unwrap();
        std::fs::write(root.join("src/main.rs"), "").unwrap();

        let entries = list_dir_in(root, "").unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", "Cargo.toml", "zzz.txt"]);
        assert!(entries[0].is_dir);

        let nested = list_dir_in(root, "src").unwrap();
        assert_eq!(nested.len(), 1);
        assert_eq!(nested[0].rel_path, "src/main.rs");
        assert!(!nested[0].is_dir);
    }

    #[test]
    fn list_dir_hides_git_pointer_file() {
        // Linked worktrees have a `.git` *file* pointing at the real gitdir.
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(".git"), "gitdir: /elsewhere\n").unwrap();
        std::fs::write(dir.path().join("a.txt"), "").unwrap();
        let entries = list_dir_in(dir.path(), "").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "a.txt");
    }

    #[test]
    fn list_dir_missing_target_is_empty() {
        let dir = tempdir().unwrap();
        assert!(list_dir_in(dir.path(), "nope").unwrap().is_empty());
    }
}
