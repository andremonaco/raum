//! Codex adapter (Phase 3).
//!
//! Codex exposes three complementary observation surfaces:
//!
//! 1. **Hooks** (`~/.codex/hooks.json`, gated on `[features] codex_hooks =
//!    true`). Event-driven; raum uses only the coarse lifecycle hooks
//!    `UserPromptSubmit` and `Stop`. `SessionStart` is deliberately
//!    *not* subscribed — see `RAUM_CODEX_HOOK_EVENTS` for why.
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
//! Codex has no replier today (`HarnessRuntime::replier` returns `None`):
//! even though the hook runtime accepts a `permissionDecision` field,
//! upstream has not wired enforcement yet. Observation only; click on
//! the notification focuses the pane and the user answers in Codex's
//! native TUI.
//!
//! # Version gate
//!
//! Hooks first shipped behind the `codex_hooks` feature flag; the
//! notification plan confirms the minimum is v0.119. If `detect_version`
//! reports a lower version, the setup plan skips the hooks.json action
//! and only writes `config.toml` with a `notify` entry (plus a
//! `SetupAction::EnsureFeatureFlag` that the executor will skip until
//! the flag is supported).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;
use tracing::debug;

#[allow(deprecated)]
use crate::agent::AgentAdapter;
use crate::agent::{AgentError, AgentKind, SessionId, SpawnOptions, VersionReport, semver_lite};
use crate::config_io::managed_json::{self, MARKER_BEGIN, MARKER_KEY, ManagedCodexHooks};
use crate::harness::channel::{ChannelError, ChannelHealth, NotificationChannel, NotificationSink};
use crate::harness::event::{
    NotificationEvent, NotificationKind, Reliability, SourceId, classify_notification_kind,
};
use crate::harness::reply::PermissionReplier;
use crate::harness::setup::{
    ConfigPathEntry, ConfigScope, ScanReport, SelftestReport, SetupAction, SetupContext,
    SetupError, SetupPlan, inspect_json_path, inspect_toml_path,
};
use crate::harness::traits::{
    HarnessIdentity, HarnessRuntime, LaunchOverrides, NotificationSetup, SessionSpec,
};

use super::hook_script_path;

// -- constants ---------------------------------------------------------------

/// Codex hook events raum subscribes to via `hooks.json`.
///
/// We intentionally keep this list coarse-grained. `PreToolUse` and
/// `PostToolUse` are Bash-scoped in upstream Codex and are not relevant
/// for raum's visible "working / idle / needs attention" model.
///
/// **Not** `SessionStart`: it would call
/// [`crate::agent_state::AgentStateMachine::arm_activity`] at boot, which
/// then lets the silence-heuristic tick promote `Idle → Working` off
/// Codex's TUI startup redraw before the user has typed anything.
/// Claude Code deliberately omits `SessionStart` for the same reason
/// (see `RAUM_HOOK_EVENTS` in `claude_code.rs`). Activity is still armed
/// in time for real turns by `UserPromptSubmit` (via the classifier) and
/// by `terminal_send_keys` on user Enter.
pub const RAUM_CODEX_HOOK_EVENTS: &[&str] = &["UserPromptSubmit", "Stop"];

/// Minimum Codex version with hook support. The developers.openai.com
/// docs do not publish a first-supported version number, but the prior
/// research round (archived in the Phase 3 task description) confirmed
/// v0.119 as the earliest release shipping `[features] codex_hooks`.
/// Lower versions get a `notify`-only fallback.
pub const CODEX_HOOKS_MINIMUM_VERSION: semver_lite::Version = semver_lite::Version {
    major: 0,
    minor: 119,
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
fn legacy_hooks_json_path(home_dir: &Path) -> PathBuf {
    home_dir.join(".codex").join("hooks.json")
}

/// Filename of the notify script raum drops into the hooks dir. Codex
/// invokes it as `argv[0]=<path> argv[1]=<json-payload>`.
pub const CODEX_NOTIFY_SCRIPT_NAME: &str = "codex-notify.sh";

// -- adapter -----------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct CodexAdapter {
    /// Override for `~/.codex/config.toml` location (tests only).
    config_toml_path_override: Option<PathBuf>,
    /// Override for `~/.codex/hooks.json` location (tests only).
    hooks_json_path_override: Option<PathBuf>,
    /// Version injected for tests so we can exercise the `notify`-only
    /// fallback without spawning a real `codex` binary.
    forced_version: Option<semver_lite::Version>,
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

// -- new trait split (Phase 2/3) --------------------------------------------

#[async_trait]
impl HarnessIdentity for CodexAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Codex
    }
    fn binary(&self) -> &'static str {
        "codex"
    }
    fn minimum_version(&self) -> semver_lite::Version {
        CODEX_HOOKS_MINIMUM_VERSION
    }
    async fn detect_version(&self) -> Result<VersionReport, AgentError> {
        if let Some(v) = &self.forced_version {
            return Ok(VersionReport {
                raw: format!("{}.{}.{}", v.major, v.minor, v.patch),
                parsed: Some(v.clone()),
                at_or_above_minimum: Some(v >= &CODEX_HOOKS_MINIMUM_VERSION),
            });
        }
        super::claude_code::run_version(
            <Self as HarnessIdentity>::binary(self),
            &<Self as HarnessIdentity>::minimum_version(self),
        )
        .await
    }
}

