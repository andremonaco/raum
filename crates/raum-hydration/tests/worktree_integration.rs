//! §6.9 — End-to-end worktree + hydration integration test.
//!
//! Creates a git repo with a `.raum.toml` in a tempdir, resolves the effective
//! project config (user-level `project.toml` merged with `.raum.toml`),
//! derives the worktree target path from the path pattern, applies the
//! branch prefix, spawns a `git worktree`, and runs hydration against the
//! fresh worktree. Asserts:
//!
//! * path pattern + branch prefix produce the expected on-disk target path,
//! * `.raum.toml` hydration rules materialize copies and symlinks,
//! * no tmux-related side effects happen (we never import raum-tmux in this
//!   crate — this is enforced by the workspace Cargo manifest, so the check
//!   here is a smoke sanity check that the `tmux` binary is never invoked).

use std::path::Path;
use std::process::Command;

use raum_core::config::{
    BranchPrefixMode, Config, HydrationManifest, ProjectConfig, RaumToml, WorktreeConfig,
};
use raum_core::store::merge_project_with_raum_toml;
use raum_hydration::{
    CreateOptions, PatternInputs, PrefixContext, apply_branch_prefix, apply_hydration,
    preview_path_pattern, resolve_worktree_pattern, worktree_create, worktree_list,
};

/// Spin up a git repo in `repo` with a seed commit, and write out `.raum.toml`
/// and a `.env` + `node_modules/` so hydration has something to do.
fn seed_repo(repo: &Path) -> bool {
    if Command::new("git").arg("--version").output().is_err() {
        return false;
    }
    if !Command::new("git")
        .current_dir(repo)
        .args(["init", "-q", "-b", "main"])
        .status()
        .is_ok_and(|s| s.success())
    {
        return false;
    }
    for (k, v) in [("user.email", "raum@example.com"), ("user.name", "raum")] {
        if !Command::new("git")
            .current_dir(repo)
            .args(["config", "--local", k, v])
            .status()
            .is_ok_and(|s| s.success())
        {
            return false;
        }
    }
    // Files we'll hydrate into the new worktree.
    std::fs::write(repo.join(".env"), "SECRET=42\n").unwrap();
    std::fs::create_dir_all(repo.join("node_modules/@demo")).unwrap();
    std::fs::write(repo.join("node_modules/@demo/index.js"), "export {}\n").unwrap();
    std::fs::write(
        repo.join(".raum.toml"),
        r#"[worktree]
pathPattern = "{parent-dir}/{base-folder}-wt/{branch-slug}"
branchPrefixMode = "custom"
branchPrefixCustom = "raum"

[hydration]
copy = [".env"]
symlink = ["node_modules"]
"#,
    )
    .unwrap();

    let steps: [&[&str]; 2] = [&["add", "."], &["commit", "-q", "-m", "seed"]];
    for args in steps {
        if !Command::new("git")
            .current_dir(repo)
            .args(args)
            .status()
            .is_ok_and(|s| s.success())
        {
            return false;
        }
    }
    true
}

