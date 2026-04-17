//! TOML-backed config types. Filled out by §2.1; consumed everywhere.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use toml::Value;

use crate::agent::AgentKind;

pub const DEFAULT_PATH_PATTERN: &str = "{parent-dir}/{base-folder}-worktrees/{branch-slug}";
pub const DEFAULT_MULTIPLEXER: &str = "tmux";
pub const DEFAULT_COALESCE_INTERVAL_MS: u64 = 12;
pub const DEFAULT_COALESCE_BYTES: usize = 16 * 1024;
pub const DEFAULT_SILENCE_THRESHOLD_MS: u64 = 500;
pub const DEFAULT_DEBOUNCE_MS: u64 = 500;
pub const XTERM_SCROLLBACK_LINES: u32 = 10_000;
pub const QUICKFIRE_HISTORY_LIMIT: usize = 100;

/// User-global `config.toml`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    // Primitives first — TOML requires all leaf values at a given depth to be
    // emitted before any nested tables.
    pub onboarded: bool,
    pub multiplexer: String,
    // Nested tables follow.
    #[serde(rename = "worktreeConfig")]
    pub worktree_config: WorktreeConfig,
    pub rendering: RenderingConfig,
    pub notifications: NotificationsConfig,
    pub sidebar: SidebarConfig,
    pub keybindings: Keybindings,
    pub harnesses: HarnessesConfig,
    pub updater: UpdaterConfig,
    /// Catch-all for forward-compatible keys so unknown user-added settings
    /// survive a round-trip. Logged at INFO by the store when populated.
    #[serde(flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub unknown: BTreeMap<String, Value>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            onboarded: false,
            multiplexer: DEFAULT_MULTIPLEXER.to_string(),
            worktree_config: WorktreeConfig::default(),
            rendering: RenderingConfig::default(),
            notifications: NotificationsConfig::default(),
            sidebar: SidebarConfig::default(),
            keybindings: Keybindings::default(),
            harnesses: HarnessesConfig::default(),
            updater: UpdaterConfig::default(),
            unknown: BTreeMap::new(),
        }
    }
}

/// Per-harness launch configuration (extra CLI flags appended at spawn time).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct HarnessesConfig {
    #[serde(skip_serializing_if = "HarnessConfig::is_default")]
    pub shell: HarnessConfig,
    #[serde(
        rename = "claude-code",
        skip_serializing_if = "HarnessConfig::is_default"
    )]
    pub claude_code: HarnessConfig,
    #[serde(skip_serializing_if = "HarnessConfig::is_default")]
    pub codex: HarnessConfig,
    #[serde(skip_serializing_if = "HarnessConfig::is_default")]
    pub opencode: HarnessConfig,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct HarnessConfig {
    /// Extra CLI flags appended verbatim to the harness binary command.
    /// Example: `--verbose --model claude-opus-4-5`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_flags: Option<String>,
}

