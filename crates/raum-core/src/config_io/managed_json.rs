//! Shared `<raum-managed>` JSON helper (Phase 1 extraction).
//!
//! Both the Claude Code (`~/.claude/settings.json`) and OpenCode
//! (`$XDG_CONFIG_HOME/opencode/config.json`) adapters maintain a block
//! of raum-owned entries inside the harness's own settings file. The
//! rules are shared between them:
//!
//! * The settings file is JSON with an object at the root; the helper
//!   refuses to rewrite the file if parsing fails (so a user's hand-
//!   edited-but-broken JSON is left on disk for them to inspect).
//! * A top-level `hooks` subtree holds per-event arrays (`Notification`,
//!   `Stop`, `UserPromptSubmit`, …). Each array entry is either a
//!   raum-managed entry (tagged with `_raum_managed_marker:
//!   "<raum-managed>"`) or a user entry we must preserve byte-for-byte.
//! * On re-installation we drop every raum-managed entry and append a
//!   single fresh entry per configured event — idempotent across runs
//!   and safe to re-invoke.
//! * Files are written through a `.raum-tmp-*` temp path and renamed so
//!   we never truncate a readable settings file in place.
//!
//! This module owns the shared logic; the adapters supply the list of
//! events and the per-entry value to splice in.

use std::path::Path;

use serde_json::{Value, json};
use thiserror::Error;
use tracing::warn;

/// Marker key embedded on every raum-managed array entry. See the
/// Claude Code adapter's module doc for the rationale (JSON has no
/// comment syntax, so the literal `<raum-managed>` / `</raum-managed>`
/// tokens live inside the sentinel's value).
pub const MARKER_KEY: &str = "_raum_managed_marker";
pub const MARKER_BEGIN: &str = "<raum-managed>";
pub const MARKER_END: &str = "</raum-managed>";

/// Errors returned by [`apply_managed_hooks`].
#[derive(Debug, Error)]
pub enum ManagedJsonError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("settings file is not valid JSON: {0}")]
    InvalidJson(serde_json::Error),
    #[error("serialize settings file failed: {0}")]
    Serialize(serde_json::Error),
}

/// Adapter-supplied configuration for [`apply_managed_hooks`]. Kept as
/// a simple builder-free struct so each adapter call-site reads
/// linearly.
#[allow(missing_debug_implementations)]
pub struct ManagedJsonHooks<'a> {
    /// Absolute path to the settings file. Parent directories are
    /// created on demand; the file itself is created if missing.
    pub path: &'a Path,
    /// Event names to splice entries under (e.g. `["Notification",
    /// "Stop", "UserPromptSubmit"]`).
    pub events: &'a [&'a str],
    /// Builder for a single raum-managed array entry. Called once per
    /// event name. The returned value is appended verbatim; the helper
    /// injects the [`MARKER_KEY`] into the top-level object if the
    /// builder forgot to set it.
    pub make_entry: &'a dyn Fn(&str) -> Value,
}

/// Apply raum-managed entries to the `hooks.<event>` arrays in the
/// JSON settings file at `spec.path`.
///
/// Returns `Ok(())` on success. Leaves the on-disk file untouched when
/// it exists but is not parseable (so the caller can surface the error
/// without scribbling over the user's content).
pub fn apply_managed_hooks(spec: &ManagedJsonHooks<'_>) -> Result<(), ManagedJsonError> {
    if let Some(parent) = spec.path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let existing = load_json_or_empty_object(spec.path)?;
    let mut root = existing;
    ensure_object(&mut root);

    {
        let hooks = root
            .as_object_mut()
            .expect("root is object after ensure_object")
            .entry("hooks")
            .or_insert_with(|| json!({}));
        ensure_object(hooks);
        let hooks_obj = hooks.as_object_mut().expect("hooks is object");

        for event in spec.events {
            let arr_entry = hooks_obj
                .entry((*event).to_string())
                .or_insert_with(|| json!([]));
            ensure_array(arr_entry);
            let arr = arr_entry.as_array_mut().expect("hooks.* is array");
            arr.retain(|v| !is_raum_managed(v));
            let mut entry = (spec.make_entry)(event);
            ensure_marker(&mut entry);
            arr.push(entry);
        }
    }

    let serialized = serde_json::to_string_pretty(&root).map_err(ManagedJsonError::Serialize)?;
    atomic_write(spec.path, serialized.as_bytes())?;
    Ok(())
}

/// Load the JSON from `path`, returning `{}` when the file is missing
/// or empty. Returns [`ManagedJsonError::InvalidJson`] when the file
/// exists but does not parse — the caller is expected to propagate
/// this and leave the original bytes untouched.
fn load_json_or_empty_object(path: &Path) -> Result<Value, ManagedJsonError> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let raw = std::fs::read_to_string(path)?;
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    match serde_json::from_str::<Value>(&raw) {
        Ok(v) => Ok(v),
        Err(e) => {
            warn!(
                ?path,
                error=%e,
                "settings JSON unparsable; preserving original bytes and refusing to edit",
            );
            Err(ManagedJsonError::InvalidJson(e))
        }
    }
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

