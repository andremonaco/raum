//! Regression guard: running the real `plan()` + `SetupExecutor::apply()`
//! against a tempdir must land the expected shell scripts under
//! `<ctx.hooks_dir>/` and reference them from the managed config
//! entries. Without this, a future plan refactor can silently drop a
//! `WriteShellScript` action — the harness config would still install,
//! but the dispatcher script it points at would not exist on disk.
//!
//! Scope per harness:
//!
//! * Claude Code — one script (`claude-code.sh`) + `settings.local.json`.
//! * Codex — two scripts (`codex.sh` + `codex-notify.sh`) + `config.toml`
//!   + `hooks.json`.
//! * OpenCode — **no** shell script on disk; SSE is the live transport
//!   (Phase 4). The plan only emits a `RemoveManagedJsonEntries` cleanup.
//!
//! `SetupReport::ok` is allowed to be `false` when `AssertBinary`
//! skips (the CI runner generally does not have `claude`/`codex`/
//! `opencode` on `$PATH`). We downgrade to asserting every action that
//! is not `AssertBinary` or `RemoveManagedJsonEntries` applied cleanly.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use raum_core::agent::semver_lite;
use raum_core::harness::setup::{
    ActionOutcome, SetupAction, SetupContext, SetupExecutor, SetupPlan, SetupReport,
};
use raum_core::harness::traits::NotificationSetup;
use raum_core::harness::{ClaudeCodeAdapter, CodexAdapter, OpenCodeAdapter};

fn tempdir() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn build_ctx(root: &Path, project_dir: &Path) -> SetupContext {
    let hooks_dir = root.join("hooks");
    let sock = root.join("events.sock");
    SetupContext::new(hooks_dir, sock, "demo")
        .with_project_dir(project_dir.to_path_buf())
        .with_home_dir(root.join("home"))
}

/// Collapse the per-action outcomes into a pass/fail that ignores
/// harness-binary absence. `AssertBinary` legitimately skips on CI and
/// would otherwise mask the interesting disk-write assertions below.
fn report_has_failed_write(report: &SetupReport) -> Option<String> {
    for action in &report.actions {
        if matches!(action.outcome, ActionOutcome::Failed { .. }) {
            return Some(format!(
                "action failed: {:?} → {:?}",
                action.action, action.outcome
            ));
        }
    }
    None
}

fn assert_script_on_disk(path: &Path) {
    assert!(path.exists(), "expected script at {}", path.display());
    let meta = std::fs::metadata(path).expect("stat script");
    let mode = meta.permissions().mode() & 0o777;
    assert_eq!(
        mode,
        0o700,
        "script {} should be mode 0700, got {:o}",
        path.display(),
        mode
    );
    let body = std::fs::read_to_string(path).expect("read script");
    assert!(
        body.starts_with("#!/usr/bin/env sh"),
        "script {} missing shebang; first line: {:?}",
        path.display(),
        body.lines().next()
    );
    assert!(
        body.contains("raum-managed"),
        "script {} missing raum-managed header",
        path.display()
    );
}

#[tokio::test]
async fn claude_code_install_writes_dispatcher_script() {
    let tmp = tempdir();
    let project_dir = tmp.path().join("project");
    let ctx = build_ctx(tmp.path(), &project_dir);

    let adapter = ClaudeCodeAdapter::new();
    let plan = adapter.plan(&ctx).await.expect("plan");
    let report = SetupExecutor::new().apply(&plan);
    if let Some(msg) = report_has_failed_write(&report) {
        panic!("claude-code plan apply failed: {msg}\nplan={plan:?}");
    }

    let script = ctx.hooks_dir.join("claude-code.sh");
    assert_script_on_disk(&script);

    // settings.local.json must reference the absolute script path.
    let settings_path = project_dir.join(".claude").join("settings.local.json");
    assert!(
        settings_path.exists(),
        "settings.local.json missing at {}",
        settings_path.display()
    );
    // Shared settings.json must remain untouched.
    let shared = project_dir.join(".claude").join("settings.json");
    assert!(
        !shared.exists(),
        "shared settings.json must not be written: {}",
        shared.display()
    );
    let raw = std::fs::read_to_string(&settings_path).expect("read settings");
    let json: serde_json::Value = serde_json::from_str(&raw).expect("parse settings");
    let hooks_obj = json["hooks"]
        .as_object()
        .expect("settings.local.json has hooks object");
    let first_event = hooks_obj
        .values()
        .next()
        .expect("settings.local.json has at least one event array");
    let command_str = first_event
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|entry| entry["hooks"].as_array())
        .and_then(|hooks| hooks.first())
        .and_then(|h| h["command"].as_str())
        .expect("hook command string");
    assert!(
        command_str.starts_with(&script.display().to_string()),
        "settings.local.json command does not reference {}: {command_str}",
        script.display(),
    );
}

