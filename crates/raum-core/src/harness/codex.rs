//! Codex adapter.
//!
//! Codex currently has no hook system exposed through raum — `install_hooks`
//! is a no-op. The previous design advertised structured stdout events via a
//! `CODEX_JSON=1` environment variable and parsed newline-delimited JSON off
//! the pipe. That environment variable is not a real Codex feature
//! (confirmed against the current Codex config reference at
//! <https://developers.openai.com/codex/config-reference>) and was never
//! wired into spawn. Phase 1 deleted the dead code; Phase 3 will rewrite
//! this adapter to use Codex's real hooks + `notify` script + OSC 9 signals.

use std::path::Path;

use async_trait::async_trait;

#[allow(deprecated)]
use crate::agent::AgentAdapter;
use crate::agent::{AgentError, AgentKind, SessionId, SpawnOptions, VersionReport, semver_lite};
use crate::harness::channel::NotificationChannel;
use crate::harness::reply::PermissionReplier;
use crate::harness::setup::{SelftestReport, SetupContext, SetupError, SetupPlan};
use crate::harness::traits::{
    HarnessIdentity, HarnessRuntime, LaunchOverrides, NotificationSetup, SessionSpec,
};

#[derive(Debug, Clone, Default)]
pub struct CodexAdapter;

impl CodexAdapter {
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
#[allow(deprecated)]
impl AgentAdapter for CodexAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Codex
    }

    fn binary_path(&self) -> &'static str {
        "codex"
    }

    async fn spawn(&self, _opts: SpawnOptions) -> Result<SessionId, AgentError> {
        which::which(self.binary_path()).map_err(|_| AgentError::BinaryMissing {
            binary: self.binary_path().to_string(),
        })?;
        Err(AgentError::Spawn(
            "spawn is owned by the tmux layer; CodexAdapter only validates preconditions".into(),
        ))
    }

    async fn install_hooks(&self, _hooks_dir: &Path) -> Result<(), AgentError> {
        // Phase 3 will write `~/.codex/hooks.json` and flip
        // `[features] codex_hooks = true` in `~/.codex/config.toml`. Until
        // then, Codex observability falls back to the silence heuristic.
        Ok(())
    }

    fn supports_native_events(&self) -> bool {
        // Kept `true` for Phase 1 to preserve the external contract while
        // the `CODEX_JSON` stdout parser is being deleted. Phase 3 will
        // back this with a real channel set (hooks + OSC 9 + notify);
        // today the state machine receives no events from Codex until
        // that lands, so it effectively falls through to the silence
        // heuristic.
        true
    }

    async fn detect_version(&self) -> Result<VersionReport, AgentError> {
        super::claude_code::run_version(
            <Self as AgentAdapter>::binary_path(self),
            &<Self as AgentAdapter>::minimum_version(self),
        )
        .await
    }

    fn minimum_version(&self) -> semver_lite::Version {
        semver_lite::Version {
            major: 0,
            minor: 1,
            patch: 0,
        }
    }
}

// ---- New trait split (Phase 2) ---------------------------------------------

#[async_trait]
impl HarnessIdentity for CodexAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Codex
    }
    fn binary(&self) -> &'static str {
        "codex"
    }
    fn minimum_version(&self) -> semver_lite::Version {
        semver_lite::Version {
            major: 0,
            minor: 1,
            patch: 0,
        }
    }
    async fn detect_version(&self) -> Result<VersionReport, AgentError> {
        super::claude_code::run_version(
            <Self as HarnessIdentity>::binary(self),
            &<Self as HarnessIdentity>::minimum_version(self),
        )
        .await
    }
}

#[async_trait]
impl NotificationSetup for CodexAdapter {
    /// Phase 2 placeholder — returns an empty plan. Phase 3 will write
    /// `~/.codex/hooks.json`, flip `[features] codex_hooks = true`, and
    /// install the `notify` script.
    async fn plan(&self, _ctx: &SetupContext) -> Result<SetupPlan, SetupError> {
        Ok(SetupPlan::new(AgentKind::Codex))
    }

    async fn selftest(&self, _ctx: &SetupContext) -> SelftestReport {
        SelftestReport::ok(
            AgentKind::Codex,
            "selftest not implemented until Phase 3 (Codex hooks)",
            0,
        )
    }
}

impl HarnessRuntime for CodexAdapter {
    fn channels(&self, _session: &SessionSpec) -> Vec<Box<dyn NotificationChannel>> {
        Vec::new()
    }

    fn replier(&self, _session: &SessionSpec) -> Option<Box<dyn PermissionReplier>> {
        None
    }

    fn launch_overrides(&self) -> LaunchOverrides {
        LaunchOverrides::default()
    }
}

#[cfg(test)]
#[allow(deprecated)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn install_hooks_is_noop() {
        let adapter = CodexAdapter::new();
        let dir = tempfile::tempdir().unwrap();
        adapter.install_hooks(dir.path()).await.unwrap();
        // No files created.
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
    }

    #[test]
    fn supports_native_events_is_true() {
        // Phase 1 keeps the external contract stable; Phase 3 backs this
        // with a real channel set.
        assert!(CodexAdapter::new().supports_native_events());
    }

    #[tokio::test]
    async fn phase2_plan_is_empty_placeholder() {
        let adapter = CodexAdapter::new();
        let dir = tempfile::tempdir().unwrap();
        let ctx = SetupContext::new(
            dir.path().to_path_buf(),
            dir.path().join("events.sock"),
            "demo",
        );
        let plan = <CodexAdapter as NotificationSetup>::plan(&adapter, &ctx)
            .await
            .unwrap();
        assert_eq!(plan.harness, Some(AgentKind::Codex));
        assert!(plan.actions.is_empty());
    }
}
