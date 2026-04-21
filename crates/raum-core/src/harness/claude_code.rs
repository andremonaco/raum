//! Claude Code adapter.
//!
//! Installs the raum hook script into a project's
//! `.claude/settings.local.json` (falling back to `~/.claude/settings.json`
//! when no project_dir is set). Per the official Claude Code docs,
//! `settings.local.json` is the personal/auto-gitignored layer: raum hooks
//! carry machine-specific paths (hook-script location, event socket) and
//! must never land in `settings.json`, which is the shared/team-checked-in
//! layer. Phase 2 expanded coverage from `{Notification, Stop,
//! UserPromptSubmit}` to the full set `{PermissionRequest, Notification,
//! Stop, UserPromptSubmit, StopFailure}`. The `PermissionRequest` hook is
//! the only synchronous one — see [`crate::harness::reply`] for the
//! decision wire format.
//!
//! # Marker discipline
//!
//! The spec asks for a raum-managed block delimited by `// <raum-managed>` /
//! `// </raum-managed>` comments. JSON does **not** allow `//` comments, so we
//! tag every hook entry we own with a sentinel key
//! (`_raum_managed_marker: "<raum-managed>"`). On reinstall we remove every
//! array entry that carries this sentinel and then re-append our fresh entries
//! — leaving anything the user (or another tool) added in place untouched.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tracing::info;

#[allow(deprecated)]
use crate::agent::AgentAdapter;
use crate::agent::{AgentError, AgentKind, SessionId, SpawnOptions, VersionReport, semver_lite};
use crate::config_io::managed_json::{
    self, MARKER_BEGIN, MARKER_KEY, ManagedJsonError, ManagedJsonHooks,
};
use crate::harness::channel::NotificationChannel;
use crate::harness::reply::PermissionReplier;
use crate::harness::setup::{
    ConfigPathEntry, ConfigScope, ScanReport, SelftestReport, SetupAction, SetupContext,
    SetupError, SetupPlan, inspect_json_path,
};
use crate::harness::traits::{
    HarnessIdentity, HarnessRuntime, LaunchOverrides, NotificationSetup, SessionSpec,
};

use super::hook_script_path;

/// Claude Code hook events raum subscribes to.
///
/// * `PermissionRequest` — synchronous. Hook returns a JSON decision;
///   raum blocks the script on a socket reply line.
/// * `Notification` — fire-and-forget. Carries a `notification_type`
///   subtype (`permission_prompt`, `idle_prompt`, `auth_success`,
///   `elicitation_dialog`) that [`crate::harness::event::classify_notification_kind`]
///   consumes.
/// * `Stop` — turn completed cleanly.
/// * `UserPromptSubmit` — user submitted a prompt (Working edge).
/// * `StopFailure` — turn ended due to an API error (rate limit, auth,
///   billing, …). Observability only — hooks cannot decide here.
pub const RAUM_HOOK_EVENTS: &[&str] = &[
    "PermissionRequest",
    "Notification",
    "Stop",
    "UserPromptSubmit",
    "StopFailure",
];

/// Claude Code adapter. Binary is looked up as `claude` on `$PATH`.
#[derive(Debug, Clone, Default)]
pub struct ClaudeCodeAdapter {
    /// Optional override for the settings.json location (tests).
    settings_path_override: Option<PathBuf>,
}

impl ClaudeCodeAdapter {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Construct an adapter with a custom settings.json path — used only by tests.
    #[must_use]
    pub fn with_settings_path(path: PathBuf) -> Self {
        Self {
            settings_path_override: Some(path),
        }
    }

    /// Legacy settings path (no context). Falls back to
    /// `~/.claude/settings.json`; the Phase-6 production path is
    /// [`Self::settings_path_for_ctx`].
    #[must_use]
    pub fn settings_path(&self) -> PathBuf {
        if let Some(p) = &self.settings_path_override {
            return p.clone();
        }
        default_user_settings_path()
    }

