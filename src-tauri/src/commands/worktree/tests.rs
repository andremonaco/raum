//! Pure unit tests covering the parsing + path/gitignore helpers. Live git
//! is exercised in the workspace integration tests (`crates/raum-tmux/tests`)
//! — anything that needs a tempdir + `git` is a deliberate higher tier.

use std::path::Path;

use raum_core::config::{
    NESTED_PATH_PATTERN, PathStrategy, SIBLING_GROUP_PATH_PATTERN, WorktreeConfig,
};

use super::config_io::{
    apply_strategy_override, ensure_raum_gitignored, gitignore_has_raum_entry,
    target_is_inside_raum_dir,
};
use super::status::parse_porcelain_v2;

#[test]
fn apply_strategy_override_no_change_when_none() {
    let mut cfg = WorktreeConfig {
        path_pattern: "freeform/{branch-slug}".into(),
        path_strategy: PathStrategy::Custom,
        ..WorktreeConfig::default()
    };
    apply_strategy_override(&mut cfg, None, None);
    assert_eq!(cfg.path_strategy, PathStrategy::Custom);
    assert_eq!(cfg.path_pattern, "freeform/{branch-slug}");
}

#[test]
fn apply_strategy_override_snaps_to_preset() {
    // Start as Custom with a wandering pattern.
    let mut cfg = WorktreeConfig {
        path_strategy: PathStrategy::Custom,
        path_pattern: "elsewhere/{branch-slug}".into(),
        ..WorktreeConfig::default()
    };
    apply_strategy_override(&mut cfg, Some(PathStrategy::Nested), None);
    assert_eq!(cfg.path_strategy, PathStrategy::Nested);
    assert_eq!(cfg.path_pattern, NESTED_PATH_PATTERN);

    apply_strategy_override(&mut cfg, Some(PathStrategy::SiblingGroup), None);
    assert_eq!(cfg.path_strategy, PathStrategy::SiblingGroup);
    assert_eq!(cfg.path_pattern, SIBLING_GROUP_PATH_PATTERN);
}

#[test]
fn apply_strategy_override_custom_uses_pattern_arg() {
    let mut cfg = WorktreeConfig::default();
    apply_strategy_override(
        &mut cfg,
        Some(PathStrategy::Custom),
        Some("custom/{branch-slug}"),
    );
    assert_eq!(cfg.path_strategy, PathStrategy::Custom);
    assert_eq!(cfg.path_pattern, "custom/{branch-slug}");

    // Empty/missing custom pattern leaves the existing pattern in place.
    let mut cfg2 = WorktreeConfig {
        path_strategy: PathStrategy::Nested,
        path_pattern: NESTED_PATH_PATTERN.into(),
        ..WorktreeConfig::default()
    };
    apply_strategy_override(&mut cfg2, Some(PathStrategy::Custom), None);
    assert_eq!(cfg2.path_strategy, PathStrategy::Custom);
    assert_eq!(cfg2.path_pattern, NESTED_PATH_PATTERN);
}

#[test]
fn parse_clean_repo_is_not_dirty() {
    let status = parse_porcelain_v2("");
    assert!(!status.dirty);
    assert!(status.untracked.is_empty());
    assert!(status.modified.is_empty());
    assert!(status.staged.is_empty());
}

#[test]
fn parse_untracked_bucket() {
    // Porcelain v2 emits untracked entries as "? <path>".
    let status = parse_porcelain_v2("? foo.txt\n? bar/baz.rs\n");
    assert!(status.dirty);
    assert_eq!(status.untracked, vec!["foo.txt", "bar/baz.rs"]);
    assert!(status.modified.is_empty());
    assert!(status.staged.is_empty());
}

