//! TOML-backed config types. Filled out by §2.1; consumed everywhere.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use toml::Value;

use crate::agent::{AgentKind, AgentState};

pub const DEFAULT_PATH_PATTERN: &str = "{parent-dir}/{base-folder}-worktrees/{branch-slug}";
/// Pattern for the `Nested` strategy — worktrees live inside the project at
/// `<root>/.raum/<branch>`. The backend auto-`.gitignore`s `.raum/` when this
/// shape is detected (see `target_is_inside_raum_dir`).
pub const NESTED_PATH_PATTERN: &str = "{repo-root}/.raum/{branch-slug}";
/// Pattern for the `SiblingGroup` strategy — alias of `DEFAULT_PATH_PATTERN`,
/// kept as a separate name so call sites that mean "the sibling preset"
/// don't read as "whatever the default happens to be".
pub const SIBLING_GROUP_PATH_PATTERN: &str = DEFAULT_PATH_PATTERN;
pub const DEFAULT_MULTIPLEXER: &str = "tmux";
pub const DEFAULT_COALESCE_INTERVAL_MS: u64 = 12;
pub const DEFAULT_COALESCE_BYTES: usize = 16 * 1024;
/// Silence fallback threshold. Applied to every live session as the
/// backstop for `Working -> Idle` when a deterministic turn-end signal
/// is missed. The value is deliberately generous so a silent think
/// doesn't get flipped to Idle too early.
pub const DEFAULT_SILENCE_THRESHOLD_MS: u64 = 10_000;
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
    pub appearance: AppearanceConfig,
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
            appearance: AppearanceConfig::default(),
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
    /// High-level path preset. `Custom` means `path_pattern` is the source of
    /// truth; `SiblingGroup`/`Nested` map to fixed pattern constants and the
    /// pattern is normalized server-side on write.
    #[serde(rename = "pathStrategy", default = "PathStrategy::default_for_serde")]
    pub path_strategy: PathStrategy,
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
            path_strategy: PathStrategy::default(),
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

/// Worktree path preset. `Custom` keeps `path_pattern` as the source of truth.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PathStrategy {
    /// Group all worktrees in a sibling folder next to the project root.
    #[default]
    SiblingGroup,
    /// Nest worktrees inside the project at `<root>/.raum/<branch>`.
    Nested,
    /// Freeform — `path_pattern` controls the layout.
    Custom,
}

impl PathStrategy {
    /// Pattern constant for non-custom presets. `None` for `Custom`.
    #[must_use]
    pub fn preset_pattern(self) -> Option<&'static str> {
        match self {
            Self::SiblingGroup => Some(SIBLING_GROUP_PATH_PATTERN),
            Self::Nested => Some(NESTED_PATH_PATTERN),
            Self::Custom => None,
        }
    }

    /// Reverse map: classify a pattern string back into its preset, or
    /// `Custom` when it doesn't match a known one. Used to derive the
    /// strategy for legacy configs that predate the field.
    #[must_use]
    pub fn infer_from_pattern(pattern: &str) -> Self {
        match pattern {
            SIBLING_GROUP_PATH_PATTERN => Self::SiblingGroup,
            NESTED_PATH_PATTERN => Self::Nested,
            _ => Self::Custom,
        }
    }

    /// Serde default: when the field is absent in legacy TOML the inference
    /// happens in `WorktreeConfig` after deserialization (see
    /// `WorktreeConfig::normalize`). At serde-default time we don't yet have
    /// the pattern in scope, so fall back to the type default.
    fn default_for_serde() -> Self {
        Self::default()
    }
}

impl WorktreeConfig {
    /// Reconcile `path_strategy` and `path_pattern`:
    ///
    /// * Non-`Custom` strategy → force `path_pattern` to the preset constant
    ///   so the two never drift out of sync after a write.
    /// * Legacy configs (where `path_strategy` defaulted to `SiblingGroup`
    ///   but the pattern is something else) → flip strategy to whatever the
    ///   pattern infers to. This keeps the UI honest for users who never
    ///   touched the new field.
    pub fn normalize(&mut self) {
        match self.path_strategy {
            PathStrategy::Custom => { /* freeform — leave pattern as-is. */ }
            preset => {
                let expected = preset.preset_pattern().expect("non-custom has pattern");
                if self.path_pattern != expected {
                    // If the user-typed pattern doesn't match the chosen
                    // preset, the pattern wins and we re-classify.
                    let inferred = PathStrategy::infer_from_pattern(&self.path_pattern);
                    if inferred == preset {
                        // Strategy is consistent; just snap pattern to the
                        // canonical constant (no-op for already-equal).
                        self.path_pattern = expected.to_string();
                    } else {
                        self.path_strategy = inferred;
                    }
                }
            }
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RenderingConfig {
    pub webgl_on_linux: bool,
}

/// Cosmetic / chrome-only preferences. Kept separate from `RenderingConfig`
/// (which gates GPU paths) because these knobs are purely visual and don't
/// affect terminal rendering correctness.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppearanceConfig {
    /// Curated VSCode theme id (e.g. "dracula", "tokyo-night"). The runtime
    /// catalog lives in `frontend/src/themes/catalog/`. Defaults to
    /// `raum-default-dark` so a fresh install matches today's look.
    #[serde(default = "default_theme_id")]
    pub theme_id: String,
    /// Path to a user-supplied VSCode theme JSON. When `Some`, takes
    /// precedence over `theme_id` so a BYO theme survives across launches
    /// without hijacking the curated picker selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_theme_path: Option<PathBuf>,
}
pub const DEFAULT_THEME_ID: &str = "raum-default-dark";

fn default_theme_id() -> String {
    DEFAULT_THEME_ID.to_string()
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            theme_id: DEFAULT_THEME_ID.to_string(),
            custom_theme_path: None,
        }
    }
}

