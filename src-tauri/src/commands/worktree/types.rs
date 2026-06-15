//! Serializable data types crossing the Tauri command boundary.

use raum_core::config::{BranchPrefixMode, PathStrategy};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeListItem {
    pub branch: Option<String>,
    pub path: String,
    pub head: Option<String>,
    pub locked: bool,
    pub detached: bool,
    /// The upstream/base branch this worktree tracks (e.g. "main", "origin/main").
    /// `None` when the branch has no upstream configured or the worktree is
    /// detached.
    pub upstream: Option<String>,
    /// The branch this worktree was originally sprouted from, as selected in
    /// the Create-Worktree modal. Persisted per-branch via
    /// `git config branch.<name>.raumBase` so it survives restarts without a
    /// new TOML schema. `None` for pre-existing worktrees and for the
    /// project's root worktree.
    pub base_branch: Option<String>,
}

/// Output of `worktree_preview_path`: both the prefixed branch (what git will
/// actually name the branch) and the fully rendered path preview.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePathPreview {
    pub prefixed_branch: String,
    pub path: String,
    pub pattern: String,
    pub branch_prefix_mode: BranchPrefixMode,
    /// Worktree path preset that produced `pattern`. The modal pre-selects its
    /// strategy picker from this so settings/modal stay in sync.
    pub path_strategy: PathStrategy,
}

/// Manifest preview payload. Mirrors `HydrationManifest` but flattens it so
/// the UI can render two sections (Copy / Symlink) without parsing TOML.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeManifestPreview {
    pub copy: Vec<String>,
    pub symlink: Vec<String>,
    pub from_raum_toml: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateOptions {
    /// When true, run `git worktree add -b <branch>` (creates the branch).
    /// Defaults to true so the common "new worktree" path Just Works.
    #[serde(default = "default_true")]
    pub create_branch: bool,
    /// Optional commit-ish to root a new branch at.
    #[serde(default)]
    pub from_ref: Option<String>,
    /// Optional branch name this worktree is being sprouted from. Persisted
    /// via `git config branch.<name>.raumBase` so the sidebar can render
    /// `base -> branch` after restart. When `None`, no config entry is
    /// written and the sidebar falls back to the upstream tracking branch.
    #[serde(default)]
    pub base_branch: Option<String>,
    /// Disable hydration (copy/symlink) for this invocation.
    #[serde(default)]
    pub skip_hydration: bool,
    /// Per-creation override for the worktree path preset. When `Some`, the
    /// effective `WorktreeConfig.path_pattern` is replaced for this call only.
    /// `Custom` requires `path_pattern_override` to be set.
    #[serde(default)]
    pub path_strategy: Option<PathStrategy>,
    /// Freeform pattern used when `path_strategy = Custom`.
    #[serde(default)]
    pub path_pattern_override: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreated {
    pub path: String,
    pub branch: String,
    pub copied: usize,
    pub symlinked: usize,
    pub skipped: usize,
    /// Which hooks executed successfully (e.g. `["preCreate", "postCreate"]`).
    /// Empty when no hooks are configured.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hooks_ran: Vec<String>,
}

/// Response from `worktree_branches`: all local branches plus the one currently
/// checked out in the root worktree.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeBranchList {
    /// All local branch names, alphabetically sorted.
    pub branches: Vec<String>,
    /// The branch currently checked out in the root worktree (`None` in
    /// detached-HEAD state).
    pub current: Option<String>,
}

/// Response from `worktree_branch_merged`. `merged_into` lists local branches
/// that already contain the queried branch's tip (excluding the branch
/// itself). An empty list means deleting the branch would drop commits that
/// aren't reachable from anywhere else locally.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchMergeStatus {
    pub merged_into: Vec<String>,
}

