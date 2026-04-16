//! Project commands (§5). Owned by Wave 3B.
//!
//! Exposes the Tauri surface the Solid UI calls:
//!
//! * `project_register(root_path, name)` — register a new project under
//!   `~/.config/raum/projects/<slug>/project.toml` with defaults from
//!   `raum_core::project::project_with_defaults` (pseudo-random palette
//!   color, built-in path pattern, branch prefix mode `none`). Detects a
//!   `.raum.toml` at `root_path` and sets `in_repo_settings` accordingly.
//! * `project_list()` — enumerate registered projects (reads every
//!   `projects/<slug>/project.toml`).
//! * `project_update(project)` — overwrite the user-level `project.toml`
//!   (e.g. color-picker edits). Never touches `.raum.toml`.
//! * `project_remove(slug)` — delete the user-level project directory. The
//!   caller is responsible for killing tagged tmux sessions via
//!   `terminal_kill`. Never modifies `.raum.toml` or `root_path`.
//! * `project_config_effective(slug)` — return the merged
//!   `project.toml` + `.raum.toml` view via
//!   `raum_core::store::merge_project_with_raum_toml`.
//! * `project_list_gitignored(slug)` — walk `root_path` and return a tree
//!   of files/directories that are covered by `.gitignore` rules, so the UI
//!   can offer a copy/symlink picker for worktree hydration.

use std::path::PathBuf;

use raum_core::config::{
    AgentDefaults, BranchPrefixMode, EffectiveProjectConfig, HydrationManifest, ProjectConfig,
    WorktreeConfig,
};
use raum_core::project::project_with_defaults;
use raum_core::sigil::{is_valid_sigil, resolve_sigil};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

use crate::state::AppHandleState;

/// UI-facing projection of a `ProjectConfig`. Mirrors the canonical fields the
/// top row + sidebar need without leaking the full TOML type surface.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListItem {
    pub slug: String,
    pub name: String,
    pub color: String,
    /// Resolved project sigil (always a concrete glyph — derived from `slug`
    /// when the underlying `ProjectConfig.sigil` is `None`).
    pub sigil: String,
    pub root_path: String,
    pub in_repo_settings: bool,
    pub has_raum_toml: bool,
}

impl ProjectListItem {
    fn from_project(project: &ProjectConfig, has_raum_toml: bool) -> Self {
        Self {
            slug: project.slug.clone(),
            name: project.name.clone(),
            color: project.color.clone(),
            sigil: resolve_sigil(&project.slug, project.sigil.as_deref()),
            root_path: project.root_path.to_string_lossy().into_owned(),
            in_repo_settings: project.in_repo_settings,
            has_raum_toml,
        }
    }
}

/// Payload for `project_update`. Optional fields so the UI can push only the
/// edits it cares about (e.g. just `color` from the color picker).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUpdate {
    pub slug: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    /// Sigil override. `None` = no change. `Some("")` = clear back to
    /// derived. `Some(glyph)` must be a member of `SIGIL_PALETTE`.
    #[serde(default)]
    pub sigil: Option<String>,
    #[serde(default)]
    pub in_repo_settings: Option<bool>,
    #[serde(default)]
    pub hydration: Option<HydrationManifest>,
    #[serde(default)]
    pub worktree: Option<WorktreeConfig>,
    #[serde(default)]
    pub agent_defaults: Option<AgentDefaults>,
}

/// §5.4 — mirrored `EffectiveProjectConfig` for the webview. Serializes with
/// camelCase so it's ergonomic for Solid consumers.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveProjectDto {
    pub slug: String,
    pub name: String,
    pub color: String,
    pub sigil: String,
    pub root_path: String,
    pub in_repo_settings: bool,
    pub has_raum_toml: bool,
    pub hydration: HydrationManifest,
    pub worktree: WorktreeConfigDto,
    pub agent_defaults: AgentDefaults,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeConfigDto {
    pub path_pattern: String,
    pub branch_prefix_mode: BranchPrefixMode,
    pub branch_prefix_custom: Option<String>,
}

