//! Per-harness trait surface (Phase 2, per-harness notification plan).
//!
//! Today's [`crate::agent::AgentAdapter`] trait bundles five responsibilities
//! — identity, version probing, spawn gating, hook install, and native-event
//! support — into one object. Phase 2 splits those into three focused traits
//! so adding a new harness (or a new event source for an existing one) is a
//! concrete file drop rather than a refactor.
//!
//! * [`HarnessIdentity`] — the stable identity triple (kind / binary / min
//!   version) plus a version probe. Everything else is keyed off this.
//! * [`NotificationSetup`] — one-shot "plan + apply" at project-bind time
//!   (config-file injection, feature-flag toggling, shell-script drop). The
//!   planner is pure; application is the [`super::setup::SetupExecutor`]'s
//!   job so every adapter shares one "write config safely" path.
//! * [`HarnessRuntime`] — runtime-side channel + replier factory.
//!
//! The old [`AgentAdapter`] trait is kept for one release as a
//! `#[deprecated]` shim so `src-tauri` continues to compile while callsites
//! migrate. Once every callsite consumes the split traits, the shim comes
//! out.

use async_trait::async_trait;

use crate::agent::{AgentError, AgentKind, VersionReport, semver_lite};
use crate::harness::channel::NotificationChannel;
use crate::harness::reply::PermissionReplier;
use crate::harness::setup::{SelftestReport, SetupContext, SetupError, SetupPlan};

/// Stable identity of a harness. Every other per-harness trait requires
/// this as a supertrait so the plan / runtime code can always read the
/// kind + binary without downcasting.
#[async_trait]
pub trait HarnessIdentity: Send + Sync {
    /// The [`AgentKind`] for this harness. Stable across versions.
    fn kind(&self) -> AgentKind;

    /// The executable name to look up on `$PATH` when spawning the harness.
    fn binary(&self) -> &'static str;

    /// The oldest harness version raum supports. Returning a freshly-
    /// constructed `Version` is fine — this is called only on preflight.
    fn minimum_version(&self) -> semver_lite::Version;

    /// Probe the installed harness version by invoking its binary. Should
    /// degrade gracefully (return [`AgentError::BinaryMissing`]) when the
    /// binary is not on `$PATH`.
    async fn detect_version(&self) -> Result<VersionReport, AgentError>;
}

/// One-shot setup run on project bind. Produces a [`SetupPlan`] the
/// executor applies transactionally. Keeping plan construction pure lets
/// tests assert the set of actions without touching the filesystem.
#[async_trait]
pub trait NotificationSetup: HarnessIdentity {
    /// Build the list of setup actions required to make this harness emit
    /// waiting-for-user events into raum. Called once at project bind;
    /// does **not** touch the filesystem itself — the
    /// [`super::setup::SetupExecutor`] applies the returned plan.
    async fn plan(&self, ctx: &SetupContext) -> Result<SetupPlan, SetupError>;

    /// Fire a synthetic event and assert the setup is end-to-end functional.
    /// Emits a [`SelftestReport`] the UI can render; never returns an error
    /// — failures are captured inside the report so the caller can render
    /// a persistent warning without aborting startup.
    async fn selftest(&self, ctx: &SetupContext) -> SelftestReport;
}

/// Runtime-side trait: produce a stream of notification events per
/// session plus an optional reply handle for two-way harnesses. Keeping
/// this separate from [`NotificationSetup`] means hot-reload / testing
/// paths can swap runtime implementations without re-running setup.
pub trait HarnessRuntime: HarnessIdentity {
    /// Build the per-session set of notification channels. Each channel
    /// owns its own async task and publishes events into a
    /// [`crate::harness::channel::NotificationSink`].
    fn channels(&self, session: &SessionSpec) -> Vec<Box<dyn NotificationChannel>>;

    /// Build a permission replier for this session, or `None` for
    /// observation-only harnesses (Codex today). Returning `Some` does
    /// **not** obligate the UI to use it — it just means "a reply channel
    /// is available".
    fn replier(&self, session: &SessionSpec) -> Option<Box<dyn PermissionReplier>>;

    /// Environment variables + extra CLI flags to inject into the spawn
    /// command. Mirrors the existing per-harness extra-flags config path.
    fn launch_overrides(&self) -> LaunchOverrides;
}

/// Session-identity payload passed to [`HarnessRuntime`] factories. Kept
/// as a struct (not an `&Session`) so the trait doesn't leak the session
/// registry into `raum-core`. Phase 3/4 adapters will read the project
/// slug + worktree id to scope their reply endpoints.
#[derive(Debug, Clone)]
pub struct SessionSpec {
    pub session_id: crate::agent::SessionId,
    pub project_slug: String,
    pub worktree_id: String,
    pub cwd: std::path::PathBuf,
}

/// Env vars + CLI flag overrides for a harness spawn. Empty by default so
/// adapters only populate the fields they care about.
#[derive(Debug, Default, Clone)]
pub struct LaunchOverrides {
    pub env: Vec<(String, String)>,
    pub extra_args: Vec<String>,
}

impl LaunchOverrides {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}
