//! Branch-prefix modes (§6.2).
//!
//! Resolves branch-prefix transformations (`none` / `username` / `custom`) idempotently —
//! applying twice is a no-op.

use raum_core::config::{BranchPrefixMode, WorktreeConfig};

#[derive(Debug, Clone)]
pub struct PrefixContext<'a> {
    pub username: &'a str,
}

#[must_use]
pub fn apply_branch_prefix(branch: &str, cfg: &WorktreeConfig, ctx: &PrefixContext) -> String {
    match cfg.branch_prefix_mode {
        BranchPrefixMode::None => branch.to_string(),
        BranchPrefixMode::Username => {
            if ctx.username.is_empty() || branch.starts_with(&format!("{}/", ctx.username)) {
                branch.to_string()
            } else {
                format!("{}/{}", ctx.username, branch)
            }
        }
        BranchPrefixMode::Custom => {
            let prefix = cfg
                .branch_prefix_custom
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("");
            if prefix.is_empty() || branch.starts_with(&format!("{prefix}/")) {
                branch.to_string()
            } else {
                format!("{prefix}/{branch}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use raum_core::config::WorktreeConfig;

    #[test]
    fn none_passes_through() {
        let cfg = WorktreeConfig::default();
        assert_eq!(
            apply_branch_prefix("foo", &cfg, &PrefixContext { username: "ada" }),
            "foo"
        );
    }

    #[test]
    fn username_prefixes_once() {
        let cfg = WorktreeConfig {
            branch_prefix_mode: BranchPrefixMode::Username,
            ..WorktreeConfig::default()
        };
        let ctx = PrefixContext { username: "ada" };
        assert_eq!(apply_branch_prefix("topic/x", &cfg, &ctx), "ada/topic/x");
        assert_eq!(
            apply_branch_prefix("ada/topic/x", &cfg, &ctx),
            "ada/topic/x"
        );
    }

    #[test]
    fn username_is_idempotent() {
        // Task 6.2: applying twice has no effect.
        let cfg = WorktreeConfig {
            branch_prefix_mode: BranchPrefixMode::Username,
            ..WorktreeConfig::default()
        };
        let ctx = PrefixContext { username: "ada" };
        let once = apply_branch_prefix("topic/x", &cfg, &ctx);
        let twice = apply_branch_prefix(&once, &cfg, &ctx);
        assert_eq!(once, twice);
        assert_eq!(once, "ada/topic/x");
    }

    #[test]
    fn custom_prefix_works() {
        let cfg = WorktreeConfig {
            branch_prefix_mode: BranchPrefixMode::Custom,
            branch_prefix_custom: Some("team-foo".into()),
            ..WorktreeConfig::default()
        };
        let ctx = PrefixContext { username: "ada" };
        assert_eq!(
            apply_branch_prefix("topic/x", &cfg, &ctx),
            "team-foo/topic/x"
        );
    }

    #[test]
    fn custom_prefix_is_idempotent() {
        // Task 6.2: applying twice has no effect.
        let cfg = WorktreeConfig {
            branch_prefix_mode: BranchPrefixMode::Custom,
            branch_prefix_custom: Some("team-foo".into()),
            ..WorktreeConfig::default()
        };
        let ctx = PrefixContext { username: "ada" };
        let once = apply_branch_prefix("topic/x", &cfg, &ctx);
        let twice = apply_branch_prefix(&once, &cfg, &ctx);
        assert_eq!(once, twice);
        assert_eq!(once, "team-foo/topic/x");
    }

    #[test]
    fn none_mode_is_idempotent() {
        let cfg = WorktreeConfig::default();
        let ctx = PrefixContext { username: "ada" };
        let once = apply_branch_prefix("topic/x", &cfg, &ctx);
        let twice = apply_branch_prefix(&once, &cfg, &ctx);
        assert_eq!(once, "topic/x");
        assert_eq!(once, twice);
    }

    #[test]
    fn custom_with_empty_string_is_treated_as_none() {
        // Task 6.2: Custom with empty branch_prefix_custom must behave like None.
        let cfg_empty = WorktreeConfig {
            branch_prefix_mode: BranchPrefixMode::Custom,
            branch_prefix_custom: Some(String::new()),
            ..WorktreeConfig::default()
        };
        let cfg_missing = WorktreeConfig {
            branch_prefix_mode: BranchPrefixMode::Custom,
            branch_prefix_custom: None,
            ..WorktreeConfig::default()
        };
        let ctx = PrefixContext { username: "ada" };
        assert_eq!(apply_branch_prefix("topic/x", &cfg_empty, &ctx), "topic/x");
        assert_eq!(
            apply_branch_prefix("topic/x", &cfg_missing, &ctx),
            "topic/x"
        );
    }

    #[test]
    fn prefix_modes_produce_expected_branch_names() {
        // Task 6.4: prefix modes produce expected branch names.
        let ctx = PrefixContext { username: "ada" };
        let none = WorktreeConfig::default();
        let username = WorktreeConfig {
            branch_prefix_mode: BranchPrefixMode::Username,
            ..WorktreeConfig::default()
        };
        let custom = WorktreeConfig {
            branch_prefix_mode: BranchPrefixMode::Custom,
            branch_prefix_custom: Some("team".into()),
            ..WorktreeConfig::default()
        };
        assert_eq!(apply_branch_prefix("feat/x", &none, &ctx), "feat/x");
        assert_eq!(apply_branch_prefix("feat/x", &username, &ctx), "ada/feat/x");
        assert_eq!(apply_branch_prefix("feat/x", &custom, &ctx), "team/feat/x");
    }
}