impl From<EffectiveProjectConfig> for EffectiveProjectDto {
    fn from(eff: EffectiveProjectConfig) -> Self {
        Self {
            slug: eff.slug,
            name: eff.name,
            color: eff.color,
            sigil: eff.sigil,
            root_path: eff.root_path.to_string_lossy().into_owned(),
            in_repo_settings: eff.in_repo_settings,
            has_raum_toml: eff.has_raum_toml,
            hydration: eff.hydration,
            worktree: WorktreeConfigDto {
                path_pattern: eff.worktree.path_pattern,
                branch_prefix_mode: eff.worktree.branch_prefix_mode,
                branch_prefix_custom: eff.worktree.branch_prefix_custom,
            },
            agent_defaults: eff.agent_defaults,
        }
    }
}

// ---- commands --------------------------------------------------------------

/// §5.1 — register a new project. Writes
/// `projects/<slug>/project.toml` with defaults from
/// `project_with_defaults` and flips `in_repo_settings` on when the project
/// root already carries a `.raum.toml`.
#[tauri::command]
pub fn project_register(
    state: tauri::State<'_, AppHandleState>,
    root_path: String,
    name: String,
) -> Result<ProjectListItem, String> {
    let root = PathBuf::from(&root_path);
    if !root.exists() {
        return Err(format!("root_path does not exist: {root_path}"));
    }
    let store = state
        .config_store
        .lock()
        .map_err(|e| format!("config_store lock: {e}"))?;

    let display_name = if name.trim().is_empty() {
        root.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("project")
            .to_string()
    } else {
        name
    };

    let mut project = project_with_defaults(&display_name, root.clone());
    // §5.1 — detect committed `.raum.toml` and default the toggle accordingly.
    let has_raum_toml = store
        .read_raum_toml(&root)
        .map_err(|e| format!("read_raum_toml: {e}"))?
        .is_some();
    project.in_repo_settings = has_raum_toml;

    store
        .write_project(&project)
        .map_err(|e| format!("write_project: {e}"))?;

    Ok(ProjectListItem::from_project(&project, has_raum_toml))
}

/// §5.4 — list every registered project.
#[tauri::command]
pub fn project_list(
    state: tauri::State<'_, AppHandleState>,
) -> Result<Vec<ProjectListItem>, String> {
    let store = state
        .config_store
        .lock()
        .map_err(|e| format!("config_store lock: {e}"))?;
    let slugs = store
        .list_project_slugs()
        .map_err(|e| format!("list_project_slugs: {e}"))?;
    let mut out = Vec::with_capacity(slugs.len());
    for slug in slugs {
        match store.read_project(&slug) {
            Ok(Some(project)) => {
                let has_raum_toml = store
                    .read_raum_toml(&project.root_path)
                    .map(|o| o.is_some())
                    .unwrap_or(false);
                out.push(ProjectListItem::from_project(&project, has_raum_toml));
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(slug = %slug, error = %e, "project_list: skipping malformed project");
            }
        }
    }
    Ok(out)
}