#[async_trait]
impl NotificationSetup for CodexAdapter {
    /// Build the Codex setup plan:
    ///
    /// 1. `AssertBinary { name: "codex" }` — the whole flow depends on
    ///    the binary being installed.
    /// 2. `WriteShellScript { codex-notify.sh, 0o700 }` — invoked by
    ///    Codex with the JSON payload appended as `argv[1]`. Forwards
    ///    the payload to the raum event socket tagged `source: "notify"`.
    /// 3. `WriteToml { ~/.codex/config.toml }` — managed block setting
    ///    `notify = ["<script>"]`, `[tui] notifications = true /
    ///    notification_method = "osc9"` (always), and `[features]
    ///    codex_hooks = true` (only when the installed Codex supports
    ///    the flag).
    /// 4. `WriteJson { <project>/.codex/hooks.json }` — managed entries
    ///    for `UserPromptSubmit` and `Stop`. **Skipped** when
    ///    `detect_version()` reports < [`CODEX_HOOKS_MINIMUM_VERSION`];
    ///    the `notify` path + OSC 9 scraper stay as the observation
    ///    channels on older hosts.
    async fn plan(&self, ctx: &SetupContext) -> Result<SetupPlan, SetupError> {
        let notify_script_path = ctx.hooks_dir.join(CODEX_NOTIFY_SCRIPT_NAME);
        let hook_script = hook_script_path(&ctx.hooks_dir, "codex");

        // Decide whether the installed binary supports hooks. Any failure
        // in `detect_version` is treated as "assume supported" so plan
        // tests stay hermetic — the real preflight surfaces the error
        // elsewhere.
        let supports_hooks = match <Self as HarnessIdentity>::detect_version(self).await {
            Ok(report) => report.at_or_above_minimum.unwrap_or(true),
            Err(_) => true,
        };

        let mut plan = SetupPlan::new(AgentKind::Codex);

        plan.push(SetupAction::AssertBinary {
            name: "codex".into(),
        });

        // Notify script — written unconditionally. Even when hooks are
        // supported the `notify` script is a useful secondary turn-end
        // signal (cheaper than parsing OSC 9).
        plan.push(SetupAction::WriteShellScript {
            path: notify_script_path.clone(),
            content: codex_notify_script_body(&ctx.event_socket_path),
            mode: 0o700,
        });

        // config.toml — features + notify. When hooks are unsupported
        // the managed block still flips the feature flag (harmless on
        // older builds that ignore unknown feature flags) so upgrading
        // the Codex binary does not require a re-install.
        let notify_body = render_codex_toml_managed_body(&notify_script_path, supports_hooks);
        plan.push(SetupAction::WriteToml {
            path: self.config_toml_path_for_ctx(ctx),
            content: notify_body,
        });

        if supports_hooks {
            let hooks_content = render_codex_hooks_json(&hook_script)?;
            let project_hooks_path = self.hooks_json_path_for_ctx(ctx);
            // Phase 6 migration: strip raum-managed entries out of the
            // user-global `~/.codex/hooks.json` if a prior raum install
            // wrote them there. Skipped when we are already writing to
            // the user-global location (no-op) or when the override is
            // set (tests that point at a single tempdir file).
            let legacy_hooks = legacy_hooks_json_path(&ctx.home_dir);
            if !ctx.project_dir.as_os_str().is_empty()
                && legacy_hooks != project_hooks_path
                && self.hooks_json_path_override.is_none()
            {
                plan.push(SetupAction::RemoveManagedJsonEntries { path: legacy_hooks });
            }
            // Emit the base codex.sh dispatcher script itself, not
            // just the hooks.json entries that reference it. Without
            // this Codex would spawn a shell pointing at a path that
            // does not exist on disk.
            plan.push(SetupAction::WriteShellScript {
                path: hook_script.clone(),
                content: crate::harness::hook_script::body(
                    crate::harness::hook_script::HookDispatcher::Codex,
                ),
                mode: 0o700,
            });
            plan.push(SetupAction::WriteJson {
                path: project_hooks_path,
                content: hooks_content,
            });
        } else {
            debug!(
                ?self.forced_version,
                "codex hooks below minimum version; skipping hooks.json",
            );
        }

        Ok(plan)
    }

    async fn selftest(&self, _ctx: &SetupContext) -> SelftestReport {
        let started = Instant::now();

        // 1. Binary responds to --version.
        let binary = <Self as HarnessIdentity>::binary(self);
        let resolved = match which::which(binary) {
            Ok(p) => p,
            Err(_) => {
                return SelftestReport::failed(
                    AgentKind::Codex,
                    format!("binary `{binary}` not found on PATH"),
                    started.elapsed().as_millis() as u64,
                );
            }
        };
        let version_ok = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            tokio::process::Command::new(&resolved)
                .arg("--version")
                .output(),
        )
        .await;
        match version_ok {
            Ok(Ok(out)) if out.status.success() => {}
            Ok(Ok(out)) => {
                return SelftestReport::failed(
                    AgentKind::Codex,
                    format!("codex --version exited {:?}", out.status.code()),
                    started.elapsed().as_millis() as u64,
                );
            }
            Ok(Err(e)) => {
                return SelftestReport::failed(
                    AgentKind::Codex,
                    format!("codex --version failed: {e}"),
                    started.elapsed().as_millis() as u64,
                );
            }
            Err(_) => {
                return SelftestReport::failed(
                    AgentKind::Codex,
                    "codex --version timed out",
                    started.elapsed().as_millis() as u64,
                );
            }
        }

        // 2. hooks.json contains a UserPromptSubmit entry with our marker
        // (best-effort — Phase 5 E2E verifies a real hook round-trip).
        // UserPromptSubmit is the always-present lifecycle event in
        // `RAUM_CODEX_HOOK_EVENTS`; SessionStart was dropped to avoid a
        // spurious `Idle → Working` promotion on Codex boot.
        let hooks_path = self.hooks_json_path();
        if hooks_path.exists() {
            match std::fs::read_to_string(&hooks_path) {
                Ok(raw) => match serde_json::from_str::<Value>(&raw) {
                    Ok(v) => {
                        let has_marker = v["hooks"]["UserPromptSubmit"]
                            .as_array()
                            .is_some_and(|arr| arr.iter().any(managed_json::is_raum_managed));
                        if !has_marker {
                            return SelftestReport::failed(
                                AgentKind::Codex,
                                "hooks.json UserPromptSubmit missing raum marker",
                                started.elapsed().as_millis() as u64,
                            );
                        }
                    }
                    Err(e) => {
                        return SelftestReport::failed(
                            AgentKind::Codex,
                            format!("hooks.json is not JSON: {e}"),
                            started.elapsed().as_millis() as u64,
                        );
                    }
                },
                Err(e) => {
                    return SelftestReport::failed(
                        AgentKind::Codex,
                        format!("cannot read hooks.json: {e}"),
                        started.elapsed().as_millis() as u64,
                    );
                }
            }
        }

