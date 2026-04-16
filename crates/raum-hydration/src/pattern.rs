//! Worktree path pattern resolution (§6.1).
//!
//! Implements the precedence chain `.raum.toml → project.toml → config.toml → built-in default`
//! plus substitution-token validation and preview rendering.

use std::path::{Path, PathBuf};

use raum_core::config::{
    BranchPrefixMode, Config, DEFAULT_PATH_PATTERN, ProjectConfig, RaumToml, WorktreeConfig,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PatternError {
    #[error("pattern lacks a unique branch substitution ({{branch-slug}} or {{branch-name}})")]
    NoBranchToken,
    #[error("unknown substitution `{0}` in pattern")]
    UnknownSubstitution(String),
}

#[derive(Debug, Clone)]
pub struct PatternInputs<'a> {
    pub project: &'a ProjectConfig,
    pub branch: &'a str,
}

const SUBS: &[&str] = &[
    "parent-dir",
    "base-folder",
    "branch-slug",
    "branch-name",
    "project-slug",
];

/// Validate that `pattern` only uses the supported substitutions and contains at least one
/// branch token (`{branch-slug}` or `{branch-name}`).
pub fn validate_path_pattern(pattern: &str) -> Result<(), PatternError> {
    for tok in extract_tokens(pattern) {
        if !SUBS.contains(&tok.as_str()) {
            return Err(PatternError::UnknownSubstitution(tok));
        }
    }
    if !pattern.contains("{branch-slug}") && !pattern.contains("{branch-name}") {
        return Err(PatternError::NoBranchToken);
    }
    Ok(())
}

/// Resolve the effective `WorktreeConfig` using the precedence chain:
/// `.raum.toml → project.toml → config.toml → built-in default`.
///
/// An empty `path_pattern` is treated as "unset" so the next-lower precedence layer applies.
pub fn resolve_worktree_pattern(
    config: &Config,
    project: &ProjectConfig,
    raum_toml: Option<&RaumToml>,
) -> WorktreeConfig {
    if let Some(rt) = raum_toml {
        if let Some(w) = &rt.worktree {
            if !w.path_pattern.is_empty() {
                return w.clone();
            }
        }
    }
    if !project.worktree.path_pattern.is_empty() {
        return project.worktree.clone();
    }
    if !config.worktree_config.path_pattern.is_empty() {
        return config.worktree_config.clone();
    }
    WorktreeConfig {
        path_pattern: DEFAULT_PATH_PATTERN.into(),
        branch_prefix_mode: BranchPrefixMode::None,
        branch_prefix_custom: None,
    }
}

/// Render `pattern` against `inputs`, producing an absolute-ish `PathBuf`.
///
/// Supports all five substitutions: `{parent-dir}`, `{base-folder}`, `{branch-slug}`,
/// `{branch-name}`, `{project-slug}`. `{branch-slug}` runs the branch name through
/// `slug::slugify`, which normalises slashes and spaces to `-`.
pub fn preview_path_pattern(pattern: &str, inputs: &PatternInputs) -> PathBuf {
    let root = &inputs.project.root_path;
    let parent_dir = root.parent().map_or_else(PathBuf::new, Path::to_path_buf);
    let base_folder = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("project")
        .to_string();
    let branch_slug = slug::slugify(inputs.branch);
    let branch_name = inputs.branch.to_string();
    let project_slug = inputs.project.slug.clone();

    let rendered = pattern
        .replace("{parent-dir}", &parent_dir.to_string_lossy())
        .replace("{base-folder}", &base_folder)
        .replace("{branch-slug}", &branch_slug)
        .replace("{branch-name}", &branch_name)
        .replace("{project-slug}", &project_slug);
    PathBuf::from(rendered)
}

