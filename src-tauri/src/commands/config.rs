//! Config + prereqs commands. Owned by Wave 1A (already implemented).
//!
//! Onboarding commands:
//!   * `config_mark_onboarded()` — flip `Config.onboarded` to `true` so the
//!     wizard never remounts on subsequent launches.
//!   * `harnesses_check()` — probe harness binaries for the wizard's step 3.
//!
//! Plus `os_info` so the wizard can pick the right install/upgrade commands
//! (Homebrew on macOS vs apt/dnf/pacman/zypper/apk on Linux).

use raum_core::config::{ActiveLayoutState, Config, NESTED_PATH_PATTERN};
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

#[tauri::command(async)]
pub fn config_get(state: tauri::State<'_, AppHandleState>) -> Result<Config, String> {
    // Recover a poisoned mutex instead of bubbling the lock error: a single
    // panic in any prior `config_store` user would otherwise permanently
    // brick `config_get`, and on boot a rejected `config_get` lets the
    // frontend's catch path clobber `active-layout.toml` with empty cells.
    // `read_config` itself already degrades a corrupt file to the default
    // (see `read_toml_or_default`'s quarantine), so the only remaining
    // failure modes are genuine IO errors, which we still surface.
    let store = state
        .config_store
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    store.read_config().map_err(|e| e.to_string())
}

/// §2.4 — startup prerequisite check. Always returns a report; UI renders the
/// blocking dependency modal when `report.all_ok()` is false.
#[tauri::command(async)]
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
#[tauri::command(async)]
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
/// Wire shape of [`active_layout_get`]. `#[serde(flatten)]` keeps the
/// `ActiveLayoutState` fields (`cells`, …) at the top level so the frontend's
/// existing `saved.cells` access is unchanged; `quarantined` is added
/// alongside so the UI can toast when a corrupt active-layout.toml was set
/// aside on this read (otherwise the graceful degrade-to-default is silent).
#[derive(serde::Serialize)]
pub struct ActiveLayoutGetResult {
    #[serde(flatten)]
    pub layout: ActiveLayoutState,
    pub quarantined: bool,
}

#[tauri::command(async)]
pub fn active_layout_get(
    state: tauri::State<'_, AppHandleState>,
) -> Result<ActiveLayoutGetResult, String> {
    // Same hardening as `config_get`: recover a poisoned lock so a corrupt
    // read can never reject. `read_active_layout_checked` quarantines a corrupt
    // file and returns the default plus a `quarantined` flag, so a parse error
    // no longer surfaces as `Err` (which the frontend `catch` would turn into a
    // layout clobber) — instead the frontend toasts on the success path.
    let store = state
        .config_store
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    store
        .read_active_layout_checked()
        .map(|(layout, quarantined)| ActiveLayoutGetResult {
            layout,
            quarantined,
        })
        .map_err(|e| e.to_string())
}

/// Persist the current runtime grid state (geometry + session IDs) to
/// `state/active-layout.toml`. Called by the frontend on a 500 ms debounce
/// after any mutation to `runtimeLayoutStore`.
#[tauri::command(async)]
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
#[tauri::command(async)]
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

/// Toggle Claude Code's fullscreen (alt-screen) rendering. When `enabled`
/// is `true` (default) raum injects `CLAUDE_CODE_NO_FLICKER=1` into newly
/// spawned panes so Claude paints the alt-screen and doesn't poison
/// scrollback with hard-wrapped Ink output on resize. Set `false` to opt
/// back into the legacy inline mode.
///
/// Existing panes continue running with whatever mode they were spawned
/// under — the env var is consumed at boot. The toggle takes effect for
/// the next pane spawn / replacement.
#[tauri::command(async)]
pub fn config_set_claude_fullscreen(
    state: tauri::State<'_, AppHandleState>,
    enabled: bool,
) -> Result<(), String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut cfg: Config = store.read_config().map_err(|e| e.to_string())?;
    if cfg.harnesses.claude_code.fullscreen == enabled {
        return Ok(());
    }
    cfg.harnesses.claude_code.fullscreen = enabled;
    store.write_config(&cfg).map_err(|e| e.to_string())
}