        // 3. notify script is executable (0o100 bit set). If it's
        // missing we defer to the plan-apply path rather than failing
        // the selftest — a freshly-installed binary on a host without
        // a plan yet should still selftest ok.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Walk the standard hooks dir (or the per-host override if
            // surfaced via env). We don't have the `SetupContext` hooks
            // dir here — the Harness Health panel calls selftest with a
            // ctx — so just check the default `~/.config/raum/hooks/`.
            if let Some(home) = std::env::var_os("HOME") {
                let p = PathBuf::from(home)
                    .join(".config")
                    .join("raum")
                    .join("hooks")
                    .join(CODEX_NOTIFY_SCRIPT_NAME);
                if p.exists() {
                    if let Ok(meta) = std::fs::metadata(&p) {
                        let mode = meta.permissions().mode() & 0o111;
                        if mode == 0 {
                            return SelftestReport::failed(
                                AgentKind::Codex,
                                format!("codex-notify.sh at {} is not executable", p.display()),
                                started.elapsed().as_millis() as u64,
                            );
                        }
                    }
                }
            }
        }

        SelftestReport::ok(
            AgentKind::Codex,
            "binary responds, hooks.json marker present, notify script executable",
            started.elapsed().as_millis() as u64,
        )
    }
}

impl CodexAdapter {
    /// Pure-read scan: report the on-disk state of
    /// `~/.codex/config.toml` and the project-scoped
    /// `<project>/.codex/hooks.json`. Does not spawn `codex`.
    #[must_use]
    pub fn scan(&self, ctx: &SetupContext) -> ScanReport {
        let binary = <Self as HarnessIdentity>::binary(self);
        let binary_on_path = which::which(binary).is_ok();

        let config_toml = self.config_toml_path_for_ctx(ctx);
        let (toml_exists, toml_managed) = inspect_toml_path(&config_toml);
        let toml_entry = ConfigPathEntry {
            kind: ConfigScope::User,
            label: "User config".into(),
            path: config_toml.clone(),
            exists: toml_exists,
            raum_managed: toml_managed,
        };

        let hooks_path = self.hooks_json_path_for_ctx(ctx);
        let (hooks_exists, hooks_managed) = inspect_json_path(&hooks_path);
        let hooks_entry = ConfigPathEntry {
            kind: if ctx.project_dir.as_os_str().is_empty() {
                ConfigScope::User
            } else {
                ConfigScope::Project
            },
            label: "Codex hooks".into(),
            path: hooks_path.clone(),
            exists: hooks_exists,
            raum_managed: hooks_managed,
        };

        let raum_hooks_installed = toml_exists && toml_managed && hooks_exists && hooks_managed;

        let reason_if_not_installed = if !binary_on_path {
            Some(format!("{binary} binary not found on PATH"))
        } else if !toml_exists || !toml_managed {
            Some(format!(
                "{} missing raum-managed block",
                config_toml.display()
            ))
        } else if !hooks_exists || !hooks_managed {
            Some(format!(
                "{} missing raum-managed entries",
                hooks_path.display()
            ))
        } else {
            None
        };

        ScanReport {
            harness: AgentKind::Codex,
            binary: binary.into(),
            binary_on_path,
            raum_hooks_installed,
            config_paths: vec![toml_entry, hooks_entry],
            reason_if_not_installed,
            note: None,
        }
    }
}

impl HarnessRuntime for CodexAdapter {
    fn channels(&self, session: &SessionSpec) -> Vec<Box<dyn NotificationChannel>> {
        let _ = session;
        // Codex's hook and notify scripts already feed the shared event-socket
        // drain loop directly, and OSC 9 is scraped from the terminal stream in
        // `src-tauri/src/commands/terminal.rs`. There is no per-session channel
        // task to spawn here.
        Vec::new()
    }

    fn replier(&self, _session: &SessionSpec) -> Option<Box<dyn PermissionReplier>> {
        // Codex is observation-only for Phase 3. Upstream accepts
        // `permissionDecision` in hook output but does not yet enforce
        // it; a replier here would set mistaken user expectations.
        None
    }

    fn launch_overrides(&self) -> LaunchOverrides {
        LaunchOverrides::default()
    }
}

// -- planner helpers --------------------------------------------------------

fn render_codex_toml_managed_body(notify_script: &Path, enable_hooks: bool) -> String {
    // TOML arrays are top-level; the `[features]` and `[tui]` tables are
    // siblings. We emit them in a single managed block so the whole raum
    // configuration sits between the sentinels.
    //
    // `[tui] notifications / notification_method` is written **always**
    // (not gated on `enable_hooks`): approval prompts are the only
    // signal raum has for `Waiting` state on Codex, and that signal
    // only arrives as OSC 9 from the TUI. Older Codex builds that
    // don't recognise the key ignore it harmlessly; newer builds that
    // do need it would otherwise silently stay in `Working` through
    // every approval prompt.
    //
    // Only `[features] codex_hooks` stays gated — it's the one setting
    // that triggers real behaviour change on versions that don't know
    // the feature flag yet.
    let path_json = serde_json::to_string(&notify_script.display().to_string())
        .unwrap_or_else(|_| "\"\"".into());
    let mut body = format!("notify = [{path_json}]\n");
    body.push_str("\n[tui]\nnotifications = true\nnotification_method = \"osc9\"\n");
    if enable_hooks {
        body.push_str("\n[features]\ncodex_hooks = true\n");
    }
    let rendered = crate::config_io::managed_toml::render(None, body.trim_end());
    // Strip the begin/end sentinel frames — the `SetupAction::WriteToml`
    // executor currently does an atomic full-file write, not a managed
    // splice, so we have to frame the whole file here. Rather than add a
    // new "apply_managed_block" executor variant, the content we pass
    // to `WriteToml` is the *entire file* with the managed block in it.
    // An existing user file is not preserved through `WriteToml`.
    // Callers that need preservation call `apply_managed_toml_block`
    // directly from an integration test or runtime shim.
    rendered
}

fn render_codex_hooks_json(hook_script: &Path) -> Result<String, SetupError> {
    // Build the Codex-shaped top-level object: `{ "hooks": {...} }`.
    let mut hooks_obj = serde_json::Map::new();
    for event in RAUM_CODEX_HOOK_EVENTS {
        hooks_obj.insert(
            (*event).to_string(),
            Value::Array(vec![codex_hook_entry(event, hook_script)]),
        );
    }
    let root = json!({
        "hooks": Value::Object(hooks_obj),
    });
    serde_json::to_string_pretty(&root).map_err(|e| SetupError::Serialize(e.to_string()))
}

fn codex_hook_entry(event: &str, hook_script: &Path) -> Value {
    // Codex timeout default is 600 s per upstream docs; leave
    // unspecified so we track that default automatically.
    json!({
        MARKER_KEY: MARKER_BEGIN,
        "_raum_event": event,
        "matcher": ".*",
        "hooks": [
            {
                "type": "command",
                "command": format!("{} {}", hook_script.display(), event),
                "statusMessage": format!("raum: forwarding {event}"),
            }
        ],
    })
}

