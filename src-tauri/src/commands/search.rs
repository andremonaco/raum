//! File search command — walks a registered project's root (honoring
//! `.gitignore`) and returns ranked filename matches for the UI's global
//! search panel. Scrollback search lives in the frontend; this complements it
//! so the ⌘⇧F overlay can surface both source files and terminal output.

use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use raum_core::store::ConfigStore;
use serde::Serialize;

/// One file match returned to the UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    /// Absolute path on disk.
    pub path: String,
    /// Project-root-relative path, forward-slashed.
    pub rel_path: String,
    /// Basename (file name).
    pub name: String,
    /// Higher = better match.
    pub score: u32,
}

/// Upper bound on results. Keeps render cheap and the IPC payload small.
const MAX_HITS: usize = 200;

/// Pure search helper — walks `root` honoring `.gitignore` and returns ranked
/// hits for `query`. Split from the command so tests don't need a populated
/// `ConfigStore`.
pub fn find_files_in(root: &Path, query: &str) -> Vec<FileHit> {
    let needle = query.trim();
    if needle.is_empty() {
        return Vec::new();
    }
    let needle_lc = needle.to_lowercase();
    let mut hits: Vec<FileHit> = Vec::new();

    let walker = WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .follow_links(false)
        .build();

    for dent in walker {
        if hits.len() >= MAX_HITS {
            break;
        }
        let dent = match dent {
            Ok(d) => d,
            Err(_) => continue,
        };
        if !dent.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = dent.path();
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let name_lc = name.to_lowercase();
        let rel_lc = rel.to_lowercase();

        let score: u32 = if name_lc == needle_lc {
            100
        } else if name_lc.starts_with(&needle_lc) {
            70
        } else if name_lc.contains(&needle_lc) {
            50
        } else if rel_lc.contains(&needle_lc) {
            20
        } else {
            continue;
        };

        hits.push(FileHit {
            path: path.to_string_lossy().into_owned(),
            rel_path: rel,
            name: name.to_string(),
            score,
        });
    }

    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(a.rel_path.len().cmp(&b.rel_path.len()))
    });
    hits.truncate(MAX_HITS);
    hits
}

/// Case-insensitive substring search over a project's tracked files. Ranks by:
/// basename exact > basename prefix > basename contains > full-path contains,
/// then prefers shorter relative paths.
#[tauri::command]
pub fn project_find_files(project_slug: String, query: String) -> Result<Vec<FileHit>, String> {
    let store = ConfigStore::default();
    let project = store
        .read_project(&project_slug)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("project '{project_slug}' not found"))?;

    let root: PathBuf = project.root_path;
    if !root.is_dir() {
        return Err(format!(
            "project root is not a directory: {}",
            root.display()
        ));
    }
    Ok(find_files_in(&root, &query))
}

/// Search files under an arbitrary directory path. Used by the frontend to
/// search each git worktree independently when the project has multiple
/// worktrees checked out at different paths.
#[tauri::command]
pub fn search_files_in_path(path: String, query: String) -> Result<Vec<FileHit>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    Ok(find_files_in(&root, &query))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn touch(dir: &Path, rel: &str) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, "").unwrap();
    }

    #[test]
    fn returns_empty_for_blank_query() {
        let src = tempdir().unwrap();
        touch(src.path(), "main.rs");
        assert!(find_files_in(src.path(), "   ").is_empty());
    }

    #[test]
    fn ranks_basename_above_path_contains() {
        let src = tempdir().unwrap();
        touch(src.path(), "foo.rs");
        touch(src.path(), "nested/also_foo.rs");
        touch(src.path(), "other/bar.rs");

        let hits = find_files_in(src.path(), "foo");
        assert!(!hits.is_empty());
        assert_eq!(hits[0].name, "foo.rs");
    }

    #[test]
    fn honors_gitignore() {
        let src = tempdir().unwrap();
        fs::create_dir_all(src.path().join(".git")).unwrap();
        fs::write(src.path().join(".gitignore"), "ignored.rs\n").unwrap();
        touch(src.path(), "visible.rs");
        touch(src.path(), "ignored.rs");

        let hits = find_files_in(src.path(), "rs");
        let names: Vec<_> = hits.iter().map(|h| h.name.as_str()).collect();
        assert!(names.contains(&"visible.rs"));
        assert!(!names.contains(&"ignored.rs"));
    }

    #[test]
    fn caps_results_at_max_hits() {
        let src = tempdir().unwrap();
        for i in 0..(MAX_HITS + 10) {
            touch(src.path(), &format!("file-{i}.rs"));
        }
        let hits = find_files_in(src.path(), "file");
        assert_eq!(hits.len(), MAX_HITS);
    }
}