fn extract_tokens(pattern: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = pattern.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = pattern[i + 1..].find('}') {
                out.push(pattern[i + 1..i + 1 + end].to_string());
                i = i + 1 + end + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use raum_core::config::{Config, ProjectConfig, RaumToml, WorktreeConfig};
    use std::path::PathBuf;

    fn project_with(pattern: &str) -> ProjectConfig {
        ProjectConfig {
            slug: "demo".into(),
            root_path: PathBuf::from("/tmp/work/demo"),
            worktree: WorktreeConfig {
                path_pattern: pattern.to_string(),
                ..WorktreeConfig::default()
            },
            ..ProjectConfig::default()
        }
    }

    fn config_with(pattern: &str) -> Config {
        Config {
            worktree_config: WorktreeConfig {
                path_pattern: pattern.to_string(),
                ..WorktreeConfig::default()
            },
            ..Config::default()
        }
    }

    #[test]
    fn validates_default_pattern() {
        validate_path_pattern("{parent-dir}/{base-folder}-worktrees/{branch-slug}").unwrap();
    }

    #[test]
    fn validates_branch_name_alternative() {
        validate_path_pattern("{parent-dir}/trees/{branch-name}").unwrap();
    }

    #[test]
    fn rejects_missing_branch_token() {
        let err = validate_path_pattern("{parent-dir}/foo").unwrap_err();
        assert!(matches!(err, PatternError::NoBranchToken));
    }

    #[test]
    fn rejects_pattern_without_any_branch_substitution() {
        // Task 6.1: validation must reject patterns missing BOTH branch tokens.
        let err = validate_path_pattern("{parent-dir}/{base-folder}/{project-slug}").unwrap_err();
        assert!(matches!(err, PatternError::NoBranchToken));
    }

    #[test]
    fn rejects_unknown_substitution() {
        let err = validate_path_pattern("{parent-dir}/{wat}/{branch-slug}").unwrap_err();
        assert!(matches!(err, PatternError::UnknownSubstitution(ref t) if t == "wat"));
    }

    #[test]
    fn previews_substitutions() {
        let p = project_with("");
        let preview = preview_path_pattern(
            "{parent-dir}/{base-folder}-worktrees/{branch-slug}",
            &PatternInputs {
                project: &p,
                branch: "feat/Add Auth",
            },
        );
        assert_eq!(
            preview,
            PathBuf::from("/tmp/work/demo-worktrees/feat-add-auth")
        );
    }

    #[test]
    fn preview_exercises_every_substitution() {
        // Task 6.1: ensure all 5 substitutions are supported.
        let p = ProjectConfig {
            slug: "my-proj".into(),
            root_path: PathBuf::from("/var/src/super-app"),
            ..ProjectConfig::default()
        };
        let preview = preview_path_pattern(
            "{parent-dir}/{base-folder}/{project-slug}/{branch-name}/{branch-slug}",
            &PatternInputs {
                project: &p,
                branch: "Topic X",
            },
        );
        assert_eq!(
            preview,
            PathBuf::from("/var/src/super-app/my-proj/Topic X/topic-x")
        );
    }

    #[test]
    fn preview_slugifies_slashes_and_spaces() {
        // Task 6.1: branch names with slashes/spaces are slugified in {branch-slug}.
        let p = project_with("");
        let preview = preview_path_pattern(
            "{parent-dir}/{branch-slug}",
            &PatternInputs {
                project: &p,
                branch: "feature/Big Refactor  v2",
            },
        );
        assert_eq!(preview, PathBuf::from("/tmp/work/feature-big-refactor-v2"));
    }

    #[test]
    fn preview_returns_pathbuf_type() {
        // Sanity: the return type is PathBuf as required by §6.1.
        let p = project_with("");
        let preview: PathBuf = preview_path_pattern(
            "{parent-dir}/{branch-slug}",
            &PatternInputs {
                project: &p,
                branch: "x",
            },
        );
        assert!(!preview.as_os_str().is_empty());
    }

    #[test]
    fn precedence_raum_toml_wins() {
        let config = Config::default();
        let project = project_with("project/{branch-slug}");
        let raum = RaumToml {
            worktree: Some(WorktreeConfig {
                path_pattern: "raum/{branch-slug}".into(),
                ..WorktreeConfig::default()
            }),
            ..RaumToml::default()
        };
        let resolved = resolve_worktree_pattern(&config, &project, Some(&raum));
        assert_eq!(resolved.path_pattern, "raum/{branch-slug}");
    }

    #[test]
    fn precedence_project_wins_over_config() {
        let config = config_with("config/{branch-slug}");
        let project = project_with("project/{branch-slug}");
        let resolved = resolve_worktree_pattern(&config, &project, None);
        assert_eq!(resolved.path_pattern, "project/{branch-slug}");
    }

    #[test]
    fn precedence_config_used_when_project_empty() {
        let config = config_with("config/{branch-slug}");
        let project = project_with("");
        let resolved = resolve_worktree_pattern(&config, &project, None);
        assert_eq!(resolved.path_pattern, "config/{branch-slug}");
    }

    #[test]
    fn precedence_falls_back_to_builtin_default() {
        let config = config_with("");
        let project = project_with("");
        let resolved = resolve_worktree_pattern(&config, &project, None);
        assert_eq!(resolved.path_pattern, DEFAULT_PATH_PATTERN);
    }

    #[test]
    fn precedence_raum_toml_with_empty_pattern_falls_through() {
        // An explicit empty path_pattern in .raum.toml should not override project.
        let config = Config::default();
        let project = project_with("project/{branch-slug}");
        let raum = RaumToml {
            worktree: Some(WorktreeConfig {
                path_pattern: String::new(),
                ..WorktreeConfig::default()
            }),
            ..RaumToml::default()
        };
        let resolved = resolve_worktree_pattern(&config, &project, Some(&raum));
        assert_eq!(resolved.path_pattern, "project/{branch-slug}");
    }

    #[test]
    fn roundtrips_raum_toml_from_tempdir() {
        // Task 6.4: read a real .raum.toml from a tempdir and verify deserialization round-trip.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".raum.toml");
        let body = r#"
[worktree]
pathPattern = "custom/{branch-slug}"
branchPrefixMode = "username"

[hydration]
copy = [".env"]
symlink = ["node_modules"]
"#;
        std::fs::write(&path, body).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let parsed: RaumToml = toml::from_str(&text).unwrap();
        let worktree = parsed.worktree.as_ref().expect("worktree present");
        assert_eq!(worktree.path_pattern, "custom/{branch-slug}");
        assert_eq!(worktree.branch_prefix_mode, BranchPrefixMode::Username);
        let hy = parsed.hydration.as_ref().expect("hydration present");
        assert_eq!(hy.copy, vec![".env".to_string()]);
        assert_eq!(hy.symlink, vec!["node_modules".to_string()]);
    }
}