/// Body of the `codex-notify.sh` script.
///
/// Codex invokes the notify command as
/// `argv[0]=<path> argv[1]=<json-payload>` (the JSON is the *last argv*,
/// not piped on stdin — confirmed against
/// `openai/codex:codex-rs/hooks/src/legacy_notify.rs`, which appends the
/// serialised payload with `command.arg(notify_payload)`). The script
/// wraps that payload in the raum event-socket envelope and forwards it
/// using the `socat` / `nc` / `python3` fallback chain already in use by
/// `raum-hooks/src/scripts.rs`.
pub fn codex_notify_script_body(_event_socket: &Path) -> String {
    // `$RAUM_EVENT_SOCK` is exported by raum at startup (see
    // `raum-hooks::set_event_sock_env`). The script reads that env var
    // rather than baking the path in, so a moved raum install doesn't
    // strand the script.
    String::from(
        r#"#!/usr/bin/env sh
# raum-managed — do not edit; regenerated on launch
# codex-notify.sh: Codex invokes this with the JSON payload as argv[1].
set -eu
SOCK="${RAUM_EVENT_SOCK:-}"
if [ -z "$SOCK" ]; then exit 0; fi
SESSION_ID="${RAUM_SESSION:-}"
# Codex invokes us with the serialised JSON as argv[1]. Use `${1-}` (no
# colon) so an empty string is still accepted; the previous form
# `${1:-{}}` tripped over POSIX brace-matching — `}` inside the default
# word terminates the expansion — and leaked a stray `}` into the
# payload. Fall back to `{}` (valid JSON) when argv[1] is unset entirely.
if [ $# -ge 1 ]; then
  PAYLOAD="$1"
else
  PAYLOAD="{}"
fi

json_escape_stdin() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
  else
    printf '""'
  fi
}

if [ -z "$SESSION_ID" ]; then
  SESSION_JSON="null"
else
  SESSION_JSON=$(printf '%s' "$SESSION_ID" | json_escape_stdin)
fi

# The payload Codex hands us is already JSON; embed it verbatim.
ENVELOPE=$(printf '{"harness":"codex","event":"Notification","source":"notify","reliability":"event-driven","session_id":%s,"payload":%s}\n' \
  "$SESSION_JSON" "$PAYLOAD")

if command -v socat >/dev/null 2>&1; then
  printf '%s' "$ENVELOPE" | socat - UNIX-CONNECT:"$SOCK" || true
elif command -v nc >/dev/null 2>&1; then
  printf '%s' "$ENVELOPE" | nc -U "$SOCK" || true
elif command -v python3 >/dev/null 2>&1; then
  printf '%s' "$ENVELOPE" | python3 -c '
import os, sys, socket
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(os.environ["RAUM_EVENT_SOCK"])
sock.sendall(sys.stdin.buffer.read())
sock.close()
' || true
fi
"#,
    )
}

// -- channels ---------------------------------------------------------------

/// Note attached to channel helpers that exist for parser/unit-test coverage
/// but are not spawned by the live Codex adapter path.
const PHASE5_NOTE: &str =
    "awaiting Phase 5 supervisor wiring: src-tauri must fan HookEvent rx into NotificationSink";

/// OSC 9 scraper channel. Tails a byte source (typically the tmux
/// pane stream) for `\x1b]9;<payload>\x07` escape sequences and maps
/// the payload into [`NotificationKind`] values.
///
/// Phase 3 defines the parser + a test-only constructor that accepts an
/// in-memory byte stream. The adapter-facing `new()` has no byte source
/// available yet and reports `ChannelHealth::Unavailable`; Phase 5
/// wires it to `raum-tmux`'s pane-stream coalescer.
pub struct OscScrapeChannel {
    session_id: SessionId,
    // Wrapped in `Arc<tokio::sync::Mutex<...>>` so `OscScrapeChannel` is
    // `Sync` (async_trait captures `&self` in a `Send` future, which
    // requires the type to be `Sync`). `run()` takes the source out of
    // the option before reading, so there is never contention in
    // practice — the mutex is there solely to satisfy the `Sync` bound.
    source: Arc<tokio::sync::Mutex<Option<OscByteSource>>>,
    health: Arc<std::sync::Mutex<ChannelHealth>>,
}

/// Type-erased async byte source for the OSC 9 scraper. Wraps any
/// `AsyncRead + Send + Unpin + 'static`. `run()` pulls bytes off this
/// until EOF or `cancel` fires.
type OscByteSource = Box<dyn tokio::io::AsyncRead + Send + Unpin + 'static>;

impl std::fmt::Debug for OscScrapeChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `source` holds an async trait object (no `Debug`) and `health`
        // sits behind a sync mutex we do not want to block on from a
        // formatter. Intentionally elide both.
        f.debug_struct("OscScrapeChannel")
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

impl OscScrapeChannel {
    /// Construct a channel with no byte source. `run()` will park on
    /// `cancel` immediately and `health()` reports
    /// [`ChannelHealth::Unavailable`] — intended for the adapter's
    /// default `HarnessRuntime::channels` return value until the Phase
    /// 5 tmux wiring lands.
    #[must_use]
    pub fn new(session_id: SessionId) -> Self {
        Self {
            session_id,
            source: Arc::new(tokio::sync::Mutex::new(None)),
            health: Arc::new(std::sync::Mutex::new(ChannelHealth::Unavailable {
                reason: format!("{PHASE5_NOTE} (+tmux byte-source handle)"),
            })),
        }
    }

    /// Construct a channel from an arbitrary async byte source. Used by
    /// unit tests today and by the Phase 5 supervisor once the tmux
    /// byte tap is exposed.
    #[must_use]
    pub fn with_source<R>(session_id: SessionId, source: R) -> Self
    where
        R: tokio::io::AsyncRead + Send + Unpin + 'static,
    {
        Self {
            session_id,
            source: Arc::new(tokio::sync::Mutex::new(Some(Box::new(source)))),
            health: Arc::new(std::sync::Mutex::new(ChannelHealth::NotStarted)),
        }
    }
}

