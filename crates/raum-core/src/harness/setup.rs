//! Transactional setup plan + executor (Phase 2, per-harness notification
//! plan).
//!
//! Adapters describe their side effects as a list of [`SetupAction`] values
//! and hand the plan to [`SetupExecutor::apply`]. The executor applies the
//! actions either all-or-nothing (via a two-phase scheme that stages each
//! write to a tempfile and renames into place on commit) or best-effort
//! (per action), and returns a [`SetupReport`] the UI can render.
//!
//! # Why a plan + executor instead of direct writes?
//!
//! * **Testability.** Adapters return a [`SetupPlan`] we can inspect byte-
//!   exactly without touching disk. Today's adapters have to reach into
//!   tempdirs just to verify hook install logic.
//! * **Uniform error surface.** One executor owns the "write JSON safely"
//!   path, including atomic rename + parent-dir creation + permission
//!   bits. Per-adapter code describes intent only.
//! * **UI hookup.** The returned [`SetupReport`] pairs each
//!   [`SetupAction`] with an outcome, which the Harness Health panel in
//!   Settings renders as a checklist.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::agent::AgentKind;
use crate::config_io::managed_json::{atomic_write, is_raum_managed};
use crate::config_io::managed_toml;

/// Context handed to each [`crate::harness::traits::NotificationSetup`]
/// planner. Carries paths the planner needs to decide what to do (hook
/// script dir, per-harness settings path) and lightweight tuning knobs.
#[derive(Debug, Clone)]
pub struct SetupContext {
    /// Directory where hook scripts live (`~/.config/raum/hooks/`).
    pub hooks_dir: PathBuf,
    /// Event socket path exported into child processes via `RAUM_EVENT_SOCK`.
    /// Adapters embed this when they generate shell scripts so they fail
    /// cleanly if raum is offline when the hook fires.
    pub event_socket_path: PathBuf,
    /// Timeout the PermissionRequest hook script waits before falling back
    /// to `"ask"` (so Claude Code shows its own TUI prompt). Configurable
    /// per the plan document's risks section (default 55 s, leaving 5 s
    /// headroom below Claude's 60 s hook timeout).
    pub permission_timeout: Duration,
    /// Project slug bound to this setup run. Adapters that write per-
    /// project config (OpenCode's future project overrides) read this.
    pub project_slug: String,
    /// Phase 6: Absolute path to the project (worktree) root. Claude Code
    /// and Codex adapters drop their per-project settings (`.claude/` /
    /// `.codex/`) under this directory so two projects' hooks coexist
    /// without clobbering each other. Empty `PathBuf` falls back to the
    /// legacy user-global path (kept for tests that only exercise the
    /// plan body).
    pub project_dir: PathBuf,
    /// Phase 6: User home directory. Adapters probe for legacy raum-
    /// managed entries at `$HOME/.claude/settings.json` /
    /// `$XDG_CONFIG_HOME/opencode/config.json` and emit a
    /// `RemoveManagedJsonEntries` action so the one-time migration off
    /// the user-global path is silent + idempotent.
    pub home_dir: PathBuf,
    /// Phase 6: Optional port override forwarded to the OpenCode adapter
    /// so the setup plan + selftest + runtime channel all agree on
    /// which port they're targeting. `None` falls through to the
    /// adapter's default discovery chain
    /// (`$OPENCODE_PORT` → lockfile → 4096).
    pub opencode_port_override: Option<u16>,
}

impl SetupContext {
    /// Convenience: build a context with sensible raum-core defaults
    /// (55 s permission timeout). Paths and project slug are required.
    ///
    /// `project_dir` defaults to an empty path (adapters fall back to
    /// the legacy user-global location when the field is empty — used
    /// by the plan-body tests that do not care which path the setup
    /// writes to). `home_dir` defaults to `$HOME` or `/` so the
    /// migration probe always has a path to check.
    #[must_use]
    pub fn new(
        hooks_dir: PathBuf,
        event_socket_path: PathBuf,
        project_slug: impl Into<String>,
    ) -> Self {
        let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
        Self {
            hooks_dir,
            event_socket_path,
            permission_timeout: Duration::from_secs(55),
            project_slug: project_slug.into(),
            project_dir: PathBuf::new(),
            home_dir: home,
            opencode_port_override: None,
        }
    }

