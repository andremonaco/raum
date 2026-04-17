//! OpenCode adapter.
//!
//! Analogous to the Claude Code adapter, but writes to
//! `$XDG_CONFIG_HOME/opencode/config.json` (or `~/.config/opencode/config.json`).
//! Phase 4 will replace the settings-file write with an SSE subscription on
//! OpenCode's local HTTP server; Phase 2 keeps the existing install so
//! observation keeps working end-to-end.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json::json;
use tracing::info;

#[allow(deprecated)]
use crate::agent::AgentAdapter;
use crate::agent::{AgentError, AgentKind, SessionId, SpawnOptions, VersionReport, semver_lite};
use crate::config_io::managed_json::{
    self, MARKER_BEGIN, MARKER_KEY, ManagedJsonError, ManagedJsonHooks,
};
use crate::harness::channel::NotificationChannel;
use crate::harness::reply::PermissionReplier;
use crate::harness::setup::{SelftestReport, SetupContext, SetupError, SetupPlan};
use crate::harness::traits::{
    HarnessIdentity, HarnessRuntime, LaunchOverrides, NotificationSetup, SessionSpec,
};

use super::hook_script_path;

#[derive(Debug, Clone, Default)]
pub struct OpenCodeAdapter {
    settings_path_override: Option<PathBuf>,
}

impl OpenCodeAdapter {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

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
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        let xdg = PathBuf::from(xdg);
        if !xdg.as_os_str().is_empty() {
            return xdg.join("opencode").join("config.json");
        }
    }
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    home.join(".config").join("opencode").join("config.json")
}

#[async_trait]
#[allow(deprecated)]
impl AgentAdapter for OpenCodeAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::OpenCode
    }

    fn binary_path(&self) -> &'static str {
        "opencode"
    }

    async fn spawn(&self, _opts: SpawnOptions) -> Result<SessionId, AgentError> {
        which::which(self.binary_path()).map_err(|_| AgentError::BinaryMissing {
            binary: self.binary_path().to_string(),
        })?;
        Err(AgentError::Spawn(
            "spawn is owned by the tmux layer; OpenCodeAdapter only validates preconditions".into(),
        ))
    }

    async fn install_hooks(&self, hooks_dir: &Path) -> Result<(), AgentError> {
        let script = hook_script_path(hooks_dir, "opencode");
        let path = self.settings_path();
        install_opencode_hooks(&path, &script)
            .map_err(|e| AgentError::HookInstall(e.to_string()))?;
        info!(?path, "opencode hooks installed");
        Ok(())
    }

    fn supports_native_events(&self) -> bool {
        true
    }

    async fn detect_version(&self) -> Result<VersionReport, AgentError> {
        super::claude_code::run_version(
            <Self as AgentAdapter>::binary_path(self),
            &<Self as AgentAdapter>::minimum_version(self),
        )
        .await
    }

    fn minimum_version(&self) -> semver_lite::Version {
        semver_lite::Version {
            major: 0,
            minor: 1,
            patch: 0,
        }
    }
}

// ---- New trait split (Phase 2) ---------------------------------------------

#[async_trait]
impl HarnessIdentity for OpenCodeAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::OpenCode
    }
    fn binary(&self) -> &'static str {
        "opencode"
    }
    fn minimum_version(&self) -> semver_lite::Version {
        semver_lite::Version {
            major: 0,
            minor: 1,
            patch: 0,
        }
    }
    async fn detect_version(&self) -> Result<VersionReport, AgentError> {
        super::claude_code::run_version(
            <Self as HarnessIdentity>::binary(self),
            &<Self as HarnessIdentity>::minimum_version(self),
        )
        .await
    }
}

#[async_trait]
impl NotificationSetup for OpenCodeAdapter {
    /// Phase 2 placeholder — returns an empty plan. Phase 4 will switch
    /// to the SSE channel; the settings-file injection stays alive via
    /// the legacy `install_hooks` path until then.
    async fn plan(&self, _ctx: &SetupContext) -> Result<SetupPlan, SetupError> {
        Ok(SetupPlan::new(AgentKind::OpenCode))
    }