#[tokio::test]
async fn codex_install_writes_dispatcher_and_notify_scripts() {
    let tmp = tempdir();
    let project_dir = tmp.path().join("project");
    let ctx = build_ctx(tmp.path(), &project_dir);

    let config_toml = tmp.path().join("codex-config.toml");
    let hooks_json = project_dir.join(".codex").join("hooks.json");
    let adapter = CodexAdapter::with_paths(
        config_toml.clone(),
        hooks_json.clone(),
        Some(semver_lite::Version {
            major: 0,
            minor: 120,
            patch: 0,
        }),
    );

    let plan: SetupPlan = adapter.plan(&ctx).await.expect("plan");
    let report = SetupExecutor::new().apply(&plan);
    if let Some(msg) = report_has_failed_write(&report) {
        panic!("codex plan apply failed: {msg}\nplan={plan:?}");
    }

    let dispatcher = ctx.hooks_dir.join("codex.sh");
    let notify = ctx.hooks_dir.join("codex-notify.sh");
    assert_script_on_disk(&dispatcher);
    assert_script_on_disk(&notify);

    // hooks.json references codex.sh.
    assert!(
        hooks_json.exists(),
        "hooks.json missing at {}",
        hooks_json.display()
    );
    let raw = std::fs::read_to_string(&hooks_json).expect("read hooks.json");
    assert!(
        raw.contains(&dispatcher.display().to_string()),
        "hooks.json does not reference codex.sh path: {raw}",
    );

    // config.toml references codex-notify.sh under [notify].
    let raw = std::fs::read_to_string(&config_toml).expect("read config.toml");
    assert!(
        raw.contains(&notify.display().to_string()),
        "config.toml does not reference codex-notify.sh path: {raw}",
    );
}

#[tokio::test]
async fn opencode_install_writes_no_shell_script() {
    let tmp = tempdir();
    let project_dir = tmp.path().join("project");
    let ctx = build_ctx(tmp.path(), &project_dir);

    // Pin the settings path inside the tempdir so RemoveManagedJsonEntries
    // cannot touch the user's real config.
    let settings = tmp.path().join("opencode-config.json");
    let adapter = OpenCodeAdapter::with_settings_path(settings);

    let plan = adapter.plan(&ctx).await.expect("plan");
    let report = SetupExecutor::new().apply(&plan);
    if let Some(msg) = report_has_failed_write(&report) {
        panic!("opencode plan apply failed: {msg}\nplan={plan:?}");
    }

    // Negative assertion: no dispatcher script on disk — SSE is the
    // live transport and `opencode.sh` is intentionally absent. A future
    // regression that starts writing it should fail this test.
    let opencode_sh = ctx.hooks_dir.join("opencode.sh");
    assert!(
        !opencode_sh.exists(),
        "OpenCode plan should not write {}",
        opencode_sh.display()
    );

    // The plan itself must not contain any WriteShellScript action.
    assert!(
        plan.actions
            .iter()
            .all(|a| !matches!(a, SetupAction::WriteShellScript { .. })),
        "OpenCode plan must not emit WriteShellScript: {plan:?}",
    );
}