#[test]
fn parse_modified_and_staged_buckets() {
    // Two ordinary-changed entries:
    //   " M" — worktree-modified only (unstaged).
    //   "M " — index-modified only (staged).
    //   "MM" — both buckets.
    let input = concat!(
        "1 .M N... 100644 100644 100644 aa bb worktree-only.rs\n",
        "1 M. N... 100644 100644 100644 aa bb staged-only.rs\n",
        "1 MM N... 100644 100644 100644 aa bb both.rs\n",
    );
    let status = parse_porcelain_v2(input);
    assert!(status.dirty);
    assert_eq!(status.modified, vec!["worktree-only.rs", "both.rs"]);
    assert_eq!(status.staged, vec!["staged-only.rs", "both.rs"]);
    assert!(status.untracked.is_empty());
}

#[test]
fn parse_rename_entry_uses_path_before_tab() {
    // Rename entries: "2 R. ... <path>\t<orig>". The displayed path is the
    // new one (before the TAB); we must not include the original copy.
    let input = "2 R. N... 100644 100644 100644 aa bb R100 new/name.rs\told/name.rs\n";
    let status = parse_porcelain_v2(input);
    assert_eq!(status.staged, vec!["new/name.rs"]);
    assert!(status.modified.is_empty());
}

#[test]
fn parse_ignores_branch_header_and_unmerged_lines() {
    let input = concat!(
        "# branch.oid abc123\n",
        "# branch.head main\n",
        "u UU N... 100644 100644 100644 100644 aa bb cc conflict.rs\n",
    );
    let status = parse_porcelain_v2(input);
    assert!(!status.dirty);
}

#[test]
fn target_is_inside_raum_detects_inside_and_outside() {
    let root = Path::new("/projects/demo");
    assert!(target_is_inside_raum_dir(
        root,
        Path::new("/projects/demo/.raum/feat-x")
    ));
    assert!(target_is_inside_raum_dir(
        root,
        Path::new("/projects/demo/.raum")
    ));
    assert!(!target_is_inside_raum_dir(
        root,
        Path::new("/projects/demo-worktrees/feat-x")
    ));
    assert!(!target_is_inside_raum_dir(
        root,
        Path::new("/projects/demo/subdir/.raum/x")
    ));
}

#[test]
fn gitignore_entry_detection() {
    assert!(gitignore_has_raum_entry(".raum/\n"));
    assert!(gitignore_has_raum_entry("node_modules\n.raum\n"));
    assert!(gitignore_has_raum_entry("# comment\n/.raum/\n"));
    assert!(!gitignore_has_raum_entry(""));
    assert!(!gitignore_has_raum_entry("node_modules\ndist\n"));
    // Partial matches must not count.
    assert!(!gitignore_has_raum_entry(".raum-backup\n"));
    assert!(!gitignore_has_raum_entry("# .raum/\n"));
}

#[test]
fn ensure_raum_gitignored_creates_file() {
    let dir = tempfile::tempdir().unwrap();
    ensure_raum_gitignored(dir.path()).unwrap();
    let body = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
    assert_eq!(body, ".raum/\n");
}

#[test]
fn ensure_raum_gitignored_appends_missing_entry() {
    let dir = tempfile::tempdir().unwrap();
    let gi = dir.path().join(".gitignore");
    std::fs::write(&gi, "node_modules\ndist\n").unwrap();
    ensure_raum_gitignored(dir.path()).unwrap();
    let body = std::fs::read_to_string(&gi).unwrap();
    assert_eq!(body, "node_modules\ndist\n.raum/\n");
}

#[test]
fn ensure_raum_gitignored_adds_newline_when_missing() {
    let dir = tempfile::tempdir().unwrap();
    let gi = dir.path().join(".gitignore");
    std::fs::write(&gi, "node_modules").unwrap();
    ensure_raum_gitignored(dir.path()).unwrap();
    let body = std::fs::read_to_string(&gi).unwrap();
    assert_eq!(body, "node_modules\n.raum/\n");
}

#[test]
fn ensure_raum_gitignored_is_noop_when_present() {
    let dir = tempfile::tempdir().unwrap();
    let gi = dir.path().join(".gitignore");
    std::fs::write(&gi, "node_modules\n.raum/\n").unwrap();
    ensure_raum_gitignored(dir.path()).unwrap();
    let body = std::fs::read_to_string(&gi).unwrap();
    assert_eq!(body, "node_modules\n.raum/\n");
}
