//! Per-project `.git/HEAD` watcher. Emits `worktree-branches-changed` so the
//! UI refreshes branch badges without polling.
//!
//! Watches `<root>/.git/HEAD` (main project) plus every
//! `<root>/.git/worktrees/*/HEAD` (linked worktrees). FS events are coalesced
//! inside a debounce window before a single event is emitted to the webview.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::mpsc;
use tracing::{debug, warn};

/// Git checkout writes multiple files (HEAD, index, packed-refs) in quick
/// succession. Coalesce the burst so we emit one frontend event per switch.
const DEBOUNCE: Duration = Duration::from_millis(150);

pub struct GitHeadWatcher {
    watcher: RecommendedWatcher,
    watched: HashSet<PathBuf>,
    /// Dropping this end closes the channel and shuts down the debounce task.
    _pulse_tx: mpsc::UnboundedSender<()>,
}

impl GitHeadWatcher {
    /// Start a watcher for `slug` rooted at `root`. Returns `Err` only when the
    /// OS refuses to create a watcher at all; individual path watch failures
    /// are logged and skipped so a missing worktree HEAD never blocks startup.
    pub fn start<R: Runtime>(slug: String, root: &Path, app: AppHandle<R>) -> notify::Result<Self> {
        let (pulse_tx, mut pulse_rx) = mpsc::unbounded_channel::<()>();

        let cb_tx = pulse_tx.clone();
        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
                Ok(ev) => {
                    if matches!(
                        ev.kind,
                        EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
                    ) {
                        let _ = cb_tx.send(());
                    }
                }
                Err(e) => warn!(error = %e, "git_watcher: notify error"),
            })?;

        let mut watched = HashSet::new();
        for path in discover_head_paths(root) {
            match watcher.watch(&path, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    debug!(path = %path.display(), "git_watcher: added watch");
                    watched.insert(path);
                }
                Err(e) => {
                    warn!(path = %path.display(), error = %e, "git_watcher: watch failed");
                }
            }
        }

        let emit_slug = slug;
        tauri::async_runtime::spawn(async move {
            while pulse_rx.recv().await.is_some() {
                // Drain any further pulses inside the debounce window.
                let deadline = tokio::time::Instant::now() + DEBOUNCE;
                loop {
                    tokio::select! {
                        maybe = pulse_rx.recv() => {
                            if maybe.is_none() { return; }
                        }
                        () = tokio::time::sleep_until(deadline) => break,
                    }
                }
                if let Err(e) = app.emit("worktree-branches-changed", json!({ "slug": emit_slug }))
                {
                    warn!(slug = %emit_slug, error = %e, "worktree-branches-changed emit failed");
                }
            }
        });

        Ok(Self {
            watcher,
            watched,
            _pulse_tx: pulse_tx,
        })
    }

    /// Re-sync the watch set against the current on-disk layout. Called after
    /// `worktree_create` / `worktree_remove` so newly-added worktree HEADs are
    /// watched and stale ones are dropped.
    pub fn rescan(&mut self, root: &Path) {
        let fresh = discover_head_paths(root);
        for path in &fresh {
            if !self.watched.contains(path) {
                match self.watcher.watch(path, RecursiveMode::NonRecursive) {
                    Ok(()) => {
                        debug!(path = %path.display(), "git_watcher: added watch");
                        self.watched.insert(path.clone());
                    }
                    Err(e) => {
                        warn!(path = %path.display(), error = %e, "git_watcher: watch failed");
                    }
                }
            }
        }
        let stale: Vec<PathBuf> = self
            .watched
            .iter()
            .filter(|p| !fresh.contains(*p))
            .cloned()
            .collect();
        for path in stale {
            let _ = self.watcher.unwatch(&path);
            self.watched.remove(&path);
        }
    }
}

fn discover_head_paths(root: &Path) -> HashSet<PathBuf> {
    let mut paths = HashSet::new();
    let git_dir = resolve_git_dir(root);
    let head = git_dir.join("HEAD");
    if head.is_file() {
        paths.insert(head);
    }
    if let Ok(entries) = std::fs::read_dir(git_dir.join("worktrees")) {
        for entry in entries.flatten() {
            let head = entry.path().join("HEAD");
            if head.is_file() {
                paths.insert(head);
            }
        }
    }
    paths
}

/// Resolve `<root>/.git` to its actual directory. A plain `.git` directory is
/// returned as-is; a `.git` file (submodule / linked worktree edge case) is
/// parsed for its `gitdir:` pointer.
fn resolve_git_dir(root: &Path) -> PathBuf {
    let git = root.join(".git");
    if git.is_dir() {
        return git;
    }
    if git.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&git) {
            if let Some(rest) = raw.strip_prefix("gitdir:") {
                let p = PathBuf::from(rest.trim());
                return if p.is_absolute() { p } else { root.join(p) };
            }
        }
    }
    git
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn discover_head_paths_finds_main_and_worktrees() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let git = root.join(".git");
        std::fs::create_dir_all(git.join("worktrees/feat-a")).unwrap();
        std::fs::create_dir_all(git.join("worktrees/feat-b")).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(
            git.join("worktrees/feat-a/HEAD"),
            "ref: refs/heads/feat-a\n",
        )
        .unwrap();
        std::fs::write(
            git.join("worktrees/feat-b/HEAD"),
            "ref: refs/heads/feat-b\n",
        )
        .unwrap();

        let paths = discover_head_paths(root);
        assert_eq!(paths.len(), 3);
        assert!(paths.contains(&git.join("HEAD")));
        assert!(paths.contains(&git.join("worktrees/feat-a/HEAD")));
        assert!(paths.contains(&git.join("worktrees/feat-b/HEAD")));
    }

    #[test]
    fn discover_head_paths_missing_repo_is_empty() {
        let dir = tempdir().unwrap();
        assert!(discover_head_paths(dir.path()).is_empty());
    }

    #[test]
    fn resolve_git_dir_follows_file_pointer() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("wt");
        let real = dir.path().join("real-gitdir");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(root.join(".git"), format!("gitdir: {}\n", real.display())).unwrap();
        assert_eq!(resolve_git_dir(&root), real);
    }
}
