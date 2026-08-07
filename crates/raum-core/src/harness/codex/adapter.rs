//! Phase 2/3 trait split impls for [`CodexAdapter`].
//!
//! Houses the `HarnessIdentity`, `NotificationSetup`, and `HarnessRuntime`
//! implementations plus the pure-read `scan` helper. The deprecated
//! `AgentAdapter` shim and the adapter struct itself live in `mod.rs`.

use std::path::PathBuf;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::Value;
use tracing::debug;

use crate::agent::{AgentError, AgentKind, VersionReport, semver_lite};
use crate::config_io::managed_json;
use crate::harness::channel::NotificationChannel;
use crate::harness::reply::PermissionReplier;
use crate::harness::setup::{
    ConfigPathEntry, ConfigScope, ScanReport, SelftestReport, SetupAction, SetupContext,
    SetupError, SetupPlan, inspect_json_path, inspect_toml_path,
};
use crate::harness::traits::{
    HarnessIdentity, HarnessRuntime, LaunchOverrides, NotificationSetup, SessionSpec,
};

use super::hook_script_path;
use super::planner::{codex_notify_script_body, merge_codex_config_toml, merge_codex_hooks_json};
use super::{
    CODEX_HOOKS_MINIMUM_VERSION, CODEX_NOTIFY_SCRIPT_NAME, CodexAdapter, legacy_hooks_json_path,
};

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
        crate::harness::claude_code::run_version(
            <Self as HarnessIdentity>::binary(self),
            &<Self as HarnessIdentity>::minimum_version(self),
        )
        .await
    }
}

/// Read a config file the plan is about to merge into. Missing file is
/// fine (fresh install); an existing-but-unreadable file is an error —
/// planning blind and then overwriting would destroy user content.
fn read_optional(path: &std::path::Path) -> Result<Option<String>, SetupError> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(SetupError::Planner(format!(
            "cannot read {}: {e}; refusing to overwrite unread content",
            path.display()
        ))),
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
    /// 3. `WriteToml { ~/.codex/config.toml }` — the user's existing
    ///    file with raum's keys merged in (`merge_codex_config_toml`):
    ///    `notify = ["<script>"]`, the `[tui]` notification keys
    ///    (always), `[features] hooks = true` (only when the installed
    ///    Codex supports hooks), and a pre-computed
    ///    `[hooks.state."<path>:..."].trusted_hash` for each raum hook
    ///    so they bypass Codex's `/hooks` review queue
    ///    (openai/codex#20321).
    /// 4. `WriteJson { <project>/.codex/hooks.json }` — the user's
    ///    existing file with raum's `UserPromptSubmit` and `Stop`
    ///    entries merged in at group index 0
    ///    (`merge_codex_hooks_json`). **Skipped** when
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

        // config.toml — features + notify + trusted-project tables,
        // merged into the user's existing file (their keys, comments,
        // and formatting survive — see `merge_codex_config_toml`).
        // Trust tables cover the project root and every worktree raum
        // knows about so Codex never re-prompts for a registered path
        // on launch.
        let mut trusted: Vec<PathBuf> = Vec::new();
        if !ctx.project_dir.as_os_str().is_empty() {
            trusted.push(ctx.project_dir.clone());
        }
        for wt in &ctx.worktree_paths {
            if !wt.as_os_str().is_empty() {
                trusted.push(wt.clone());
            }
        }
        // The hooks.json path is needed twice — once to seed the
        // trusted_hash key inside the config.toml managed block, and
        // again as the `WriteJson` target below — so resolve it up
        // front.
        let project_hooks_path = self.hooks_json_path_for_ctx(ctx);
        let config_toml_path = self.config_toml_path_for_ctx(ctx);
        let merged_config = merge_codex_config_toml(
            read_optional(&config_toml_path)?.as_deref(),
            &notify_script_path,
            supports_hooks,
            &trusted,
            &project_hooks_path,
            &hook_script,
        )?;
        plan.push(SetupAction::WriteToml {
            path: config_toml_path,
            content: merged_config,
        });

        if supports_hooks {
            let hooks_content = merge_codex_hooks_json(
                read_optional(&project_hooks_path)?.as_deref(),
                &hook_script,
            )?;
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