    /// Project-scoped settings path. Resolves to
    /// `<ctx.project_dir>/.claude/settings.local.json` when `project_dir`
    /// is populated, or falls back to the legacy user-global path when
    /// it is empty (tests / deprecated shim).
    ///
    /// `settings.local.json` is the officially-documented personal,
    /// auto-gitignored layer; using it keeps raum's machine-specific
    /// hook paths out of the repo's shared `settings.json`.
    #[must_use]
    pub fn settings_path_for_ctx(&self, ctx: &SetupContext) -> PathBuf {
        if let Some(p) = &self.settings_path_override {
            return p.clone();
        }
        if ctx.project_dir.as_os_str().is_empty() {
            return default_user_settings_path();
        }
        ctx.project_dir.join(".claude").join("settings.local.json")
    }
}

fn default_user_settings_path() -> PathBuf {
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    home.join(".claude").join("settings.json")
}

/// Legacy user-global `settings.json` path keyed off an explicit
/// `home_dir`. Used by the migration probe so the adapter respects
/// `SetupContext::home_dir` (which tests can override to a tempdir).
fn legacy_user_settings_path(home_dir: &Path) -> PathBuf {
    home_dir.join(".claude").join("settings.json")
}

/// Legacy project-scoped `<project>/.claude/settings.json` path. Prior
/// raum versions wrote managed hook entries here, which incorrectly
/// polluted the repo's shared settings file. The migration probe sweeps
/// any raum-managed entries out of it before writing the new
/// `settings.local.json`.
fn legacy_project_settings_path(project_dir: &Path) -> PathBuf {
    project_dir.join(".claude").join("settings.json")
}

#[async_trait]
#[allow(deprecated)]
impl AgentAdapter for ClaudeCodeAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::ClaudeCode
    }

    fn binary_path(&self) -> &'static str {
        "claude"
    }

    async fn spawn(&self, _opts: SpawnOptions) -> Result<SessionId, AgentError> {
        // Ensure the binary exists before the tmux layer tries to launch it.
        which::which(self.binary_path()).map_err(|_| AgentError::BinaryMissing {
            binary: self.binary_path().to_string(),
        })?;
        Err(AgentError::Spawn(
            "spawn is owned by the tmux layer; ClaudeCodeAdapter only validates preconditions"
                .into(),
        ))
    }

    async fn install_hooks(&self, hooks_dir: &Path) -> Result<(), AgentError> {
        let script = hook_script_path(hooks_dir, "claude-code");
        let path = self.settings_path();
        install_claude_hooks(&path, &script).map_err(|e| AgentError::HookInstall(e.to_string()))?;
        info!(?path, "claude-code hooks installed");
        Ok(())
    }

    fn supports_native_events(&self) -> bool {
        true
    }

    async fn detect_version(&self) -> Result<VersionReport, AgentError> {
        run_version(
            <Self as AgentAdapter>::binary_path(self),
            &<Self as AgentAdapter>::minimum_version(self),
        )
        .await
    }

    fn minimum_version(&self) -> semver_lite::Version {
        semver_lite::Version {
            major: 0,
            minor: 2,
            patch: 0,
        }
    }
}

// ---- New trait split (Phase 2) ---------------------------------------------

#[async_trait]
impl HarnessIdentity for ClaudeCodeAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::ClaudeCode
    }
    fn binary(&self) -> &'static str {
        "claude"
    }
    fn minimum_version(&self) -> semver_lite::Version {
        semver_lite::Version {
            major: 0,
            minor: 2,
            patch: 0,
        }
    }
    async fn detect_version(&self) -> Result<VersionReport, AgentError> {
        run_version(
            <Self as HarnessIdentity>::binary(self),
            &<Self as HarnessIdentity>::minimum_version(self),
        )
        .await
    }
}