/// §5.4 / §5.2 — partial update of the user-level `project.toml`. Only the
/// fields the UI supplies are overwritten. `.raum.toml` is never touched here.
///
/// When the color changes, a `project-color-changed` event is emitted on the
/// Tauri event bus so terminal panes can re-render their borders without
/// re-reading the full project list (§5.2).
#[tauri::command]
pub fn project_update<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    update: ProjectUpdate,
) -> Result<ProjectListItem, String> {
    let store = state
        .config_store
        .lock()
        .map_err(|e| format!("config_store lock: {e}"))?;
    let mut project = store
        .read_project(&update.slug)
        .map_err(|e| format!("read_project: {e}"))?
        .ok_or_else(|| format!("project not found: {}", update.slug))?;

    let previous_color = project.color.clone();
    let previous_sigil = resolve_sigil(&project.slug, project.sigil.as_deref());
    if let Some(name) = update.name {
        project.name = name;
    }
    if let Some(color) = update.color {
        project.color = color;
    }
    if let Some(raw) = update.sigil {
        // Empty string clears back to the derived value.
        if raw.is_empty() {
            project.sigil = None;
        } else if is_valid_sigil(&raw) {
            project.sigil = Some(raw);
        } else {
            return Err(format!("invalid sigil: {raw}"));
        }
    }
    if let Some(flag) = update.in_repo_settings {
        project.in_repo_settings = flag;
    }
    if let Some(hydration) = update.hydration {
        project.hydration = hydration;
    }
    if let Some(worktree) = update.worktree {
        project.worktree = worktree;
    }
    if let Some(agent_defaults) = update.agent_defaults {
        project.agent_defaults = agent_defaults;
    }

    store
        .write_project(&project)
        .map_err(|e| format!("write_project: {e}"))?;

    if project.color != previous_color {
        if let Err(e) = app.emit(
            "project-color-changed",
            serde_json::json!({
                "slug": project.slug,
                "color": project.color,
            }),
        ) {
            tracing::warn!(slug = %project.slug, error = %e, "project-color-changed emit failed");
        }
    }

    let new_sigil = resolve_sigil(&project.slug, project.sigil.as_deref());
    if new_sigil != previous_sigil {
        if let Err(e) = app.emit(
            "project-sigil-changed",
            serde_json::json!({
                "slug": project.slug,
                "sigil": new_sigil,
            }),
        ) {
            tracing::warn!(slug = %project.slug, error = %e, "project-sigil-changed emit failed");
        }
    }

    let has_raum_toml = store
        .read_raum_toml(&project.root_path)
        .is_ok_and(|o| o.is_some());
    Ok(ProjectListItem::from_project(&project, has_raum_toml))
}

/// §5.3 / §5.4 — remove a project. Deletes `projects/<slug>/` only; the caller
/// is responsible for killing tagged tmux sessions (the Solid UI walks
/// `terminal_list()` and issues `terminal_kill` for each matching session).
#[tauri::command]
pub fn project_remove(state: tauri::State<'_, AppHandleState>, slug: String) -> Result<(), String> {
    let store = state
        .config_store
        .lock()
        .map_err(|e| format!("config_store lock: {e}"))?;
    store
        .delete_project(&slug)
        .map_err(|e| format!("delete_project: {e}"))
}

/// §5.4 — merged `project.toml` + `.raum.toml` view.
#[tauri::command]
pub fn project_config_effective(
    state: tauri::State<'_, AppHandleState>,
    slug: String,
) -> Result<Option<EffectiveProjectDto>, String> {
    let store = state
        .config_store
        .lock()
        .map_err(|e| format!("config_store lock: {e}"))?;
    let maybe = store
        .effective_project(&slug)
        .map_err(|e| format!("effective_project: {e}"))?;
    Ok(maybe.map(EffectiveProjectDto::from))
}

// ---- gitignore tree ---------------------------------------------------------

/// One node in the gitignored-file tree returned to the hydration picker UI.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitignoreNode {
    pub name: String,
    /// Project-root-relative path, always forward-slashed.
    pub path: String,
    pub is_dir: bool,
    /// Non-empty only for non-ignored directories that contain ignored
    /// descendants. Gitignored directories are leaf nodes — the whole subtree
    /// is treated as one hydration unit.
    pub children: Vec<GitignoreNode>,
}

/// OS-generated metadata files that clutter the tree and are never useful for
/// worktree hydration. Checked against the final path component only.
fn is_noise_filename(name: &str) -> bool {
    matches!(
        name,
        ".DS_Store"
            | "Thumbs.db"
            | "ehthumbs.db"
            | "Desktop.ini"
            | ".localized"
            | ".Spotlight-V100"
            | ".Trashes"
            | ".fseventsd"
            | ".AppleDouble"
            | ".TemporaryItems"
    ) || name.starts_with("._")
}