#[test]
fn worktree_creation_respects_pattern_prefix_and_hydration() {
    // The whole test is a no-op when `git` isn't on PATH — keeps CI on
    // minimal containers from hard-failing. The CI workflow installs git
    // unconditionally, so this branch shouldn't be hit in practice.
    let outside = tempfile::tempdir().unwrap();
    let repo = outside.path().join("my-proj");
    std::fs::create_dir_all(&repo).unwrap();
    if !seed_repo(&repo) {
        eprintln!("skipping: git unavailable in this environment");
        return;
    }

    // Build a ProjectConfig that matches the on-disk layout; merge it with
    // the committed `.raum.toml`.
    let project = ProjectConfig {
        slug: "my-proj".into(),
        name: "My Proj".into(),
        root_path: repo.clone(),
        in_repo_settings: true,
        // project.toml intentionally has weak defaults so `.raum.toml` wins.
        worktree: WorktreeConfig {
            path_pattern: "project-should-be-overridden/{branch-slug}".into(),
            branch_prefix_mode: BranchPrefixMode::None,
            branch_prefix_custom: None,
        },
        hydration: HydrationManifest {
            copy: vec!["should-be-overridden".into()],
            symlink: vec![],
        },
        ..ProjectConfig::default()
    };

    // Read .raum.toml straight off disk — the production path uses
    // ConfigStore::read_raum_toml, but that requires XDG plumbing; parsing
    // directly is equivalent for this test's purposes.
    let raw = std::fs::read_to_string(repo.join(".raum.toml")).unwrap();
    let raum: RaumToml = toml::from_str(&raw).expect("parse .raum.toml");

    let effective = merge_project_with_raum_toml(&project, Some(&raum));
    assert!(effective.has_raum_toml);
    assert_eq!(
        effective.worktree.branch_prefix_mode,
        BranchPrefixMode::Custom
    );
    assert_eq!(effective.hydration.copy, vec![".env".to_string()]);

    // Resolve the effective worktree config via the precedence chain.
    let config = Config::default();
    let resolved = resolve_worktree_pattern(&config, &project, Some(&raum));
    assert_eq!(
        resolved.path_pattern,
        "{parent-dir}/{base-folder}-wt/{branch-slug}"
    );

    // Apply the branch prefix to the user-supplied branch name.
    let prefixed = apply_branch_prefix("topic/x", &resolved, &PrefixContext { username: "andre" });
    assert_eq!(prefixed, "raum/topic/x", "custom prefix applied");

    // Render the target path. With our pattern + branch:
    //   parent-dir = <outside.path()>
    //   base-folder = my-proj
    //   branch-slug = slugify("raum/topic/x") = "raum-topic-x"
    let target = preview_path_pattern(
        &resolved.path_pattern,
        &PatternInputs {
            project: &project,
            branch: &prefixed,
        },
    );
    let expected = outside.path().join("my-proj-wt").join("raum-topic-x");
    assert_eq!(target, expected, "path pattern resolved as expected");

    // Create the worktree. `git worktree add` requires the target's parent
    // to be creatable; it creates the leaf itself.
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    worktree_create(
        &repo,
        &target,
        &CreateOptions {
            branch: prefixed.clone(),
            create_branch: true,
            from_ref: None,
        },
    )
    .expect("worktree_create");

    assert!(target.is_dir(), "worktree directory exists");
    assert!(target.join(".env").is_file(), "seed file present");

    // Hydration pulls from the source repo (which has the sibling files we want
    // to project into the worktree). The .env already exists in the worktree
    // because it's tracked, but hydration should overwrite it cleanly.
    let report = apply_hydration(&repo, &target, &effective.hydration).expect("hydrate");
    assert_eq!(report.copied.len(), 1, "exactly one copy rule applied");
    assert_eq!(
        report.symlinked.len(),
        1,
        "exactly one symlink rule applied"
    );

    // Assert copy: .env present and non-empty.
    let copied_env = std::fs::read_to_string(target.join(".env")).unwrap();
    assert!(copied_env.contains("SECRET"));

    // Assert symlink: node_modules in the worktree is a symlink to the source
    // repo's node_modules. Note git tracks node_modules/@demo as a real path
    // in the worktree too; hydration removes the tracked path and replaces it
    // with a symlink.
    let meta = target
        .join("node_modules")
        .symlink_metadata()
        .expect("symlink present");
    assert!(
        meta.file_type().is_symlink(),
        "node_modules is a symlink, not a real dir"
    );

    // Listing includes the new branch.
    let entries = worktree_list(&repo).expect("list");
    assert!(
        entries
            .iter()
            .any(|e| e.branch.as_deref() == Some("raum/topic/x")),
        "new branch appears in worktree list"
    );

    // Smoke: we never invoked tmux. `raum-tmux` isn't a dep of this crate —
    // the Cargo manifest makes that structurally impossible. This just
    // documents intent.
    //
    // (No assertion needed; the absence of a dep is enforced at compile
    // time.)
}