#[async_trait]
impl NotificationSetup for ClaudeCodeAdapter {
    /// Build the plan that installs raum hooks into the project's
    /// `.claude/settings.local.json` (falling back to
    /// `~/.claude/settings.json` when no project_dir is set).
    ///
    /// Every hook entry is tagged with
    /// `_raum_managed_marker: "<raum-managed>"`; re-running the plan
    /// replaces the raum entries without touching user-authored ones.
    async fn plan(&self, ctx: &SetupContext) -> Result<SetupPlan, SetupError> {
        let script = hook_script_path(&ctx.hooks_dir, "claude-code");
        let settings_path = self.settings_path_for_ctx(ctx);
        // Migration: earlier raum versions wrote managed entries into
        // either the user-global `~/.claude/settings.json` or — worse —
        // the repo's shared `<project>/.claude/settings.json`. Both are
        // swept before we write the new `settings.local.json` target,
        // so upgrading cleans up without the user having to do anything.
        // The `RemoveManagedJsonEntries` action is a no-op when the file
        // is missing or carries no raum-managed entries.
        let legacy_user = legacy_user_settings_path(&ctx.home_dir);
        let legacy_project = (!ctx.project_dir.as_os_str().is_empty())
            .then(|| legacy_project_settings_path(&ctx.project_dir));
        let skip_migration = self.settings_path_override.is_some();

        // Build the in-memory JSON we want on disk, then serialise once.
        let mut root = if settings_path.exists() {
            let raw = std::fs::read_to_string(&settings_path)?;
            if raw.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str::<Value>(&raw)
                    .map_err(|e| SetupError::Planner(format!("settings.json not JSON: {e}")))?
            }
        } else {
            json!({})
        };
        if !root.is_object() {
            root = json!({});
        }

        let hooks = root
            .as_object_mut()
            .expect("root is object")
            .entry("hooks".to_string())
            .or_insert_with(|| json!({}));
        if !hooks.is_object() {
            *hooks = json!({});
        }
        let hooks_obj = hooks.as_object_mut().expect("hooks is object");
        for event in RAUM_HOOK_EVENTS {
            let arr_entry = hooks_obj
                .entry((*event).to_string())
                .or_insert_with(|| json!([]));
            if !arr_entry.is_array() {
                *arr_entry = json!([]);
            }
            let arr = arr_entry.as_array_mut().expect("hooks.* is array");
            arr.retain(|v| !managed_json::is_raum_managed(v));
            arr.push(raum_hook_entry(event, &script));
        }

        let serialized = serde_json::to_string_pretty(&root)
            .map_err(|e| SetupError::Serialize(e.to_string()))?;

        let mut plan = SetupPlan::new(AgentKind::ClaudeCode);
        plan.push(SetupAction::AssertBinary {
            name: "claude".into(),
        });
        if !skip_migration {
            if let Some(legacy_project) = legacy_project
                && legacy_project != settings_path
            {
                plan.push(SetupAction::RemoveManagedJsonEntries {
                    path: legacy_project,
                });
            }
            if legacy_user != settings_path {
                plan.push(SetupAction::RemoveManagedJsonEntries { path: legacy_user });
            }
        }
        // Write the hook-dispatcher script itself. Without this the
        // `command` reference in settings.json points at a path that
        // does not exist on disk — the script must land as part of the
        // same atomic plan apply.
        plan.push(SetupAction::WriteShellScript {
            path: script.clone(),
            content: crate::harness::hook_script::body(
                crate::harness::hook_script::HookDispatcher::ClaudeCode,
            ),
            mode: 0o700,
        });
        plan.push(SetupAction::WriteJson {
            path: settings_path,
            content: serialized,
        });
        Ok(plan)
    }

    async fn selftest(&self, ctx: &SetupContext) -> SelftestReport {
        let started = Instant::now();
        // Bind a short-lived side-socket next to the real event socket and
        // push a synthetic hook event into it via a unix-socket write. This
        // verifies we can at least reach the raum-hooks socket (if it's
        // up) from this process; the Claude binary is *not* launched here
        // because selftest must be fast and offline-safe.
        let path = &ctx.event_socket_path;
        if !path.exists() {
            return SelftestReport::failed(
                AgentKind::ClaudeCode,
                format!("event socket {} does not exist", path.display()),
                started.elapsed().as_millis() as u64,
            );
        }
        let stream_result =
            tokio::time::timeout(Duration::from_secs(2), UnixStream::connect(path)).await;
        let Ok(stream) = stream_result else {
            return SelftestReport::failed(
                AgentKind::ClaudeCode,
                "timeout connecting to event socket",
                started.elapsed().as_millis() as u64,
            );
        };
        let mut stream = match stream {
            Ok(s) => s,
            Err(e) => {
                return SelftestReport::failed(
                    AgentKind::ClaudeCode,
                    format!("connect failed: {e}"),
                    started.elapsed().as_millis() as u64,
                );
            }
        };
        let line = b"{\"harness\":\"claude-code\",\"event\":\"Notification\",\"payload\":{\"selftest\":true}}\n";
        if let Err(e) = stream.write_all(line).await {
            return SelftestReport::failed(
                AgentKind::ClaudeCode,
                format!("write failed: {e}"),
                started.elapsed().as_millis() as u64,
            );
        }
        let _ = stream.flush().await;
        // Drop the write half so the server reads EOF; the socket has no
        // protocol for the client to await ack, so "we wrote successfully"
        // is the strongest signal we can offer here without plumbing a
        // bidirectional selftest round-trip through raum-hooks.
        SelftestReport::ok(
            AgentKind::ClaudeCode,
            "synthetic Notification written to event socket",
            started.elapsed().as_millis() as u64,
        )
    }
}

