//! Codex adapter (Phase 3).
//!
//! Codex exposes three complementary observation surfaces:
//!
//! 1. **Hooks** (`~/.codex/hooks.json`, gated on `[features] codex_hooks =
//!    true`). Event-driven; raum uses the coarse lifecycle hooks
//!    `UserPromptSubmit` and `Stop` plus the blocking `PermissionRequest`
//!    approval hook. `SessionStart` is deliberately *not* subscribed —
//!    see `RAUM_CODEX_HOOK_EVENTS` for why.
//! 2. **`notify` script** (top-level `notify = […]` in `config.toml`).
//!    Legacy pathway; currently only emits `agent-turn-complete`. Payload
//!    is handed to the script as the **last argv argument** — Codex does
//!    *not* replace a `"{json}"` placeholder (the plan's suggested
//!    `notify = [..., "{json}"]` shape is stale).
//! 3. **OSC 9 scrape**. Codex's TUI emits `\x1b]9;<payload>\x07` on
//!    approval / turn-complete when `tui.notifications` is enabled; raum
//!    tails the coalesced tmux byte stream to pick these up. Phase 3
//!    defines the channel; the tmux-side byte tap is Phase 5 work.
//!
//! Replies ride the blocking `PermissionRequest` hook: the dispatcher
//! parks on the event socket until raum writes back `allow` or `deny`.
//! `HarnessRuntime::replier` still returns `None` for the same reason
//! Claude Code's does — the decision goes out over the parked socket
//! writer, which lives in `src-tauri`, not through a per-session
//! replier object.
//!
//! # Version gate
//!
//! Codex 0.130 renamed the `[features].codex_hooks` flag to
//! `[features].hooks` (openai/codex#20684) and started gating unmanaged
//! hooks behind a `trusted_hash` review (openai/codex#20321). raum's
//! plan emits both the renamed flag and a pre-computed `trusted_hash`
//! per hook, so we require ≥ 0.130. If `detect_version` reports a
//! lower version, the setup plan skips the hooks.json action and only
//! writes `config.toml` with a `notify` entry.

use std::path::{Path, PathBuf};

use async_trait::async_trait;

#[allow(deprecated)]
use crate::agent::AgentAdapter;
use crate::agent::{AgentError, AgentKind, SessionId, SpawnOptions, VersionReport, semver_lite};
use crate::harness::setup::SetupContext;

use super::hook_script_path;

mod adapter;
mod channels;
mod planner;

pub use channels::{
    Osc9Parser, OscScrapeChannel, SilenceChannel, classify_osc9_payload, install_codex_hooks_json,
};
pub use planner::codex_notify_script_body;

#[cfg(test)]
mod tests;

// -- constants ---------------------------------------------------------------

/// Codex hook events raum subscribes to via `hooks.json`.
///
/// We intentionally keep this list coarse-grained. `PreToolUse` and
/// `PostToolUse` are Bash-scoped in upstream Codex and are not relevant
/// for raum's visible "working / idle / needs attention" model.
///
/// `PermissionRequest` (openai/codex#17563, stable since 0.122) is the
/// one blocking event: the dispatcher waits for a decision line and
/// answers with `hookSpecificOutput.decision.behavior`. It is also the
/// only event here that keeps a matcher through Codex's normalisation —
/// see [`planner::codex_hook_trusted_hash`].
///
/// **Not** `SessionStart`: it would call
/// [`crate::agent_state::AgentStateMachine::arm_activity`] at boot, which
/// then lets the silence-heuristic tick promote `Idle → Working` off
/// Codex's TUI startup redraw before the user has typed anything.
/// Claude Code deliberately omits `SessionStart` for the same reason
/// (see `RAUM_HOOK_EVENTS` in `claude_code.rs`). Activity is still armed
/// in time for real turns by `UserPromptSubmit` (via the classifier) and
/// by `terminal_send_keys` on user Enter.
pub const RAUM_CODEX_HOOK_EVENTS: &[&str] = &["PermissionRequest", "UserPromptSubmit", "Stop"];

/// Minimum Codex version this adapter targets for hooks. Codex 0.130
/// introduced two coupled changes that raum's hook plumbing depends on:
/// the `[features].codex_hooks` flag was renamed to `[features].hooks`
/// (openai/codex#20684), and unmanaged hooks are now gated behind a
/// per-hook `trusted_hash` review (openai/codex#20321) — without a
/// matching hash entry in `[hooks.state]`, hooks sit in `Untrusted`
/// state and never run. Lower versions get a `notify`-only fallback.
pub const CODEX_HOOKS_MINIMUM_VERSION: semver_lite::Version = semver_lite::Version {
    major: 0,
    minor: 130,
    patch: 0,
};