    /// Set the project (worktree) root directory for this context.
    #[must_use]
    pub fn with_project_dir(mut self, project_dir: PathBuf) -> Self {
        self.project_dir = project_dir;
        self
    }

    /// Override `$HOME`. Used only by tests that need to exercise the
    /// legacy-config migration path under a tempdir.
    #[must_use]
    pub fn with_home_dir(mut self, home_dir: PathBuf) -> Self {
        self.home_dir = home_dir;
        self
    }

    /// Override the OpenCode port. `None` restores the default
    /// discovery chain.
    #[must_use]
    pub fn with_opencode_port(mut self, port: Option<u16>) -> Self {
        self.opencode_port_override = port;
        self
    }
}

/// A single side-effect the executor applies. The plan is `Vec<SetupAction>`;
/// ordering is preserved.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SetupAction {
    /// Write a JSON file (pretty-printed) atomically. Content is the raw
    /// UTF-8 bytes, already fully serialised by the planner.
    WriteJson { path: PathBuf, content: String },
    /// Write a TOML file atomically. Content is already serialised.
    WriteToml { path: PathBuf, content: String },
    /// Write a shell script with a specific mode. The executor `chmod`s
    /// the file after rename so mode is always authoritative.
    WriteShellScript {
        path: PathBuf,
        content: String,
        mode: u32,
    },
    /// Assert a binary exists on `$PATH`. Non-fatal — reported in the
    /// [`SetupReport`] so the UI can warn but the app still launches.
    AssertBinary { name: String },
    /// Ensure a feature flag is set. Carries the file path, the
    /// dotted-TOML-key path, and the boolean value. Implementation is
    /// Phase 3 (Codex `[features] codex_hooks = true`); Phase 2 just
    /// defines the variant.
    EnsureFeatureFlag {
        path: PathBuf,
        key_path: Vec<String>,
        value: bool,
    },
    /// Parse a JSON settings file and drop every array entry that is
    /// tagged with the `_raum_managed_marker: "<raum-managed>"`
    /// sentinel. Used by adapters (OpenCode, Phase 4) that previously
    /// injected hook entries into a harness's config file and are now
    /// migrating to a different notification transport.
    ///
    /// No-op when the file is missing or unparsable — the executor
    /// refuses to scribble over a user's hand-edited-but-broken JSON.
    RemoveManagedJsonEntries { path: PathBuf },
}

/// Plan a harness returns from its [`crate::harness::traits::NotificationSetup::plan`].
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SetupPlan {
    pub harness: Option<AgentKind>,
    pub actions: Vec<SetupAction>,
}

impl SetupPlan {
    #[must_use]
    pub fn new(harness: AgentKind) -> Self {
        Self {
            harness: Some(harness),
            actions: Vec::new(),
        }
    }

    pub fn push(&mut self, action: SetupAction) -> &mut Self {
        self.actions.push(action);
        self
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.actions.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.actions.is_empty()
    }
}

/// Outcome of applying a single [`SetupAction`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "kebab-case")]
pub enum ActionOutcome {
    Applied,
    Skipped { reason: String },
    Failed { error: String },
}

/// Per-action report returned from [`SetupExecutor::apply`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActionReport {
    pub action: SetupAction,
    pub outcome: ActionOutcome,
}

/// Aggregate report covering a single adapter's plan application.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SetupReport {
    pub harness: Option<AgentKind>,
    pub actions: Vec<ActionReport>,
    /// `true` when every action applied cleanly; `false` when any action
    /// failed. Best-effort actions (`AssertBinary`, `EnsureFeatureFlag`
    /// phase 2) that are skipped do **not** flip this to false.
    pub ok: bool,
}

