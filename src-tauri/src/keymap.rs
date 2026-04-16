//! §12.1–12.3 — the default keymap plus the user-override merge layer.
//!
//! The default keymap is a compile-time table keyed by stable action name.
//! [`merged_keymap`] layers `~/.config/raum/keybindings.toml` on top: valid
//! overrides replace the default accelerator for the matching action, invalid
//! or unknown entries are logged via `tracing::warn!` and dropped so a broken
//! user file never takes the app down.
//!
//! Two entries — `focus-raum` and `spawn-shell-global` — are registered as
//! OS-level accelerators through `tauri-plugin-global-shortcut` (see
//! `lib.rs::run`). Every other action is app-level and handled by the
//! frontend keymap provider.

use raum_core::config::Keybindings;
use raum_core::store::ConfigStore;
use serde::Serialize;
use tracing::warn;

/// One row in the keymap: a stable action name, the accelerator that triggers
/// it, and a human-readable description for the cheat-sheet UI.
///
/// Owned strings (not `&'static str`) so [`merged_keymap`] can substitute a
/// user override without cloning the world.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeymapEntry {
    pub action: String,
    pub accelerator: String,
    pub description: String,
    /// Global (OS-level) shortcuts fire even when raum is unfocused; everything
    /// else is app-level (handled by the frontend keymap provider).
    pub global: bool,
}

/// Internal table of defaults. `&'static str` tuples keep the data in `.rodata`;
/// callers convert to owned [`KeymapEntry`] as needed.
const DEFAULTS: &[(&str, &str, &str, bool)] = &[
    // ---- spawn ------------------------------------------------------------
    (
        "spawn-shell",
        "CmdOrCtrl+Shift+T",
        "Spawn a shell pane",
        false,
    ),
    (
        "spawn-claude-code",
        "CmdOrCtrl+Shift+C",
        "Spawn a Claude Code pane",
        false,
    ),
    (
        "spawn-codex",
        "CmdOrCtrl+Shift+X",
        "Spawn a Codex pane",
        false,
    ),
    (
        "spawn-opencode",
        "CmdOrCtrl+Shift+O",
        "Spawn an OpenCode pane",
        false,
    ),
    // ---- top-row navigation ----------------------------------------------
    (
        "cycle-tab-next",
        "CmdOrCtrl+Alt+Right",
        "Cycle to next top-row tab",
        false,
    ),
    (
        "cycle-tab-prev",
        "CmdOrCtrl+Alt+Left",
        "Cycle to previous top-row tab",
        false,
    ),
    (
        "select-project-1",
        "CmdOrCtrl+Shift+1",
        "Select project tab 1",
        false,
    ),
    (
        "select-project-2",
        "CmdOrCtrl+Shift+2",
        "Select project tab 2",
        false,
    ),
    (
        "select-project-3",
        "CmdOrCtrl+Shift+3",
        "Select project tab 3",
        false,
    ),
    (
        "select-project-4",
        "CmdOrCtrl+Shift+4",
        "Select project tab 4",
        false,
    ),
    (
        "select-project-5",
        "CmdOrCtrl+Shift+5",
        "Select project tab 5",
        false,
    ),
    (
        "select-project-6",
        "CmdOrCtrl+Shift+6",
        "Select project tab 6",
        false,
    ),
    (
        "select-project-7",
        "CmdOrCtrl+Shift+7",
        "Select project tab 7",
        false,
    ),
    (
        "select-project-8",
        "CmdOrCtrl+Shift+8",
        "Select project tab 8",
        false,
    ),
    (
        "select-project-9",
        "CmdOrCtrl+Shift+9",
        "Select project tab 9",
        false,
    ),
    (
        "select-filter-active",
        "CmdOrCtrl+1",
        "Filter: Active",
        false,
    ),
    (
        "select-filter-needs-input",
        "CmdOrCtrl+2",
        "Filter: Needs input",
        false,
    ),
    (
        "select-filter-recent",
        "CmdOrCtrl+3",
        "Filter: Recent",
        false,
    ),
    // ---- panes ------------------------------------------------------------
    ("focus-pane-1", "CmdOrCtrl+Alt+1", "Focus pane 1", false),
    ("focus-pane-2", "CmdOrCtrl+Alt+2", "Focus pane 2", false),
    ("focus-pane-3", "CmdOrCtrl+Alt+3", "Focus pane 3", false),
    ("focus-pane-4", "CmdOrCtrl+Alt+4", "Focus pane 4", false),
    ("focus-pane-5", "CmdOrCtrl+Alt+5", "Focus pane 5", false),
    ("focus-pane-6", "CmdOrCtrl+Alt+6", "Focus pane 6", false),
    ("focus-pane-7", "CmdOrCtrl+Alt+7", "Focus pane 7", false),
    ("focus-pane-8", "CmdOrCtrl+Alt+8", "Focus pane 8", false),
    ("focus-pane-9", "CmdOrCtrl+Alt+9", "Focus pane 9", false),
    (
        "cycle-focus-forward",
        "CmdOrCtrl+]",
        "Cycle focus forward",
        false,
    ),
    ("cycle-focus-back", "CmdOrCtrl+[", "Cycle focus back", false),
    (
        "maximize-pane",
        "CmdOrCtrl+Shift+M",
        "Toggle maximize the focused pane",
        false,
    ),
    // ---- chrome -----------------------------------------------------------
    (
        "toggle-sidebar",
        "CmdOrCtrl+B",
        "Collapse/expand sidebar",
        false,
    ),
    (
        "toggle-quick-fire",
        "CmdOrCtrl+Shift+K",
        "Toggle quick-fire input",
        false,
    ),
    (
        "focus-quick-fire",
        "CmdOrCtrl+K",
        "Focus quick-fire input",
        false,
    ),
    (
        "global-search",
        "CmdOrCtrl+Shift+F",
        "Global scrollback search",
        false,
    ),
    (
        "open-grid-builder",
        "CmdOrCtrl+Shift+G",
        "Open the grid builder",
        false,
    ),
    (
        "cheat-sheet",
        "CmdOrCtrl+/",
        "Show keymap cheat-sheet",
        false,
    ),
    ("spotlight", "CmdOrCtrl+.", "Open spotlight dock", false),
    // ---- worktrees --------------------------------------------------------
    (
        "new-worktree",
        "CmdOrCtrl+Shift+N",
        "Create a new worktree",
        false,
    ),
    ("switch-worktree", "CmdOrCtrl+P", "Switch worktree", false),
    (
        "apply-last-used-preset",
        "CmdOrCtrl+Shift+L",
        "Apply last-used preset",
        false,
    ),
    // ---- global (OS-level) shortcuts -------------------------------------
    ("focus-raum", "CmdOrCtrl+Alt+R", "Focus raum window", true),
    (
        "spawn-shell-global",
        "CmdOrCtrl+Alt+T",
        "Spawn a shell in the active worktree (global)",
        true,
    ),
];

