//! Claude Code adapter (§7.3).
//!
//! Installs the raum hook script into `~/.claude/settings.json` under the
//! `hooks.Notification`, `hooks.Stop`, and `hooks.UserPromptSubmit` keys.
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

use async_trait::async_trait;
use serde_json::{Value, json};
use tracing::{info, warn};

use crate::agent::{
    AgentAdapter, AgentError, AgentKind, SessionId, SpawnOptions, VersionReport, semver_lite,
};

use super::{MARKER_BEGIN, MARKER_END, MARKER_KEY, hook_script_path};

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
        run_version(self.binary_path(), &self.minimum_version()).await
    }

    fn minimum_version(&self) -> semver_lite::Version {
        semver_lite::Version {
            major: 0,
            minor: 2,
            patch: 0,
        }
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
                    warn!(?path, error=%e, "claude settings.json unparsable; preserving original bytes and refusing to edit");
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("settings.json is not valid JSON: {e}"),
                    ));
                }
            }
        }
    } else {
        json!({})
    };

    let mut root = existing;
    ensure_object(&mut root);

    // `hooks` subtree — create if missing, preserve otherwise.
    let hooks = root
        .as_object_mut()
        .expect("root is object after ensure_object")
        .entry("hooks")
        .or_insert_with(|| json!({}));
    ensure_object(hooks);

    for event in ["Notification", "Stop", "UserPromptSubmit"] {
        let arr = hooks
            .as_object_mut()
            .expect("hooks is object")
            .entry(event)
            .or_insert_with(|| json!([]));
        ensure_array(arr);
        let arr_mut = arr.as_array_mut().expect("hooks.* is array");
        // Remove any raum-managed entries.
        arr_mut.retain(|v| !is_raum_managed(v));
        // Append our managed entry.
        arr_mut.push(raum_hook_entry(event, script));
    }

    let serialized = serde_json::to_string_pretty(&root).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("serialize settings.json failed: {e}"),
        )
    })?;
    atomic_write(path, serialized.as_bytes())?;
    Ok(())
}

fn ensure_object(v: &mut Value) {
    if !v.is_object() {
        *v = json!({});
    }
}

fn ensure_array(v: &mut Value) {
    if !v.is_array() {
        *v = json!([]);
    }
}

fn is_raum_managed(v: &Value) -> bool {
    v.as_object()
        .and_then(|o| o.get(MARKER_KEY))
        .and_then(|m| m.as_str())
        .is_some_and(|s| s == MARKER_BEGIN || s == MARKER_END)
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

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(
        ".raum-tmp-{}",
        path.file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("settings.json")
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
    async fn creates_settings_json_when_missing() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join(".claude").join("settings.json");
        let adapter = ClaudeCodeAdapter::with_settings_path(settings.clone());
        adapter.install_hooks(dir.path()).await.unwrap();
        assert!(settings.exists());
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        for event in ["Notification", "Stop", "UserPromptSubmit"] {
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
        for event in ["Notification", "Stop", "UserPromptSubmit"] {
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
}
