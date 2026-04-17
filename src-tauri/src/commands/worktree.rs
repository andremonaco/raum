//! Worktree commands (§6.5–§6.8, §9.1–§9.7). Owned by Wave 2B;
//! Wave 3C adds `worktree_status`, `quickfire_history_*`, and
//! `config_set_sidebar_width` for the sidebar
//! (`frontend/src/components/Sidebar.tsx`).
//!
//! Exposes the Tauri surface that the Solid UI calls:
//!
//! * `worktree_preview_path` — live path preview for the "Create worktree"
//!   modal. Rendered from the effective project config.
//! * `worktree_preview_manifest` — return the effective hydration manifest
//!   so the modal can show "will be copied / symlinked".
//! * `worktree_create` — resolve branch prefix + path pattern, run
//!   `git worktree add`, then apply the hydration manifest.
//! * `worktree_list` — list worktrees for a project.
//! * `worktree_remove` — remove a worktree.
//! * `worktree_config_write` — save a TOML fragment either into the project's
//!   `.raum.toml` (if `in_repo`) or into the user-level `project.toml`.
//! * `worktree_status` — §9.1 poll `git status --porcelain=v2` for a worktree
//!   and return a classified `{dirty, untracked, modified, staged}` snapshot
//!   used by the sidebar dirty indicator and the Open/Staged file groups.
//! * `quickfire_history_get` / `quickfire_history_push` — §9.6 persist the
//!   bounded ring of recent quick-fire commands in
//!   `~/.config/raum/state/quickfire-history.toml`.
//! * `config_set_sidebar_width` — §9.7 persist the sidebar width drag handle
//!   into `config.toml.sidebar.width_px` (debounced client-side).

use std::path::{Path, PathBuf};
use std::process::Command;

use raum_core::config::{BranchPrefixMode, QUICKFIRE_HISTORY_LIMIT, WorktreeConfig};
use raum_hydration::{
    CreateOptions, HookContext, HookError, HookPhase, PatternInputs, PrefixContext,
    apply_branch_prefix, apply_hydration, preview_path_pattern, resolve_hook_path,
    resolve_worktree_pattern, run_hook, worktree_create as git_worktree_create,
    worktree_list as git_worktree_list, worktree_remove as git_worktree_remove,
};
use serde::{Deserialize, Serialize};

use crate::state::AppHandleState;

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
    /// Disable hydration (copy/symlink) for this invocation.
    #[serde(default)]
    pub skip_hydration: bool,
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

// ---- preview commands ------------------------------------------------------

#[tauri::command]
pub fn worktree_preview_path(
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
    branch: String,
) -> Result<WorktreePathPreview, String> {
    let effective = load_effective(&state, &project_slug)?;
    let prefix_ctx = PrefixContext {
        username: &os_username(),
    };
    let prefixed = apply_branch_prefix(&branch, &effective.worktree, &prefix_ctx);
    // Build a pseudo-ProjectConfig for pattern substitution. We only need
    // `slug`, `root_path`, and the worktree block.
    let project = raum_core::config::ProjectConfig {
        slug: effective.slug.clone(),
        name: effective.name.clone(),
        root_path: effective.root_path.clone(),
        color: effective.color.clone(),
        in_repo_settings: effective.in_repo_settings,
        hydration: effective.hydration.clone(),
        worktree: effective.worktree.clone(),
        agent_defaults: effective.agent_defaults.clone(),
        ..raum_core::config::ProjectConfig::default()
    };
    let path = preview_path_pattern(
        &effective.worktree.path_pattern,
        &PatternInputs {
            project: &project,
            branch: &prefixed,
        },
    );
    Ok(WorktreePathPreview {
        prefixed_branch: prefixed,
        path: path.to_string_lossy().into_owned(),
        pattern: effective.worktree.path_pattern.clone(),
        branch_prefix_mode: effective.worktree.branch_prefix_mode,
    })
}

#[tauri::command]
pub fn worktree_preview_manifest(
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
) -> Result<WorktreeManifestPreview, String> {
    let effective = load_effective(&state, &project_slug)?;
    Ok(WorktreeManifestPreview {
        copy: effective.hydration.copy.clone(),
        symlink: effective.hydration.symlink.clone(),
        from_raum_toml: effective.has_raum_toml,
    })
}