/// Return the built-in default keymap as owned [`KeymapEntry`] values.
#[must_use]
pub fn default_keymap() -> Vec<KeymapEntry> {
    DEFAULTS
        .iter()
        .map(|(action, accel, desc, global)| KeymapEntry {
            action: (*action).to_string(),
            accelerator: (*accel).to_string(),
            description: (*desc).to_string(),
            global: *global,
        })
        .collect()
}

/// Return the subset of defaults that are registered as OS-level global
/// shortcuts (§12.3).
#[must_use]
#[allow(dead_code)]
pub fn global_shortcut_actions() -> Vec<KeymapEntry> {
    default_keymap().into_iter().filter(|e| e.global).collect()
}

/// Tauri accelerator validator.
///
/// A conservative parser that accepts the accelerator grammar shared by
/// `tauri`/`tao`/`global-hotkey`: one or more modifier tokens (`Cmd`, `Command`,
/// `Super`, `Meta`, `Ctrl`, `Control`, `CmdOrCtrl`, `CommandOrControl`, `Alt`,
/// `Option`, `AltGr`, `Shift`) joined by `+`, followed by exactly one key token.
///
/// This is intentionally stricter than the real parser in order to reject
/// obvious garbage like `"nope"` at config-load time. Anything valid here will
/// also parse at registration time inside the plugin.
#[must_use]
pub fn is_valid_accelerator(input: &str) -> bool {
    let s = input.trim();
    if s.is_empty() {
        return false;
    }
    let mut key: Option<&str> = None;
    for token in s.split('+') {
        let token = token.trim();
        if token.is_empty() {
            return false;
        }
        if is_modifier_token(token) {
            continue;
        }
        // First non-modifier becomes the key; any further non-modifier token
        // is a parse error.
        if key.is_some() {
            return false;
        }
        if !is_key_token(token) {
            return false;
        }
        key = Some(token);
    }
    key.is_some()
}

fn is_modifier_token(s: &str) -> bool {
    matches!(
        s,
        "Cmd"
            | "Command"
            | "Super"
            | "Meta"
            | "Ctrl"
            | "Control"
            | "CmdOrCtrl"
            | "CommandOrControl"
            | "Alt"
            | "Option"
            | "AltGr"
            | "Shift"
    )
}