/// Absolute default paths for Codex's config files. Override-only for
/// tests — the real binary hard-codes `~/.codex/` for `config.toml`;
/// `hooks.json` is discovered layer-by-layer and picks up project-local
/// `<repo>/.codex/hooks.json` when Codex is run with cwd inside the
/// repo (confirmed against `codex-rs/hooks/src/engine/discovery.rs`).
fn default_config_toml_path() -> PathBuf {
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    home.join(".codex").join("config.toml")
}

fn default_hooks_json_path() -> PathBuf {
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    home.join(".codex").join("hooks.json")
}

/// `config.toml` keyed off an explicit `home_dir`. `config.toml` stays
/// user-global in Phase 6 — Codex does not support per-project
/// `config.toml` (`docs/config.md` documents only
/// `~/.codex/config.toml`). We parameterise on home only so tests can
/// point at a tempdir without clobbering the user's real config.
fn legacy_config_toml_path(home_dir: &Path) -> PathBuf {
    home_dir.join(".codex").join("config.toml")
}

/// Legacy user-global `hooks.json`. Used for the Phase 6 migration
/// probe — if a previous raum install wrote managed entries here, the
/// plan strips them so the project-local `.codex/hooks.json` becomes
/// the single source of raum-managed hooks.
pub(super) fn legacy_hooks_json_path(home_dir: &Path) -> PathBuf {
    home_dir.join(".codex").join("hooks.json")
}

/// Filename of the notify script raum drops into the hooks dir. Codex
/// invokes it as `argv[0]=<path> argv[1]=<json-payload>`.
pub const CODEX_NOTIFY_SCRIPT_NAME: &str = "codex-notify.sh";

// -- adapter -----------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct CodexAdapter {
    /// Override for `~/.codex/config.toml` location (tests only).
    pub(super) config_toml_path_override: Option<PathBuf>,
    /// Override for `~/.codex/hooks.json` location (tests only).
    pub(super) hooks_json_path_override: Option<PathBuf>,
    /// Version injected for tests so we can exercise the `notify`-only
    /// fallback without spawning a real `codex` binary.
    pub(super) forced_version: Option<semver_lite::Version>,
}

impl CodexAdapter {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Test constructor: override both config paths and optionally force
    /// a detected version (so plan() can be driven without a real binary).
    #[must_use]
    pub fn with_paths(
        config_toml: PathBuf,
        hooks_json: PathBuf,
        forced_version: Option<semver_lite::Version>,
    ) -> Self {
        Self {
            config_toml_path_override: Some(config_toml),
            hooks_json_path_override: Some(hooks_json),
            forced_version,
        }
    }

    #[must_use]
    pub fn config_toml_path(&self) -> PathBuf {
        self.config_toml_path_override
            .clone()
            .unwrap_or_else(default_config_toml_path)
    }

    /// Phase-6 `config.toml` path keyed off the context's `home_dir`.
    /// Codex does not read per-project `config.toml` (`docs/config.md`
    /// documents only `~/.codex/config.toml`), so the feature flag +
    /// notify script live user-global and apply to every Codex spawn
    /// regardless of which project the user is in.
    #[must_use]
    pub fn config_toml_path_for_ctx(&self, ctx: &SetupContext) -> PathBuf {
        if let Some(p) = &self.config_toml_path_override {
            return p.clone();
        }
        legacy_config_toml_path(&ctx.home_dir)
    }

    #[must_use]
    pub fn hooks_json_path(&self) -> PathBuf {
        self.hooks_json_path_override
            .clone()
            .unwrap_or_else(default_hooks_json_path)
    }

    /// Phase-6 project-scoped `hooks.json` path. Resolves to
    /// `<ctx.project_dir>/.codex/hooks.json` when `project_dir` is
    /// populated, falling back to the legacy user-global path when it
    /// is empty (tests / deprecated shim).
    #[must_use]
    pub fn hooks_json_path_for_ctx(&self, ctx: &SetupContext) -> PathBuf {
        if let Some(p) = &self.hooks_json_path_override {
            return p.clone();
        }
        if ctx.project_dir.as_os_str().is_empty() {
            return legacy_hooks_json_path(&ctx.home_dir);
        }
        ctx.project_dir.join(".codex").join("hooks.json")
    }
}

// -- deprecated AgentAdapter shim -------------------------------------------

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
        // The new code path is `NotificationSetup::plan` + `SetupExecutor`;
        // the deprecated shim stays a no-op for callers still on the old
        // `install_hooks` surface during the Phase 2/3 transition.
        Ok(())
    }

    fn supports_native_events(&self) -> bool {
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
        // `HarnessIdentity::minimum_version` is the authoritative answer
        // for the notification-plan side; keep this at the laxer 0.1.0
        // so the deprecated preflight does not reject hosts running an
        // older codex for reasons unrelated to hooks.
        semver_lite::Version {
            major: 0,
            minor: 1,
            patch: 0,
        }
    }
}
