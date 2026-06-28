//! End-to-end worktree creation, shared by the Tauri `worktree_create` command
//! and the `raum worktree create` CLI.
//!
//! [`create_worktree`] runs the validate → preCreate → `git worktree add` →
//! base-meta → hydrate → postCreate sequence synchronously, reporting progress
//! through a transport-agnostic [`Progress`] callback. The Tauri wrapper maps
//! those events onto its IPC `Channel`; the CLI prints them to stdout.
//!
//! Config resolution (which needs the `ConfigStore`) stays with the caller —
//! this module takes an already-resolved [`WorktreeConfig`] + [`HydrationManifest`].

use std::path::{Path, PathBuf};
use std::process::Command;

use raum_core::config::{HydrationManifest, ProjectConfig, WorktreeConfig};

use crate::{
    CreateOptions, HookContext, HookError, HookPhase, PatternInputs, PrefixContext,
    apply_branch_prefix, apply_hydration_with_progress, preview_path_pattern, resolve_hook_path,
    run_hook, validate_path_pattern, worktree_create,
};

/// Per-step `(id, label)` tuples. The `id` strings MUST stay in sync with the
/// frontend progress modal (`CREATE_STEPS` in `create-worktree-modal.tsx`) — the
/// runtime UI matches incoming events to template entries by `id`. The trailing
/// `rescan` step is app-specific (git-watcher refresh) and stays in the Tauri
/// wrapper.
pub const STEP_VALIDATE: (&str, &str) = ("validate", "Validating settings");
pub const STEP_PRE_HOOK: (&str, &str) = ("pre-hook", "Running preCreate hook");
pub const STEP_GIT_ADD: (&str, &str) = ("git-add", "Creating git worktree");
pub const STEP_BASE_META: (&str, &str) = ("base-meta", "Recording base branch");
pub const STEP_HYDRATE: (&str, &str) = ("hydrate", "Hydrating files");
pub const STEP_POST_HOOK: (&str, &str) = ("post-hook", "Running postCreate hook");

/// Status of a single creation step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepStatus {
    Running,
    Completed,
    Skipped,
    Failed,
}

/// A progress update emitted during [`create_worktree`].
#[derive(Debug, Clone)]
pub enum Progress {
    /// A step changed status. `detail` carries an error/warning message when present.
    Step {
        id: &'static str,
        label: &'static str,
        status: StepStatus,
        detail: Option<String>,
    },
    /// Per-rule hydration progress (`current` of `total` rules applied).
    Counter {
        id: &'static str,
        current: u64,
        total: u64,
    },
}

/// Per-creation inputs (the branch + git options). Config (path/prefix/hooks +
/// hydration manifest) is passed separately because the caller resolves it.
#[derive(Debug, Clone)]
pub struct CreateParams {
    pub branch: String,
    pub create_branch: bool,
    pub from_ref: Option<String>,
    pub base_branch: Option<String>,
    pub skip_hydration: bool,
    /// OS username, used to expand the `Username` branch-prefix mode.
    pub username: String,
}

/// Outcome of a successful [`create_worktree`].
#[derive(Debug, Clone)]
pub struct CreateReport {
    pub path: PathBuf,
    pub branch: String,
    pub copied: usize,
    pub symlinked: usize,
    pub skipped: usize,
    pub hooks_ran: Vec<String>,
}

/// Failure modes of [`create_worktree`]. All carry a human-readable message;
/// [`CreateError::PostHook`] additionally means the worktree already exists on
/// disk (the hook ran after `git worktree add` + hydration).
#[derive(Debug)]
pub enum CreateError {
    Validate(String),
    PreHook(String),
    GitAdd(String),
    Hydrate(String),
    PostHook { message: String, path: PathBuf },
}

impl CreateError {
    #[must_use]
    pub fn message(&self) -> &str {
        match self {
            CreateError::Validate(m)
            | CreateError::PreHook(m)
            | CreateError::GitAdd(m)
            | CreateError::Hydrate(m) => m,
            CreateError::PostHook { message, .. } => message,
        }
    }

    /// True when the worktree exists on disk despite the error, so callers
    /// should still refresh their worktree list / git watcher.
    #[must_use]
    pub fn worktree_created(&self) -> bool {
        matches!(self, CreateError::PostHook { .. })
    }
}

impl std::fmt::Display for CreateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for CreateError {}

fn emit(
    progress: &mut dyn FnMut(Progress),
    step: (&'static str, &'static str),
    status: StepStatus,
) {
    progress(Progress::Step {
        id: step.0,
        label: step.1,
        status,
        detail: None,
    });
}