impl ClaudeCodeAdapter {
    /// Pure-read scan: report whether Claude Code's project-scoped
    /// `settings.local.json` exists and carries raum-managed entries.
    /// Does not spawn the `claude` binary.
    #[must_use]
    pub fn scan(&self, ctx: &SetupContext) -> ScanReport {
        let binary = <Self as HarnessIdentity>::binary(self);
        let binary_on_path = which::which(binary).is_ok();
        let settings_path = self.settings_path_for_ctx(ctx);
        let (exists, raum_managed) = inspect_json_path(&settings_path);
        let entry = ConfigPathEntry {
            kind: ConfigScope::Project,
            label: "Claude Code local settings".into(),
            path: settings_path.clone(),
            exists,
            raum_managed,
        };
        let raum_hooks_installed = exists && raum_managed;
        let reason_if_not_installed = if !binary_on_path {
            Some(format!("{binary} binary not found on PATH"))
        } else if !exists {
            Some(format!("{} does not exist yet", settings_path.display()))
        } else if !raum_managed {
            Some(format!(
                "{} has no raum-managed entries",
                settings_path.display()
            ))
        } else {
            None
        };
        ScanReport {
            harness: AgentKind::ClaudeCode,
            binary: binary.into(),
            binary_on_path,
            raum_hooks_installed,
            config_paths: vec![entry],
            reason_if_not_installed,
            note: None,
        }
    }
}

impl HarnessRuntime for ClaudeCodeAdapter {
    fn channels(&self, _session: &SessionSpec) -> Vec<Box<dyn NotificationChannel>> {
        // Phase 2 defines the trait surface; concrete channel impls
        // (`UnixSocketChannel`, `SilenceChannel`) land in Phase 3/4. We
        // return `[]` here so callers can already exercise the factory
        // without waiting for the supervisor work.
        Vec::new()
    }

    fn replier(&self, _session: &SessionSpec) -> Option<Box<dyn PermissionReplier>> {
        // Phase 2 wires the `HookResponseReplier` inside `raum-hooks`; the
        // factory is provided from the `src-tauri` layer at runtime
        // because it needs a handle to the pending-request registry.
        None
    }

    fn launch_overrides(&self) -> LaunchOverrides {
        LaunchOverrides::default()
    }
}

pub(super) async fn run_version(
    binary: &str,
    minimum: &semver_lite::Version,
) -> Result<VersionReport, AgentError> {
    let resolved = which::which(binary).map_err(|_| AgentError::BinaryMissing {
        binary: binary.to_string(),
    })?;
    let output = tokio::process::Command::new(&resolved)
        .arg("--version")
        .output()
        .await
        .map_err(AgentError::Io)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let raw = if stdout.is_empty() { stderr } else { stdout };
    let parsed = semver_lite::Version::parse(&raw);
    let at_or_above_minimum = parsed.as_ref().map(|v| v >= minimum);
    Ok(VersionReport {
        raw,
        parsed,
        at_or_above_minimum,
    })
}