fn is_key_token(s: &str) -> bool {
    // Single characters (letters, digits, punctuation) are always accepted.
    if s.chars().count() == 1 {
        return true;
    }
    // Named keys recognised by the Tauri accelerator grammar.
    matches!(
        s,
        "Up" | "Down"
            | "Left"
            | "Right"
            | "Space"
            | "Tab"
            | "Enter"
            | "Return"
            | "Escape"
            | "Esc"
            | "Backspace"
            | "Delete"
            | "Home"
            | "End"
            | "PageUp"
            | "PageDown"
            | "Insert"
            | "CapsLock"
            | "NumLock"
            | "ScrollLock"
            | "PrintScreen"
            | "Pause"
            | "F1"
            | "F2"
            | "F3"
            | "F4"
            | "F5"
            | "F6"
            | "F7"
            | "F8"
            | "F9"
            | "F10"
            | "F11"
            | "F12"
            | "F13"
            | "F14"
            | "F15"
            | "F16"
            | "F17"
            | "F18"
            | "F19"
            | "F20"
            | "F21"
            | "F22"
            | "F23"
            | "F24"
            | "Plus"
            | "Minus"
            | "Equal"
            | "Comma"
            | "Period"
            | "Slash"
            | "Backslash"
            | "Semicolon"
            | "Quote"
            | "BracketLeft"
            | "BracketRight"
            | "Backquote"
    )
}

/// Merge a [`Keybindings`] override map onto the defaults.
///
/// Rules:
/// * Each override maps an action name to an accelerator string.
/// * Unknown action names are logged at WARN level and ignored.
/// * Invalid accelerators are logged at WARN level and ignored; the default
///   accelerator for that action stays in place.
/// * Valid overrides replace the accelerator for the matching action.
fn merge_overrides(defaults: Vec<KeymapEntry>, kb: &Keybindings) -> Vec<KeymapEntry> {
    let mut out = defaults;
    for (action, accel) in &kb.overrides {
        let Some(entry) = out.iter_mut().find(|e| &e.action == action) else {
            warn!(
                action = %action,
                accelerator = %accel,
                "keybindings.toml: unknown action; ignoring"
            );
            continue;
        };
        if !is_valid_accelerator(accel) {
            warn!(
                action = %action,
                accelerator = %accel,
                "keybindings.toml: invalid accelerator; keeping default"
            );
            continue;
        }
        entry.accelerator.clone_from(accel);
    }
    out
}

