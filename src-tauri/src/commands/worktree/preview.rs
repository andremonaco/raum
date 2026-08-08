//! Preview + list commands. Pure read-only — used by the create-worktree
//! modal and the sidebar to render path/manifest/list information without
//! mutating disk.

use std::collections::HashMap;
use std::path::Path;

use raum_core::config::PathStrategy;
use raum_hydration::{
    PatternInputs, PrefixContext, apply_branch_prefix, preview_path_pattern,
    worktree_list as git_worktree_list,
};

use raum_hydration::orchestrate::raum_base_branch_map;

use super::branches::upstream_branch_map;
use super::config_io::{apply_strategy_override, blocking, load_effective, os_username};
use super::types::{WorktreeListItem, WorktreeManifestPreview, WorktreePathPreview};
use crate::state::AppHandleState;

/// Three git subprocesses total, regardless of worktree count: the list, one
/// batched upstream lookup, one batched base-branch lookup. Resolving those two
/// per entry cost `3N + 1` forks, and at boot the sidebar prewarm pays it for
/// every worktree of every project.
pub(super) fn list_worktree_items_for_root(
    root_path: &Path,
) -> Result<Vec<WorktreeListItem>, String> {
    let entries = git_worktree_list(root_path).map_err(|e| format!("list: {e}"))?;
    let root = root_path.to_string_lossy().into_owned();
    let upstreams = upstream_branch_map(&root);
    let bases = raum_base_branch_map(&root);
    Ok(entries
        .into_iter()
        .map(|e| {
            let path_str = e.path.to_string_lossy().into_owned();
            let upstream = e
                .branch
                .as_deref()
                .and_then(|branch| upstreams.get(branch).cloned());
            let base_branch = e
                .branch
                .as_deref()
                .and_then(|branch| bases.get(branch).cloned());
            WorktreeListItem {
                branch: e.branch,
                path: path_str,
                head: e.head,
                locked: e.locked,
                detached: e.detached,
                upstream,
                base_branch,
            }
        })
        .collect())
}

#[tauri::command(async)]
pub fn worktree_preview_path(
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
    branch: String,
    path_strategy: Option<PathStrategy>,
    path_pattern_override: Option<String>,
) -> Result<WorktreePathPreview, String> {
    let mut effective = load_effective(&state, &project_slug)?;
    apply_strategy_override(
        &mut effective.worktree,
        path_strategy,
        path_pattern_override.as_deref(),
    );
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
        path_strategy: effective.worktree.path_strategy,
    })
}

#[tauri::command(async)]
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

/// Three git subprocesses, so the walk goes to the blocking pool — running it
/// inline would stall the UI for the length of the process spawns.
#[tauri::command]
pub async fn worktree_list(
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
) -> Result<Vec<WorktreeListItem>, String> {
    let effective = load_effective(&state, &project_slug)?;
    let root_path = effective.root_path;
    blocking("worktree_list", move || {
        list_worktree_items_for_root(&root_path)
    })
    .await?
}

#[tauri::command]
pub async fn worktree_list_all(
    state: tauri::State<'_, AppHandleState>,
) -> Result<HashMap<String, Vec<WorktreeListItem>>, String> {
    let projects = {
        let store = state
            .config_store
            .lock()
            .map_err(|e| format!("config_store lock: {e}"))?;
        let slugs = store
            .list_project_slugs()
            .map_err(|e| format!("list_project_slugs: {e}"))?;
        let mut projects = Vec::with_capacity(slugs.len());
        for slug in slugs {
            match store.effective_project(&slug) {
                Ok(Some(mut effective)) => {
                    effective.worktree.normalize();
                    projects.push(effective);
                }
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!(slug = %slug, error = %e, "worktree_list_all: skipping malformed project");
                }
            }
        }
        projects
    };

    // Git subprocesses — never on the main thread, and one blocking task per
    // project so N repos cost one repo's latency instead of N.
    let mut tasks = tokio::task::JoinSet::new();
    for project in projects {
        tasks.spawn_blocking(move || {
            let items = list_worktree_items_for_root(&project.root_path).unwrap_or_else(|e| {
                tracing::warn!(slug = %project.slug, error = %e, "worktree_list_all: list failed");
                Vec::new()
            });
            (project.slug, items)
        });
    }
    let mut out = HashMap::new();
    while let Some(res) = tasks.join_next().await {
        let (slug, items) = res.map_err(|e| format!("worktree_list_all join: {e}"))?;
        out.insert(slug, items);
    }
    Ok(out)
}