impl SetupReport {
    #[must_use]
    pub fn is_ok(&self) -> bool {
        self.ok
    }
}

/// Scope of a managed config path — whether it lives inside the project
/// (`.claude/settings.json`, `.codex/hooks.json`) or under the user's
/// home directory (`~/.codex/config.toml`). Rendered next to the path in
/// the Harness Health panel so the user knows which scope a change
/// affects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConfigScope {
    Project,
    User,
}

/// One file the setup plan would write to, enriched with the "exists +
/// currently raum-managed" snapshot so the UI can render an install /
/// reinstall / healthy badge without re-parsing the plan client-side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigPathEntry {
    /// Project-local vs user-global.
    pub kind: ConfigScope,
    /// Short human label ("Project settings", "User config", …).
    pub label: String,
    /// Absolute path on disk. Rendered verbatim in the UI; click-to-reveal
    /// opens the parent directory in Finder/Explorer.
    pub path: PathBuf,
    /// `true` iff the file currently exists on disk.
    pub exists: bool,
    /// `true` iff the file exists AND contains at least one entry tagged
    /// with the `<raum-managed>` marker (JSON: `_raum_managed_marker`;
    /// TOML: the `# <raum-managed>` comment sentinel).
    pub raum_managed: bool,
}

/// Pure-read scan result for a single harness. Produced from
/// [`crate::harness::traits::NotificationSetup::scan`] — no subprocess
/// spawns, no disk writes, safe to call whenever the user opens the
/// Harness Health panel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanReport {
    pub harness: AgentKind,
    /// Binary raum looks for on `$PATH`.
    pub binary: String,
    /// `true` iff `which(binary)` resolved.
    pub binary_on_path: bool,
    /// Summary flag: `true` when every mandatory managed config path
    /// exists AND carries the `<raum-managed>` marker.
    pub raum_hooks_installed: bool,
    /// Config files raum's plan would touch for this harness, with their
    /// current on-disk state.
    pub config_paths: Vec<ConfigPathEntry>,
    /// When `raum_hooks_installed` is false, a one-line reason suitable
    /// for the panel. `None` when nothing needs attention.
    pub reason_if_not_installed: Option<String>,
    /// Harnesses that have no config file at all (OpenCode, Shell) emit
    /// a one-liner instead of a paths list. Rendered underneath the
    /// headline row.
    pub note: Option<String>,
}

/// Selftest report returned from [`crate::harness::traits::NotificationSetup::selftest`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SelftestReport {
    pub harness: Option<AgentKind>,
    pub ok: bool,
    pub detail: String,
    /// Total wall-clock time the selftest took. Rendered next to the
    /// "Run again" button so users can tell a slow event socket apart
    /// from a successful-but-near-timeout result.
    pub elapsed_ms: u64,
}

impl SelftestReport {
    #[must_use]
    pub fn ok(harness: AgentKind, detail: impl Into<String>, elapsed_ms: u64) -> Self {
        Self {
            harness: Some(harness),
            ok: true,
            detail: detail.into(),
            elapsed_ms,
        }
    }

    #[must_use]
    pub fn failed(harness: AgentKind, detail: impl Into<String>, elapsed_ms: u64) -> Self {
        Self {
            harness: Some(harness),
            ok: false,
            detail: detail.into(),
            elapsed_ms,
        }
    }
}

/// Errors the planner (not the executor) can raise. The executor emits
/// per-action [`ActionOutcome::Failed`] instead of bubbling errors up so
/// one broken action doesn't abort the whole plan.
#[derive(Debug, Error)]
pub enum SetupError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialize: {0}")]
    Serialize(String),
    #[error("planner: {0}")]
    Planner(String),
}