/// Persist the appearance theme. Pass `theme_id` to switch to a curated
/// catalog entry (clears any custom path) or `custom_theme_path` to point at
/// a user-supplied VSCode theme JSON on disk (sets `theme_id` back to the
/// default so the picker shows the BYO entry instead of stale curated
/// selection). Both being null clears any theme override and falls back to
/// the default at next boot.
#[tauri::command(async)]
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

/// Persist the per-pane prompt-overlay toggle. The overlay fades the
/// first and last user prompt over each agent pane as a glanceable
/// banner; some users find it noisy and want it off.
#[tauri::command(async)]
pub fn config_set_appearance_show_prompt_overlay(
    state: tauri::State<'_, AppHandleState>,
    enabled: bool,
) -> Result<(), String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut cfg: Config = store.read_config().map_err(|e| e.to_string())?;
    if cfg.appearance.show_prompt_overlay == enabled {
        return Ok(());
    }
    cfg.appearance.show_prompt_overlay = enabled;
    store.write_config(&cfg).map_err(|e| e.to_string())
}

/// Persist the top-bar "auto-hide inactive projects" toggle + day threshold.
/// A project whose harnesses haven't been prompted within `days` collapses into
/// the "Other projects" list. The staleness check itself is derived in the
/// frontend (it has the per-session prompt timestamps); this only stores the
/// preference. `days` is clamped to a minimum of 1.
#[tauri::command(async)]
pub fn config_set_projects_auto_hide(
    state: tauri::State<'_, AppHandleState>,
    enabled: bool,
    days: u32,
) -> Result<(), String> {
    let days = days.max(1);
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut cfg: Config = store.read_config().map_err(|e| e.to_string())?;
    if cfg.projects.auto_hide_inactive == enabled && cfg.projects.auto_hide_inactive_days == days {
        return Ok(());
    }
    cfg.projects.auto_hide_inactive = enabled;
    cfg.projects.auto_hide_inactive_days = days;
    store.write_config(&cfg).map_err(|e| e.to_string())
}

/// Persist the "auto-dock inactive terminals" toggle + day threshold. A
/// terminal/harness with no activity (a prompt sent, the pane focused, or just
/// created) within `days` is moved into the dock — per individual tab. The
/// staleness check itself is derived in the frontend (it holds the per-session
/// activity timestamps); this only stores the preference. `days` is clamped to a
/// minimum of 1.
#[tauri::command(async)]
pub fn config_set_terminals_auto_dock(
    state: tauri::State<'_, AppHandleState>,
    enabled: bool,
    days: u32,
) -> Result<(), String> {
    let days = days.max(1);
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut cfg: Config = store.read_config().map_err(|e| e.to_string())?;
    if cfg.terminals.auto_dock_inactive == enabled && cfg.terminals.auto_dock_inactive_days == days
    {
        return Ok(());
    }
    cfg.terminals.auto_dock_inactive = enabled;
    cfg.terminals.auto_dock_inactive_days = days;
    store.write_config(&cfg).map_err(|e| e.to_string())
}

/// Persist the global worktree `path_pattern`. Called by the Worktrees settings
/// section when the user picks a preset or edits a custom pattern.
///
/// An empty/whitespace-only pattern is treated as "reset to default" and stores
/// the built-in `NESTED_PATH_PATTERN` (raum's default strategy). Validation uses
/// the same rules as `worktree_preview_path` so an invalid pattern here surfaces
/// the same error the user would see at worktree-create time.
#[tauri::command(async)]
pub fn config_set_worktree_path_pattern(
    state: tauri::State<'_, AppHandleState>,
    pattern: String,
) -> Result<String, String> {
    let trimmed = pattern.trim();
    let effective = if trimmed.is_empty() {
        NESTED_PATH_PATTERN.to_string()
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