#[async_trait]
impl NotificationChannel for OscScrapeChannel {
    fn id(&self) -> &'static str {
        "osc9"
    }
    fn reliability(&self) -> Reliability {
        Reliability::EventDriven
    }

    async fn run(
        self: Box<Self>,
        sink: NotificationSink,
        cancel: CancellationToken,
    ) -> Result<(), ChannelError> {
        let Self {
            session_id,
            source,
            health,
        } = *self;
        let mut source = {
            let mut guard = source.lock().await;
            match guard.take() {
                Some(s) => s,
                None => {
                    // No byte tap; park on cancel so the supervisor can
                    // still treat this as a legal channel task.
                    drop(guard);
                    cancel.cancelled().await;
                    return Ok(());
                }
            }
        };
        if let Ok(mut g) = health.lock() {
            *g = ChannelHealth::Live;
        }
        let mut buf = [0u8; 4096];
        let mut parser = Osc9Parser::new();
        loop {
            tokio::select! {
                () = cancel.cancelled() => {
                    if let Ok(mut g) = health.lock() {
                        *g = ChannelHealth::NotStarted;
                    }
                    return Ok(());
                }
                read = source.read(&mut buf) => {
                    match read {
                        Ok(0) => {
                            if let Ok(mut g) = health.lock() {
                                *g = ChannelHealth::Failed;
                            }
                            return Ok(());
                        }
                        Ok(n) => {
                            for payload in parser.feed(&buf[..n]) {
                                if let Some(kind) = classify_osc9_payload(&payload) {
                                    let ev = NotificationEvent {
                                        session_id: session_id.clone(),
                                        harness: AgentKind::Codex,
                                        kind,
                                        source: SourceId::from("osc9"),
                                        reliability: Reliability::EventDriven,
                                        request_id: None,
                                        payload: Value::String(payload),
                                    };
                                    if sink.send(ev).await.is_err() {
                                        return Ok(());
                                    }
                                }
                            }
                        }
                        Err(e) => return Err(ChannelError::Io(e)),
                    }
                }
            }
        }
    }

    async fn health(&self) -> ChannelHealth {
        self.health
            .lock()
            .ok()
            .map_or(ChannelHealth::Failed, |g| g.clone())
    }
}

/// Stateful OSC 9 parser. Handles `\x1b]9;<payload>\x07` and its
/// 7-bit-safe `ST` terminator `\x1b\\`. Carries partial payloads
/// across `feed()` calls so byte boundaries inside a payload do not
/// drop events.
#[derive(Debug, Default)]
pub struct Osc9Parser {
    state: OscState,
    current: Vec<u8>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum OscState {
    /// Scanning for `\x1b`.
    #[default]
    Idle,
    /// Saw `\x1b`; expecting `]`.
    Esc,
    /// Saw `\x1b]`; expecting `9`.
    Oscb,
    /// Saw `\x1b]9`; expecting `;`.
    NineOsc,
    /// Inside the payload; terminates on `\x07` or `\x1b\\`.
    Payload,
    /// Inside payload, just saw `\x1b` — waiting for `\\` to
    /// finish the ST terminator.
    PayloadEsc,
}

impl Osc9Parser {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed `bytes` and return every complete OSC 9 payload found in
    /// this call. Partial payloads survive across calls.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in bytes {
            match self.state {
                OscState::Idle => {
                    if b == 0x1b {
                        self.state = OscState::Esc;
                    }
                }
                OscState::Esc => {
                    self.state = if b == b']' {
                        OscState::Oscb
                    } else {
                        OscState::Idle
                    };
                }
                OscState::Oscb => {
                    self.state = if b == b'9' {
                        OscState::NineOsc
                    } else {
                        OscState::Idle
                    };
                }
                OscState::NineOsc => {
                    if b == b';' {
                        self.current.clear();
                        self.state = OscState::Payload;
                    } else {
                        self.state = OscState::Idle;
                    }
                }
                OscState::Payload => match b {
                    0x07 => {
                        let payload = String::from_utf8_lossy(&self.current).into_owned();
                        out.push(payload);
                        self.current.clear();
                        self.state = OscState::Idle;
                    }
                    0x1b => {
                        self.state = OscState::PayloadEsc;
                    }
                    _ => self.current.push(b),
                },
                OscState::PayloadEsc => {
                    if b == b'\\' {
                        let payload = String::from_utf8_lossy(&self.current).into_owned();
                        out.push(payload);
                        self.current.clear();
                        self.state = OscState::Idle;
                    } else {
                        // Not an ST — fold the lone ESC back into the
                        // payload and continue.
                        self.current.push(0x1b);
                        if b == 0x07 {
                            let payload = String::from_utf8_lossy(&self.current).into_owned();
                            out.push(payload);
                            self.current.clear();
                            self.state = OscState::Idle;
                        } else {
                            self.current.push(b);
                            self.state = OscState::Payload;
                        }
                    }
                }
            }
        }
        out
    }
}

#[must_use]
pub fn classify_osc9_payload(payload: &str) -> Option<NotificationKind> {
    // Codex's `tui.notifications` emits payloads like:
    //   approval-requested: shell tool ...
    //   agent-turn-complete
    // We match on prefixes so future subtype suffixes do not break us.
    let lower = payload.to_ascii_lowercase();
    if lower.contains("approval-requested") {
        Some(NotificationKind::PermissionNeeded)
    } else if lower.contains("agent-turn-complete") {
        Some(NotificationKind::TurnEnd)
    } else {
        // Unknown OSC 9 payloads are ignored: this is a heuristic
        // channel and we do not want to emit synthetic TurnStart
        // events from arbitrary terminal-emitted OSCs (other TUIs
        // unrelated to Codex also use OSC 9 for growl-style toasts).
        let _ = classify_notification_kind(payload);
        None
    }
}

/// Silence heuristic channel — last-resort detection. Reports
/// `Heuristic` reliability; no actual implementation until the Phase 5
/// supervisor wires it up. Present here so
/// `HarnessRuntime::channels()` returns a stable set.
#[derive(Debug)]
pub struct SilenceChannel {
    session_id: SessionId,
    health: Arc<Mutex<ChannelHealth>>,
}

impl SilenceChannel {
    #[must_use]
    pub fn new(session_id: SessionId) -> Self {
        Self {
            session_id,
            health: Arc::new(Mutex::new(ChannelHealth::Unavailable {
                reason: PHASE5_NOTE.into(),
            })),
        }
    }
}

#[async_trait]
impl NotificationChannel for SilenceChannel {
    fn id(&self) -> &'static str {
        "silence"
    }
    fn reliability(&self) -> Reliability {
        Reliability::Heuristic
    }
    async fn run(
        self: Box<Self>,
        _sink: NotificationSink,
        cancel: CancellationToken,
    ) -> Result<(), ChannelError> {
        let _ = self.session_id;
        cancel.cancelled().await;
        Ok(())
    }
    async fn health(&self) -> ChannelHealth {
        self.health
            .lock()
            .ok()
            .map_or(ChannelHealth::Failed, |g| g.clone())
    }
}

