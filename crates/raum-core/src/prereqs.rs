//! Startup self-check for required external tools (§2.4).
//!
//! We verify `tmux --version` ≥ 3.2 and `git --version` ≥ 2.30. Missing or
//! outdated tools are reported to the UI via a blocking modal.

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

/// Per-harness availability snapshot for the onboarding wizard. Unlike
/// `ToolStatus`, harnesses have no minimum version — the user just needs to
/// know whether the binary exists and which version is on PATH.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatus {
    pub kind: AgentKind,
    pub binary: String,
    pub found: bool,
    pub version: Option<Version>,
    pub raw: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarnessReport {
    pub harnesses: Vec<HarnessStatus>,
}

/// Probe each user-facing harness binary on PATH. `Shell` is excluded — it's
/// always available and isn't surfaced as a "harness" in the wizard.
#[must_use]
pub fn check_harnesses() -> HarnessReport {
    let kinds = [AgentKind::ClaudeCode, AgentKind::Codex, AgentKind::OpenCode];
    let harnesses = kinds.iter().map(|k| check_harness(*k)).collect();
    HarnessReport { harnesses }
}

fn check_harness(kind: AgentKind) -> HarnessStatus {
    let binary = kind.binary_name();
    let output = Command::new(binary).arg("--version").output();
    let Ok(output) = output else {
        return HarnessStatus {
            kind,
            binary: binary.into(),
            found: false,
            version: None,
            raw: None,
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
    HarnessStatus {
        kind,
        binary: binary.into(),
        found: true,
        version,
        raw: Some(raw_line),
    }
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