/// Install raum hooks into a Claude Code `settings.json` at `path`, pointing at
/// the hook `script`. Pure function — takes and writes full bytes, no I/O
/// outside the filesystem write-through.
pub fn install_claude_hooks(path: &Path, script: &Path) -> std::io::Result<()> {
    managed_json::apply_managed_hooks(&ManagedJsonHooks {
        path,
        events: RAUM_HOOK_EVENTS,
        make_entry: &|event| raum_hook_entry(event, script),
    })
    .map_err(managed_json_error_to_io)
}

fn managed_json_error_to_io(e: ManagedJsonError) -> std::io::Error {
    match e {
        ManagedJsonError::Io(err) => err,
        ManagedJsonError::InvalidJson(err) => std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("settings.json is not valid JSON: {err}"),
        ),
        ManagedJsonError::Serialize(err) => std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("serialize settings.json failed: {err}"),
        ),
    }
}

fn raum_hook_entry(event: &str, script: &Path) -> Value {
    // Claude Code hook entry schema: { matcher: ".*", hooks: [{ type: "command", command: "..." }] }
    //
    // The `_raum_managed_marker: "<raum-managed>"` sentinel key is how we
    // identify entries we own on re-install: `retain(|v| !is_raum_managed(v))`
    // drops every previously-written raum entry before we append the fresh
    // one. JSON has no comment syntax, so the literal `<raum-managed>` and
    // `</raum-managed>` tokens from the spec are encoded as the sentinel's
    // string values (see `adapters::MARKER_BEGIN` / `MARKER_END`).
    json!({
        MARKER_KEY: MARKER_BEGIN,
        "_raum_event": event,
        "matcher": ".*",
        "hooks": [
            {
                "type": "command",
                "command": format!("{} {}", script.display(), event),
            }
        ],
    })
}

#[cfg(test)]
#[allow(deprecated)]
mod tests {
    use super::*;
    use crate::config_io::managed_json::is_raum_managed;
    use tempfile::tempdir;