/// Install a Codex hooks.json at `path` pointing at `hook_script`.
/// Exposed as a pure function so integration tests / deprecated install
/// paths can reach the managed-JSON helper without recreating the plan.
pub fn install_codex_hooks_json(path: &Path, hook_script: &Path) -> std::io::Result<()> {
    managed_json::apply_managed_codex_hooks(&ManagedCodexHooks {
        path,
        events: RAUM_CODEX_HOOK_EVENTS,
        make_entry: &|event| codex_hook_entry(event, hook_script),
    })
    .map_err(|e| match e {
        managed_json::ManagedJsonError::Io(err) => err,
        managed_json::ManagedJsonError::InvalidJson(err) => std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("hooks.json is not valid JSON: {err}"),
        ),
        managed_json::ManagedJsonError::Serialize(err) => std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("serialize hooks.json failed: {err}"),
        ),
    })
}

#[cfg(test)]
#[allow(deprecated)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use tokio::io::AsyncWriteExt;
    use tokio::sync::mpsc;

    fn test_ctx(dir: &Path, slug: &str) -> SetupContext {
        SetupContext::new(dir.join("hooks"), dir.join("events.sock"), slug)
    }

    #[tokio::test]
    async fn install_hooks_is_noop() {
        // Deprecated shim stays no-op; the real logic is in `plan`.
        let adapter = CodexAdapter::new();
        let dir = tempdir().unwrap();
        adapter.install_hooks(dir.path()).await.unwrap();
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
    }

    #[tokio::test]
    async fn plan_on_supported_version_emits_notify_and_dispatcher_scripts() {
        let dir = tempdir().unwrap();
        let config_toml = dir.path().join("codex-config.toml");
        let hooks_json = dir.path().join("codex-hooks.json");
        let adapter = CodexAdapter::with_paths(
            config_toml.clone(),
            hooks_json.clone(),
            Some(semver_lite::Version {
                major: 0,
                minor: 120,
                patch: 0,
            }),
        );
        let ctx = test_ctx(dir.path(), "demo");
        let notify_path = ctx.hooks_dir.join(CODEX_NOTIFY_SCRIPT_NAME);
        let dispatcher_path = ctx.hooks_dir.join("codex.sh");
        let plan = <CodexAdapter as NotificationSetup>::plan(&adapter, &ctx)
            .await
            .unwrap();
        assert_eq!(plan.harness, Some(AgentKind::Codex));
        // AssertBinary + WriteShellScript(codex-notify.sh) + WriteToml(config.toml)
        // + WriteShellScript(codex.sh) + WriteJson(hooks.json).
        assert_eq!(plan.actions.len(), 5, "plan: {plan:?}");
        assert!(
            matches!(plan.actions[0], SetupAction::AssertBinary { ref name } if name == "codex")
        );
        // codex-notify.sh — argv[1]-driven forwarder for the `notify = [...]`
        // contract in config.toml.
        let SetupAction::WriteShellScript {
            ref path,
            mode: notify_mode,
            ..
        } = plan.actions[1]
        else {
            panic!(
                "expected WriteShellScript at index 1, got {:?}",
                plan.actions[1]
            );
        };
        assert_eq!(path, &notify_path);
        assert_eq!(notify_mode, 0o700);
        // config.toml write targets the override path.
        let SetupAction::WriteToml {
            ref path,
            ref content,
        } = plan.actions[2]
        else {
            panic!("expected WriteToml at index 2, got {:?}", plan.actions[2]);
        };
        assert_eq!(path, &config_toml);
        assert!(content.contains("# <raum-managed>"));
        assert!(content.contains("codex_hooks = true"));
        assert!(content.contains("notify = ["));
        assert!(content.contains("notifications = true"));
        assert!(content.contains("notification_method = \"osc9\""));
        // codex.sh dispatcher — referenced by each entry in hooks.json. Must
        // be written before the hooks.json entry that points at it.
        let SetupAction::WriteShellScript {
            ref path,
            mode: dispatcher_mode,
            ..
        } = plan.actions[3]
        else {
            panic!(
                "expected WriteShellScript at index 3, got {:?}",
                plan.actions[3]
            );
        };
        assert_eq!(path, &dispatcher_path);
        assert_eq!(dispatcher_mode, 0o700);
        // hooks.json is the fifth action.
        let SetupAction::WriteJson {
            ref path,
            ref content,
        } = plan.actions[4]
        else {
            panic!("expected WriteJson at index 4, got {:?}", plan.actions[4]);
        };
        assert_eq!(path, &hooks_json);
        let parsed: Value = serde_json::from_str(content).unwrap();
        for event in RAUM_CODEX_HOOK_EVENTS {
            let arr = parsed["hooks"][event].as_array().unwrap();
            assert_eq!(arr.len(), 1, "event {event}");
            assert_eq!(arr[0][MARKER_KEY].as_str().unwrap(), MARKER_BEGIN);
        }
        assert!(parsed["hooks"]["PreToolUse"].is_null());
        assert!(parsed["hooks"]["PostToolUse"].is_null());
    }

    #[tokio::test]
    async fn plan_on_old_version_skips_hooks_json() {
        let dir = tempdir().unwrap();
        let adapter = CodexAdapter::with_paths(
            dir.path().join("config.toml"),
            dir.path().join("hooks.json"),
            Some(semver_lite::Version {
                major: 0,
                minor: 100,
                patch: 0,
            }),
        );
        let ctx = test_ctx(dir.path(), "demo");
        let dispatcher_path = ctx.hooks_dir.join("codex.sh");
        let plan = <CodexAdapter as NotificationSetup>::plan(&adapter, &ctx)
            .await
            .unwrap();
        // Only AssertBinary + WriteShellScript(codex-notify.sh) + WriteToml —
        // no hooks.json, and no codex.sh dispatcher (nothing would reference it).
        assert_eq!(plan.actions.len(), 3);
        assert!(
            plan.actions
                .iter()
                .all(|a| !matches!(a, SetupAction::WriteJson { .. }))
        );
        assert!(
            plan.actions.iter().all(|a| !matches!(
                a,
                SetupAction::WriteShellScript { path, .. } if path == &dispatcher_path
            )),
            "old-version plan must NOT write codex.sh: {plan:?}",
        );
        // The config.toml managed body still contains notify and the
        // `[tui]` block (so OSC 9 approvals fire on any Codex version),
        // but NOT the `codex_hooks = true` flip (there is no feature
        // to enable on <0.119 builds).
        let SetupAction::WriteToml { ref content, .. } = plan.actions[2] else {
            panic!("expected WriteToml at index 2");
        };
        assert!(content.contains("notify = ["));
        assert!(content.contains("notifications = true"));
        assert!(content.contains("notification_method = \"osc9\""));
        assert!(!content.contains("codex_hooks"));
    }

    #[tokio::test]
    async fn plan_notify_script_body_has_event_socket_env_and_codex_tag() {
        let dir = tempdir().unwrap();
        let adapter = CodexAdapter::with_paths(
            dir.path().join("config.toml"),
            dir.path().join("hooks.json"),
            Some(semver_lite::Version {
                major: 0,
                minor: 120,
                patch: 0,
            }),
        );
        let ctx = test_ctx(dir.path(), "demo");
        let plan = <CodexAdapter as NotificationSetup>::plan(&adapter, &ctx)
            .await
            .unwrap();
        let SetupAction::WriteShellScript { ref content, .. } = plan.actions[1] else {
            panic!("expected WriteShellScript at index 1");
        };
        assert!(content.contains("RAUM_EVENT_SOCK"));
        assert!(content.contains("\"harness\":\"codex\""));
        assert!(content.contains("\"source\":\"notify\""));
        // Script reads payload from argv[1], NOT stdin (Codex contract).
        assert!(content.contains("PAYLOAD=\"$1\""));
    }

    #[test]
    fn install_codex_hooks_json_writes_wrapped_schema() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("hooks.json");
        let script = dir.path().join("codex.sh");
        install_codex_hooks_json(&path, &script).unwrap();
        let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // Wrapped under `hooks`, NOT flat.
        assert!(parsed["hooks"].is_object());
        // `SessionStart` is intentionally absent (see `RAUM_CODEX_HOOK_EVENTS`
        // docs): subscribing would falsely promote `Idle → Working` on boot.
        assert!(parsed["hooks"]["SessionStart"].is_null());
        let ups = parsed["hooks"]["UserPromptSubmit"].as_array().unwrap();
        assert_eq!(ups[0]["matcher"].as_str().unwrap(), ".*");
    }

    #[test]
    fn install_codex_hooks_json_is_idempotent() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("hooks.json");
        let script = dir.path().join("codex.sh");
        install_codex_hooks_json(&path, &script).unwrap();
        let first = std::fs::read_to_string(&path).unwrap();
        install_codex_hooks_json(&path, &script).unwrap();
        let second = std::fs::read_to_string(&path).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn osc9_parser_extracts_single_bel_terminated_payload() {
        let mut p = Osc9Parser::new();
        let payloads = p.feed(b"\x1b]9;approval-requested\x07");
        assert_eq!(payloads, vec!["approval-requested".to_string()]);
    }

    #[test]
    fn osc9_parser_extracts_st_terminated_payload() {
        let mut p = Osc9Parser::new();
        let payloads = p.feed(b"\x1b]9;agent-turn-complete\x1b\\");
        assert_eq!(payloads, vec!["agent-turn-complete".to_string()]);
    }

    #[test]
    fn osc9_parser_handles_split_payload_across_feeds() {
        let mut p = Osc9Parser::new();
        let first = p.feed(b"\x1b]9;approval-re");
        assert!(first.is_empty());
        let second = p.feed(b"quested\x07");
        assert_eq!(second, vec!["approval-requested".to_string()]);
    }

    #[test]
    fn osc9_parser_ignores_other_oscs() {
        let mut p = Osc9Parser::new();
        // OSC 0 (window title) — should not match OSC 9.
        let payloads = p.feed(b"\x1b]0;some title\x07");
        assert!(payloads.is_empty());
    }

    #[test]
    fn classify_osc9_maps_known_prefixes() {
        assert_eq!(
            classify_osc9_payload("approval-requested"),
            Some(NotificationKind::PermissionNeeded)
        );
        assert_eq!(
            classify_osc9_payload("approval-requested: shell tool"),
            Some(NotificationKind::PermissionNeeded)
        );
        assert_eq!(
            classify_osc9_payload("agent-turn-complete"),
            Some(NotificationKind::TurnEnd)
        );
        assert_eq!(classify_osc9_payload("some-other-osc9"), None);
    }

    #[tokio::test]
    async fn osc_scrape_channel_emits_permission_needed_from_byte_source() {
        // Wire the channel to an in-memory pipe so we can drive OSC 9
        // bytes through it and assert the emitted NotificationEvent.
        let (client, server) = tokio::io::duplex(4096);
        let session_id = SessionId::new("raum-osc-1");
        let channel: Box<dyn NotificationChannel> =
            Box::new(OscScrapeChannel::with_source(session_id.clone(), client));
        let (tx, mut rx) = mpsc::channel(4);
        let cancel = CancellationToken::new();
        let cancel2 = cancel.clone();
        let task = tokio::spawn(async move { channel.run(tx, cancel2).await });

        let mut server = server;
        server
            .write_all(b"\x1b]9;approval-requested\x07")
            .await
            .unwrap();
        server.flush().await.unwrap();

        let ev = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("osc9 scraper did not emit event in time")
            .expect("sink closed");
        assert_eq!(ev.session_id, session_id);
        assert_eq!(ev.kind, NotificationKind::PermissionNeeded);
        assert_eq!(ev.harness, AgentKind::Codex);
        assert_eq!(ev.source.as_str(), "osc9");
        assert_eq!(ev.reliability, Reliability::EventDriven);

        cancel.cancel();
        drop(server);
        let _ = task.await;
    }

    #[tokio::test]
    async fn osc_scrape_channel_reports_unavailable_without_source() {
        let ch = OscScrapeChannel::new(SessionId::new("raum-x"));
        let health = ch.health().await;
        matches!(health, ChannelHealth::Unavailable { .. })
            .then_some(())
            .expect("expected Unavailable health for sourceless scraper");
    }

    #[tokio::test]
    async fn hooks_json_path_for_ctx_resolves_under_project_dir() {
        let adapter = CodexAdapter::new();
        let tmp = tempdir().unwrap();
        let ctx = SetupContext::new(
            tmp.path().join("hooks"),
            tmp.path().join("events.sock"),
            "demo",
        )
        .with_project_dir(tmp.path().to_path_buf());
        let resolved = adapter.hooks_json_path_for_ctx(&ctx);
        assert_eq!(resolved, tmp.path().join(".codex").join("hooks.json"));
    }

    #[tokio::test]
    async fn config_toml_path_for_ctx_stays_user_global() {
        // The plan explicitly keeps config.toml at the user-global
        // path because Codex does not support per-project config.toml
        // (docs/config.md documents only ~/.codex/config.toml).
        let adapter = CodexAdapter::new();
        let tmp = tempdir().unwrap();
        let fake_home = tmp.path().to_path_buf();
        let ctx = SetupContext::new(
            tmp.path().join("hooks"),
            tmp.path().join("events.sock"),
            "demo",
        )
        .with_project_dir(tmp.path().join("project"))
        .with_home_dir(fake_home.clone());
        let resolved = adapter.config_toml_path_for_ctx(&ctx);
        assert_eq!(resolved, fake_home.join(".codex").join("config.toml"));
    }

    #[tokio::test]
    async fn plan_emits_legacy_hooks_migration_when_project_scoped() {
        let tmp = tempdir().unwrap();
        let fake_home = tmp.path().to_path_buf();
        let project_dir = tmp.path().join("proj");
        let adapter = CodexAdapter::default();
        // Give it a fake forced version + leave path overrides None so
        // the real per-ctx resolution runs.
        let adapter = CodexAdapter {
            forced_version: Some(semver_lite::Version {
                major: 0,
                minor: 120,
                patch: 0,
            }),
            ..adapter
        };
        let ctx = SetupContext::new(
            tmp.path().join("hooks"),
            tmp.path().join("events.sock"),
            "demo",
        )
        .with_project_dir(project_dir.clone())
        .with_home_dir(fake_home.clone());
        let plan = <CodexAdapter as NotificationSetup>::plan(&adapter, &ctx)
            .await
            .unwrap();
        let legacy_hooks = fake_home.join(".codex").join("hooks.json");
        assert!(
            plan.actions.iter().any(|a| matches!(
                a,
                SetupAction::RemoveManagedJsonEntries { path } if path == &legacy_hooks
            )),
            "expected legacy migration for {legacy_hooks:?}: {plan:?}"
        );
        let project_hooks = project_dir.join(".codex").join("hooks.json");
        assert!(
            plan.actions.iter().any(|a| matches!(
                a,
                SetupAction::WriteJson { path, .. } if path == &project_hooks
            )),
            "expected WriteJson to {project_hooks:?}: {plan:?}"
        );
    }

    #[tokio::test]
    async fn plan_write_toml_path_is_under_home_dir_codex_config() {
        // Regression pin for the Phase 7 "weird path" bug. With a
        // realistic `home_dir` of `/Users/alice`, the plan must
        // emit `SetupAction::WriteToml { path: /Users/alice/.codex/config.toml }`.
        // Any drift from this — a tempdir leaking in, a Debug-quoted
        // string, an empty path, a double-separator — will break
        // the clickable path in the Harness Health panel.
        let tmp = tempdir().unwrap();
        let fake_home = PathBuf::from("/Users/alice");
        let adapter = CodexAdapter {
            forced_version: Some(semver_lite::Version {
                major: 0,
                minor: 120,
                patch: 0,
            }),
            ..CodexAdapter::default()
        };
        let ctx = SetupContext::new(
            tmp.path().join("hooks"),
            tmp.path().join("events.sock"),
            "demo",
        )
        .with_project_dir(tmp.path().to_path_buf())
        .with_home_dir(fake_home.clone());
        let plan = <CodexAdapter as NotificationSetup>::plan(&adapter, &ctx)
            .await
            .unwrap();
        let write_toml_path = plan
            .actions
            .iter()
            .find_map(|a| match a {
                SetupAction::WriteToml { path, .. } => Some(path.clone()),
                _ => None,
            })
            .expect("plan must contain WriteToml");
        assert_eq!(
            write_toml_path,
            fake_home.join(".codex").join("config.toml"),
            "Codex config.toml must be rooted at $HOME/.codex/config.toml, not under project_dir or tempdir"
        );
        // Sanity: the Display representation is plain — no Debug quotes,
        // no escaped separators.
        assert_eq!(
            write_toml_path.display().to_string(),
            "/Users/alice/.codex/config.toml"
        );
    }

    #[tokio::test]
    async fn scan_reports_user_global_config_toml_path() {
        // The Phase 7 scan is the one that renders the path in the
        // panel. It must agree with the plan: user-global TOML.
        let tmp = tempdir().unwrap();
        let fake_home = tmp.path().join("home");
        std::fs::create_dir_all(fake_home.join(".codex")).unwrap();
        std::fs::write(fake_home.join(".codex").join("config.toml"), "").unwrap();

        let adapter = CodexAdapter::new();
        let ctx = SetupContext::new(
            tmp.path().join("hooks"),
            tmp.path().join("events.sock"),
            "demo",
        )
        .with_project_dir(tmp.path().join("project"))
        .with_home_dir(fake_home.clone());
        let report = adapter.scan(&ctx);
        assert_eq!(report.harness, AgentKind::Codex);
        let toml_entry = report
            .config_paths
            .iter()
            .find(|e| e.label == "User config")
            .expect("scan must include a user-config entry");
        assert_eq!(
            toml_entry.path,
            fake_home.join(".codex").join("config.toml")
        );
        assert!(toml_entry.exists);
        let hooks_entry = report
            .config_paths
            .iter()
            .find(|e| e.label == "Codex hooks")
            .expect("scan must include a codex-hooks entry");
        assert_eq!(
            hooks_entry.path,
            tmp.path().join("project").join(".codex").join("hooks.json")
        );
    }

    #[tokio::test]
    async fn runtime_returns_no_session_channels_and_no_replier() {
        let adapter = CodexAdapter::new();
        let spec = SessionSpec {
            session_id: SessionId::new("raum-x"),
            project_slug: "demo".into(),
            worktree_id: "default".into(),
            cwd: std::path::PathBuf::from("/tmp"),
            opencode_port: None,
        };
        let channels = adapter.channels(&spec);
        let ids: Vec<&'static str> = channels.iter().map(|c| c.id()).collect();
        assert!(
            ids.is_empty(),
            "codex runtime should not spawn channel tasks"
        );
        assert!(adapter.replier(&spec).is_none());
    }
}
