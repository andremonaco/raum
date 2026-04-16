//! OpenCode adapter (§7.4).
//!
//! Analogous to the Claude Code adapter, but writes to
//! `$XDG_CONFIG_HOME/opencode/config.json` (or `~/.config/opencode/config.json`).

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json::{Value, json};
use tracing::{info, warn};

use crate::agent::{
    AgentAdapter, AgentError, AgentKind, SessionId, SpawnOptions, VersionReport, semver_lite,
};

use super::{MARKER_BEGIN, MARKER_END, MARKER_KEY, hook_script_path};

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
        super::claude_code::run_version(self.binary_path(), &self.minimum_version()).await
    }

    fn minimum_version(&self) -> semver_lite::Version {
        semver_lite::Version {
            major: 0,
            minor: 1,
            patch: 0,
        }
    }
}

/// Install raum hooks into an OpenCode `config.json` at `path`. Mirrors the
/// Claude Code install path (see that module for the marker-discipline rationale).
pub fn install_opencode_hooks(path: &Path, script: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let existing: Value = if path.exists() {
        let raw = std::fs::read_to_string(path)?;
        if raw.trim().is_empty() {
            json!({})
        } else {
            match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(e) => {
                    warn!(?path, error=%e, "opencode config.json unparsable; leaving file untouched");
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("config.json is not valid JSON: {e}"),
                    ));
                }
            }
        }
    } else {
        json!({})
    };

    let mut root = existing;
    if !root.is_object() {
        root = json!({});
    }

    let hooks = root
        .as_object_mut()
        .expect("root is object")
        .entry("hooks")
        .or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }

    for event in ["Notification", "Stop", "UserPromptSubmit"] {
        let arr = hooks
            .as_object_mut()
            .expect("hooks is object")
            .entry(event)
            .or_insert_with(|| json!([]));
        if !arr.is_array() {
            *arr = json!([]);
        }
        let arr_mut = arr.as_array_mut().expect("hooks.* is array");
        arr_mut.retain(|v| !is_raum_managed(v));
        // `_raum_managed_marker: "<raum-managed>"` identifies entries we own;
        // see the Claude Code adapter module doc for the rationale.
        arr_mut.push(json!({
            MARKER_KEY: MARKER_BEGIN,
            "_raum_event": event,
            "matcher": ".*",
            "hooks": [
                { "type": "command", "command": format!("{} {}", script.display(), event) }
            ],
        }));
    }

    let serialized = serde_json::to_string_pretty(&root).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("serialize config.json failed: {e}"),
        )
    })?;
    atomic_write(path, serialized.as_bytes())?;
    Ok(())
}

fn is_raum_managed(v: &Value) -> bool {
    v.as_object()
        .and_then(|o| o.get(MARKER_KEY))
        .and_then(|m| m.as_str())
        .is_some_and(|s| s == MARKER_BEGIN || s == MARKER_END)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(
        ".raum-tmp-{}",
        path.file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("config.json")
    ));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