// ---- mutations -------------------------------------------------------------

#[tauri::command]
pub fn worktree_create(
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
    branch: String,
    options: Option<WorktreeCreateOptions>,
) -> Result<WorktreeCreated, String> {
    let opts = options.unwrap_or(WorktreeCreateOptions {
        create_branch: true,
        from_ref: None,
        skip_hydration: false,
    });
    let effective = load_effective(&state, &project_slug)?;
    let prefix_ctx = PrefixContext {
        username: &os_username(),
    };
    let prefixed = apply_branch_prefix(&branch, &effective.worktree, &prefix_ctx);
    let project = raum_core::config::ProjectConfig {
        slug: effective.slug.clone(),
        name: effective.name.clone(),
        root_path: effective.root_path.clone(),
        worktree: effective.worktree.clone(),
        hydration: effective.hydration.clone(),
        ..raum_core::config::ProjectConfig::default()
    };
    let target = preview_path_pattern(
        &effective.worktree.path_pattern,
        &PatternInputs {
            project: &project,
            branch: &prefixed,
        },
    );
    // If the user picked the inside-project preset (target lives under
    // `<root>/.raum/…`), make sure the directory is gitignored so the worktree
    // doesn't show up in the main repo's index. Failure is never fatal — a
    // read-only repo or a project without git should still be able to create
    // worktrees.
    if target_is_inside_raum_dir(&effective.root_path, &target) {
        if let Err(e) = ensure_raum_gitignored(&effective.root_path) {
            tracing::warn!(
                root = %effective.root_path.display(),
                error = %e,
                "worktree_create: failed to update .gitignore for .raum/"
            );
        }
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
    }

    let hooks = &effective.worktree.hooks;
    let timeout_secs = hooks.timeout_secs;
    let mut hooks_ran: Vec<String> = Vec::new();

    // Pre-create hook: runs with the project root as cwd, before git creates
    // anything. Failure aborts creation — no worktree ends up on disk.
    if let Some(raw) = hooks.pre_create.as_deref() {
        let script = resolve_hook_path(&effective.root_path, raw);
        let ctx = HookContext {
            project_slug: &effective.slug,
            project_root: &effective.root_path,
            worktree_path: &target,
            branch: &prefixed,
        };
        run_hook(HookPhase::PreCreate, &script, &ctx, timeout_secs)
            .map_err(|e| format_hook_error("preCreate", &e))?;
        hooks_ran.push("preCreate".into());
    }

    git_worktree_create(
        &effective.root_path,
        &target,
        &CreateOptions {
            branch: prefixed.clone(),
            create_branch: opts.create_branch,
            from_ref: opts.from_ref.clone(),
        },
    )
    .map_err(|e| format!("worktree add: {e}"))?;

    let mut copied = 0usize;
    let mut symlinked = 0usize;
    let mut skipped = 0usize;
    if !opts.skip_hydration {
        let report = apply_hydration(&effective.root_path, &target, &effective.hydration)
            .map_err(|e| format!("hydration: {e}"))?;
        copied = report.copied.len();
        symlinked = report.symlinked.len();
        skipped = report.skipped.len();
    }

    // Post-create hook: cwd is the fresh worktree. Failure does NOT roll back —
    // the worktree exists, so we surface the error with a note so the user can
    // inspect or delete manually.
    if let Some(raw) = hooks.post_create.as_deref() {
        let script = resolve_hook_path(&effective.root_path, raw);
        let ctx = HookContext {
            project_slug: &effective.slug,
            project_root: &effective.root_path,
            worktree_path: &target,
            branch: &prefixed,
        };
        if let Err(e) = run_hook(HookPhase::PostCreate, &script, &ctx, timeout_secs) {
            rescan_git_watcher(&state, &project_slug, &effective.root_path);
            return Err(format!(
                "{} (worktree was created at {} — inspect or remove manually)",
                format_hook_error("postCreate", &e),
                target.display()
            ));
        }
        hooks_ran.push("postCreate".into());
    }

    rescan_git_watcher(&state, &project_slug, &effective.root_path);

    Ok(WorktreeCreated {
        path: target.to_string_lossy().into_owned(),
        branch: prefixed,
        copied,
        symlinked,
        skipped,
        hooks_ran,
    })
}

