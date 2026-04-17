//! Startup self-check for required external tools (§2.4).
//!
//! We verify `tmux --version` ≥ 3.2 and `git --version` ≥ 2.30. Missing or
//! outdated tools are reported to the UI via a blocking modal.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use tracing::{info, warn};

use crate::agent::AgentKind;
use crate::agent::semver_lite::Version;

/// Minimum tmux version (per `app-shell` spec §2.4 / design context).
pub const TMUX_MIN_VERSION: Version = Version {
    major: 3,
    minor: 2,
    patch: 0,
};

/// Minimum git version.
pub const GIT_MIN_VERSION: Version = Version {
    major: 2,
    minor: 30,
    patch: 0,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolStatus {
    pub name: String,
    pub found: bool,
    pub version: Option<Version>,
    pub meets_minimum: bool,
    pub minimum: Version,
    /// Raw stdout/stderr line the version was parsed from (for UI display).
    pub raw: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrereqReport {
    pub tmux: ToolStatus,
    pub git: ToolStatus,
}

impl PrereqReport {
    #[must_use]
    pub fn all_ok(&self) -> bool {
        self.tmux.found && self.tmux.meets_minimum && self.git.found && self.git.meets_minimum
    }
}

// semver_lite::Version is only `PartialOrd, Ord` — make `PartialEq` etc.
// available to downstream consumers via a local shim trait implementation.
impl Serialize for Version {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("{}.{}.{}", self.major, self.minor, self.patch))
    }
}

/// Run the prerequisite check. Non-fatal: always returns a report — the caller
/// decides whether to block the UI.
#[must_use]
pub fn check_prereqs() -> PrereqReport {
    let tmux = check_tool("tmux", &["-V"], &TMUX_MIN_VERSION);
    let git = check_tool("git", &["--version"], &GIT_MIN_VERSION);
    info!(
        tmux_found = tmux.found,
        tmux_ok = tmux.meets_minimum,
        git_found = git.found,
        git_ok = git.meets_minimum,
        "prereq check complete"
    );
    PrereqReport { tmux, git }
}

/// Per-harness availability snapshot. Includes resolved install path, the
/// minimum version raum expects (if any), whether the detected version meets
/// it, hook-capability flag, and the managed settings file raum writes into
/// (for harnesses that expose a hook-config surface).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatus {
    pub kind: AgentKind,
    pub binary: String,
    pub found: bool,
    pub version: Option<Version>,
    pub raw: Option<String>,
    /// Absolute path resolved via `which` — `None` when the binary is missing.
    pub resolved_path: Option<String>,
    /// Minimum version raum expects. `None` for Shell (no minimum).
    pub minimum: Option<Version>,
    /// Tri-state: `Some(true/false)` once we have both a minimum and a parsed
    /// version; `None` when either is missing.
    pub meets_minimum: Option<bool>,
    /// Whether raum can receive native hook events from this harness.
    pub supports_native_events: bool,
    /// One-line install hint (URL or package name) surfaced to the UI.
    pub install_hint: Option<String>,
    /// Absolute path to the harness config file raum writes hooks into, if any.
    pub settings_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarnessReport {
    pub harnesses: Vec<HarnessStatus>,
}

/// Probe each harness binary on PATH. Shell is included so the settings UI
/// can render a consistent row for every harness raum speaks to.
#[must_use]
pub fn check_harnesses() -> HarnessReport {
    let kinds = [
        AgentKind::Shell,
        AgentKind::ClaudeCode,
        AgentKind::Codex,
        AgentKind::OpenCode,
    ];
    let harnesses = kinds.iter().map(|k| check_harness(*k)).collect();
    HarnessReport { harnesses }
}

fn check_harness(kind: AgentKind) -> HarnessStatus {
    let binary = kind.binary_name();
    let resolved_path = which::which(binary)
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let minimum = minimum_version_for(kind);
    let supports_native_events = supports_native_events_for(kind);
    let install_hint = install_hint_for(kind).map(str::to_string);
    let settings_path = settings_path_for(kind).map(|p| p.to_string_lossy().into_owned());

    let output = Command::new(binary).arg("--version").output();
    let Ok(output) = output else {
        return HarnessStatus {
            kind,
            binary: binary.into(),
            found: false,
            version: None,
            raw: None,
            resolved_path,
            minimum,
            meets_minimum: None,
            supports_native_events,
            install_hint,
            settings_path,
        };
    };
    let raw_stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let raw_stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let raw_line = if raw_stdout.is_empty() {
        raw_stderr
    } else {
        raw_stdout
    };
    let version = Version::parse(&raw_line);
    let meets_minimum = match (&version, &minimum) {
        (Some(v), Some(min)) => Some(v >= min),
        _ => None,
    };
    HarnessStatus {
        kind,
        binary: binary.into(),
        found: true,
        version,
        raw: Some(raw_line),
        resolved_path,
        minimum,
        meets_minimum,
        supports_native_events,
        install_hint,
        settings_path,
    }
}