impl HarnessConfig {
    pub fn is_default(&self) -> bool {
        self.extra_flags.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct WorktreeConfig {
    #[serde(rename = "pathPattern")]
    pub path_pattern: String,
    #[serde(rename = "branchPrefixMode")]
    pub branch_prefix_mode: BranchPrefixMode,
    #[serde(rename = "branchPrefixCustom", skip_serializing_if = "Option::is_none")]
    pub branch_prefix_custom: Option<String>,
    /// Optional executable scripts that run before / after worktree creation.
    /// Defaults omit the entire table from serialized TOML.
    #[serde(default, skip_serializing_if = "WorktreeHooks::is_default")]
    pub hooks: WorktreeHooks,
}

impl Default for WorktreeConfig {
    fn default() -> Self {
        Self {
            path_pattern: DEFAULT_PATH_PATTERN.to_string(),
            branch_prefix_mode: BranchPrefixMode::None,
            branch_prefix_custom: None,
            hooks: WorktreeHooks::default(),
        }
    }
}

/// User-defined executable scripts run around worktree creation.
///
/// * `pre_create` runs before `git worktree add` (cwd = project root); failure aborts creation.
/// * `post_create` runs after hydration completes (cwd = new worktree); failure leaves the
///   worktree in place so the user can inspect partial state.
///
/// Hook paths may be absolute or relative; relative paths resolve against the project root.
/// Scripts receive context via env vars: `RAUM_PHASE`, `RAUM_PROJECT_SLUG`, `RAUM_PROJECT_ROOT`,
/// `RAUM_WORKTREE_PATH`, `RAUM_BRANCH`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct WorktreeHooks {
    #[serde(rename = "preCreate", skip_serializing_if = "Option::is_none")]
    pub pre_create: Option<String>,
    #[serde(rename = "postCreate", skip_serializing_if = "Option::is_none")]
    pub post_create: Option<String>,
    /// Per-hook timeout in seconds. `0` disables the timeout.
    #[serde(rename = "timeoutSecs", default = "default_hook_timeout_secs")]
    pub timeout_secs: u32,
}

pub const DEFAULT_HOOK_TIMEOUT_SECS: u32 = 300;

fn default_hook_timeout_secs() -> u32 {
    DEFAULT_HOOK_TIMEOUT_SECS
}

impl Default for WorktreeHooks {
    fn default() -> Self {
        Self {
            pre_create: None,
            post_create: None,
            timeout_secs: DEFAULT_HOOK_TIMEOUT_SECS,
        }
    }
}

impl WorktreeHooks {
    #[must_use]
    pub fn is_default(&self) -> bool {
        self.pre_create.is_none()
            && self.post_create.is_none()
            && self.timeout_secs == DEFAULT_HOOK_TIMEOUT_SECS
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BranchPrefixMode {
    #[default]
    None,
    Username,
    Custom,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RenderingConfig {
    pub webgl_on_linux: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct NotificationsConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sound: Option<String>,
    /// §11.4 — set to `true` after the one-time "notifications denied" hint
    /// banner has been shown. Prevents the in-app banner from reappearing on
    /// every launch when the user has declined OS notification permission.
    #[serde(default)]
    pub notifications_hint_shown: bool,
    /// §11 — fire an OS notification when an agent transitions to `waiting`
    /// (needs user input). Defaults to `true`.
    #[serde(default = "default_true")]
    pub notify_on_waiting: bool,
    /// §11 — fire an OS notification when an agent transitions to `completed`
    /// or `errored` (agent is done). Defaults to `true`.
    #[serde(default = "default_true")]
    pub notify_on_done: bool,
}

fn default_true() -> bool {
    true
}

impl Default for NotificationsConfig {
    fn default() -> Self {
        Self {
            sound: None,
            notifications_hint_shown: false,
            notify_on_waiting: true,
            notify_on_done: true,
        }
    }
}

/// Auto-updater preferences. The signing key + endpoint live in
/// `tauri.conf.json`; this struct only captures per-user toggles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct UpdaterConfig {
    /// Run a background `check()` a few seconds after launch and surface a
    /// non-blocking toast if a newer release is available. On by default;
    /// the frontend still skips the check in dev builds.
    #[serde(default = "default_true")]
    pub check_on_launch: bool,
}

impl Default for UpdaterConfig {
    fn default() -> Self {
        Self {
            check_on_launch: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SidebarConfig {
    pub width_px: u32,
    pub collapsed: bool,
}

impl Default for SidebarConfig {
    fn default() -> Self {
        Self {
            width_px: 280,
            collapsed: false,
        }
    }
}

/// User `keybindings.toml` — action-name → accelerator string overrides.
/// Invalid / unknown accelerators are tolerated at load time; they are logged
/// and dropped when the keymap is assembled (§12.2 / §12.5).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Keybindings {
    pub overrides: BTreeMap<String, String>,
}

/// Per-project `project.toml`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProjectConfig {
    // Primitives first for TOML ordering.
    pub slug: String,
    pub name: String,
    pub root_path: PathBuf,
    pub color: String,
    /// Optional override for the project's sigil glyph. When `None`, the UI
    /// derives one from `slug` via `crate::sigil::derive_sigil`. Persisted to
    /// `project.toml` only when the user explicitly picks a value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sigil: Option<String>,
    /// Whether hydration/worktree edits should be written to `.raum.toml`
    /// (when a committed one is present) instead of this file.
    pub in_repo_settings: bool,
    // Nested tables follow.
    pub hydration: HydrationManifest,
    pub worktree: WorktreeConfig,
    pub agent_defaults: AgentDefaults,
    #[serde(flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub unknown: BTreeMap<String, Value>,
}

impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            slug: String::new(),
            name: String::new(),
            root_path: PathBuf::new(),
            color: "#7dd3fc".into(),
            sigil: None,
            in_repo_settings: false,
            hydration: HydrationManifest::default(),
            worktree: WorktreeConfig::default(),
            agent_defaults: AgentDefaults::default(),
            unknown: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct HydrationManifest {
    pub copy: Vec<String>,
    pub symlink: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentDefaults {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<AgentKind>,
    /// Per-harness silence-heuristic threshold overrides (milliseconds).
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub silence_threshold_ms: BTreeMap<String, u64>,
}

/// `.raum.toml` schema — repo-level overrides for hydration + worktree + agent_defaults.
/// Unknown top-level keys are tolerated and surfaced via `unknown` so the loader
/// can log them at INFO (§2.6).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RaumToml {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hydration: Option<HydrationManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_defaults: Option<AgentDefaults>,
    #[serde(flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub unknown: BTreeMap<String, Value>,
}

/// Merged result of `ProjectConfig` + optional `.raum.toml`.
/// Consumers call `ConfigStore::effective_project` (§2.6) to build this.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EffectiveProjectConfig {
    pub slug: String,
    pub name: String,
    pub root_path: PathBuf,
    pub color: String,
    /// Resolved sigil — always concrete (derived from slug when no explicit
    /// override is set on the project).
    pub sigil: String,
    pub hydration: HydrationManifest,
    pub worktree: WorktreeConfig,
    pub agent_defaults: AgentDefaults,
    pub in_repo_settings: bool,
    /// True if this came from a merge with a committed `.raum.toml`.
    pub has_raum_toml: bool,
}

/// `state/sessions.toml` — transient cross-project session index.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionState {
    #[serde(rename = "session", default)]
    pub sessions: Vec<TrackedSession>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrackedSession {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    pub kind: AgentKind,
    pub created_at_unix_ms: u64,
}

/// `state/quickfire-history.toml` — bounded ring of recent quick-fire commands.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct QuickfireHistory {
    pub entries: Vec<String>,
}

/// `state/active-layout.toml` — snapshot of the runtime grid including live
/// session bindings. Written on every debounced change by the frontend; read
/// at startup to rehydrate the grid without user action.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ActiveLayoutState {
    /// Unix seconds when this snapshot was last written.
    pub saved_at: u64,
    /// Project / worktree context at the time of save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    #[serde(rename = "cell", default)]
    pub cells: Vec<ActiveLayoutCell>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveLayoutCell {
    pub id: String,
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub kind: AgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub active_tab_id: String,
    #[serde(rename = "tab", default)]
    pub tabs: Vec<ActiveLayoutTab>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveLayoutTab {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// User-chosen display label shown in the pane's tab strip. When unset,
    /// the UI falls back to the harness icon + state indicator only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl QuickfireHistory {
    /// Push a new entry to the front, dedupe, and truncate to `QUICKFIRE_HISTORY_LIMIT`.
    pub fn push(&mut self, command: String) {
        if command.trim().is_empty() {
            return;
        }
        self.entries.retain(|e| e != &command);
        self.entries.insert(0, command);
        if self.entries.len() > QUICKFIRE_HISTORY_LIMIT {
            self.entries.truncate(QUICKFIRE_HISTORY_LIMIT);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip<T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug>(value: T) {
        let raw = toml::to_string_pretty(&value).expect("serialize");
        let back: T = toml::from_str(&raw).expect("deserialize");
        assert_eq!(value, back, "round-trip mismatch. raw was:\n{raw}");
    }

    #[test]
    fn config_roundtrip_defaults() {
        roundtrip(Config::default());
    }

    #[test]
    fn config_roundtrip_custom() {
        let mut overrides = BTreeMap::new();
        overrides.insert("global-search".into(), "CmdOrCtrl+Shift+F".into());
        let cfg = Config {
            onboarded: true,
            notifications: NotificationsConfig {
                sound: Some("glass".into()),
                notifications_hint_shown: true,
                notify_on_waiting: true,
                notify_on_done: false,
            },
            keybindings: Keybindings { overrides },
            sidebar: SidebarConfig {
                width_px: 320,
                collapsed: false,
            },
            worktree_config: WorktreeConfig {
                path_pattern: DEFAULT_PATH_PATTERN.into(),
                branch_prefix_mode: BranchPrefixMode::Custom,
                branch_prefix_custom: Some("feature/".into()),
                ..WorktreeConfig::default()
            },
            ..Config::default()
        };
        roundtrip(cfg);
    }

    #[test]
    fn project_config_roundtrip() {
        let mut silence_threshold_ms = BTreeMap::new();
        silence_threshold_ms.insert("codex".into(), 1500u64);
        let p = ProjectConfig {
            slug: "acme".into(),
            name: "Acme".into(),
            root_path: PathBuf::from("/tmp/acme"),
            hydration: HydrationManifest {
                copy: vec![".env".into()],
                symlink: vec!["node_modules".into()],
            },
            agent_defaults: AgentDefaults {
                default: Some(AgentKind::Codex),
                silence_threshold_ms,
            },
            ..ProjectConfig::default()
        };
        roundtrip(p);
    }

    #[test]
    fn raum_toml_roundtrip_partial() {
        let rt = RaumToml {
            hydration: Some(HydrationManifest {
                copy: vec![".env".into()],
                symlink: vec!["node_modules".into()],
            }),
            worktree: Some(WorktreeConfig {
                path_pattern: "{parent-dir}/wt/{branch-slug}".into(),
                branch_prefix_mode: BranchPrefixMode::Username,
                branch_prefix_custom: None,
                ..WorktreeConfig::default()
            }),
            agent_defaults: None,
            unknown: BTreeMap::new(),
        };
        roundtrip(rt);
    }

    #[test]
    fn raum_toml_unknown_keys_survive() {
        let raw = r#"
            [hydration]
            copy = [".env"]
            symlink = []

            [unknown_future_key]
            foo = "bar"
        "#;
        let parsed: RaumToml = toml::from_str(raw).expect("parse");
        assert!(parsed.unknown.contains_key("unknown_future_key"));
    }

    #[test]
    fn active_layout_state_roundtrip() {
        let state = ActiveLayoutState {
            saved_at: 1_714_000_001,
            project_slug: Some("acme".into()),
            worktree_id: Some("/path/to/wt".into()),
            cells: vec![ActiveLayoutCell {
                id: "cell-1".into(),
                x: 0,
                y: 0,
                w: 6,
                h: 10,
                kind: AgentKind::ClaudeCode,
                title: Some("Main".into()),
                active_tab_id: "tab-1".into(),
                tabs: vec![
                    ActiveLayoutTab {
                        id: "tab-1".into(),
                        session_id: Some("raum-claude-123".into()),
                        label: Some("Main agent".into()),
                    },
                    ActiveLayoutTab {
                        id: "tab-2".into(),
                        session_id: None,
                        label: None,
                    },
                ],
            }],
        };
        roundtrip(state);
    }

    #[test]
    fn active_layout_state_default_roundtrip() {
        roundtrip(ActiveLayoutState::default());
    }

    #[test]
    fn session_state_roundtrip() {
        let st = SessionState {
            sessions: vec![TrackedSession {
                session_id: "raum-abc".into(),
                project_slug: Some("acme".into()),
                worktree_id: Some("acme/main".into()),
                kind: AgentKind::Shell,
                created_at_unix_ms: 1_714_000_000_000,
            }],
        };
        roundtrip(st);
    }

    #[test]
    fn quickfire_history_push_dedupes_and_bounds() {
        let mut h = QuickfireHistory::default();
        h.push("ls -la".into());
        h.push("git status".into());
        h.push("ls -la".into()); // dedupe to front
        assert_eq!(h.entries, vec!["ls -la".to_string(), "git status".into()]);

        for i in 0..(QUICKFIRE_HISTORY_LIMIT + 10) {
            h.push(format!("cmd {i}"));
        }
        assert_eq!(h.entries.len(), QUICKFIRE_HISTORY_LIMIT);
    }

    #[test]
    fn quickfire_history_ignores_empty() {
        let mut h = QuickfireHistory::default();
        h.push("   ".into());
        assert!(h.entries.is_empty());
    }
}
