//! Pure unit tests covering the parsing + path/gitignore helpers. Live git
//! is exercised in the workspace integration tests (`crates/raum-tmux/tests`)
//! — anything that needs a tempdir + `git` is a deliberate higher tier.

use raum_core::config::{
    NESTED_PATH_PATTERN, PathStrategy, SIBLING_GROUP_PATH_PATTERN, WorktreeConfig,
};

use super::config_io::apply_strategy_override;
use super::git_parse::{
    MAX_FILE_CHANGES, PorcelainStatus, assemble_status, numstat_totals, parse_log_z,
    parse_name_status_z, parse_numstat_z, parse_porcelain_v2_z,
};
use super::types::{FileChange, FileChangeKind};

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

/// Shorthand: (path, kind, staged) projection for assertions.
fn proj(changes: &[FileChange]) -> Vec<(&str, FileChangeKind, bool)> {
    changes
        .iter()
        .map(|c| (c.path.as_str(), c.kind, c.staged))
        .collect()
}

#[test]
fn parse_clean_repo_is_not_dirty() {
    let status = parse_porcelain_v2_z(b"");
    assert!(status.changes.is_empty());
    assert!(status.branch.is_none());
}

#[test]
fn parse_untracked_entries() {
    let status = parse_porcelain_v2_z(b"? foo.txt\0? bar/baz.rs\0");
    assert_eq!(
        proj(&status.changes),
        vec![
            ("foo.txt", FileChangeKind::Untracked, false),
            ("bar/baz.rs", FileChangeKind::Untracked, false),
        ]
    );
}

#[test]
fn parse_modified_staged_and_double_entry() {
    // ".M" — worktree-modified only (unstaged).
    // "M." — index-modified only (staged).
    // "MM" — both sides → two entries for one path.
    let input = concat!(
        "1 .M N... 100644 100644 100644 aa bb worktree-only.rs\0",
        "1 M. N... 100644 100644 100644 aa bb staged-only.rs\0",
        "1 MM N... 100644 100644 100644 aa bb both.rs\0",
        "1 A. N... 000000 100644 100644 aa bb added.rs\0",
        "1 .D N... 100644 100644 000000 aa bb gone.rs\0",
    );
    let status = parse_porcelain_v2_z(input.as_bytes());
    assert_eq!(
        proj(&status.changes),
        vec![
            ("worktree-only.rs", FileChangeKind::Modified, false),
            ("staged-only.rs", FileChangeKind::Modified, true),
            ("both.rs", FileChangeKind::Modified, true),
            ("both.rs", FileChangeKind::Modified, false),
            ("added.rs", FileChangeKind::Added, true),
            ("gone.rs", FileChangeKind::Deleted, false),
        ]
    );
}

#[test]
fn parse_rename_consumes_orig_token_and_keeps_spaces() {
    // `-z` rename records carry the original path as a separate NUL token;
    // the path itself may contain spaces (no quoting in -z mode).
    let input =
        b"2 R. N... 100644 100644 100644 aa bb R100 new dir/name.rs\0old name.rs\0? next.txt\0";
    let status = parse_porcelain_v2_z(input);
    assert_eq!(
        proj(&status.changes),
        vec![
            ("new dir/name.rs", FileChangeKind::Renamed, true),
            ("next.txt", FileChangeKind::Untracked, false),
        ]
    );
    assert_eq!(status.changes[0].orig_path.as_deref(), Some("old name.rs"));
}

#[test]
fn parse_rename_with_worktree_modification() {
    // "RM" — staged rename + unstaged modification of the new path.
    let input = b"2 RM N... 100644 100644 100644 aa bb R100 new.rs\0old.rs\0";
    let status = parse_porcelain_v2_z(input);
    assert_eq!(
        proj(&status.changes),
        vec![
            ("new.rs", FileChangeKind::Renamed, true),
            ("new.rs", FileChangeKind::Modified, false),
        ]
    );
}