fn emit_detail(
    progress: &mut dyn FnMut(Progress),
    step: (&'static str, &'static str),
    status: StepStatus,
    detail: String,
) {
    progress(Progress::Step {
        id: step.0,
        label: step.1,
        status,
        detail: Some(detail),
    });
}

fn format_hook_error(phase: &str, err: &HookError) -> String {
    format!("hook:{phase}: {err}")
}

/// Create a worktree end to end.
///
/// `worktree` must already carry the effective path pattern, branch-prefix mode,
/// and hooks; `manifest` the effective hydration rules. Progress is reported
/// through `progress`; the function returns the [`CreateReport`] on success.
pub fn create_worktree(
    project_slug: &str,
    repo: &Path,
    worktree: &WorktreeConfig,
    manifest: &HydrationManifest,
    params: &CreateParams,
    progress: &mut dyn FnMut(Progress),
) -> Result<CreateReport, CreateError> {
    // ---- Step 1: validate ------------------------------------------------
    emit(progress, STEP_VALIDATE, StepStatus::Running);
    if let Err(e) = validate_path_pattern(&worktree.path_pattern) {
        emit_detail(progress, STEP_VALIDATE, StepStatus::Failed, e.to_string());
        return Err(CreateError::Validate(e.to_string()));
    }
    let prefix_ctx = PrefixContext {
        username: &params.username,
    };
    let prefixed = apply_branch_prefix(&params.branch, worktree, &prefix_ctx);
    let project = ProjectConfig {
        slug: project_slug.to_string(),
        root_path: repo.to_path_buf(),
        worktree: worktree.clone(),
        ..ProjectConfig::default()
    };
    let target = preview_path_pattern(
        &worktree.path_pattern,
        &PatternInputs {
            project: &project,
            branch: &prefixed,
        },
    );
    // Inside-project preset → make sure `.raum/` is gitignored so the worktree
    // doesn't show up in the main repo's index. Never fatal.
    if target_is_inside_raum_dir(repo, &target) {
        if let Err(e) = ensure_raum_gitignored(repo) {
            tracing::warn!(
                root = %repo.display(),
                error = %e,
                "create_worktree: failed to update .gitignore for .raum/"
            );
        }
    }
    if let Some(parent) = target.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            let msg = format!("mkdir parent: {e}");
            emit_detail(progress, STEP_VALIDATE, StepStatus::Failed, msg.clone());
            return Err(CreateError::Validate(msg));
        }
    }
    emit(progress, STEP_VALIDATE, StepStatus::Completed);

    let timeout_secs = worktree.hooks.timeout_secs;
    let mut hooks_ran: Vec<String> = Vec::new();

    // ---- Step 2: preCreate hook ------------------------------------------
    if let Some(raw) = worktree.hooks.pre_create.as_deref() {
        emit(progress, STEP_PRE_HOOK, StepStatus::Running);
        let script = resolve_hook_path(repo, raw);
        let ctx = HookContext {
            project_slug,
            project_root: repo,
            worktree_path: &target,
            branch: &prefixed,
        };
        match run_hook(HookPhase::PreCreate, &script, &ctx, timeout_secs) {
            Ok(_) => {
                emit(progress, STEP_PRE_HOOK, StepStatus::Completed);
                hooks_ran.push("preCreate".into());
            }
            Err(e) => {
                let msg = format_hook_error("preCreate", &e);
                emit_detail(progress, STEP_PRE_HOOK, StepStatus::Failed, msg.clone());
                return Err(CreateError::PreHook(msg));
            }
        }
    } else {
        emit(progress, STEP_PRE_HOOK, StepStatus::Skipped);
    }

    // ---- Step 3: git worktree add ----------------------------------------
    emit(progress, STEP_GIT_ADD, StepStatus::Running);
    if let Err(e) = worktree_create(
        repo,
        &target,
        &CreateOptions {
            branch: prefixed.clone(),
            create_branch: params.create_branch,
            from_ref: params.from_ref.clone(),
        },
    ) {
        let msg = format!("worktree add: {e}");
        emit_detail(progress, STEP_GIT_ADD, StepStatus::Failed, msg.clone());
        return Err(CreateError::GitAdd(msg));
    }
    emit(progress, STEP_GIT_ADD, StepStatus::Completed);

    // ---- Step 4: persist base-branch metadata ----------------------------
    match params
        .base_branch
        .as_deref()
        .filter(|s| !s.is_empty())
        .filter(|_| params.create_branch)
    {
        Some(base) => {
            emit(progress, STEP_BASE_META, StepStatus::Running);
            match set_raum_base_branch(repo, &prefixed, base) {
                Ok(()) => emit(progress, STEP_BASE_META, StepStatus::Completed),
                Err(e) => {
                    tracing::warn!(
                        branch = %prefixed,
                        error = %e,
                        "create_worktree: failed to persist raumBase",
                    );
                    // Non-fatal — the worktree exists, sidebar falls back to upstream.
                    emit_detail(
                        progress,
                        STEP_BASE_META,
                        StepStatus::Skipped,
                        format!("warn: {e}"),
                    );
                }
            }
        }
        None => emit(progress, STEP_BASE_META, StepStatus::Skipped),
    }

    // ---- Step 5: hydrate (per-rule counter) ------------------------------
    let mut copied = 0usize;
    let mut symlinked = 0usize;
    let mut skipped = 0usize;
    if params.skip_hydration {
        emit(progress, STEP_HYDRATE, StepStatus::Skipped);
    } else {
        emit(progress, STEP_HYDRATE, StepStatus::Running);
        let res = apply_hydration_with_progress(repo, &target, manifest, |cur, tot| {
            progress(Progress::Counter {
                id: STEP_HYDRATE.0,
                current: cur,
                total: tot,
            });
        });
        match res {
            Ok(report) => {
                copied = report.copied.len();
                symlinked = report.symlinked.len();
                skipped = report.skipped.len();
                emit(progress, STEP_HYDRATE, StepStatus::Completed);
            }
            Err(e) => {
                let msg = format!("hydration: {e}");
                emit_detail(progress, STEP_HYDRATE, StepStatus::Failed, msg.clone());
                return Err(CreateError::Hydrate(msg));
            }
        }
    }

    // ---- Step 6: postCreate hook -----------------------------------------
    if let Some(raw) = worktree.hooks.post_create.as_deref() {
        emit(progress, STEP_POST_HOOK, StepStatus::Running);
        let script = resolve_hook_path(repo, raw);
        let ctx = HookContext {
            project_slug,
            project_root: repo,
            worktree_path: &target,
            branch: &prefixed,
        };
        match run_hook(HookPhase::PostCreate, &script, &ctx, timeout_secs) {
            Ok(_) => {
                emit(progress, STEP_POST_HOOK, StepStatus::Completed);
                hooks_ran.push("postCreate".into());
            }
            Err(e) => {
                let msg = format!(
                    "{} (worktree was created at {} — inspect or remove manually)",
                    format_hook_error("postCreate", &e),
                    target.display()
                );
                emit_detail(progress, STEP_POST_HOOK, StepStatus::Failed, msg.clone());
                return Err(CreateError::PostHook {
                    message: msg,
                    path: target,
                });
            }
        }
    } else {
        emit(progress, STEP_POST_HOOK, StepStatus::Skipped);
    }

    Ok(CreateReport {
        path: target,
        branch: prefixed,
        copied,
        symlinked,
        skipped,
        hooks_ran,
    })
}

