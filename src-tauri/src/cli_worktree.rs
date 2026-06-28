//! `raum worktree create <branch>` — headless worktree creation from inside a
//! raum pane.
//!
//! Resolves which project the invocation belongs to (via `$RAUM_PROJECT_SLUG`,
//! injected into the pane env at spawn, or by matching the current git repo
//! against the registered projects), loads the user's stored worktree settings
//! (global path + per-project prefix / hooks / hydration), and runs the shared
//! [`raum_hydration::create_worktree`] orchestrator — the same hydration +
//! pre/post-create scripts as the GUI — printing progress to stdout.
//!
//! Runs as a short-lived process and exits; it never boots the GUI.

use std::path::{Path, PathBuf};
use std::process::Command;

use raum_core::config::{
    NESTED_PATH_PATTERN, PathStrategy, ProjectConfig, SIBLING_GROUP_PATH_PATTERN, WorktreeConfig,
};
use raum_core::store::{ConfigStore, merge_project_with_raum_toml};
use raum_hydration::{CreateParams, CreateReport, Progress, StepStatus, create_worktree};

const HELP: &str = "raum worktree create — create a git worktree using your raum settings

USAGE:
    raum worktree create <BRANCH> [OPTIONS]

ARGS:
    <BRANCH>                Name of a NEW branch for the worktree. The branch is
                            created; it must not already exist.

OPTIONS:
    --base <REF>           Base ref/branch to root the new branch on.
    --strategy <STRATEGY>  Path placement: nested | parent | custom
                           (defaults to your Settings -> Worktrees choice).
    --path <PATTERN>       Custom path pattern (implies --strategy custom).
    --project <SLUG>       Project slug (defaults to $RAUM_PROJECT_SLUG or the
                           current git repository).
    --json                 Print the result as JSON.
    -h, --help             Show this message.

Runs the same hydration + pre/post-create scripts as the raum GUI.";

/// Entry point for the `worktree` subcommand. `args` is everything after the
/// `worktree` token. Returns the process exit code.
#[must_use]
pub fn run(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("create") => create(&args[1..]),
        Some("-h" | "--help") | None => {
            println!("{HELP}");
            0
        }
        Some(other) => {
            eprintln!("raum worktree: unknown subcommand `{other}` (try `raum worktree --help`)");
            2
        }
    }
}

struct CreateArgs {
    branch: Option<String>,
    base: Option<String>,
    strategy: Option<String>,
    path: Option<String>,
    project: Option<String>,
    json: bool,
}

fn parse_create_args(args: &[String]) -> Result<CreateArgs, String> {
    let mut out = CreateArgs {
        branch: None,
        base: None,
        strategy: None,
        path: None,
        project: None,
        json: false,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-h" | "--help" => {
                println!("{HELP}");
                std::process::exit(0);
            }
            "--json" => out.json = true,
            "--base" => out.base = Some(next_value(&mut it, "--base")?),
            "--strategy" => out.strategy = Some(next_value(&mut it, "--strategy")?),
            "--path" => out.path = Some(next_value(&mut it, "--path")?),
            "--project" => out.project = Some(next_value(&mut it, "--project")?),
            flag if flag.starts_with('-') => return Err(format!("unknown flag `{flag}`")),
            positional => {
                if out.branch.is_some() {
                    return Err(format!("unexpected extra argument `{positional}`"));
                }
                out.branch = Some(positional.to_string());
            }
        }
    }
    Ok(out)
}

fn next_value(it: &mut std::slice::Iter<'_, String>, flag: &str) -> Result<String, String> {
    it.next()
        .cloned()
        .ok_or_else(|| format!("`{flag}` needs a value"))
}

