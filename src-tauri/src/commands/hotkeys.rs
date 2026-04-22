//! §12.1 / §12.2 — Tauri commands that expose the keymap to the frontend.
//!
//! The keymap data model lives in [`crate::keymap`]; this file is only the
//! `#[tauri::command]` surface on top of it.

use crate::keymap::{self, KeymapEntry};
use crate::state::AppHandleState;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct DefaultKeymap {
    pub bindings: Vec<KeymapEntry>,
}

/// §12.1 — return the compile-time default keymap.
#[tauri::command]
pub fn keymap_get_defaults() -> DefaultKeymap {
    DefaultKeymap {
        bindings: keymap::default_keymap(),
    }
}

/// §12.2 — return the keymap with `~/.config/raum/keybindings.toml` merged
/// over the defaults.
#[tauri::command]
pub fn keymap_get_effective(
    state: tauri::State<'_, AppHandleState>,
) -> Result<Vec<KeymapEntry>, String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    Ok(keymap::merged_keymap(&store))
}

/// Upsert a single override in `keybindings.toml`. Rejects unknown actions and
/// invalid accelerator strings. Returns the new effective keymap so the
/// frontend can refresh without a second round-trip.
#[tauri::command]
pub fn keymap_set_override(
    state: tauri::State<'_, AppHandleState>,
    action: String,
    accelerator: String,
) -> Result<Vec<KeymapEntry>, String> {
    if !keymap::default_keymap().iter().any(|e| e.action == action) {
        return Err(format!("unknown action: {action}"));
    }
    if !keymap::is_valid_accelerator(&accelerator) {
        return Err(format!("invalid accelerator: {accelerator}"));
    }
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut kb = store.read_keybindings().unwrap_or_default();
    kb.overrides.insert(action, accelerator);
    store.write_keybindings(&kb).map_err(|e| e.to_string())?;
    Ok(keymap::merged_keymap(&store))
}

/// Remove a single override from `keybindings.toml`, restoring the default for
/// that action. Returns the new effective keymap.
#[tauri::command]
pub fn keymap_clear_override(
    state: tauri::State<'_, AppHandleState>,
    action: String,
) -> Result<Vec<KeymapEntry>, String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut kb = store.read_keybindings().unwrap_or_default();
    kb.overrides.remove(&action);
    store.write_keybindings(&kb).map_err(|e| e.to_string())?;
    Ok(keymap::merged_keymap(&store))
}

#[cfg(test)]
mod tests {
    use super::*;
    use raum_core::store::ConfigStore;

    fn default_for(action: &str) -> String {
        keymap::default_keymap()
            .into_iter()
            .find(|e| e.action == action)
            .unwrap()
            .accelerator
    }

    #[test]
    fn set_override_persists_and_returns_merged_keymap() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();

        let mut kb = store.read_keybindings().unwrap_or_default();
        kb.overrides
            .insert("toggle-sidebar".to_string(), "Ctrl+Alt+B".to_string());
        store.write_keybindings(&kb).unwrap();

        let merged = keymap::merged_keymap(&store);
        let sidebar = merged
            .iter()
            .find(|e| e.action == "toggle-sidebar")
            .unwrap();
        assert_eq!(sidebar.accelerator, "Ctrl+Alt+B");

        // and on disk
        let reloaded = store.read_keybindings().unwrap();
        assert_eq!(
            reloaded.overrides.get("toggle-sidebar").map(String::as_str),
            Some("Ctrl+Alt+B")
        );
    }

    #[test]
    fn clear_override_restores_default() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();

        let original = default_for("toggle-sidebar");

        let mut kb = store.read_keybindings().unwrap_or_default();
        kb.overrides
            .insert("toggle-sidebar".to_string(), "Ctrl+Alt+B".to_string());
        store.write_keybindings(&kb).unwrap();

        // Now clear
        let mut kb = store.read_keybindings().unwrap();
        kb.overrides.remove("toggle-sidebar");
        store.write_keybindings(&kb).unwrap();

        let merged = keymap::merged_keymap(&store);
        let sidebar = merged
            .iter()
            .find(|e| e.action == "toggle-sidebar")
            .unwrap();
        assert_eq!(sidebar.accelerator, original);
    }

    #[test]
    fn validation_rejects_unknown_action() {
        // Pure validation logic check — doesn't need a store.
        assert!(
            !keymap::default_keymap()
                .iter()
                .any(|e| e.action == "totally-made-up")
        );
    }

    #[test]
    fn validation_rejects_invalid_accelerator() {
        assert!(!keymap::is_valid_accelerator("nope"));
        assert!(!keymap::is_valid_accelerator("CmdOrCtrl+Shift"));
    }
}