fn format_hook_error(phase: &str, err: &HookError) -> String {
    format!("hook:{phase}: {err}")
}

#[tauri::command]
pub fn worktree_list(
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
) -> Result<Vec<WorktreeListItem>, String> {
    let effective = load_effective(&state, &project_slug)?;
    let entries = git_worktree_list(&effective.root_path).map_err(|e| format!("list: {e}"))?;
    Ok(entries
        .into_iter()
        .map(|e| {
            let path_str = e.path.to_string_lossy().into_owned();
            let upstream = e
                .branch
                .as_deref()
                .and_then(|branch| fetch_upstream_branch(&path_str, branch));
            WorktreeListItem {
                branch: e.branch,
                path: path_str,
                head: e.head,
                locked: e.locked,
                detached: e.detached,
                upstream,
            }
        })
        .collect())
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

#[tauri::command]
pub fn worktree_branches(
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
) -> Result<WorktreeBranchList, String> {
    let effective = load_effective(&state, &project_slug)?;
    let root = effective.root_path.to_string_lossy().into_owned();

    // Current branch in root worktree (empty in detached-HEAD).
    let current = Command::new("git")
        .args(["-C", &root, "branch", "--show-current"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if s.is_empty() { None } else { Some(s) }
            } else {
                None
            }
        });

    // All local branch names.
    let branches_out = Command::new("git")
        .args(["-C", &root, "branch", "--format=%(refname:short)"])
        .output()
        .map_err(|e| format!("git branch: {e}"))?;
    let mut branches: Vec<String> = String::from_utf8_lossy(&branches_out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    branches.sort();

    Ok(WorktreeBranchList { branches, current })
}

/// Read the configured upstream/merge branch for `branch` in the worktree at
/// `path`. Returns `None` if git is unavailable, the branch is untracked, or
/// the worktree is in detached-HEAD state.
fn fetch_upstream_branch(path: &str, branch: &str) -> Option<String> {
    // Try `git rev-parse --abbrev-ref --symbolic-full-name @{u}` first — this
    // gives "origin/main" or "main" depending on tracking setup.
    let output = Command::new("git")
        .args([
            "-C",
            path,
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{u}",
        ])
        .output()
        .ok()?;
    if output.status.success() {
        let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !s.is_empty() && s != "HEAD" {
            return Some(s);
        }
    }
    // Fallback: read `branch.<name>.merge` from git config, stripping the
    // `refs/heads/` prefix so the UI sees a short name.
    let key = format!("branch.{branch}.merge");
    let out2 = Command::new("git")
        .args(["-C", path, "config", "--get", &key])
        .output()
        .ok()?;
    if out2.status.success() {
        let s = String::from_utf8_lossy(&out2.stdout).trim().to_string();
        if !s.is_empty() {
            return Some(s.trim_start_matches("refs/heads/").to_string());
        }
    }
    None
}

#[tauri::command]
pub fn worktree_remove(
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
    path: String,
    force: bool,
) -> Result<(), String> {
    let effective = load_effective(&state, &project_slug)?;
    git_worktree_remove(&effective.root_path, Path::new(&path), force)
        .map_err(|e| format!("remove: {e}"))?;
    rescan_git_watcher(&state, &project_slug, &effective.root_path);
    Ok(())
}

/// §6.8 — in-app TOML-fragment editor.
///
/// Writes the provided TOML text verbatim to either
/// `<project_root>/.raum.toml` (when `in_repo` is true) or
/// `~/.config/raum/projects/<slug>/project.toml`. The caller (the Solid
/// editor UI) is responsible for round-tripping the current file contents
/// so the write is non-destructive; the backend stays out of the TOML
/// parser to keep the dependency surface minimal.
///
/// Parse errors in the written file surface on next read via `ConfigStore`,
/// which logs a WARN and returns defaults (for `.raum.toml`) or propagates
/// the parse error (for `project.toml`).
#[tauri::command]
pub fn worktree_config_write(
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
    in_repo: bool,
    toml_fragment: String,
) -> Result<(), String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let target: PathBuf = if in_repo {
        let project = store
            .read_project(&project_slug)
            .map_err(|e| format!("read project: {e}"))?
            .ok_or_else(|| format!("project not found: {project_slug}"))?;
        project.root_path.join(".raum.toml")
    } else {
        store
            .root
            .join("projects")
            .join(&project_slug)
            .join("project.toml")
    };
    raum_core::store::atomic_write(&target, toml_fragment.as_bytes())
        .map_err(|e| format!("atomic_write {}: {e}", target.display()))?;
    Ok(())
}