/// Insert a node at the correct position in the tree, creating intermediate
/// directory nodes as needed. `raw` is the full forward-slashed path; `is_dir`
/// refers to the leaf.
fn insert_node(
    children: &mut Vec<GitignoreNode>,
    components: &[&str],
    is_dir: bool,
    full_path: &str,
) {
    if components.is_empty() {
        return;
    }
    if components.len() == 1 {
        children.push(GitignoreNode {
            name: components[0].to_string(),
            path: full_path.to_string(),
            is_dir,
            children: vec![],
        });
        return;
    }
    // Intermediate directory — find or create it.
    let dir_name = components[0];
    let slash = full_path.find('/').unwrap_or(full_path.len());
    let dir_path = &full_path[..slash];
    let rest_path = &full_path[slash.saturating_add(1)..];

    if let Some(node) = children.iter_mut().find(|n| n.name == dir_name) {
        insert_node(&mut node.children, &components[1..], is_dir, rest_path);
    } else {
        let mut new_dir = GitignoreNode {
            name: dir_name.to_string(),
            path: dir_path.to_string(),
            is_dir: true,
            children: vec![],
        };
        insert_node(&mut new_dir.children, &components[1..], is_dir, rest_path);
        children.push(new_dir);
    }
}

/// Sort nodes in-place: directories first, then alphabetical within each group.
fn sort_nodes_recursive(nodes: &mut [GitignoreNode]) {
    nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    for node in nodes.iter_mut() {
        sort_nodes_recursive(&mut node.children);
    }
}

/// Build a `GitignoreNode` tree from the flat, forward-slashed paths returned
/// by `git ls-files --others --ignored --exclude-standard --directory`.
///
/// Lines ending in `/` are gitignored directories (leaf nodes). Other lines
/// are individual gitignored files which may sit inside non-ignored
/// subdirectories (git shows their full relative path in that case).
fn build_tree_from_git_lines(lines: impl Iterator<Item = String>) -> Vec<GitignoreNode> {
    let mut roots: Vec<GitignoreNode> = Vec::new();

    for raw in lines {
        let raw = raw.trim().to_string();
        if raw.is_empty() {
            continue;
        }

        let is_dir = raw.ends_with('/');
        let path = raw.trim_end_matches('/').to_string();

        // Filter OS noise by checking every component.
        if path.split('/').any(is_noise_filename) {
            continue;
        }

        let components: Vec<&str> = path.split('/').collect();
        insert_node(&mut roots, &components, is_dir, &path);
    }

    sort_nodes_recursive(&mut roots);
    roots
}

