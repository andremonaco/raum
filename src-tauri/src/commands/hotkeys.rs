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
