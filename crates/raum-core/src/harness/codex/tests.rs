#![allow(deprecated)]

use std::path::{Path, PathBuf};

use serde_json::Value;
use tempfile::tempdir;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agent::{AgentAdapter, AgentKind, SessionId, semver_lite};
use crate::config_io::managed_json::{MARKER_BEGIN, MARKER_KEY};
use crate::harness::channel::{ChannelHealth, NotificationChannel};
use crate::harness::event::{NotificationKind, Reliability};
use crate::harness::setup::{SetupAction, SetupContext};
use crate::harness::traits::{HarnessRuntime, NotificationSetup, SessionSpec};

use super::{
    CODEX_NOTIFY_SCRIPT_NAME, CodexAdapter, Osc9Parser, OscScrapeChannel, RAUM_CODEX_HOOK_EVENTS,
    classify_osc9_payload, install_codex_hooks_json,
};

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
    assert!(matches!(plan.actions[0], SetupAction::AssertBinary { ref name } if name == "codex"));
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
async fn plan_emits_trusted_project_tables_for_root_and_worktrees() {
    // With project_dir + worktree_paths set, the managed config.toml
    // body must declare every path as Codex-trusted so the harness
    // never re-prompts on spawn.
    let dir = tempdir().unwrap();
    let config_toml = dir.path().join("config.toml");
    let adapter = CodexAdapter::with_paths(
        config_toml.clone(),
        dir.path().join("hooks.json"),
        Some(semver_lite::Version {
            major: 0,
            minor: 120,
            patch: 0,
        }),
    );
    let project_root = dir.path().join("proj");
    let wt_one = dir.path().join("proj-worktrees").join("feature-a");
    let wt_two = dir.path().join("proj-worktrees").join("feature-b");
    let ctx = SetupContext::new(
        dir.path().join("hooks"),
        dir.path().join("events.sock"),
        "demo",
    )
    .with_project_dir(project_root.clone())
    .with_worktree_paths(vec![wt_one.clone(), wt_two.clone(), project_root.clone()]);
    let plan = <CodexAdapter as NotificationSetup>::plan(&adapter, &ctx)
        .await
        .unwrap();
    let SetupAction::WriteToml { ref content, .. } = plan.actions[2] else {
        panic!("expected WriteToml at index 2");
    };
    let root_key = serde_json::to_string(&project_root.display().to_string()).unwrap();
    let wt_one_key = serde_json::to_string(&wt_one.display().to_string()).unwrap();
    let wt_two_key = serde_json::to_string(&wt_two.display().to_string()).unwrap();
    assert!(
        content.contains(&format!("[projects.{root_key}]")),
        "project root trust table missing: {content}",
    );
    assert!(
        content.contains(&format!("[projects.{wt_one_key}]")),
        "worktree #1 trust table missing: {content}",
    );
    assert!(
        content.contains(&format!("[projects.{wt_two_key}]")),
        "worktree #2 trust table missing: {content}",
    );
    // Duplicate (project_root appears in both project_dir and
    // worktree_paths) must be emitted once, not twice.
    let root_table_count = content.matches(&format!("[projects.{root_key}]")).count();
    assert_eq!(root_table_count, 1, "duplicate trust tables: {content}");
    assert!(content.contains("trust_level = \"trusted\""));
}

#[tokio::test]
async fn plan_with_empty_project_dir_emits_no_trust_tables() {
    // Plan-body tests run with project_dir = "" (the default). No
    // trust tables should be written — raum does not declare the
    // user-global process as trusted.
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
    let SetupAction::WriteToml { ref content, .. } = plan.actions[2] else {
        panic!("expected WriteToml at index 2");
    };
    assert!(
        !content.contains("[projects."),
        "unexpected trust table in empty-project body: {content}",
    );
    assert!(!content.contains("trust_level"));
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