#[test]
fn parse_conflict_entry() {
    let input = b"u UU N... 100644 100644 100644 100644 aa bb cc conflict.rs\0";
    let status = parse_porcelain_v2_z(input);
    assert_eq!(
        proj(&status.changes),
        vec![("conflict.rs", FileChangeKind::Conflicted, false)]
    );
}

#[test]
fn parse_branch_headers() {
    let input = concat!(
        "# branch.oid abc123\0",
        "# branch.head main\0",
        "# branch.upstream origin/main\0",
        "# branch.ab +2 -1\0",
    );
    let status = parse_porcelain_v2_z(input.as_bytes());
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(status.upstream.as_deref(), Some("origin/main"));
    assert_eq!(status.ahead, 2);
    assert_eq!(status.behind, 1);
    assert!(status.changes.is_empty());
}

#[test]
fn parse_detached_head_has_no_branch() {
    let status = parse_porcelain_v2_z(b"# branch.oid abc123\0# branch.head (detached)\0");
    assert!(status.branch.is_none());
}

#[test]
fn parse_numstat_plain_binary_and_rename() {
    let input = b"12\t4\tsrc/app.rs\0-\t-\tlogo.png\09\t0\t\0old/path.rs\0new/path.rs\0";
    let map = parse_numstat_z(input);
    assert_eq!(map.get("src/app.rs"), Some(&(Some(12), Some(4))));
    assert_eq!(map.get("logo.png"), Some(&(None, None)));
    assert_eq!(map.get("new/path.rs"), Some(&(Some(9), Some(0))));
    assert_eq!(numstat_totals(&map), (21, 4));
}

#[test]
fn assemble_caps_changes_untracked_first() {
    let mut changes: Vec<FileChange> = (0..MAX_FILE_CHANGES)
        .map(|i| FileChange {
            path: format!("untracked-{i}.txt"),
            orig_path: None,
            kind: FileChangeKind::Untracked,
            staged: false,
            insertions: None,
            deletions: None,
        })
        .collect();
    changes.push(FileChange {
        path: "tracked.rs".into(),
        orig_path: None,
        kind: FileChangeKind::Modified,
        staged: false,
        insertions: None,
        deletions: None,
    });
    let porcelain = PorcelainStatus {
        changes,
        ..PorcelainStatus::default()
    };
    let status = assemble_status(porcelain, &std::collections::HashMap::new(), 0);
    assert!(status.dirty);
    assert!(status.truncated);
    assert_eq!(status.changes.len(), MAX_FILE_CHANGES);
    // The tracked change must survive the cap; untracked entries are dropped.
    assert_eq!(status.changes[0].path, "tracked.rs");
}

#[test]
fn parse_log_chunks_of_five() {
    let input = b"aaaa\x00aa\x00Alice\x001700000000\x00feat: one\x00bbbb\x00bb\x00Bob\x001700000100\x00\x00";
    let commits = parse_log_z(input);
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0].hash, "aaaa");
    assert_eq!(commits[0].short_hash, "aa");
    assert_eq!(commits[0].author, "Alice");
    assert_eq!(commits[0].timestamp, 1_700_000_000);
    assert_eq!(commits[0].subject, "feat: one");
    // Empty subject is an interior token — must survive the trailing-empty
    // trim.
    assert_eq!(commits[1].subject, "");
}

#[test]
fn parse_name_status_with_rename() {
    let input = b"M\0src/app.rs\0R100\0old.rs\0new.rs\0A\0fresh.rs\0D\0gone.rs\0";
    let entries = parse_name_status_z(input);
    assert_eq!(
        entries,
        vec![
            (FileChangeKind::Modified, "src/app.rs".to_string(), None),
            (
                FileChangeKind::Renamed,
                "new.rs".to_string(),
                Some("old.rs".to_string())
            ),
            (FileChangeKind::Added, "fresh.rs".to_string(), None),
            (FileChangeKind::Deleted, "gone.rs".to_string(), None),
        ]
    );
}

// `target_is_inside_raum_dir` + `.gitignore` helpers moved to
// `raum_hydration::orchestrate`; their tests live there now.
