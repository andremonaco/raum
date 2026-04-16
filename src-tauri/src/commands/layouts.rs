//! Layout preset commands (§10.2). Owned by Wave 3D.
//!
//! Exposes CRUD over `~/.config/raum/layouts.toml` for the preset library:
//!
//! * `layouts_list()` — return every preset (empty list if the file doesn't exist).
//! * `layouts_save(preset)` — insert or update a preset, keyed by name. Names
//!   are unique; duplicate inserts via a dedicated "create" path would error,
//!   but the save command intentionally upserts so the UI's rename/save flow
//!   is idempotent. The uniqueness check that matters is that two *different*
//!   presets cannot share a name — which is trivially satisfied by keying on
//!   `name`.
//! * `layouts_delete(name)` — remove a preset and clear any worktree-preset
//!   pointers that reference it (§10.5).
//!
//! TOML writes go through `ConfigStore::write_layouts` which in turn uses
//! `atomic_write` (temp + rename). Frontend debounces writes at 500 ms (§10.9)
//! before invoking these commands, so there's no DebouncedWriter on this side.

use raum_core::config::LayoutPreset;

use crate::state::AppHandleState;

/// §10.2 — list every preset from `layouts.toml`.
#[tauri::command]
pub fn layouts_list(state: tauri::State<'_, AppHandleState>) -> Result<Vec<LayoutPreset>, String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let lib = store
        .read_layouts()
        .map_err(|e| format!("read layouts: {e}"))?;
    Ok(lib.presets)
}

/// §10.2 — insert or update a preset by name. Two presets with the same name
/// collapse into one (last write wins). Returns the full updated list so the
/// caller can swap state atomically.
#[tauri::command]
pub fn layouts_save(
    state: tauri::State<'_, AppHandleState>,
    preset: LayoutPreset,
) -> Result<Vec<LayoutPreset>, String> {
    if preset.name.trim().is_empty() {
        return Err("preset name must be non-empty".into());
    }
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut lib = store
        .read_layouts()
        .map_err(|e| format!("read layouts: {e}"))?;
    if let Some(slot) = lib.presets.iter_mut().find(|p| p.name == preset.name) {
        *slot = preset;
    } else {
        lib.presets.push(preset);
    }
    store
        .write_layouts(&lib)
        .map_err(|e| format!("write layouts: {e}"))?;
    Ok(lib.presets)
}

/// §10.2 + §10.5 — delete a preset and clear any worktree pointers that
/// reference it, so a dangling pointer never survives the preset it names.
#[tauri::command]
pub fn layouts_delete(
    state: tauri::State<'_, AppHandleState>,
    name: String,
) -> Result<Vec<LayoutPreset>, String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    let mut lib = store
        .read_layouts()
        .map_err(|e| format!("read layouts: {e}"))?;
    let before = lib.presets.len();
    lib.presets.retain(|p| p.name != name);
    if lib.presets.len() == before {
        return Err(format!("preset not found: {name}"));
    }
    store
        .write_layouts(&lib)
        .map_err(|e| format!("write layouts: {e}"))?;

    // §10.5: clear pointers that referenced the deleted preset.
    let mut pointers = store
        .read_worktree_presets()
        .map_err(|e| format!("read pointers: {e}"))?;
    let had = pointers.map.len();
    pointers.map.retain(|_, v| *v != name);
    if pointers.map.len() != had {
        store
            .write_worktree_presets(&pointers)
            .map_err(|e| format!("write pointers: {e}"))?;
    }

    Ok(lib.presets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use raum_core::AgentKind;
    use raum_core::config::{LayoutCell, WorktreePresetPointer};
    use raum_core::store::ConfigStore;
    use std::collections::BTreeMap;
    use tempfile::tempdir;

    fn preset(name: &str) -> LayoutPreset {
        LayoutPreset {
            name: name.into(),
            cells: vec![LayoutCell {
                x: 0,
                y: 0,
                w: 6,
                h: 6,
                kind: AgentKind::Shell,
                title: None,
            }],
            created_at: Some(1),
        }
    }

    #[test]
    fn save_then_list_roundtrips() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        let mut lib = store.read_layouts().unwrap();
        lib.presets.push(preset("two-agents"));
        store.write_layouts(&lib).unwrap();
        let back = store.read_layouts().unwrap();
        assert_eq!(back.presets.len(), 1);
        assert_eq!(back.presets[0].name, "two-agents");
    }

    #[test]
    fn upsert_by_name_does_not_duplicate() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        let mut lib = store.read_layouts().unwrap();
        // Seed two distinct presets.
        lib.presets.push(preset("alpha"));
        lib.presets.push(preset("beta"));
        store.write_layouts(&lib).unwrap();

        // Upsert alpha in place.
        let mut updated = preset("alpha");
        updated.created_at = Some(42);
        let mut lib = store.read_layouts().unwrap();
        if let Some(slot) = lib.presets.iter_mut().find(|p| p.name == updated.name) {
            *slot = updated;
        } else {
            lib.presets.push(updated);
        }
        store.write_layouts(&lib).unwrap();

        let back = store.read_layouts().unwrap();
        assert_eq!(back.presets.len(), 2);
        let alpha = back.presets.iter().find(|p| p.name == "alpha").unwrap();
        assert_eq!(alpha.created_at, Some(42));
    }

    #[test]
    fn delete_clears_pointers() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();

        // Seed a preset and a pointer that references it.
        let mut lib = store.read_layouts().unwrap();
        lib.presets.push(preset("doomed"));
        store.write_layouts(&lib).unwrap();
        let mut map = BTreeMap::new();
        map.insert("acme/main".to_string(), "doomed".to_string());
        map.insert("acme/feature".to_string(), "kept".to_string());
        store
            .write_worktree_presets(&WorktreePresetPointer { map })
            .unwrap();

        // Simulate `layouts_delete` internals.
        let mut lib = store.read_layouts().unwrap();
        lib.presets.retain(|p| p.name != "doomed");
        store.write_layouts(&lib).unwrap();
        let mut pointers = store.read_worktree_presets().unwrap();
        pointers.map.retain(|_, v| v != "doomed");
        store.write_worktree_presets(&pointers).unwrap();

        let back_ptrs = store.read_worktree_presets().unwrap();
        assert_eq!(back_ptrs.map.len(), 1);
        assert!(back_ptrs.map.contains_key("acme/feature"));
        assert!(!back_ptrs.map.contains_key("acme/main"));
    }
}
