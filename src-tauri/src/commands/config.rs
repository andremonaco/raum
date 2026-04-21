//! Config + prereqs commands. Owned by Wave 1A (already implemented).
//!
//! Onboarding commands:
//!   * `config_mark_onboarded()` — flip `Config.onboarded` to `true` so the
//!     wizard never remounts on subsequent launches.
//!   * `harnesses_check()` — probe harness binaries for the wizard's step 3.
//!
//! Plus `os_info` so the wizard can pick the right install/upgrade commands
//! (Homebrew on macOS vs apt/dnf/pacman/zypper/apk on Linux).

use raum_core::config::{ActiveLayoutState, Config, DEFAULT_PATH_PATTERN};
use raum_core::prereqs::{self, HarnessReport, PrereqReport};
use raum_hydration::validate_path_pattern;
use serde::Serialize;

use crate::state::AppHandleState;

/// Coarse-grained OS info for the onboarding wizard. `family` is always
/// populated from `cfg!`; `linux_id` is parsed from `/etc/os-release` and
/// matches the values upstream produces (`ubuntu`, `debian`, `fedora`,
/// `arch`, `opensuse-tumbleweed`, …). Treat unknown ids as "other Linux".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsInfo {
    pub family: &'static str,
    pub linux_id: Option<String>,
    pub linux_id_like: Vec<String>,
}

#[tauri::command]
pub fn os_info() -> OsInfo {
    let family = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    };
    let (linux_id, linux_id_like) = if family == "linux" {
        parse_os_release()
    } else {
        (None, Vec::new())
    };
    OsInfo {
        family,
        linux_id,
        linux_id_like,
    }
}

fn parse_os_release() -> (Option<String>, Vec<String>) {
    let raw = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
    let mut id = None;
    let mut id_like = Vec::new();
    for line in raw.lines() {
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let v = v.trim().trim_matches('"').to_string();
        match k.trim() {
            "ID" => id = Some(v),
            "ID_LIKE" => id_like = v.split_whitespace().map(str::to_string).collect(),
            _ => {}
        }
    }
    (id, id_like)
}

#[tauri::command]
pub fn config_get(state: tauri::State<'_, AppHandleState>) -> Result<Config, String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    store.read_config().map_err(|e| e.to_string())
}

/// §2.4 — startup prerequisite check. Always returns a report; UI renders the
/// blocking dependency modal when `report.all_ok()` is false.
#[tauri::command]
pub fn prereqs_check() -> PrereqReport {
    prereqs::check_prereqs()
}

/// Onboarding wizard step 3 — probe each user-facing harness binary and
/// report whether it's installed (plus its version). Purely informational;
/// nothing is persisted.
#[tauri::command]
pub async fn harnesses_check() -> HarnessReport {
    prereqs::check_harnesses_async().await
}

/// §13.2 — mark onboarding complete. Called on wizard finish *or* skip-from-any-step.
#[tauri::command]
pub fn config_mark_onboarded(state: tauri::State<'_, AppHandleState>) -> Result<Config, String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut cfg = store.read_config().map_err(|e| e.to_string())?;
    cfg.onboarded = true;
    store.write_config(&cfg).map_err(|e| e.to_string())?;
    Ok(cfg)
}

/// Read the last-saved active layout snapshot from `state/active-layout.toml`.
/// Returns an empty `ActiveLayoutState` (with `cells: []`) when no snapshot
/// exists yet (first launch or user cleared the grid and the file is absent).
#[tauri::command]
pub fn active_layout_get(
    state: tauri::State<'_, AppHandleState>,
) -> Result<ActiveLayoutState, String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    store.read_active_layout().map_err(|e| e.to_string())
}

/// Persist the current runtime grid state (geometry + session IDs) to
/// `state/active-layout.toml`. Called by the frontend on a 500 ms debounce
/// after any mutation to `runtimeLayoutStore`.
#[tauri::command]
pub fn active_layout_save(
    state: tauri::State<'_, AppHandleState>,
    layout: ActiveLayoutState,
) -> Result<(), String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    store
        .write_active_layout(&layout)
        .map_err(|e| e.to_string())
}

/// Persist extra CLI flags for a single harness. Called from the Harnesses
/// settings section when the user edits the flags input.
///
/// `harness` must be one of: `"shell"`, `"claude-code"`, `"codex"`, `"opencode"`.
/// Pass `flags = None` (or an empty string) to clear the flags for that harness.
#[tauri::command]
pub fn config_set_harness_flags(
    state: tauri::State<'_, AppHandleState>,
    harness: String,
    flags: Option<String>,
) -> Result<(), String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut cfg: Config = store.read_config().map_err(|e| e.to_string())?;
    let flags = flags.filter(|s| !s.trim().is_empty());
    match harness.as_str() {
        "shell" => cfg.harnesses.shell.extra_flags = flags,
        "claude-code" => cfg.harnesses.claude_code.extra_flags = flags,
        "codex" => cfg.harnesses.codex.extra_flags = flags,
        "opencode" => cfg.harnesses.opencode.extra_flags = flags,
        _ => return Err(format!("unknown harness: {harness}")),
    }
    store.write_config(&cfg).map_err(|e| e.to_string())
}

/// Persist the appearance theme. Pass `theme_id` to switch to a curated
/// catalog entry (clears any custom path) or `custom_theme_path` to point at
/// a user-supplied VSCode theme JSON on disk (sets `theme_id` back to the
/// default so the picker shows the BYO entry instead of stale curated
/// selection). Both being null clears any theme override and falls back to
/// the default at next boot.
#[tauri::command]
pub fn config_set_appearance_theme(
    state: tauri::State<'_, AppHandleState>,
    theme_id: Option<String>,
    custom_theme_path: Option<std::path::PathBuf>,
) -> Result<(), String> {
    use raum_core::config::DEFAULT_THEME_ID;
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut cfg: Config = store.read_config().map_err(|e| e.to_string())?;
    let next_theme = theme_id.unwrap_or_else(|| DEFAULT_THEME_ID.to_string());
    let next_custom = custom_theme_path;
    if cfg.appearance.theme_id == next_theme && cfg.appearance.custom_theme_path == next_custom {
        return Ok(());
    }
    cfg.appearance.theme_id = next_theme;
    cfg.appearance.custom_theme_path = next_custom;
    store.write_config(&cfg).map_err(|e| e.to_string())
}

/// Persist the global worktree `path_pattern`. Called by the Worktrees settings
/// section when the user picks a preset or edits a custom pattern.
///
/// An empty/whitespace-only pattern is treated as "reset to default" and stores
/// the built-in `DEFAULT_PATH_PATTERN`. Validation uses the same rules as
/// `worktree_preview_path` so an invalid pattern here surfaces the same error
/// the user would see at worktree-create time.
#[tauri::command]
pub fn config_set_worktree_path_pattern(
    state: tauri::State<'_, AppHandleState>,
    pattern: String,
) -> Result<String, String> {
    let trimmed = pattern.trim();
    let effective = if trimmed.is_empty() {
        DEFAULT_PATH_PATTERN.to_string()
    } else {
        validate_path_pattern(trimmed).map_err(|e| e.to_string())?;
        trimmed.to_string()
    };
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut cfg: Config = store.read_config().map_err(|e| e.to_string())?;
    cfg.worktree_config.path_pattern.clone_from(&effective);
    store.write_config(&cfg).map_err(|e| e.to_string())?;
    Ok(effective)
}