fn create(args: &[String]) -> i32 {
    let parsed = match parse_create_args(args) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("raum worktree create: {e}");
            return 2;
        }
    };
    let Some(branch) = parsed.branch.clone() else {
        eprintln!("raum worktree create: missing <BRANCH> (try `raum worktree create --help`)");
        return 2;
    };

    let store = ConfigStore::default();

    let project = match resolve_project(&store, parsed.project.as_deref()) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("raum worktree create: {e}");
            return 1;
        }
    };

    // Effective config: global path overlay + per-project prefix / hooks / hydration.
    let raum_toml = store.read_raum_toml(&project.root_path).ok().flatten();
    let mut effective = merge_project_with_raum_toml(&project, raum_toml.as_ref());
    let global = match store.read_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("raum worktree create: read config: {e}");
            return 1;
        }
    };
    effective
        .worktree
        .apply_global_path(&global.worktree_config);
    if let Err(e) = apply_cli_strategy(
        &mut effective.worktree,
        parsed.strategy.as_deref(),
        parsed.path.as_deref(),
    ) {
        eprintln!("raum worktree create: {e}");
        return 2;
    }

    let params = CreateParams {
        branch,
        create_branch: true,
        from_ref: parsed.base.clone(),
        base_branch: parsed.base.clone(),
        skip_hydration: false,
        username: os_username(),
    };

    let mut cb = print_progress;
    match create_worktree(
        &effective.slug,
        &effective.root_path,
        &effective.worktree,
        &effective.hydration,
        &params,
        &mut cb,
    ) {
        Ok(report) => {
            if parsed.json {
                println!("{}", report_json(&report));
            } else {
                println!("Created worktree {}", report.branch);
                println!("  path: {}", report.path.display());
                println!(
                    "  copied: {}  symlinked: {}  skipped: {}",
                    report.copied, report.symlinked, report.skipped
                );
                if !report.hooks_ran.is_empty() {
                    println!("  hooks: {}", report.hooks_ran.join(", "));
                }
            }
            0
        }
        Err(e) => {
            eprintln!("raum worktree create: {}", e.message());
            1
        }
    }
}

/// Resolve which registered project this invocation targets.
fn resolve_project(
    store: &ConfigStore,
    explicit_slug: Option<&str>,
) -> Result<ProjectConfig, String> {
    // 1) `--project`, then `$RAUM_PROJECT_SLUG` (injected into the pane env).
    let slug = explicit_slug.map(str::to_string).or_else(|| {
        std::env::var(raum_hooks::RAUM_PROJECT_SLUG_ENV)
            .ok()
            .filter(|s| !s.is_empty())
    });
    if let Some(slug) = slug {
        return store
            .read_project(&slug)
            .map_err(|e| format!("read project `{slug}`: {e}"))?
            .ok_or_else(|| format!("project `{slug}` not found"));
    }

    // 2) Match the current git repo's main worktree against registered projects.
    let repo_root = current_repo_root().ok_or_else(|| {
        "could not determine the project (set RAUM_PROJECT_SLUG, pass --project, or run inside a \
         registered git repo)"
            .to_string()
    })?;
    for s in store
        .list_project_slugs()
        .map_err(|e| format!("list projects: {e}"))?
    {
        if let Some(p) = store.read_project(&s).ok().flatten() {
            if same_path(&p.root_path, &repo_root) {
                return Ok(p);
            }
        }
    }
    Err(format!(
        "no registered raum project matches {}",
        repo_root.display()
    ))
}

