//! Claude Code adapter.
//!
//! Installs the raum hook script into `~/.claude/settings.json`. Phase 2
//! expanded coverage from `{Notification, Stop, UserPromptSubmit}` to the
//! full set `{PermissionRequest, Notification, Stop, UserPromptSubmit,
//! StopFailure}`. The `PermissionRequest` hook is the only synchronous
//! one — see [`crate::harness::reply`] for the decision wire format.
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
use crate::harness::setup::{SelftestReport, SetupAction, SetupContext, SetupError, SetupPlan};
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

    #[must_use]
    pub fn settings_path(&self) -> PathBuf {
        if let Some(p) = &self.settings_path_override {
            return p.clone();
        }
        default_settings_path()
    }
}

fn default_settings_path() -> PathBuf {
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    home.join(".claude").join("settings.json")
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
    /// Build the plan that installs raum hooks into `~/.claude/settings.json`.
    ///
    /// Every hook entry is tagged with
    /// `_raum_managed_marker: "<raum-managed>"`; re-running the plan
    /// replaces the raum entries without touching user-authored ones.
    async fn plan(&self, ctx: &SetupContext) -> Result<SetupPlan, SetupError> {
        let script = hook_script_path(&ctx.hooks_dir, "claude-code");
        let settings_path = self.settings_path();

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
