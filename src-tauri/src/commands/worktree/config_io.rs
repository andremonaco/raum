//! Effective-config loading, TOML write-through, and small environment
//! helpers shared across the rest of the worktree submodules.

use std::path::{Path, PathBuf};

use raum_core::config::WorktreeConfig;

use crate::state::AppHandleState;

/// Run a closure on the blocking pool, mapping a `JoinError` into a `String`
/// so call sites can `?`-propagate cleanly.
pub(super) async fn blocking<T, F>(label: &str, f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("{label} join: {e}"))
}

/// Apply a per-call strategy override onto a `WorktreeConfig`.
///
/// * `Custom` requires a non-empty pattern override; if the override is
///   missing we leave the existing pattern in place and only flip the
///   strategy field.
/// * Non-`Custom` presets snap `path_pattern` to the matching constant.
/// * `None` strategy = no change.
pub(super) fn apply_strategy_override(
    cfg: &mut WorktreeConfig,
    strategy: Option<raum_core::config::PathStrategy>,
    pattern_override: Option<&str>,
) {
    let Some(strategy) = strategy else { return };
    cfg.path_strategy = strategy;
    if let Some(preset) = strategy.preset_pattern() {
        cfg.path_pattern = preset.to_string();
    } else if let Some(p) = pattern_override.filter(|p| !p.is_empty()) {
        cfg.path_pattern = p.to_string();
    }
}

pub(super) fn load_effective(
    state: &tauri::State<'_, AppHandleState>,
    project_slug: &str,
) -> Result<raum_core::config::EffectiveProjectConfig, String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut eff = store
        .effective_project(project_slug)
        .map_err(|e| format!("effective_project: {e}"))?
        .ok_or_else(|| format!("project not found: {project_slug}"))?;
    // The worktree path is a single global setting (Settings → Worktrees) that
    // applies to every project — overlay it onto the effective config so the
    // preview/create paths always honor the global default. Branch-prefix and
    // hooks stay per-project.
    let config = store
        .read_config()
        .map_err(|e| format!("read_config: {e}"))?;
    eff.worktree.apply_global_path(&config.worktree_config);
    Ok(eff)
}

pub(super) fn os_username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default()
}

/// Re-sync the slug's `GitHeadWatcher` against the current on-disk layout.
/// A no-op when no watcher is registered (e.g. bootstrap failed).
pub(super) fn rescan_git_watcher(
    state: &tauri::State<'_, AppHandleState>,
    slug: &str,
    root: &Path,
) {
    if let Ok(mut watchers) = state.git_watchers.lock() {
        if let Some(w) = watchers.get_mut(slug) {
            w.rescan(root);
        }
    }
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