// ---- §9.1 worktree_status --------------------------------------------------

/// Output of `worktree_status`. `dirty` is `true` iff *any* of the three
/// buckets is non-empty — the sidebar uses it for the bullet indicator and
/// expands the file groups lazily on user request.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub dirty: bool,
    pub untracked: Vec<String>,
    pub modified: Vec<String>,
    pub staged: Vec<String>,
    /// Total lines added vs HEAD (staged + unstaged). 0 when clean or no HEAD.
    pub insertions: u32,
    /// Total lines removed vs HEAD (staged + unstaged). 0 when clean or no HEAD.
    pub deletions: u32,
}

/// §9.1 — poll `git status --porcelain=v2` for the worktree at `path`.
///
/// We parse the v2 format because it's stable across git versions and
/// unambiguously separates path fields (tab-separated for renames; the
/// pathname is always the last field on the line). The three buckets returned
/// map to the sidebar's display groups:
///
/// * `untracked` — lines beginning with `?`.
/// * `modified` — entries whose *worktree* status char (`XY`, Y) is non-`.`.
/// * `staged` — entries whose *index* status char (`XY`, X) is non-`.`.
///
/// A single path can appear in both `modified` and `staged` when it has both
/// index and worktree changes; the sidebar surfaces both buckets so the user
/// can see it in each.
#[tauri::command]
pub async fn worktree_status(path: String) -> Result<WorktreeStatus, String> {
    // `git status` shells out — offload to the blocking pool so a slow repo
    // (fsck-in-progress, cold cache) doesn't stall the tokio runtime the
    // webview IPC uses. The 2-second poll cadence means this is the hottest
    // blocking-pool customer in the sidebar.
    tokio::task::spawn_blocking(move || {
        let output = Command::new("git")
            .args([
                "-C",
                path.as_str(),
                "status",
                "--porcelain=v2",
                "--untracked-files=normal",
            ])
            .output()
            .map_err(|e| format!("git status: {e}"))?;
        if !output.status.success() {
            // Non-zero exit is usually "not a git repository" when a
            // worktree path was deleted out from under us. Treat as empty /
            // clean rather than poisoning the sidebar with an error row.
            return Ok(WorktreeStatus::default());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut status = parse_porcelain_v2(stdout.as_ref());

        // Also fetch line-level diff stats vs HEAD. `git diff --shortstat HEAD`
        // covers both staged and unstaged changes in the working tree.
        // On a brand-new repo with no commits, this will fail — treat as 0/0.
        let diff_out = Command::new("git")
            .args(["-C", path.as_str(), "diff", "--shortstat", "HEAD"])
            .output();
        if let Ok(diff_out) = diff_out {
            if diff_out.status.success() {
                let diff_str = String::from_utf8_lossy(&diff_out.stdout);
                let (ins, del) = parse_shortstat(diff_str.as_ref());
                status.insertions = ins;
                status.deletions = del;
            }
        }

        Ok(status)
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))?
}

/// Parse `git status --porcelain=v2` output into the three buckets the sidebar
/// renders. Split out for unit testing without a live repo.
fn parse_porcelain_v2(stdout: &str) -> WorktreeStatus {
    let mut status = WorktreeStatus::default();
    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, ' ');
        let marker = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        match marker {
            // Untracked: "? <path>"
            "?" if !rest.is_empty() => {
                status.untracked.push(rest.to_string());
            }
            "1" => {
                // Ordinary changed entry:
                //   "1 XY sub <mH> <mI> <mW> <hH> <hI> <path>"
                push_changed_path("1", rest, &mut status);
            }
            "2" => {
                // Renamed / copied entry:
                //   "2 XY sub <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<orig>"
                push_changed_path("2", rest, &mut status);
            }
            // "u " (unmerged) and "#" (branch header) are ignored on purpose —
            // the sidebar only visualizes dirty vs clean at this layer.
            _ => {}
        }
    }
    status.dirty =
        !status.untracked.is_empty() || !status.modified.is_empty() || !status.staged.is_empty();
    status
}