/// Preview payload for a merge of `<source_branch>` (the worktree's branch)
/// into `<target_branch>` (its sprouted-from base). Pure read-only — runs
/// `git merge-tree` so no working tree is mutated.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeMergePreview {
    /// Branch the source worktree is on. `None` for detached HEAD.
    pub source_branch: Option<String>,
    /// Branch the merge would land into. Resolved in this order:
    /// `branch.<src>.raumBase` → upstream stripped of `origin/` → main
    /// worktree's branch. `None` when none of those resolve to a usable ref.
    pub target_branch: Option<String>,
    /// Filesystem path of the worktree currently checking out `target_branch`,
    /// when one exists. The merge runs there.
    pub target_worktree_path: Option<String>,
    /// True iff `target_branch` is checked out in some worktree we know about.
    /// When false the merge command would have to switch branches in the main
    /// repo, which we refuse — the user should check it out themselves.
    pub target_checked_out: bool,
    /// Source worktree dirty state — same shape as `worktree_status`.
    pub source_dirty: bool,
    /// Target worktree dirty state. `false` when the target isn't checked out
    /// anywhere we know about.
    pub target_dirty: bool,
    /// Commits on source not in target. `0` means already merged / nothing to do.
    pub ahead: u32,
    /// Commits on target not in source. Informational only.
    pub behind: u32,
    /// True when target is reachable from source (fast-forward possible).
    pub can_fast_forward: bool,
    /// Conflicting paths detected by `git merge-tree`. Empty list = clean merge.
    pub conflicts: Vec<String>,
    /// True when `ahead == 0` — source already reachable from target. The UI
    /// surfaces this as "nothing to merge".
    pub already_merged: bool,
    /// Surfaced when something prevents previewing: missing target, missing
    /// merge base, etc. The preview still returns 200 so the modal can render.
    pub error: Option<String>,
}

/// Classified status of one changed file, parsed from porcelain v2 XY codes.
/// `Renamed` covers copies too (both carry an original path).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
    TypeChange,
}

/// One changed file in a worktree. A path with both index and worktree
/// changes (porcelain `MM`) appears **twice** — once with `staged: true`,
/// once with `staged: false` — mirroring the sidebar's two buckets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Worktree-relative path (the *new* path for renames).
    pub path: String,
    /// Original path for renames/copies; `None` otherwise.
    pub orig_path: Option<String>,
    pub kind: FileChangeKind,
    /// True = index side (staged), false = worktree side (unstaged).
    pub staged: bool,
    /// Lines added vs HEAD from `git diff --numstat`. `None` for binary
    /// files, untracked files, and unborn-HEAD repos.
    pub insertions: Option<u32>,
    pub deletions: Option<u32>,
}

/// Output of `worktree_status`. `dirty` is `true` iff `changes` was
/// non-empty before the cap — the sidebar uses it for the bullet indicator
/// and expands the file groups lazily on user request.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub dirty: bool,
    /// Per-file entries (staged and unstaged interleaved; filter on
    /// `staged`). Capped at `MAX_FILE_CHANGES` — see `truncated`.
    pub changes: Vec<FileChange>,
    /// True when `changes` was truncated to the cap (untracked entries are
    /// dropped first). `dirty` and the totals below are computed pre-cap.
    pub truncated: bool,
    /// Total lines added vs HEAD (staged + unstaged). 0 when clean or no HEAD.
    pub insertions: u32,
    /// Total lines removed vs HEAD (staged + unstaged). 0 when clean or no HEAD.
    pub deletions: u32,
    /// Upstream tracking branch (e.g. `origin/main`, or `main`). `None` when
    /// the branch has no upstream configured or the worktree is detached.
    pub upstream: Option<String>,
    /// Commits on HEAD that aren't in `upstream` — the "unpushed" count the
    /// delete dialog surfaces so the user knows what would be lost. `0` when
    /// there's no upstream or the ref walk fails.
    pub ahead: u32,
    /// Commits on `upstream` that aren't in HEAD — just informational; the
    /// delete dialog doesn't warn on it (we're not about to lose them).
    pub behind: u32,
    /// `git stash list` entries recorded while the worktree's branch was
    /// checked out. Stash entries are repo-wide but we filter to the ones
    /// whose `WIP on <branch>` message matches the current branch.
    pub stash_count: u32,
}

/// One commit row in the sidebar's History tab (`git_log`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    /// Unix epoch seconds (`%at`); the frontend renders relative time.
    pub timestamp: i64,
    pub subject: String,
    /// True when the commit is reachable from HEAD but not from
    /// `@{upstream}`. Always false when no upstream is configured — a
    /// no-remote repo shouldn't render every commit as "unpushed" noise
    /// (consistent with `WorktreeStatus.ahead == 0` in that case).
    pub unpushed: bool,
}

/// One changed file of a specific commit (`git_commit_files`). Same shape as
/// [`FileChange`] minus `staged` — a committed change has no stage split.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileChange {
    pub path: String,
    pub orig_path: Option<String>,
    /// Never `Untracked` — commits only contain tracked files.
    pub kind: FileChangeKind,
    /// `None` for binary files.
    pub insertions: Option<u32>,
    pub deletions: Option<u32>,
}