// ---- base-branch metadata (git config) -----------------------------------

/// Write `branch.<name>.raumBase = <base>` in the repo's local git config so
/// the worktree list can reconstruct "sprouted from" after a restart.
pub fn set_raum_base_branch(repo: &Path, branch: &str, base: &str) -> Result<(), String> {
    let key = format!("branch.{branch}.raumBase");
    let out = Command::new("git")
        .current_dir(repo)
        .args(["config", "--local", &key, base])
        .output()
        .map_err(|e| format!("spawn git config: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Read a previously-persisted `branch.<name>.raumBase` value. `None` when
/// unset, the repo is missing, or git is unavailable.
#[must_use]
pub fn get_raum_base_branch(repo: &str, branch: &str) -> Option<String> {
    let key = format!("branch.{branch}.raumBase");
    let out = Command::new("git")
        .args(["-C", repo, "config", "--local", "--get", &key])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

// ---- inside-project `.gitignore` handling --------------------------------

/// True when `target` lives somewhere under `<root>/.raum/`. Gates the
/// `.gitignore` auto-write on the inside-project (nested) worktree preset.
#[must_use]
pub fn target_is_inside_raum_dir(root: &Path, target: &Path) -> bool {
    let raum_dir = root.join(".raum");
    target.starts_with(&raum_dir)
}

/// Ensure `<root>/.gitignore` lists `.raum/`. Idempotent:
///
/// * Missing file → create one containing `.raum/\n`.
/// * Existing file that already ignores `.raum` (or `.raum/`) → no-op.
/// * Existing file without the entry → append a `.raum/` line (preserving a
///   trailing newline if one was present, adding one otherwise).
pub fn ensure_raum_gitignored(root: &Path) -> std::io::Result<()> {
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

#[must_use]
pub fn gitignore_has_raum_entry(body: &str) -> bool {
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
