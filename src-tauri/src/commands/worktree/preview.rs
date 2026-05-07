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

use super::branches::fetch_upstream_branch;
use super::config_io::{apply_strategy_override, load_effective, os_username};
use super::create::get_raum_base_branch;
use super::types::{WorktreeListItem, WorktreeManifestPreview, WorktreePathPreview};
use crate::state::AppHandleState;

pub(super) fn list_worktree_items_for_root(
    root_path: &Path,
) -> Result<Vec<WorktreeListItem>, String> {
    let entries = git_worktree_list(root_path).map_err(|e| format!("list: {e}"))?;
    let root = root_path.to_string_lossy().into_owned();
    Ok(entries
        .into_iter()
        .map(|e| {
            let path_str = e.path.to_string_lossy().into_owned();
            let upstream = e
                .branch
                .as_deref()
                .and_then(|branch| fetch_upstream_branch(&path_str, branch));
            let base_branch = e
                .branch
                .as_deref()
                .and_then(|branch| get_raum_base_branch(&root, branch));
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

#[tauri::command]
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

#[tauri::command]
pub fn worktree_list(
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
) -> Result<Vec<WorktreeListItem>, String> {
    let effective = load_effective(&state, &project_slug)?;
    list_worktree_items_for_root(&effective.root_path)
}

#[tauri::command]
pub fn worktree_list_all(
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

    let mut out = HashMap::with_capacity(projects.len());
    for project in projects {
        let slug = project.slug;
        let root_path = project.root_path;
        match list_worktree_items_for_root(&root_path) {
            Ok(items) => {
                out.insert(slug, items);
            }
            Err(e) => {
                tracing::warn!(slug = %slug, error = %e, "worktree_list_all: list failed");
                out.insert(slug, Vec::new());
            }
        }
    }
    Ok(out)
}