/// Transactional executor for [`SetupPlan`]s.
///
/// "Transactional" here is weaker than a database commit — each individual
/// write is atomic (tempfile + rename), but a partial failure mid-plan
/// leaves already-applied actions in place. That is the documented
/// Phase 2 contract: the UI renders per-action outcomes and a retry
/// button, so partial application is visible and recoverable.
#[derive(Debug, Default, Clone)]
pub struct SetupExecutor {
    _private: (),
}

impl SetupExecutor {
    #[must_use]
    pub fn new() -> Self {
        Self { _private: () }
    }

    /// Apply `plan` in order, returning a per-action report. The
    /// report's `ok` flag is `true` iff every action yielded
    /// [`ActionOutcome::Applied`] or a non-fatal [`ActionOutcome::Skipped`].
    pub fn apply(&self, plan: &SetupPlan) -> SetupReport {
        let mut actions = Vec::with_capacity(plan.actions.len());
        let mut any_failed = false;
        for action in &plan.actions {
            let outcome = self.apply_one(action);
            if matches!(outcome, ActionOutcome::Failed { .. }) {
                any_failed = true;
            }
            actions.push(ActionReport {
                action: action.clone(),
                outcome,
            });
        }
        SetupReport {
            harness: plan.harness,
            actions,
            ok: !any_failed,
        }
    }

    fn apply_one(&self, action: &SetupAction) -> ActionOutcome {
        match action {
            SetupAction::WriteJson { path, content } => {
                match atomic_write(path, content.as_bytes()) {
                    Ok(()) => ActionOutcome::Applied,
                    Err(e) => ActionOutcome::Failed {
                        error: e.to_string(),
                    },
                }
            }
            SetupAction::WriteToml { path, content } => {
                match atomic_write(path, content.as_bytes()) {
                    Ok(()) => ActionOutcome::Applied,
                    Err(e) => ActionOutcome::Failed {
                        error: e.to_string(),
                    },
                }
            }
            SetupAction::WriteShellScript {
                path,
                content,
                mode,
            } => match atomic_write(path, content.as_bytes()) {
                Ok(()) => match chmod(path, *mode) {
                    Ok(()) => ActionOutcome::Applied,
                    Err(e) => ActionOutcome::Failed {
                        error: format!("chmod {mode:o}: {e}"),
                    },
                },
                Err(e) => ActionOutcome::Failed {
                    error: e.to_string(),
                },
            },
            SetupAction::AssertBinary { name } => match which::which(name) {
                Ok(_) => ActionOutcome::Applied,
                Err(_) => ActionOutcome::Skipped {
                    reason: format!("binary `{name}` not on $PATH"),
                },
            },
            // Phase 3 implementation (Codex TOML feature flag). Phase 2
            // records the intent so plans are testable and the Harness
            // Health panel can render pending actions without waiting
            // for a full implementation.
            SetupAction::EnsureFeatureFlag { .. } => ActionOutcome::Skipped {
                reason: "feature-flag action not implemented until Phase 3".into(),
            },
            SetupAction::RemoveManagedJsonEntries { path } => remove_managed_entries(path),
        }
    }
}

/// Body of [`SetupAction::RemoveManagedJsonEntries`]. Kept private because
/// the executor is the only caller; extracted purely so the logic is easy
/// to follow and test against.
fn remove_managed_entries(path: &Path) -> ActionOutcome {
    if !path.exists() {
        return ActionOutcome::Skipped {
            reason: format!("{} does not exist", path.display()),
        };
    }
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            return ActionOutcome::Failed {
                error: format!("read {}: {e}", path.display()),
            };
        }
    };
    if raw.trim().is_empty() {
        return ActionOutcome::Skipped {
            reason: format!("{} is empty", path.display()),
        };
    }
    let mut root: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            return ActionOutcome::Skipped {
                reason: format!("{} is not parsable JSON: {e}", path.display()),
            };
        }
    };
    let mut removed = 0usize;
    if let Some(hooks) = root
        .as_object_mut()
        .and_then(|o| o.get_mut("hooks"))
        .and_then(|v| v.as_object_mut())
    {
        for (_event, arr) in hooks.iter_mut() {
            if let Some(list) = arr.as_array_mut() {
                let before = list.len();
                list.retain(|v| !is_raum_managed(v));
                removed += before - list.len();
            }
        }
    }
    if removed == 0 {
        return ActionOutcome::Skipped {
            reason: format!("no <raum-managed> entries in {}", path.display()),
        };
    }
    let serialized = match serde_json::to_string_pretty(&root) {
        Ok(s) => s,
        Err(e) => {
            return ActionOutcome::Failed {
                error: format!("serialize: {e}"),
            };
        }
    };
    match atomic_write(path, serialized.as_bytes()) {
        Ok(()) => ActionOutcome::Applied,
        Err(e) => ActionOutcome::Failed {
            error: format!("write: {e}"),
        },
    }
}