fn push_changed_path(marker: &str, rest: &str, out: &mut WorktreeStatus) {
    // `rest` begins with "XY ..." — split off the XY pair then walk to the path.
    let xy = rest.get(..2).unwrap_or("..");
    let index_char = xy.chars().next().unwrap_or('.');
    let worktree_char = xy.chars().nth(1).unwrap_or('.');

    // The path is the final whitespace-separated field for marker "1"; for
    // marker "2" it's the field before the TAB separator (then the original
    // path follows the TAB). We use `rsplit_once('\t')` to peel the TAB half
    // off first; whatever is left has the path as its final space-separated
    // field.
    let pre_tab = rest.rsplit_once('\t').map_or(rest, |(left, _)| left);
    let Some(path) = pre_tab.rsplit_once(' ').map(|(_, p)| p) else {
        return;
    };
    let path = path.to_string();

    // Rename entries (marker "2") always have an index change; guard just in
    // case a future git version breaks that invariant.
    if marker == "2" || index_char != '.' {
        out.staged.push(path.clone());
    }
    if worktree_char != '.' {
        out.modified.push(path);
    }
}

/// Parse `git diff --shortstat HEAD` output into `(insertions, deletions)`.
/// Example line: " 3 files changed, 12 insertions(+), 4 deletions(-)"
/// When only insertions or only deletions, one clause is absent.
fn parse_shortstat(s: &str) -> (u32, u32) {
    let mut ins: u32 = 0;
    let mut del: u32 = 0;
    for part in s.split(',') {
        let part = part.trim();
        if part.contains("insertion") {
            ins = part
                .split_whitespace()
                .next()
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
        } else if part.contains("deletion") {
            del = part
                .split_whitespace()
                .next()
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
        }
    }
    (ins, del)
}

// ---- git stage / unstage ---------------------------------------------------

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

// ---- §9.6 quickfire history ------------------------------------------------

/// §9.6 — list persisted quick-fire commands, most-recent first.
#[tauri::command]
pub fn quickfire_history_get(
    state: tauri::State<'_, AppHandleState>,
) -> Result<Vec<String>, String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let hist = store
        .read_quickfire_history()
        .map_err(|e| format!("read quickfire history: {e}"))?;
    Ok(hist.entries)
}

/// §9.6 — push a new command to the ring. Delegates to
/// `QuickfireHistory::push` which dedupes and truncates to
/// `QUICKFIRE_HISTORY_LIMIT`. Returns the updated list so the UI can avoid a
/// follow-up `_get` round-trip.
#[tauri::command]
pub fn quickfire_history_push(
    state: tauri::State<'_, AppHandleState>,
    command: String,
) -> Result<Vec<String>, String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut hist = store
        .read_quickfire_history()
        .map_err(|e| format!("read quickfire history: {e}"))?;
    hist.push(command);
    // Belt-and-braces cap in case the persisted file was ever written past
    // the limit by a future version.
    if hist.entries.len() > QUICKFIRE_HISTORY_LIMIT {
        hist.entries.truncate(QUICKFIRE_HISTORY_LIMIT);
    }
    store
        .write_quickfire_history(&hist)
        .map_err(|e| format!("write quickfire history: {e}"))?;
    Ok(hist.entries)
}

// ---- §9.7 sidebar width -----------------------------------------------------