/// The main repo's working-tree root (resolves correctly from inside a worktree
/// via `--git-common-dir`).
fn current_repo_root() -> Option<PathBuf> {
    let out = Command::new("git")
        .args(["rev-parse", "--git-common-dir"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let common = PathBuf::from(&raw);
    let common_abs = if common.is_absolute() {
        common
    } else {
        std::env::current_dir().ok()?.join(common)
    };
    // `--git-common-dir` points at `<root>/.git`; strip it for the work tree.
    let root = if common_abs.file_name().is_some_and(|n| n == ".git") {
        common_abs.parent()?.to_path_buf()
    } else {
        common_abs
    };
    Some(std::fs::canonicalize(&root).unwrap_or(root))
}

fn same_path(a: &Path, b: &Path) -> bool {
    let ca = std::fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let cb = std::fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

/// Apply an optional per-invocation `--strategy` / `--path` override onto the
/// resolved worktree config (mirrors the modal's transient override).
fn apply_cli_strategy(
    wc: &mut WorktreeConfig,
    strategy: Option<&str>,
    path: Option<&str>,
) -> Result<(), String> {
    match strategy {
        None => {
            // `--path` without `--strategy` implies custom.
            if let Some(p) = path {
                wc.path_strategy = PathStrategy::Custom;
                wc.path_pattern = p.to_string();
            }
            Ok(())
        }
        Some("nested") => {
            wc.path_strategy = PathStrategy::Nested;
            wc.path_pattern = NESTED_PATH_PATTERN.to_string();
            Ok(())
        }
        Some("parent") => {
            wc.path_strategy = PathStrategy::SiblingGroup;
            wc.path_pattern = SIBLING_GROUP_PATH_PATTERN.to_string();
            Ok(())
        }
        Some("custom") => {
            wc.path_strategy = PathStrategy::Custom;
            match path {
                Some(p) => {
                    wc.path_pattern = p.to_string();
                    Ok(())
                }
                None => Err("--strategy custom requires --path <PATTERN>".to_string()),
            }
        }
        Some(other) => Err(format!(
            "unknown --strategy `{other}` (expected nested|parent|custom)"
        )),
    }
}

fn os_username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default()
}

fn print_progress(p: Progress) {
    match p {
        Progress::Step {
            label,
            status,
            detail,
            ..
        } => match status {
            StepStatus::Completed => println!("  \u{2713} {label}"),
            StepStatus::Failed => eprintln!(
                "  \u{2717} {label}{}",
                detail.map(|d| format!(": {d}")).unwrap_or_default()
            ),
            StepStatus::Skipped | StepStatus::Running => {}
        },
        Progress::Counter { .. } => {}
    }
}

fn report_json(r: &CreateReport) -> String {
    serde_json::json!({
        "path": r.path.to_string_lossy(),
        "branch": r.branch,
        "copied": r.copied,
        "symlinked": r.symlinked,
        "skipped": r.skipped,
        "hooksRan": r.hooks_ran,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn parses_branch_and_flags() {
        let p = parse_create_args(&args(&[
            "feat/x",
            "--base",
            "main",
            "--project",
            "proj",
            "--json",
        ]))
        .unwrap();
        assert_eq!(p.branch.as_deref(), Some("feat/x"));
        assert_eq!(p.base.as_deref(), Some("main"));
        assert_eq!(p.project.as_deref(), Some("proj"));
        assert!(p.json);
        assert!(p.strategy.is_none());
    }

    #[test]
    fn missing_flag_value_errors() {
        assert!(parse_create_args(&args(&["feat/x", "--base"])).is_err());
    }

    #[test]
    fn unknown_flag_errors() {
        assert!(parse_create_args(&args(&["feat/x", "--nope"])).is_err());
    }

    #[test]
    fn extra_positional_errors() {
        assert!(parse_create_args(&args(&["a", "b"])).is_err());
    }

    #[test]
    fn strategy_presets_snap_to_canonical_patterns() {
        let mut wc = WorktreeConfig::default();
        apply_cli_strategy(&mut wc, Some("nested"), None).unwrap();
        assert_eq!(wc.path_strategy, PathStrategy::Nested);
        assert_eq!(wc.path_pattern, NESTED_PATH_PATTERN);

        apply_cli_strategy(&mut wc, Some("parent"), None).unwrap();
        assert_eq!(wc.path_strategy, PathStrategy::SiblingGroup);
        assert_eq!(wc.path_pattern, SIBLING_GROUP_PATH_PATTERN);
    }

    #[test]
    fn strategy_custom_requires_path() {
        let mut wc = WorktreeConfig::default();
        assert!(apply_cli_strategy(&mut wc, Some("custom"), None).is_err());
        apply_cli_strategy(&mut wc, Some("custom"), Some("x/{branch-slug}")).unwrap();
        assert_eq!(wc.path_strategy, PathStrategy::Custom);
        assert_eq!(wc.path_pattern, "x/{branch-slug}");
    }

    #[test]
    fn bare_path_implies_custom() {
        let mut wc = WorktreeConfig::default();
        apply_cli_strategy(&mut wc, None, Some("y/{branch-slug}")).unwrap();
        assert_eq!(wc.path_strategy, PathStrategy::Custom);
        assert_eq!(wc.path_pattern, "y/{branch-slug}");
    }

    #[test]
    fn unknown_strategy_errors() {
        let mut wc = WorktreeConfig::default();
        assert!(apply_cli_strategy(&mut wc, Some("sideways"), None).is_err());
    }
}