/// Dock / taskbar badge verbosity. Independent of the OS-notification
/// toggles — a user can silence notifications but still want the glance
/// value of a badge, or vice versa.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BadgeMode {
    /// Never set a badge count. The app clears the badge on every update.
    Off,
    /// Count only open permission requests (the subset of `waiting` that
    /// blocks on user approval).
    Critical,
    /// Count every agent currently in `waiting`, `completed`, or `errored`.
    /// Default — strict superset of the pre-verbosity behavior.
    #[default]
    AllUnread,
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
    /// §11 — master switch for OS notification banners. When `false`, the
    /// frontend skips `sendNotification` (and the toast fallback) for every
    /// event regardless of `notify_on_waiting` / `notify_on_done`. The dock
    /// badge keeps updating because `badge_mode` is an independent channel.
    /// Defaults to `true`.
    #[serde(default = "default_true")]
    pub notify_banner_enabled: bool,
    /// §11.3 — dock/taskbar badge verbosity. Defaults to [`BadgeMode::AllUnread`].
    #[serde(default)]
    pub badge_mode: BadgeMode,
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
            notify_banner_enabled: true,
            badge_mode: BadgeMode::default(),
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_port: Option<u16>,
    pub kind: AgentKind,
    pub created_at_unix_ms: u64,
    /// Last harness state observed for this session. Written by the agent
    /// event bridge on every transition; read on reattach to seed the fresh
    /// `AgentStateMachine` so reloaded panes retain their waiting/working
    /// indicators instead of resetting to `Idle`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_state: Option<AgentState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_state_at_unix_ms: Option<u64>,
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
    #[serde(default, alias = "cell")]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    pub active_tab_id: String,
    #[serde(default, alias = "tab")]
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
    /// Per-tab project binding, captured at tab-spawn time. Lets a tab stay
    /// pointed at the worktree it was created under even if the pane's
    /// pane-level `project_slug` later moves or the sidebar scope changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
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
                notify_banner_enabled: false,
                badge_mode: BadgeMode::Critical,
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
    fn notifications_badge_mode_default_is_all_unread() {
        let cfg = NotificationsConfig::default();
        assert_eq!(cfg.badge_mode, BadgeMode::AllUnread);
    }

    #[test]
    fn notifications_badge_mode_serializes_snake_case() {
        let cfg = NotificationsConfig {
            badge_mode: BadgeMode::AllUnread,
            ..NotificationsConfig::default()
        };
        let raw = toml::to_string(&cfg).expect("serialize");
        assert!(
            raw.contains("badge_mode = \"all_unread\""),
            "expected snake_case badge_mode, got:\n{raw}"
        );
    }

    #[test]
    fn notifications_missing_badge_mode_defaults() {
        let raw = r"
            notify_on_waiting = true
            notify_on_done = true
        ";
        let cfg: NotificationsConfig = toml::from_str(raw).expect("deserialize");
        assert_eq!(cfg.badge_mode, BadgeMode::AllUnread);
    }

    #[test]
    fn notifications_notify_banner_enabled_defaults_true() {
        // Both a blank TOML block and a pre-banner-field config (missing
        // `notify_banner_enabled`) should deserialize to the on-by-default
        // banner state so existing user configs keep receiving banners
        // after upgrade.
        let cfg = NotificationsConfig::default();
        assert!(cfg.notify_banner_enabled);

        let raw = r"
            notify_on_waiting = true
            notify_on_done = true
        ";
        let cfg: NotificationsConfig = toml::from_str(raw).expect("deserialize");
        assert!(cfg.notify_banner_enabled);
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
    fn appearance_config_roundtrip_default() {
        // Default → TOML → struct should preserve theme_id and leave
        // custom_theme_path as None (skip_serializing_if guarantees the
        // field doesn't even appear in the serialized form).
        let cfg = AppearanceConfig::default();
        let raw = toml::to_string_pretty(&cfg).expect("serialize");
        assert!(
            raw.contains(DEFAULT_THEME_ID),
            "raw missing default theme_id: {raw}"
        );
        assert!(
            !raw.contains("custom_theme_path"),
            "default should omit custom_theme_path: {raw}"
        );
        let back: AppearanceConfig = toml::from_str(&raw).expect("deserialize");
        assert_eq!(cfg, back);
    }

    #[test]
    fn appearance_config_roundtrip_custom() {
        let cfg = AppearanceConfig {
            theme_id: "dracula".into(),
            custom_theme_path: Some(PathBuf::from("/tmp/custom-theme.json")),
        };
        roundtrip(cfg);
    }

    #[test]
    fn appearance_config_back_compat_missing_fields() {
        // Older configs may still carry removed appearance keys. Make sure
        // deserialization ignores them cleanly and keeps the current defaults.
        let raw = "glass_intensity = 50";
        let parsed: AppearanceConfig = toml::from_str(raw).expect("parse");
        assert_eq!(parsed.theme_id, DEFAULT_THEME_ID);
        assert!(parsed.custom_theme_path.is_none());
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
                project_slug: Some("acme".into()),
                worktree_id: Some("/path/to/wt".into()),
                active_tab_id: "tab-1".into(),
                tabs: vec![
                    ActiveLayoutTab {
                        id: "tab-1".into(),
                        session_id: Some("raum-claude-123".into()),
                        label: Some("Main agent".into()),
                        project_slug: Some("acme".into()),
                        worktree_id: Some("/path/to/wt".into()),
                    },
                    ActiveLayoutTab {
                        id: "tab-2".into(),
                        session_id: None,
                        label: None,
                        project_slug: None,
                        worktree_id: None,
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
                opencode_port: None,
                kind: AgentKind::Shell,
                created_at_unix_ms: 1_714_000_000_000,
                last_state: None,
                last_state_at_unix_ms: None,
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
    fn path_strategy_default_is_sibling_group() {
        assert_eq!(PathStrategy::default(), PathStrategy::SiblingGroup);
    }

    #[test]
    fn path_strategy_serializes_kebab_case() {
        // Wire-format check: multi-word variant uses kebab-case.
        assert_eq!(
            serde_json::to_string(&PathStrategy::SiblingGroup).expect("ser"),
            "\"sibling-group\""
        );
        assert_eq!(
            serde_json::to_string(&PathStrategy::Nested).expect("ser"),
            "\"nested\""
        );
        assert_eq!(
            serde_json::to_string(&PathStrategy::Custom).expect("ser"),
            "\"custom\""
        );
    }

    #[test]
    fn path_strategy_infers_from_pattern() {
        assert_eq!(
            PathStrategy::infer_from_pattern(SIBLING_GROUP_PATH_PATTERN),
            PathStrategy::SiblingGroup
        );
        assert_eq!(
            PathStrategy::infer_from_pattern(NESTED_PATH_PATTERN),
            PathStrategy::Nested
        );
        assert_eq!(
            PathStrategy::infer_from_pattern("anything-else/{branch-slug}"),
            PathStrategy::Custom
        );
    }

    #[test]
    fn worktree_normalize_snaps_pattern_to_preset() {
        // Strategy=Nested but pattern wandered → snap pattern back to canonical.
        let mut wc = WorktreeConfig {
            path_strategy: PathStrategy::Nested,
            path_pattern: "stale/{branch-slug}".into(),
            ..WorktreeConfig::default()
        };
        wc.normalize();
        assert_eq!(wc.path_strategy, PathStrategy::Custom);
        // (We deliberately demote to Custom rather than overwriting a hand-typed pattern.)
        assert_eq!(wc.path_pattern, "stale/{branch-slug}");

        // Already-canonical pair is a no-op.
        let mut wc2 = WorktreeConfig {
            path_strategy: PathStrategy::Nested,
            path_pattern: NESTED_PATH_PATTERN.into(),
            ..WorktreeConfig::default()
        };
        wc2.normalize();
        assert_eq!(wc2.path_strategy, PathStrategy::Nested);
        assert_eq!(wc2.path_pattern, NESTED_PATH_PATTERN);

        // Custom strategy never touches the pattern.
        let mut wc3 = WorktreeConfig {
            path_strategy: PathStrategy::Custom,
            path_pattern: "freeform/{branch-slug}".into(),
            ..WorktreeConfig::default()
        };
        wc3.normalize();
        assert_eq!(wc3.path_strategy, PathStrategy::Custom);
        assert_eq!(wc3.path_pattern, "freeform/{branch-slug}");
    }

    #[test]
    fn worktree_config_legacy_toml_omits_path_strategy() {
        // Older configs predate the field; serde default + normalize should
        // recover a sensible strategy from the pattern alone.
        let raw = format!(
            r#"pathPattern = "{NESTED_PATH_PATTERN}"
branchPrefixMode = "none"
"#
        );
        let mut cfg: WorktreeConfig = toml::from_str(&raw).expect("deserialize");
        // Field absent → falls back to type default (SiblingGroup) until normalize.
        assert_eq!(cfg.path_strategy, PathStrategy::SiblingGroup);
        cfg.normalize();
        // The pattern matches the Nested constant, so normalize re-classifies.
        assert_eq!(cfg.path_strategy, PathStrategy::Nested);
    }

    #[test]
    fn quickfire_history_ignores_empty() {
        let mut h = QuickfireHistory::default();
        h.push("   ".into());
        assert!(h.entries.is_empty());
    }
}