/// Inspect `path` and decide whether it currently contains any
/// raum-managed entries under `hooks.*`. Returns `(exists, raum_managed)`.
/// `raum_managed` is `false` when the file does not exist or is not
/// JSON or has no hook arrays at all — callers treat that the same as
/// "install needed".
#[must_use]
pub fn inspect_json_path(path: &Path) -> (bool, bool) {
    if !path.exists() {
        return (false, false);
    }
    let Ok(raw) = std::fs::read_to_string(path) else {
        return (true, false);
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return (true, false);
    };
    let managed = value
        .get("hooks")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|hooks| {
            hooks
                .values()
                .filter_map(serde_json::Value::as_array)
                .any(|arr| arr.iter().any(is_raum_managed))
        });
    (true, managed)
}

/// Inspect a Codex `config.toml` for the raum `# <raum-managed>` block.
#[must_use]
pub fn inspect_toml_path(path: &Path) -> (bool, bool) {
    if !path.exists() {
        return (false, false);
    }
    let Ok(raw) = std::fs::read_to_string(path) else {
        return (true, false);
    };
    (true, managed_toml::contains_managed_block(&raw))
}

/// `Arc` wrapper for contexts that need to share one executor across tasks.
#[must_use]
pub fn shared_executor() -> Arc<SetupExecutor> {
    Arc::new(SetupExecutor::new())
}