/// §12.2 — return the keymap with the user's `keybindings.toml` merged over
/// the defaults. Used both by the `keymap_get_effective` Tauri command and by
/// the global-shortcut registration in `lib.rs::run`.
#[must_use]
pub fn merged_keymap(store: &ConfigStore) -> Vec<KeymapEntry> {
    let defaults = default_keymap();
    match store.read_keybindings() {
        Ok(kb) => merge_overrides(defaults, &kb),
        Err(e) => {
            warn!(error = %e, "failed to read keybindings.toml; using defaults");
            defaults
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use raum_core::config::Keybindings;
    use std::collections::BTreeMap;
    use tempfile::tempdir;
    use tracing_test::traced_test;

    // ---- accelerator validation ------------------------------------------

    #[test]
    fn valid_accelerators_accepted() {
        assert!(is_valid_accelerator("CmdOrCtrl+Shift+T"));
        assert!(is_valid_accelerator("CmdOrCtrl+/"));
        assert!(is_valid_accelerator("Ctrl+Tab"));
        assert!(is_valid_accelerator("Alt+F4"));
        assert!(is_valid_accelerator("CmdOrCtrl+Alt+Right"));
        assert!(is_valid_accelerator("Shift+["));
    }

    #[test]
    fn invalid_accelerators_rejected() {
        assert!(!is_valid_accelerator(""));
        assert!(!is_valid_accelerator("   "));
        assert!(!is_valid_accelerator("nope"));
        assert!(!is_valid_accelerator("CmdOrCtrl+"));
        assert!(!is_valid_accelerator("+T"));
        assert!(!is_valid_accelerator("CmdOrCtrl+T+U")); // two keys
        assert!(!is_valid_accelerator("CmdOrCtrl+Shift")); // no key at all
        assert!(!is_valid_accelerator("CmdOrCtrl+Shift+NotAKey"));
    }

    // ---- defaults cover every documented action --------------------------

    #[test]
    fn defaults_contain_every_spec_action() {
        let defaults = default_keymap();
        let actions: Vec<&str> = defaults.iter().map(|e| e.action.as_str()).collect();
        for needed in [
            // spec.md "Default keymap"
            "spawn-shell",
            "spawn-claude-code",
            "spawn-codex",
            "spawn-opencode",
            "cycle-tab-next",
            "cycle-tab-prev",
            "select-project-1",
            "select-project-9",
            "select-filter-active",
            "select-filter-needs-input",
            "select-filter-recent",
            "focus-pane-1",
            "focus-pane-9",
            "cycle-focus-forward",
            "cycle-focus-back",
            "toggle-sidebar",
            "toggle-quick-fire",
            "focus-quick-fire",
            "new-worktree",
            "switch-worktree",
            "maximize-pane",
            "global-search",
            "open-grid-builder",
            "apply-last-used-preset",
            "spotlight",
            // design D8 global shortcuts
            "focus-raum",
            "spawn-shell-global",
        ] {
            assert!(actions.contains(&needed), "missing action `{needed}`");
        }
    }

    #[test]
    fn every_default_accelerator_is_valid() {
        for entry in default_keymap() {
            assert!(
                is_valid_accelerator(&entry.accelerator),
                "default accelerator `{}` for action `{}` failed validation",
                entry.accelerator,
                entry.action
            );
        }
    }

    // ---- merge_overrides --------------------------------------------------

    #[test]
    fn empty_overrides_yield_defaults() {
        let defaults = default_keymap();
        let merged = merge_overrides(defaults.clone(), &Keybindings::default());
        assert_eq!(merged, defaults);
    }

    #[test]
    fn partial_override_replaces_accelerator_only_for_that_action() {
        let defaults = default_keymap();
        let mut overrides = BTreeMap::new();
        overrides.insert("global-search".to_string(), "Ctrl+K".to_string());
        let merged = merge_overrides(defaults.clone(), &Keybindings { overrides });

        let gs = merged.iter().find(|e| e.action == "global-search").unwrap();
        assert_eq!(gs.accelerator, "Ctrl+K");

        // Every other action keeps its default accelerator.
        for def in &defaults {
            if def.action == "global-search" {
                continue;
            }
            let got = merged.iter().find(|e| e.action == def.action).unwrap();
            assert_eq!(got.accelerator, def.accelerator);
        }
    }

    #[traced_test]
    #[test]
    fn invalid_accelerator_keeps_default_and_warns() {
        let defaults = default_keymap();
        let default_spawn_shell = defaults
            .iter()
            .find(|e| e.action == "spawn-shell")
            .unwrap()
            .accelerator
            .clone();

        let mut overrides = BTreeMap::new();
        overrides.insert("spawn-shell".to_string(), "nope".to_string());
        let merged = merge_overrides(defaults, &Keybindings { overrides });

        let got = merged.iter().find(|e| e.action == "spawn-shell").unwrap();
        assert_eq!(got.accelerator, default_spawn_shell);

        assert!(logs_contain("invalid accelerator"));
        assert!(logs_contain("spawn-shell"));
    }

    #[traced_test]
    #[test]
    fn unknown_action_is_warned_and_dropped() {
        let defaults = default_keymap();
        let mut overrides = BTreeMap::new();
        overrides.insert("totally-made-up".to_string(), "Ctrl+K".to_string());
        let merged = merge_overrides(defaults.clone(), &Keybindings { overrides });

        assert_eq!(merged, defaults);
        assert!(logs_contain("unknown action"));
        assert!(logs_contain("totally-made-up"));
    }

    // ---- merged_keymap (integration with ConfigStore) --------------------

    #[test]
    fn merged_keymap_with_no_overrides_returns_defaults() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        let merged = merged_keymap(&store);
        assert_eq!(merged, default_keymap());
    }

    #[test]
    fn merged_keymap_applies_valid_override_from_toml() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();

        let mut overrides = BTreeMap::new();
        overrides.insert("cycle-tab-next".to_string(), "Ctrl+Tab".to_string());
        store.write_keybindings(&Keybindings { overrides }).unwrap();

        let merged = merged_keymap(&store);
        let got = merged
            .iter()
            .find(|e| e.action == "cycle-tab-next")
            .unwrap();
        assert_eq!(got.accelerator, "Ctrl+Tab");
    }

    // ---- §12.3 global-shortcut coverage -----------------------------------

    #[test]
    fn merged_keymap_contains_global_shortcuts_with_defaults() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        let merged = merged_keymap(&store);

        let by_action = |action: &str| -> KeymapEntry {
            merged
                .iter()
                .find(|e| e.action == action)
                .cloned()
                .unwrap_or_else(|| panic!("missing `{action}`"))
        };

        let focus = by_action("focus-raum");
        assert!(focus.global);
        assert_eq!(focus.accelerator, "CmdOrCtrl+Alt+R");

        let shell = by_action("spawn-shell-global");
        assert!(shell.global);
        assert_eq!(shell.accelerator, "CmdOrCtrl+Alt+T");

        // And confirm `global_shortcut_actions` returns exactly those two.
        let globals = global_shortcut_actions();
        let names: Vec<&str> = globals.iter().map(|e| e.action.as_str()).collect();
        assert_eq!(names, vec!["focus-raum", "spawn-shell-global"]);
    }
}