fn ensure_marker(v: &mut Value) {
    if let Some(obj) = v.as_object_mut() {
        obj.entry(MARKER_KEY.to_string())
            .or_insert_with(|| Value::String(MARKER_BEGIN.to_string()));
    }
}

/// Returns `true` when `v` carries our `_raum_managed_marker` sentinel
/// set to either [`MARKER_BEGIN`] or [`MARKER_END`].
#[must_use]
pub fn is_raum_managed(v: &Value) -> bool {
    v.as_object()
        .and_then(|o| o.get(MARKER_KEY))
        .and_then(Value::as_str)
        .is_some_and(|s| s == MARKER_BEGIN || s == MARKER_END)
}

/// Write `bytes` to `path` through a sibling `.raum-tmp-*` file that is
/// renamed on top of the destination. Parent directories are created
/// on demand.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("settings.json");
    let tmp = parent.join(format!(".raum-tmp-{file_name}"));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn dummy_entry(event: &str) -> Value {
        json!({
            "matcher": ".*",
            "_raum_event": event,
            "hooks": [{ "type": "command", "command": format!("/bin/true {event}") }],
        })
    }

    #[test]
    fn creates_missing_file_with_marker() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        apply_managed_hooks(&ManagedJsonHooks {
            path: &path,
            events: &["Notification", "Stop"],
            make_entry: &dummy_entry,
        })
        .unwrap();

        let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        for event in ["Notification", "Stop"] {
            let arr = parsed["hooks"][event].as_array().unwrap();
            assert_eq!(arr.len(), 1);
            assert_eq!(arr[0][MARKER_KEY].as_str().unwrap(), MARKER_BEGIN);
        }
    }

    #[test]
    fn preserves_non_raum_entries_and_sibling_keys() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let original = json!({
            "theme": "dark",
            "editor": { "fontSize": 14 },
            "hooks": {
                "Notification": [
                    { "matcher": "user", "hooks": [] }
                ],
                "PreToolUse": [
                    { "matcher": "Bash", "hooks": [] }
                ]
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&original).unwrap()).unwrap();

        apply_managed_hooks(&ManagedJsonHooks {
            path: &path,
            events: &["Notification", "Stop"],
            make_entry: &dummy_entry,
        })
        .unwrap();

        let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["theme"].as_str().unwrap(), "dark");
        assert_eq!(parsed["editor"]["fontSize"].as_i64().unwrap(), 14);
        assert_eq!(parsed["hooks"]["PreToolUse"].as_array().unwrap().len(), 1);
        let notif = parsed["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 2);
        assert!(notif.iter().any(|v| v["matcher"].as_str() == Some("user")));
        assert!(notif.iter().any(is_raum_managed));
    }

    #[test]
    fn reinstall_is_idempotent_byte_for_byte() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        apply_managed_hooks(&ManagedJsonHooks {
            path: &path,
            events: &["Notification"],
            make_entry: &dummy_entry,
        })
        .unwrap();
        let first = std::fs::read_to_string(&path).unwrap();
        apply_managed_hooks(&ManagedJsonHooks {
            path: &path,
            events: &["Notification"],
            make_entry: &dummy_entry,
        })
        .unwrap();
        let second = std::fs::read_to_string(&path).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn unparsable_json_is_not_overwritten() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{not json").unwrap();
        let err = apply_managed_hooks(&ManagedJsonHooks {
            path: &path,
            events: &["Notification"],
            make_entry: &dummy_entry,
        })
        .unwrap_err();
        assert!(matches!(err, ManagedJsonError::InvalidJson(_)));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{not json");
    }

    #[test]
    fn non_object_root_is_coerced_to_object() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "42").unwrap();
        apply_managed_hooks(&ManagedJsonHooks {
            path: &path,
            events: &["Notification"],
            make_entry: &dummy_entry,
        })
        .unwrap();
        let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(parsed.is_object());
        assert!(parsed["hooks"]["Notification"].is_array());
    }

    #[test]
    fn stale_raum_entry_is_replaced_not_duplicated() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let stale = json!({
            "hooks": {
                "Notification": [
                    { MARKER_KEY: MARKER_BEGIN, "matcher": ".*", "hooks": [{"type":"command","command":"/old/path.sh"}] }
                ]
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&stale).unwrap()).unwrap();

        apply_managed_hooks(&ManagedJsonHooks {
            path: &path,
            events: &["Notification"],
            make_entry: &dummy_entry,
        })
        .unwrap();

        let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let notif = parsed["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 1);
        let cmd = notif[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.starts_with("/bin/true "), "got: {cmd}");
        assert!(!cmd.contains("/old/path.sh"));
    }

    #[test]
    fn entry_without_marker_gets_one_injected() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        apply_managed_hooks(&ManagedJsonHooks {
            path: &path,
            events: &["Notification"],
            // Deliberately skip MARKER_KEY — the helper should inject it.
            make_entry: &|_| json!({ "matcher": ".*", "hooks": [] }),
        })
        .unwrap();
        let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let entry = &parsed["hooks"]["Notification"].as_array().unwrap()[0];
        assert_eq!(entry[MARKER_KEY].as_str().unwrap(), MARKER_BEGIN);
    }

    #[test]
    fn atomic_write_creates_parent_dirs() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("deep").join("settings.json");
        atomic_write(&path, b"{}").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"{}");
    }
}