    #[tokio::test]
    async fn creates_settings_json_when_missing() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join(".claude").join("settings.json");
        let adapter = ClaudeCodeAdapter::with_settings_path(settings.clone());
        adapter.install_hooks(dir.path()).await.unwrap();
        assert!(settings.exists());
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        for event in RAUM_HOOK_EVENTS {
            let arr = parsed["hooks"][event].as_array().unwrap();
            assert_eq!(arr.len(), 1);
            assert_eq!(arr[0][MARKER_KEY].as_str().unwrap(), MARKER_BEGIN);
        }
    }

    #[tokio::test]
    async fn preserves_non_raum_content_on_install() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        let original = json!({
            "theme": "dark",
            "editor": { "fontSize": 14 },
            "hooks": {
                "Notification": [
                    { "matcher": "user-defined", "hooks": [{ "type": "command", "command": "echo hi" }] }
                ],
                "PreToolUse": [
                    { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo pre" }] }
                ]
            }
        });
        std::fs::write(&settings, serde_json::to_string_pretty(&original).unwrap()).unwrap();

        let adapter = ClaudeCodeAdapter::with_settings_path(settings.clone());
        adapter.install_hooks(dir.path()).await.unwrap();

        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        // User content preserved.
        assert_eq!(parsed["theme"].as_str().unwrap(), "dark");
        assert_eq!(parsed["editor"]["fontSize"].as_i64().unwrap(), 14);
        assert_eq!(parsed["hooks"]["PreToolUse"].as_array().unwrap().len(), 1);
        // Notification array has user entry + raum entry.
        let notif = parsed["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 2);
        assert!(
            notif
                .iter()
                .any(|v| v["matcher"].as_str() == Some("user-defined"))
        );
        assert!(
            notif
                .iter()
                .any(|v| v[MARKER_KEY].as_str() == Some(MARKER_BEGIN))
        );
    }

    #[tokio::test]
    async fn replaces_stale_raum_block_on_reinstall() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        let adapter = ClaudeCodeAdapter::with_settings_path(settings.clone());

        adapter.install_hooks(dir.path()).await.unwrap();
        let first = std::fs::read_to_string(&settings).unwrap();
        adapter.install_hooks(dir.path()).await.unwrap();
        let second = std::fs::read_to_string(&settings).unwrap();

        // Same content — idempotent.
        assert_eq!(first, second);

        // Hooks arrays still have exactly one raum entry per event.
        let parsed: Value = serde_json::from_str(&second).unwrap();
        for event in RAUM_HOOK_EVENTS {
            let arr = parsed["hooks"][event].as_array().unwrap();
            let raum: Vec<_> = arr.iter().filter(|v| is_raum_managed(v)).collect();
            assert_eq!(raum.len(), 1, "expected 1 raum entry in {event}");
        }
    }

    #[tokio::test]
    async fn reinstall_after_manual_stale_entry_replaces_it() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        // Pre-seed a stale raum-managed entry manually — note the sentinel key
        // value of `MARKER_BEGIN` is what identifies it as ours.
        let stale = json!({
            "hooks": {
                "Notification": [
                    { MARKER_KEY: MARKER_BEGIN, "matcher": ".*", "hooks": [{"type":"command","command":"/old/path.sh"}] }
                ],
                "Stop": [],
                "UserPromptSubmit": []
            },
            "theme": "dark"
        });
        std::fs::write(&settings, serde_json::to_string_pretty(&stale).unwrap()).unwrap();

        let adapter = ClaudeCodeAdapter::with_settings_path(settings.clone());
        adapter.install_hooks(dir.path()).await.unwrap();

        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(parsed["theme"].as_str().unwrap(), "dark");
        let notif = parsed["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 1);
        let cmd = notif[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.ends_with("claude-code.sh Notification"), "got: {cmd}");
        assert!(!cmd.contains("/old/path.sh"));
    }

    #[tokio::test]
    async fn rejects_non_object_root() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        std::fs::write(&settings, "42").unwrap();
        let adapter = ClaudeCodeAdapter::with_settings_path(settings.clone());
        // Non-object root → we coerce to {} (documented behavior); the prior
        // bytes are lost. This is acceptable because Claude settings are always
        // an object in practice; the goal is to not *silently* corrupt a valid
        // file.
        adapter.install_hooks(dir.path()).await.unwrap();
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert!(parsed.is_object());
    }

    #[tokio::test]
    async fn unparsable_json_is_not_overwritten() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        std::fs::write(&settings, "{this is not json").unwrap();
        let adapter = ClaudeCodeAdapter::with_settings_path(settings.clone());
        let err = adapter.install_hooks(dir.path()).await.unwrap_err();
        assert!(matches!(err, AgentError::HookInstall(_)));
        // Original bytes are preserved.
        assert_eq!(
            std::fs::read_to_string(&settings).unwrap(),
            "{this is not json"
        );
    }

    #[tokio::test]
    async fn plan_emits_write_json_action_for_all_five_events() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join(".claude").join("settings.json");
        let adapter = ClaudeCodeAdapter::with_settings_path(settings.clone());
        let ctx = SetupContext::new(
            dir.path().to_path_buf(),
            dir.path().join("events.sock"),
            "demo",
        );
        let plan = <ClaudeCodeAdapter as NotificationSetup>::plan(&adapter, &ctx)
            .await
            .unwrap();
        assert!(plan.len() >= 2);
        let has_json = plan
            .actions
            .iter()
            .any(|a| matches!(a, SetupAction::WriteJson { .. }));
        assert!(has_json, "plan must include WriteJson for settings.json");
        let has_assert = plan
            .actions
            .iter()
            .any(|a| matches!(a, SetupAction::AssertBinary { name } if name == "claude"));
        assert!(has_assert, "plan must AssertBinary `claude`");
    }

    #[tokio::test]
    async fn settings_path_for_ctx_resolves_under_project_dir() {
        let adapter = ClaudeCodeAdapter::new();
        let dir = tempdir().unwrap();
        let ctx = SetupContext::new(
            dir.path().join("hooks"),
            dir.path().join("events.sock"),
            "demo",
        )
        .with_project_dir(dir.path().to_path_buf());
        let resolved = adapter.settings_path_for_ctx(&ctx);
        assert_eq!(
            resolved,
            dir.path().join(".claude").join("settings.local.json")
        );
    }

    #[tokio::test]
    async fn settings_path_for_ctx_falls_back_without_project_dir() {
        // Empty project_dir → use legacy global path so plan-only tests
        // (no explicit project) still work.
        let adapter = ClaudeCodeAdapter::new();
        let dir = tempdir().unwrap();
        let ctx = SetupContext::new(
            dir.path().join("hooks"),
            dir.path().join("events.sock"),
            "demo",
        );
        let resolved = adapter.settings_path_for_ctx(&ctx);
        assert!(
            resolved.ends_with(".claude/settings.json"),
            "unexpected: {}",
            resolved.display()
        );
    }

    #[tokio::test]
    async fn plan_emits_migration_action_when_legacy_entry_present() {
        // Simulate a pre-Phase-6 install that wrote raum-managed
        // entries into `~/.claude/settings.json`. When the new plan
        // runs with a real project_dir, a `RemoveManagedJsonEntries`
        // must be emitted for the legacy path.
        let tmp = tempdir().unwrap();
        let fake_home = tmp.path().to_path_buf();
        let project_dir = tmp.path().join("project-42");
        let legacy = fake_home.join(".claude").join("settings.json");
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        let stale = json!({
            "hooks": {
                "Notification": [
                    { MARKER_KEY: MARKER_BEGIN, "matcher": ".*", "hooks": [] }
                ]
            }
        });
        std::fs::write(&legacy, serde_json::to_string_pretty(&stale).unwrap()).unwrap();

        let adapter = ClaudeCodeAdapter::new();
        let ctx = SetupContext::new(
            tmp.path().join("hooks"),
            tmp.path().join("events.sock"),
            "demo",
        )
        .with_project_dir(project_dir.clone())
        .with_home_dir(fake_home.clone());
        let plan = <ClaudeCodeAdapter as NotificationSetup>::plan(&adapter, &ctx)
            .await
            .unwrap();
        let has_migration = plan.actions.iter().any(
            |a| matches!(a, SetupAction::RemoveManagedJsonEntries { path } if path == &legacy),
        );
        assert!(has_migration, "expected legacy migration action: {plan:?}");
        // Project-local write target must be under project_dir AND use
        // `settings.local.json` (the personal, auto-gitignored layer).
        let has_project_write = plan.actions.iter().any(|a| matches!(
            a,
            SetupAction::WriteJson { path, .. } if path == &project_dir.join(".claude").join("settings.local.json")
        ));
        assert!(
            has_project_write,
            "expected project-local WriteJson: {plan:?}"
        );
    }

    #[tokio::test]
    async fn plan_sweeps_legacy_project_settings_json() {
        // Earlier raum versions wrote managed entries into the repo's
        // shared `.claude/settings.json`. When the new plan runs, a
        // `RemoveManagedJsonEntries` for that path must be emitted so
        // upgrading cleans up the repo without user intervention.
        let tmp = tempdir().unwrap();
        let project_dir = tmp.path().join("project-7");
        let legacy_project = project_dir.join(".claude").join("settings.json");
        std::fs::create_dir_all(legacy_project.parent().unwrap()).unwrap();
        let stale = json!({
            "hooks": {
                "Notification": [
                    { MARKER_KEY: MARKER_BEGIN, "matcher": ".*", "hooks": [] }
                ]
            }
        });
        std::fs::write(
            &legacy_project,
            serde_json::to_string_pretty(&stale).unwrap(),
        )
        .unwrap();

        let adapter = ClaudeCodeAdapter::new();
        let ctx = SetupContext::new(
            tmp.path().join("hooks"),
            tmp.path().join("events.sock"),
            "demo",
        )
        .with_project_dir(project_dir.clone())
        .with_home_dir(tmp.path().to_path_buf());
        let plan = <ClaudeCodeAdapter as NotificationSetup>::plan(&adapter, &ctx)
            .await
            .unwrap();
        let has_project_migration = plan.actions.iter().any(|a| {
            matches!(
                a,
                SetupAction::RemoveManagedJsonEntries { path } if path == &legacy_project
            )
        });
        assert!(
            has_project_migration,
            "expected sweep of project settings.json: {plan:?}"
        );

        // Applying the plan must strip the stale entry from settings.json.
        let report = crate::harness::SetupExecutor::new().apply(&plan);
        assert!(report.ok, "plan apply failed: {report:?}");
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&legacy_project).unwrap()).unwrap();
        let notif = parsed["hooks"]["Notification"].as_array().unwrap();
        assert!(
            notif.iter().all(|v| !is_raum_managed(v)),
            "settings.json should no longer contain raum entries"
        );
        // …and the new settings.local.json should carry the fresh entries.
        let local = project_dir.join(".claude").join("settings.local.json");
        assert!(local.exists(), "expected {local:?} to be written");
        let parsed_local: Value =
            serde_json::from_str(&std::fs::read_to_string(&local).unwrap()).unwrap();
        for event in RAUM_HOOK_EVENTS {
            let arr = parsed_local["hooks"][event].as_array().unwrap();
            assert_eq!(arr.len(), 1);
            assert!(is_raum_managed(&arr[0]));
        }
    }

    #[tokio::test]
    async fn scan_flags_missing_settings_as_not_installed() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("project");
        let adapter = ClaudeCodeAdapter::new();
        let ctx = SetupContext::new(
            dir.path().join("hooks"),
            dir.path().join("events.sock"),
            "demo",
        )
        .with_project_dir(project.clone());
        let report = adapter.scan(&ctx);
        assert_eq!(report.harness, AgentKind::ClaudeCode);
        assert_eq!(report.config_paths.len(), 1);
        let entry = &report.config_paths[0];
        assert_eq!(
            entry.path,
            project.join(".claude").join("settings.local.json")
        );
        assert!(!entry.exists);
        assert!(!entry.raum_managed);
        assert!(!report.raum_hooks_installed);
        assert!(report.reason_if_not_installed.is_some());
    }

    #[tokio::test]
    async fn scan_reports_raum_managed_when_plan_applied() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("project");
        let adapter = ClaudeCodeAdapter::new();
        let ctx = SetupContext::new(
            dir.path().join("hooks"),
            dir.path().join("events.sock"),
            "demo",
        )
        .with_project_dir(project.clone());
        let plan = <ClaudeCodeAdapter as NotificationSetup>::plan(&adapter, &ctx)
            .await
            .unwrap();
        let report = crate::harness::SetupExecutor::new().apply(&plan);
        assert!(report.ok);
        let scan = adapter.scan(&ctx);
        // Even if the binary is missing (CI sandbox), the files
        // should be raum-managed now.
        let entry = &scan.config_paths[0];
        assert!(entry.exists);
        assert!(entry.raum_managed);
    }

    #[tokio::test]
    async fn plan_json_contains_all_five_hook_events() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join(".claude").join("settings.json");
        let adapter = ClaudeCodeAdapter::with_settings_path(settings.clone());
        let ctx = SetupContext::new(
            dir.path().to_path_buf(),
            dir.path().join("events.sock"),
            "demo",
        );
        let plan = <ClaudeCodeAdapter as NotificationSetup>::plan(&adapter, &ctx)
            .await
            .unwrap();
        let content = plan
            .actions
            .iter()
            .find_map(|a| match a {
                SetupAction::WriteJson { content, .. } => Some(content.clone()),
                _ => None,
            })
            .expect("WriteJson present");
        let parsed: Value = serde_json::from_str(&content).unwrap();
        for event in RAUM_HOOK_EVENTS {
            let arr = parsed["hooks"][event]
                .as_array()
                .unwrap_or_else(|| panic!("plan JSON missing hooks.{event}"));
            assert_eq!(arr.len(), 1, "exactly one raum entry under {event}");
        }
    }
}