/// Walk a project's root directory and return a tree of files/directories
/// that are covered by `.gitignore` rules. Uses `git ls-files` so the result
/// matches git's own resolution (global gitignore, `.git/info/exclude`, nested
/// `.gitignore` files). Used by the hydration picker.
#[tauri::command]
pub fn project_list_gitignored(
    state: tauri::State<'_, AppHandleState>,
    slug: String,
) -> Result<Vec<GitignoreNode>, String> {
    let store = state
        .config_store
        .lock()
        .map_err(|e| format!("config_store lock: {e}"))?;
    let project = store
        .read_project(&slug)
        .map_err(|e| format!("read_project: {e}"))?
        .ok_or_else(|| format!("project not found: {slug}"))?;

    let root = project.root_path;
    if !root.is_dir() {
        return Err(format!(
            "project root is not a directory: {}",
            root.display()
        ));
    }

    // `--directory` collapses entirely-ignored subtrees (e.g. `node_modules/`)
    // into a single entry so we never enumerate thousands of files inside them.
    let output = std::process::Command::new("git")
        .args([
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "--no-empty-directory",
        ])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("git ls-files: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git ls-files failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let nodes = build_tree_from_git_lines(stdout.lines().map(|l| l.to_string()));
    Ok(nodes)
}

/// List the immediate children of a directory inside a project root. Used by
/// the hydration file-tree to lazily expand gitignored directories without
/// pre-loading their entire (potentially huge) subtree.
///
/// Returns `GitignoreNode` entries with empty `children` — further expansion
/// triggers another call. OS noise files are filtered.
#[tauri::command]
pub fn project_list_dir(
    state: tauri::State<'_, AppHandleState>,
    slug: String,
    rel_path: String,
) -> Result<Vec<GitignoreNode>, String> {
    let store = state
        .config_store
        .lock()
        .map_err(|e| format!("config_store lock: {e}"))?;
    let project = store
        .read_project(&slug)
        .map_err(|e| format!("read_project: {e}"))?
        .ok_or_else(|| format!("project not found: {slug}"))?;

    let root = project.root_path;

    // Prevent path traversal: join then verify the result is still inside root.
    let target = root.join(&rel_path);
    if !target.starts_with(&root) {
        return Err(format!("path escapes project root: {rel_path}"));
    }
    if !target.is_dir() {
        return Ok(vec![]);
    }

    let mut nodes: Vec<GitignoreNode> = std::fs::read_dir(&target)
        .map_err(|e| format!("read_dir: {e}"))?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_noise_filename(&name) {
                return None;
            }
            let is_dir = entry.path().is_dir();
            // Build a forward-slashed relative path from the project root.
            let rel = format!("{}/{}", rel_path.trim_end_matches('/'), name);
            Some(GitignoreNode {
                name,
                path: rel,
                is_dir,
                children: vec![],
            })
        })
        .collect();

    // Directories first, then files; both groups alphabetical.
    nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(nodes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use raum_core::store::ConfigStore;
    use tempfile::tempdir;

    fn build_store(root: &std::path::Path) -> ConfigStore {
        let store = ConfigStore::new(root);
        store.ensure_layout().unwrap();
        store
    }

    #[test]
    fn project_list_item_from_project_reflects_flag() {
        let dir = tempdir().unwrap();
        let mut project = project_with_defaults("Acme", dir.path().to_path_buf());
        project.in_repo_settings = true;
        let item = ProjectListItem::from_project(&project, true);
        assert_eq!(item.name, "Acme");
        assert!(item.in_repo_settings);
        assert!(item.has_raum_toml);
    }

    #[test]
    fn project_register_persists_defaults() {
        // Exercise the store plumbing directly (Tauri command bodies require a
        // live `AppHandle`, so we mirror the logic instead).
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let store = build_store(&dir.path().join("cfg"));

        let mut project = project_with_defaults("Acme", repo.clone());
        assert!(store.read_raum_toml(&repo).unwrap().is_none());
        project.in_repo_settings = false;

        store.write_project(&project).unwrap();
        let back = store.read_project(&project.slug).unwrap().unwrap();
        assert_eq!(back.name, "Acme");
        assert!(back.color.starts_with('#'));
        assert_eq!(back.root_path, repo);
    }

    #[test]
    fn register_flips_in_repo_when_raum_toml_present() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(
            repo.join(".raum.toml"),
            "[hydration]\ncopy = [\".env\"]\nsymlink = []\n",
        )
        .unwrap();
        let store = build_store(&dir.path().join("cfg"));

        let mut project = project_with_defaults("Acme", repo.clone());
        let has = store.read_raum_toml(&repo).unwrap().is_some();
        project.in_repo_settings = has;

        assert!(project.in_repo_settings);
        store.write_project(&project).unwrap();
        let back = store.read_project(&project.slug).unwrap().unwrap();
        assert!(back.in_repo_settings);
    }

    #[test]
    fn remove_deletes_project_dir() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let store = build_store(&dir.path().join("cfg"));

        let project = project_with_defaults("Acme", repo);
        store.write_project(&project).unwrap();
        assert!(store.read_project(&project.slug).unwrap().is_some());

        store.delete_project(&project.slug).unwrap();
        assert!(store.read_project(&project.slug).unwrap().is_none());
    }

    #[test]
    fn partial_update_only_touches_supplied_fields() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let store = build_store(&dir.path().join("cfg"));

        let project = project_with_defaults("Acme", repo);
        store.write_project(&project).unwrap();

        // Mimic `project_update` with only `color` set.
        let mut reloaded = store.read_project(&project.slug).unwrap().unwrap();
        reloaded.color = "#ff00ff".to_string();
        store.write_project(&reloaded).unwrap();

        let back = store.read_project(&project.slug).unwrap().unwrap();
        assert_eq!(back.color, "#ff00ff");
        assert_eq!(back.name, project.name);
    }
}