fn minimum_version_for(kind: AgentKind) -> Option<Version> {
    match kind {
        AgentKind::Shell => None,
        AgentKind::ClaudeCode => Some(Version {
            major: 0,
            minor: 2,
            patch: 0,
        }),
        AgentKind::Codex | AgentKind::OpenCode => Some(Version {
            major: 0,
            minor: 1,
            patch: 0,
        }),
    }
}

fn supports_native_events_for(kind: AgentKind) -> bool {
    !matches!(kind, AgentKind::Shell)
}

fn install_hint_for(kind: AgentKind) -> Option<&'static str> {
    match kind {
        AgentKind::Shell => None,
        AgentKind::ClaudeCode => Some("https://docs.claude.com/en/docs/claude-code"),
        AgentKind::Codex => Some("https://github.com/openai/codex"),
        AgentKind::OpenCode => Some("https://opencode.ai"),
    }
}

fn settings_path_for(kind: AgentKind) -> Option<PathBuf> {
    match kind {
        AgentKind::ClaudeCode => Some(claude_settings_path()),
        AgentKind::OpenCode => Some(opencode_settings_path()),
        AgentKind::Codex | AgentKind::Shell => None,
    }
}

fn claude_settings_path() -> PathBuf {
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    home.join(".claude").join("settings.json")
}

fn opencode_settings_path() -> PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        let xdg = PathBuf::from(xdg);
        if !xdg.as_os_str().is_empty() {
            return xdg.join("opencode").join("config.json");
        }
    }
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    home.join(".config").join("opencode").join("config.json")
}

fn check_tool(name: &str, args: &[&str], minimum: &Version) -> ToolStatus {
    let output = Command::new(name).args(args).output();
    let Ok(output) = output else {
        warn!(tool = name, "not found on PATH");
        return ToolStatus {
            name: name.into(),
            found: false,
            version: None,
            meets_minimum: false,
            minimum: minimum.clone(),
            raw: None,
        };
    };

    let raw_stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let raw_stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    // tmux -V writes to stdout; git --version also stdout; be tolerant.
    let raw_line = if raw_stdout.is_empty() {
        raw_stderr
    } else {
        raw_stdout
    };

    let version = Version::parse(&raw_line);
    let meets_minimum = version.as_ref().is_some_and(|v| v >= minimum);
    if !meets_minimum {
        warn!(
            tool = name,
            raw = %raw_line,
            "tool version below minimum or unparsable"
        );
    }
    ToolStatus {
        name: name.into(),
        found: true,
        version,
        meets_minimum,
        minimum: minimum.clone(),
        raw: Some(raw_line),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_serializes_to_dotted_string() {
        // Wrap in a struct so TOML (which requires a table at the root) is happy.
        #[derive(Serialize)]
        struct Wrap {
            v: Version,
        }
        let w = Wrap {
            v: Version {
                major: 3,
                minor: 4,
                patch: 0,
            },
        };
        let s = toml::to_string(&w).unwrap();
        assert!(s.contains("v = \"3.4.0\""), "unexpected: {s}");
    }

    #[test]
    fn missing_binary_is_not_found() {
        let s = check_tool(
            "this-binary-does-not-exist-raum-test",
            &["--version"],
            &GIT_MIN_VERSION,
        );
        assert!(!s.found);
        assert!(!s.meets_minimum);
        assert!(s.version.is_none());
    }

    #[test]
    fn check_prereqs_returns_both_tools() {
        // Purely smoke — we don't assert a specific outcome because the
        // test host may or may not have tmux/git.
        let r = check_prereqs();
        assert_eq!(r.tmux.name, "tmux");
        assert_eq!(r.git.name, "git");
        assert_eq!(r.tmux.minimum, TMUX_MIN_VERSION);
        assert_eq!(r.git.minimum, GIT_MIN_VERSION);
    }
}
