//! XDG-respecting filesystem layout for raum.

use std::env;
use std::path::PathBuf;

/// Instance namespace for every per-instance resource.
///
/// raum supports running several fully isolated instances side by side — most
/// importantly a `task dev` build next to a release install — by deriving the
/// config tree, the state dir, the event socket and the tmux socket name from
/// a single `RAUM_INSTANCE` env var:
///
/// * unset / empty → the default `"raum"` instance
/// * `RAUM_INSTANCE=dev` → `"raum-dev"`
///
/// `task dev` sets `RAUM_INSTANCE=dev`, so the dev app never touches the
/// release app's agents, `sessions.toml`, hook scripts, or event socket.
#[must_use]
pub fn instance_name() -> String {
    instance_name_from(env::var("RAUM_INSTANCE").ok().as_deref())
}

fn instance_name_from(instance: Option<&str>) -> String {
    match instance {
        Some(s) if !s.trim().is_empty() => format!("raum-{}", s.trim()),
        _ => "raum".to_string(),
    }
}

/// Root directory: `$XDG_CONFIG_HOME/<instance>` or `~/.config/<instance>`,
/// where `<instance>` is [`instance_name`] (`raum` by default, `raum-dev` for
/// the dev build).
///
/// Resolved once per process — every other path helper funnels through here,
/// so this is hot enough that the env lookups and joins are worth skipping.
/// `RAUM_INSTANCE` / `XDG_CONFIG_HOME` are launch-time inputs; a mid-process
/// change to either is not observed.
pub fn config_root() -> PathBuf {
    static ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    ROOT.get_or_init(|| {
        let base = match env::var("XDG_CONFIG_HOME") {
            Ok(xdg) if !xdg.is_empty() => PathBuf::from(xdg),
            _ => home_dir().join(".config"),
        };
        base.join(instance_name())
    })
    .clone()
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

#[cfg(test)]
mod tests {
    use super::instance_name_from;

    #[test]
    fn unset_or_empty_instance_is_the_default_namespace() {
        assert_eq!(instance_name_from(None), "raum");
        assert_eq!(instance_name_from(Some("")), "raum");
        assert_eq!(instance_name_from(Some("   ")), "raum");
    }

    #[test]
    fn named_instance_is_suffixed() {
        assert_eq!(instance_name_from(Some("dev")), "raum-dev");
        assert_eq!(instance_name_from(Some(" dev ")), "raum-dev");
    }
}