/// §9.7 — persist the sidebar width drag handle into
/// `config.toml.sidebar.width_px`. The frontend already debounces drag events;
/// this command is a direct read-modify-write.
///
/// Width is clamped to `[160, 800]` to defend against accidental "drag to
/// 0" states that would render the sidebar invisible and unrecoverable
/// without editing config.toml by hand.
#[tauri::command]
pub fn config_set_sidebar_width(
    state: tauri::State<'_, AppHandleState>,
    width: u32,
) -> Result<u32, String> {
    let clamped = width.clamp(160, 800);
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut cfg = store.read_config().map_err(|e| format!("read: {e}"))?;
    cfg.sidebar.width_px = clamped;
    store
        .write_config(&cfg)
        .map_err(|e| format!("write: {e}"))?;
    Ok(clamped)
}

// ---- helpers ---------------------------------------------------------------

fn load_effective(
    state: &tauri::State<'_, AppHandleState>,
    project_slug: &str,
) -> Result<raum_core::config::EffectiveProjectConfig, String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut eff = store
        .effective_project(project_slug)
        .map_err(|e| format!("effective_project: {e}"))?
        .ok_or_else(|| format!("project not found: {project_slug}"))?;
    // If the effective path_pattern is empty (all layers above the built-in
    // default were silent), fall back to the built-in default via
    // `resolve_worktree_pattern`.
    if eff.worktree.path_pattern.is_empty() {
        let config = store
            .read_config()
            .map_err(|e| format!("read_config: {e}"))?;
        let resolved = resolve_worktree_pattern(
            &config,
            &raum_core::config::ProjectConfig {
                slug: eff.slug.clone(),
                root_path: eff.root_path.clone(),
                worktree: eff.worktree.clone(),
                ..raum_core::config::ProjectConfig::default()
            },
            None,
        );
        eff.worktree = WorktreeConfig {
            path_pattern: resolved.path_pattern,
            branch_prefix_mode: eff.worktree.branch_prefix_mode,
            branch_prefix_custom: eff.worktree.branch_prefix_custom.clone(),
            hooks: eff.worktree.hooks.clone(),
        };
    }
    Ok(eff)
}

fn os_username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default()
}

/// Re-sync the slug's `GitHeadWatcher` against the current on-disk layout.
/// A no-op when no watcher is registered (e.g. bootstrap failed).
fn rescan_git_watcher(state: &tauri::State<'_, AppHandleState>, slug: &str, root: &Path) {
    if let Ok(mut watchers) = state.git_watchers.lock() {
        if let Some(w) = watchers.get_mut(slug) {
            w.rescan(root);
        }
    }
}

/// True when `target` lives somewhere under `<root>/.raum/`. Used to gate the
/// `.gitignore` auto-write on the inside-project worktree preset.
fn target_is_inside_raum_dir(root: &Path, target: &Path) -> bool {
    let raum_dir = root.join(".raum");
    target.starts_with(&raum_dir)
}

/// Ensure `<root>/.gitignore` lists `.raum/`. Idempotent:
///
/// * Missing file → create one containing `.raum/\n`.
/// * Existing file that already ignores `.raum` (or `.raum/`) → no-op.
/// * Existing file without the entry → append a `.raum/` line (preserving a
///   trailing newline if one was present, adding one otherwise).
fn ensure_raum_gitignored(root: &Path) -> std::io::Result<()> {
    let gitignore = root.join(".gitignore");
    match std::fs::read_to_string(&gitignore) {
        Ok(existing) => {
            if gitignore_has_raum_entry(&existing) {
                return Ok(());
            }
            let mut updated = existing;
            if !updated.ends_with('\n') {
                updated.push('\n');
            }
            updated.push_str(".raum/\n");
            std::fs::write(&gitignore, updated)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::write(&gitignore, ".raum/\n")
        }
        Err(e) => Err(e),
    }
}

fn gitignore_has_raum_entry(body: &str) -> bool {
    body.lines().any(|line| {
        let trimmed = line.trim();
        // Skip comments and blank lines. Accept either `.raum` or `.raum/` —
        // git treats both as ignoring the directory at repo root. Also accept
        // the leading-slash forms users sometimes write (`/.raum`, `/.raum/`).
        if trimmed.is_empty() || trimmed.starts_with('#') {
            return false;
        }
        matches!(trimmed, ".raum" | ".raum/" | "/.raum" | "/.raum/")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