fn chmod(path: &Path, mode: u32) -> std::io::Result<()> {
    let perms = std::fs::Permissions::from_mode(mode);
    std::fs::set_permissions(path, perms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn executor_writes_json_atomically() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("settings.json");
        let mut plan = SetupPlan::new(AgentKind::ClaudeCode);
        plan.push(SetupAction::WriteJson {
            path: path.clone(),
            content: "{\"hello\":\"world\"}".to_string(),
        });
        let exec = SetupExecutor::new();
        let report = exec.apply(&plan);
        assert!(report.ok);
        assert_eq!(report.actions.len(), 1);
        assert!(matches!(report.actions[0].outcome, ActionOutcome::Applied));
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, "{\"hello\":\"world\"}");
    }

    #[test]
    fn executor_chmods_shell_scripts() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("raum-hook.sh");
        let mut plan = SetupPlan::new(AgentKind::ClaudeCode);
        plan.push(SetupAction::WriteShellScript {
            path: path.clone(),
            content: "#!/bin/sh\necho hi\n".to_string(),
            mode: 0o700,
        });
        let report = SetupExecutor::new().apply(&plan);
        assert!(report.ok);
        let meta = std::fs::metadata(&path).unwrap();
        let actual = meta.permissions().mode() & 0o777;
        assert_eq!(actual, 0o700);
    }

    #[test]
    fn assert_binary_skipped_when_missing() {
        let mut plan = SetupPlan::new(AgentKind::ClaudeCode);
        plan.push(SetupAction::AssertBinary {
            name: "raum-definitely-not-on-path-xxyy".into(),
        });
        let report = SetupExecutor::new().apply(&plan);
        // Missing binaries are non-fatal → plan still ok.
        assert!(report.ok);
        let outcome = &report.actions[0].outcome;
        assert!(matches!(outcome, ActionOutcome::Skipped { .. }));
    }

    #[test]
    fn plan_len_and_empty_surface() {
        let mut plan = SetupPlan::new(AgentKind::ClaudeCode);
        assert!(plan.is_empty());
        assert_eq!(plan.len(), 0);
        plan.push(SetupAction::AssertBinary { name: "sh".into() });
        assert!(!plan.is_empty());
        assert_eq!(plan.len(), 1);
    }

    #[test]
    fn remove_managed_json_noop_when_file_missing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut plan = SetupPlan::new(AgentKind::OpenCode);
        plan.push(SetupAction::RemoveManagedJsonEntries { path: path.clone() });
        let report = SetupExecutor::new().apply(&plan);
        assert!(report.ok);
        assert!(matches!(
            report.actions[0].outcome,
            ActionOutcome::Skipped { .. }
        ));
    }

    #[test]
    fn remove_managed_json_strips_only_raum_entries() {
        use crate::config_io::managed_json::{MARKER_BEGIN, MARKER_KEY};
        use serde_json::json;
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let original = json!({
            "provider": { "openai": { "model": "gpt-4" } },
            "hooks": {
                "Notification": [
                    { "matcher": "user", "hooks": [] },
                    { MARKER_KEY: MARKER_BEGIN, "matcher": ".*", "hooks": [] }
                ],
                "Stop": [
                    { MARKER_KEY: MARKER_BEGIN, "matcher": ".*", "hooks": [] }
                ]
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&original).unwrap()).unwrap();

        let mut plan = SetupPlan::new(AgentKind::OpenCode);
        plan.push(SetupAction::RemoveManagedJsonEntries { path: path.clone() });
        let report = SetupExecutor::new().apply(&plan);
        assert!(report.ok);
        assert!(matches!(report.actions[0].outcome, ActionOutcome::Applied));

        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // Unrelated config preserved.
        assert_eq!(
            parsed["provider"]["openai"]["model"].as_str().unwrap(),
            "gpt-4"
        );
        // User entry preserved, raum entry removed.
        let notif = parsed["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 1);
        assert_eq!(notif[0]["matcher"].as_str().unwrap(), "user");
        let stop = parsed["hooks"]["Stop"].as_array().unwrap();
        assert!(stop.is_empty());
    }

    #[test]
    fn remove_managed_json_skips_unparsable() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, "{not json").unwrap();
        let mut plan = SetupPlan::new(AgentKind::OpenCode);
        plan.push(SetupAction::RemoveManagedJsonEntries { path: path.clone() });
        let report = SetupExecutor::new().apply(&plan);
        assert!(report.ok);
        assert!(matches!(
            report.actions[0].outcome,
            ActionOutcome::Skipped { .. }
        ));
        // Original bytes preserved.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not json");
    }

    #[test]
    fn remove_managed_json_skips_when_nothing_to_remove() {
        use serde_json::json;
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let original = json!({
            "hooks": { "Notification": [{ "matcher": "user", "hooks": [] }] }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&original).unwrap()).unwrap();
        let mut plan = SetupPlan::new(AgentKind::OpenCode);
        plan.push(SetupAction::RemoveManagedJsonEntries { path: path.clone() });
        let report = SetupExecutor::new().apply(&plan);
        assert!(report.ok);
        assert!(matches!(
            report.actions[0].outcome,
            ActionOutcome::Skipped { .. }
        ));
    }

    #[test]
    fn selftest_report_builders() {
        let ok = SelftestReport::ok(AgentKind::ClaudeCode, "fired and received", 42);
        assert!(ok.ok);
        let bad = SelftestReport::failed(AgentKind::Codex, "socket closed", 7);
        assert!(!bad.ok);
        assert_eq!(bad.detail, "socket closed");
    }
}
