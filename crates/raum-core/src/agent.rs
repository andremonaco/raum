//! AgentAdapter trait + agent state types. Filled in by §7.1; consumed by §7.3-§7.11.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    Shell,
    ClaudeCode,
    Codex,
    #[serde(rename = "opencode")]
    OpenCode,
}

impl AgentKind {
    #[must_use]
    pub fn binary_name(self) -> &'static str {
        match self {
            Self::Shell => "sh",
            Self::ClaudeCode => "claude",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentState {
    Idle,
    Working,
    Waiting,
    Completed,
    Errored,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionId(pub String);

impl SessionId {
    #[must_use]
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionReport {
    pub raw: String,
    pub parsed: Option<semver_lite::Version>,
    pub at_or_above_minimum: Option<bool>,
}

/// A minimal semver parser to avoid pulling the full `semver` crate transitively here.
pub mod semver_lite {
    #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
    pub struct Version {
        pub major: u64,
        pub minor: u64,
        pub patch: u64,
    }

    impl Version {
        /// Parse a loose version string. Tolerates:
        /// * leading non-digit prefix (`"v1.2.3"`, `"tmux 3.6a"`)
        /// * `.` / `-` / `+` separators
        /// * trailing non-digit characters on each component (`tmux`'s
        ///   `"3.6a"` patch suffix, OpenSSH's `"9.6p1"`, etc.)
        /// * missing minor / patch fields
        ///
        /// Returns `None` only when the major component has no leading digits.
        #[must_use]
        pub fn parse(s: &str) -> Option<Self> {
            let trimmed = s.trim_start_matches(|c: char| !c.is_ascii_digit());
            let mut parts = trimmed.split(['.', '-', '+', ' ']);
            let major = parse_leading_u64(parts.next()?)?;
            let minor = parts.next().and_then(parse_leading_u64).unwrap_or(0);
            let patch = parts.next().and_then(parse_leading_u64).unwrap_or(0);
            Some(Self {
                major,
                minor,
                patch,
            })
        }
    }

    /// Parse the longest leading run of ASCII digits from `s` as `u64`.
    /// Returns `None` if there are no leading digits.
    fn parse_leading_u64(s: &str) -> Option<u64> {
        let end = s.bytes().take_while(u8::is_ascii_digit).count();
        if end == 0 {
            return None;
        }
        s[..end].parse().ok()
    }
}

#[derive(Debug, Clone)]
pub struct SpawnOptions {
    pub cwd: std::path::PathBuf,
    pub project_slug: String,
    pub worktree_id: String,
    pub extra_env: Vec<(String, String)>,
}

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("binary `{binary}` not found on PATH")]
    BinaryMissing { binary: String },
    #[error("spawn failed: {0}")]
    Spawn(String),
    #[error("hook install failed: {0}")]
    HookInstall(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Unified harness adapter trait.
///
/// **Deprecated** — Phase 2 of the per-harness notification plan splits
/// this into three focused traits in [`crate::harness::traits`]:
///
/// * [`crate::harness::traits::HarnessIdentity`] — kind / binary /
///   version probing.
/// * [`crate::harness::traits::NotificationSetup`] — plan + selftest.
/// * [`crate::harness::traits::HarnessRuntime`] — channel + replier
///   factories.
///
/// The shim is kept for one release so `src-tauri` compiles unchanged
/// while callsites migrate. New code should prefer the split traits.
#[async_trait]
#[deprecated(
    since = "0.2.0",
    note = "use HarnessIdentity + NotificationSetup + HarnessRuntime from raum_core::harness::traits"
)]
pub trait AgentAdapter: Send + Sync {
    fn kind(&self) -> AgentKind;
    /// The executable name to look up on `$PATH` when spawning the harness.
    fn binary_path(&self) -> &str;
    async fn spawn(&self, opts: SpawnOptions) -> Result<SessionId, AgentError>;
    async fn install_hooks(&self, hooks_dir: &Path) -> Result<(), AgentError>;
    fn supports_native_events(&self) -> bool;
    async fn detect_version(&self) -> Result<VersionReport, AgentError>;
    fn minimum_version(&self) -> semver_lite::Version;
}

/// Build the default set of registered adapters (§7.3-§7.5).
///
/// Order is stable: Claude Code, OpenCode, Codex — used for deterministic
/// iteration in the app-shell initialisation path.
#[must_use]
#[allow(deprecated)]
pub fn build_default_adapters() -> Vec<Arc<dyn AgentAdapter>> {
    crate::harness::default_registry()
}

#[cfg(test)]
mod tests {
    use super::AgentKind;
    use super::semver_lite::Version;

    #[test]
    fn agent_kind_serializes_kebab_case() {
        let cases = [
            (AgentKind::Shell, "\"shell\""),
            (AgentKind::ClaudeCode, "\"claude-code\""),
            (AgentKind::Codex, "\"codex\""),
            (AgentKind::OpenCode, "\"opencode\""),
        ];
        for (kind, expected) in cases {
            let s = serde_json::to_string(&kind).unwrap();
            assert_eq!(s, expected, "{kind:?}");
        }
    }

    #[test]
    fn parses_dotted_versions() {
        let v = Version::parse("1.2.3").unwrap();
        assert_eq!(
            v,
            Version {
                major: 1,
                minor: 2,
                patch: 3
            }
        );
    }

    #[test]
    fn parses_leading_non_digits() {
        let v = Version::parse("v1.2.3").unwrap();
        assert_eq!(
            v,
            Version {
                major: 1,
                minor: 2,
                patch: 3
            }
        );
        let v = Version::parse("claude-code v0.9.4").unwrap();
        assert_eq!(
            v,
            Version {
                major: 0,
                minor: 9,
                patch: 4
            }
        );
    }

    #[test]
    fn parses_tmux_letter_suffix() {
        // tmux ships odd-numbered patches with a letter suffix (`3.6a`, `3.4b`)
        // that previously broke the parser into reading `minor = 0`.
        let v = Version::parse("tmux 3.6a").unwrap();
        assert_eq!(
            v,
            Version {
                major: 3,
                minor: 6,
                patch: 0
            }
        );
        assert!(
            v >= Version {
                major: 3,
                minor: 2,
                patch: 0
            },
            "tmux 3.6a must satisfy the >= 3.2 minimum"
        );
    }

    #[test]
    fn parses_openssh_style_p_suffix() {
        // OpenSSH-style `9.6p1` (letter suffix on minor field). We only care
        // that major and minor parse cleanly; the patch comes from the next
        // dotted segment which OpenSSH doesn't provide.
        let v = Version::parse("OpenSSH_9.6p1").unwrap();
        assert_eq!(v.major, 9);
        assert_eq!(v.minor, 6);
    }

    #[test]
    fn parses_trailing_build_metadata() {
        let v = Version::parse("1.2.3-rc1").unwrap();
        assert_eq!(
            v,
            Version {
                major: 1,
                minor: 2,
                patch: 3
            }
        );
        let v = Version::parse("1.2.3+build.7").unwrap();
        assert_eq!(
            v,
            Version {
                major: 1,
                minor: 2,
                patch: 3
            }
        );
    }

    #[test]
    fn parses_missing_minor_and_patch() {
        let v = Version::parse("1").unwrap();
        assert_eq!(
            v,
            Version {
                major: 1,
                minor: 0,
                patch: 0
            }
        );
        let v = Version::parse("2.5").unwrap();
        assert_eq!(
            v,
            Version {
                major: 2,
                minor: 5,
                patch: 0
            }
        );
    }

    #[test]
    fn rejects_garbage_input() {
        assert_eq!(Version::parse(""), None);
        assert_eq!(Version::parse("not a version"), None);
        assert_eq!(Version::parse("abc"), None);
    }

    #[test]
    fn default_adapter_registry_has_three_real_adapters() {
        #[allow(deprecated)]
        let r = super::build_default_adapters();
        assert_eq!(r.len(), 3);
    }
}
