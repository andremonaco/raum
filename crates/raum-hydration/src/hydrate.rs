//! Hydration (§6.3/§6.4) — speck-style copy + symlink with path-traversal protection.
//!
//! Provides both a blocking `apply_hydration` and an async-friendly `apply_hydration_async`
//! that wraps the blocking I/O in `tokio::task::spawn_blocking`. Callers in async contexts
//! (Tauri commands, other tokio-driven code paths) should prefer the async variant so the
//! reactor is never stalled on filesystem work.

use std::path::{Path, PathBuf};

use raum_core::config::HydrationManifest;
use thiserror::Error;
use tracing::{debug, warn};

#[derive(Debug, Error)]
pub enum HydrationError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("rule `{0}` escapes worktree root")]
    EscapingPath(String),
    #[error("blocking task join error: {0}")]
    Join(String),
}

#[derive(Debug, Default, Clone)]
pub struct HydrationReport {
    pub copied: Vec<PathBuf>,
    pub symlinked: Vec<PathBuf>,
    pub skipped: Vec<PathBuf>,
}

/// Apply `manifest` synchronously. Safe to call from non-async contexts; for async callers
/// prefer [`apply_hydration_async`] so the tokio reactor is not blocked on filesystem work.
pub fn apply_hydration(
    source: &Path,
    target: &Path,
    manifest: &HydrationManifest,
) -> Result<HydrationReport, HydrationError> {
    let mut report = HydrationReport::default();

    // Symlinks win over duplicate copies — collect symlink set first.
    let symlink_set: std::collections::HashSet<&String> = manifest.symlink.iter().collect();

    for rel in &manifest.copy {
        if symlink_set.contains(rel) {
            continue;
        }
        let src = safe_join(source, rel)?;
        let dst = safe_join(target, rel)?;
        if !src.exists() {
            report.skipped.push(src);
            continue;
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if src.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            // `std::fs::copy` preserves permission bits on Unix, which satisfies §6.3's
            // "preserve file modes on copy" requirement.
            std::fs::copy(&src, &dst)?;
        }
        report.copied.push(dst);
    }

    for rel in &manifest.symlink {
        let src = safe_join(source, rel)?;
        let dst = safe_join(target, rel)?;
        if !src.exists() {
            report.skipped.push(src);
            continue;
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if dst.exists() || dst.symlink_metadata().is_ok() {
            // Replace pre-existing destination so the symlink wins.
            if dst.is_dir() && !dst.symlink_metadata()?.file_type().is_symlink() {
                std::fs::remove_dir_all(&dst)?;
            } else {
                std::fs::remove_file(&dst)?;
            }
        }
        symlink(&src, &dst)?;
        report.symlinked.push(dst);
    }

    debug!(
        copied = report.copied.len(),
        symlinked = report.symlinked.len(),
        skipped = report.skipped.len(),
        "hydration applied"
    );
    Ok(report)
}

/// Async-friendly wrapper: runs [`apply_hydration`] on a `tokio::task::spawn_blocking`
/// worker, avoiding blocking filesystem I/O on the runtime reactor.
pub async fn apply_hydration_async(
    source: PathBuf,
    target: PathBuf,
    manifest: HydrationManifest,
) -> Result<HydrationReport, HydrationError> {
    tokio::task::spawn_blocking(move || apply_hydration(&source, &target, &manifest))
        .await
        .map_err(|e| HydrationError::Join(e.to_string()))?
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if file_type.is_symlink() {
            let target = std::fs::read_link(&from)?;
            symlink(&target, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, HydrationError> {
    let cleaned = PathBuf::from(rel);
    if cleaned.is_absolute() {
        return Err(HydrationError::EscapingPath(rel.to_string()));
    }
    for component in cleaned.components() {
        if matches!(
            component,
            std::path::Component::ParentDir | std::path::Component::RootDir
        ) {
            return Err(HydrationError::EscapingPath(rel.to_string()));
        }
    }
    let joined = root.join(cleaned);
    // Belt-and-suspenders: canonicalize both sides to defeat symlink escapes. Walk the
    // joined path up until we find an existing ancestor we can canonicalize.
    let canon_root = canonicalize_or_self(root);
    let canon_anchor = closest_canonical_ancestor(&joined, &canon_root);
    if !canon_anchor.starts_with(&canon_root) {
        warn!(?joined, "rejected path outside root");
        return Err(HydrationError::EscapingPath(rel.to_string()));
    }
    Ok(joined)
}

fn canonicalize_or_self(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Return the canonical form of `path`'s closest existing ancestor. If no ancestor
/// canonicalizes successfully, fall back to `fallback`.
fn closest_canonical_ancestor(path: &Path, fallback: &Path) -> PathBuf {
    let mut cur: Option<&Path> = Some(path);
    while let Some(p) = cur {
        if let Ok(canon) = std::fs::canonicalize(p) {
            return canon;
        }
        cur = p.parent();
    }
    fallback.to_path_buf()
}

#[cfg(unix)]
fn symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

#[cfg(windows)]
fn symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::os::windows::fs::symlink_dir(src, dst)
    } else {
        std::os::windows::fs::symlink_file(src, dst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write(p: &Path, body: &str) {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, body).unwrap();
    }

    #[test]
    fn copies_files_and_dirs() {
        let src = tempdir().unwrap();
        let dst = tempdir().unwrap();
        write(&src.path().join(".env"), "X=1");
        write(&src.path().join("config/app.toml"), "k='v'");
        let manifest = HydrationManifest {
            copy: vec![".env".into(), "config".into()],
            symlink: vec![],
        };
        apply_hydration(src.path(), dst.path(), &manifest).unwrap();
        assert_eq!(
            std::fs::read_to_string(dst.path().join(".env")).unwrap(),
            "X=1"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("config/app.toml")).unwrap(),
            "k='v'"
        );
    }

    #[test]
    fn copies_dir_recursively_with_nested_structure() {
        // Task 6.4: copy dir recursively — verify nested subtrees land intact.
        let src = tempdir().unwrap();
        let dst = tempdir().unwrap();
        write(&src.path().join("tree/a/b/c.txt"), "deep");
        write(&src.path().join("tree/top.txt"), "top");
        let manifest = HydrationManifest {
            copy: vec!["tree".into()],
            symlink: vec![],
        };
        apply_hydration(src.path(), dst.path(), &manifest).unwrap();
        assert_eq!(
            std::fs::read_to_string(dst.path().join("tree/a/b/c.txt")).unwrap(),
            "deep"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("tree/top.txt")).unwrap(),
            "top"
        );
    }

    #[test]
    fn creates_nested_target_dirs() {
        // Task 6.3: nested directory creation — a rule referencing a deep path must
        // cause intermediate target dirs to be materialised.
        let src = tempdir().unwrap();
        let dst = tempdir().unwrap();
        write(&src.path().join("deep/inner/file.txt"), "hi");
        let manifest = HydrationManifest {
            copy: vec!["deep/inner/file.txt".into()],
            symlink: vec![],
        };
        // Note: dst.path() exists (tempdir), but deep/inner does not — the implementation
        // must create both levels before copying the file.
        assert!(!dst.path().join("deep").exists());
        let report = apply_hydration(src.path(), dst.path(), &manifest).unwrap();
        assert_eq!(report.copied.len(), 1);
        assert!(dst.path().join("deep/inner").is_dir());
        assert_eq!(
            std::fs::read_to_string(dst.path().join("deep/inner/file.txt")).unwrap(),
            "hi"
        );
    }

    #[cfg(unix)]
    #[test]
    fn copy_preserves_file_modes() {
        // Task 6.3: preserve file modes on copy (std::fs::copy preserves perms on unix).
        use std::os::unix::fs::PermissionsExt;
        let src = tempdir().unwrap();
        let dst = tempdir().unwrap();
        let script = src.path().join("run.sh");
        write(&script, "#!/bin/sh\necho hi\n");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let manifest = HydrationManifest {
            copy: vec!["run.sh".into()],
            symlink: vec![],
        };
        apply_hydration(src.path(), dst.path(), &manifest).unwrap();
        let copied_meta = std::fs::metadata(dst.path().join("run.sh")).unwrap();
        let mode = copied_meta.permissions().mode() & 0o777;
        assert_eq!(mode, 0o755, "copy preserved unix mode bits");
    }

    #[test]
    fn symlinks_dirs() {
        let src = tempdir().unwrap();
        let dst = tempdir().unwrap();
        std::fs::create_dir_all(src.path().join("node_modules")).unwrap();
        let manifest = HydrationManifest {
            copy: vec![],
            symlink: vec!["node_modules".into()],
        };
        apply_hydration(src.path(), dst.path(), &manifest).unwrap();
        let meta = dst.path().join("node_modules").symlink_metadata().unwrap();
        assert!(meta.file_type().is_symlink());
    }

    #[test]
    fn symlink_wins_over_duplicate_copy() {
        let src = tempdir().unwrap();
        let dst = tempdir().unwrap();
        std::fs::create_dir_all(src.path().join(".claude")).unwrap();
        let manifest = HydrationManifest {
            copy: vec![".claude".into()],
            symlink: vec![".claude".into()],
        };
        apply_hydration(src.path(), dst.path(), &manifest).unwrap();
        let meta = dst.path().join(".claude").symlink_metadata().unwrap();
        assert!(meta.file_type().is_symlink());
    }

    #[test]
    fn missing_source_is_skipped() {
        let src = tempdir().unwrap();
        let dst = tempdir().unwrap();
        let manifest = HydrationManifest {
            copy: vec!["missing.txt".into()],
            symlink: vec!["also_missing".into()],
        };
        let report = apply_hydration(src.path(), dst.path(), &manifest).unwrap();
        assert!(report.copied.is_empty());
        assert!(report.symlinked.is_empty());
        assert_eq!(report.skipped.len(), 2);
    }

    #[test]
    fn rejects_escaping_path_parent_dir() {
        let src = tempdir().unwrap();
        let dst = tempdir().unwrap();
        let manifest = HydrationManifest {
            copy: vec!["../oops".into()],
            symlink: vec![],
        };
        let err = apply_hydration(src.path(), dst.path(), &manifest).unwrap_err();
        assert!(matches!(err, HydrationError::EscapingPath(_)));
    }

    #[test]
    fn rejects_absolute_rule_path() {
        // Task 6.3: reject absolute paths in rules.
        let src = tempdir().unwrap();
        let dst = tempdir().unwrap();
        let manifest = HydrationManifest {
            copy: vec!["/etc/passwd".into()],
            symlink: vec![],
        };
        let err = apply_hydration(src.path(), dst.path(), &manifest).unwrap_err();
        assert!(matches!(err, HydrationError::EscapingPath(_)));
    }

    #[test]
    fn rejects_nested_parent_traversal() {
        let src = tempdir().unwrap();
        let dst = tempdir().unwrap();
        let manifest = HydrationManifest {
            copy: vec!["subdir/../../oops".into()],
            symlink: vec![],
        };
        let err = apply_hydration(src.path(), dst.path(), &manifest).unwrap_err();
        assert!(matches!(err, HydrationError::EscapingPath(_)));
    }

    #[tokio::test]
    async fn async_variant_applies_hydration() {
        // Task 6.3: apply_hydration_async wraps blocking I/O correctly.
        let src = tempdir().unwrap();
        let dst = tempdir().unwrap();
        write(&src.path().join("file.txt"), "async hi");
        let manifest = HydrationManifest {
            copy: vec!["file.txt".into()],
            symlink: vec![],
        };
        let report =
            apply_hydration_async(src.path().to_path_buf(), dst.path().to_path_buf(), manifest)
                .await
                .unwrap();
        assert_eq!(report.copied.len(), 1);
        assert_eq!(
            std::fs::read_to_string(dst.path().join("file.txt")).unwrap(),
            "async hi"
        );
    }
}
