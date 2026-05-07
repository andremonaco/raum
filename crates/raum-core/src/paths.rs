//! XDG-respecting filesystem layout for raum.

use std::env;
use std::path::PathBuf;

/// Root directory: `$XDG_CONFIG_HOME/raum` or `~/.config/raum`.
pub fn config_root() -> PathBuf {
    if let Ok(xdg) = env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("raum");
        }
    }
    home_dir().join(".config").join("raum")
}

pub fn projects_dir() -> PathBuf {
    config_root().join("projects")
}

pub fn hooks_dir() -> PathBuf {
    config_root().join("hooks")
}

pub fn state_dir() -> PathBuf {
    config_root().join("state")
}

pub fn logs_dir() -> PathBuf {
    config_root().join("logs")
}

pub fn config_file() -> PathBuf {
    config_root().join("config.toml")
}

pub fn keybindings_file() -> PathBuf {
    config_root().join("keybindings.toml")
}

pub fn sessions_state_file() -> PathBuf {
    state_dir().join("sessions.toml")
}

pub fn quickfire_history_file() -> PathBuf {
    state_dir().join("quickfire-history.toml")
}

pub fn active_layout_file() -> PathBuf {
    state_dir().join("active-layout.toml")
}

pub fn event_socket_path() -> PathBuf {
    state_dir().join("events.sock")
}

/// Per-pane terminal-snapshot directory. raum persists xterm.js
/// `SerializeAddon`-encoded VT blobs here for the inline-Claude / shell
/// reattach paths so cross-restart scrollback survives without abusing the
/// webview's localStorage (which is capped at ~5 MiB and evictable on
/// macOS WebKit's 7-day storage policy). Snapshots are deleted when the
/// owning tmux session is killed; the directory itself is GC'd on raum
/// startup against the live tmux session list.
pub fn terminal_snapshots_dir() -> PathBuf {
    state_dir().join("terminal-snapshots")
}

fn home_dir() -> PathBuf {
    if let Ok(home) = env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    PathBuf::from("/")
}