    async fn selftest(&self, _ctx: &SetupContext) -> SelftestReport {
        SelftestReport::ok(
            AgentKind::OpenCode,
            "selftest not implemented until Phase 4 (OpenCode SSE)",
            0,
        )
    }
}

impl HarnessRuntime for OpenCodeAdapter {
    fn channels(&self, _session: &SessionSpec) -> Vec<Box<dyn NotificationChannel>> {
        Vec::new()
    }

    fn replier(&self, _session: &SessionSpec) -> Option<Box<dyn PermissionReplier>> {
        None
    }

    fn launch_overrides(&self) -> LaunchOverrides {
        LaunchOverrides::default()
    }
}

/// Install raum hooks into an OpenCode `config.json` at `path`. Mirrors the
/// Claude Code install path (see that module for the marker-discipline rationale).
pub fn install_opencode_hooks(path: &Path, script: &Path) -> std::io::Result<()> {
    managed_json::apply_managed_hooks(&ManagedJsonHooks {
        path,
        events: &["Notification", "Stop", "UserPromptSubmit"],
        make_entry: &|event| {
            json!({
                MARKER_KEY: MARKER_BEGIN,
                "_raum_event": event,
                "matcher": ".*",
                "hooks": [
                    { "type": "command", "command": format!("{} {}", script.display(), event) }
                ],
            })
        },
    })
    .map_err(managed_json_error_to_io)
}

fn managed_json_error_to_io(e: ManagedJsonError) -> std::io::Error {
    match e {
        ManagedJsonError::Io(err) => err,
        ManagedJsonError::InvalidJson(err) => std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("config.json is not valid JSON: {err}"),
        ),
        ManagedJsonError::Serialize(err) => std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("serialize config.json failed: {err}"),
        ),
    }
}

#[cfg(test)]
#[allow(deprecated)]
mod tests {
    use super::*;
    use serde_json::Value;
    use tempfile::tempdir;

    #[tokio::test]
    async fn creates_missing_config_and_writes_three_events() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join("opencode").join("config.json");
        let adapter = OpenCodeAdapter::with_settings_path(settings.clone());
        adapter.install_hooks(dir.path()).await.unwrap();
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        for event in ["Notification", "Stop", "UserPromptSubmit"] {
            let arr = parsed["hooks"][event].as_array().unwrap();
            assert_eq!(arr.len(), 1);
            assert_eq!(arr[0][MARKER_KEY].as_str().unwrap(), MARKER_BEGIN);
        }
    }

    #[tokio::test]
    async fn preserves_unrelated_config_and_non_raum_hook_entries() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join("config.json");
        let original = json!({
            "provider": { "openai": { "model": "gpt-4" } },
            "hooks": {
                "Notification": [{ "matcher": "user-x", "hooks": [] }]
            }
        });
        std::fs::write(&settings, serde_json::to_string_pretty(&original).unwrap()).unwrap();
        let adapter = OpenCodeAdapter::with_settings_path(settings.clone());
        adapter.install_hooks(dir.path()).await.unwrap();
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(
            parsed["provider"]["openai"]["model"].as_str().unwrap(),
            "gpt-4"
        );
        let notif = parsed["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 2);
        assert!(
            notif
                .iter()
                .any(|v| v["matcher"].as_str() == Some("user-x"))
        );
    }

    #[tokio::test]
    async fn reinstall_is_idempotent() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join("config.json");
        let adapter = OpenCodeAdapter::with_settings_path(settings.clone());
        adapter.install_hooks(dir.path()).await.unwrap();
        let first = std::fs::read_to_string(&settings).unwrap();
        adapter.install_hooks(dir.path()).await.unwrap();
        let second = std::fs::read_to_string(&settings).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn default_settings_path_ends_with_opencode_config_json() {
        let p = default_settings_path();
        assert!(
            p.ends_with("opencode/config.json"),
            "unexpected path: {}",
            p.display()
        );
    }
}
