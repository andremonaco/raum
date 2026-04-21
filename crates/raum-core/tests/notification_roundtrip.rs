//! Phase 5 — end-to-end notification round-trip, one test per harness.
//!
//! Each test wires up the real subsystems a harness would interact with
//! in production (event socket, hook scripts, OSC 9 parser,
//! [`OpenCodeSseChannel`], [`HttpReplyReplier`]) and asserts that a
//! canned notification produced on the harness side arrives inside raum
//! with the right shape.
//!
//! The tests avoid spawning any real agent binary; the harness side is
//! simulated with a subprocess that executes the generated hook script,
//! an in-memory byte stream driving the OSC 9 parser, or a wiremock SSE
//! server. Each harness is its own `#[tokio::test]` function so a
//! failure pinpoints the broken path.
//!
//! A handful of tests fiddle with `$HOME`/`$RAUM_EVENT_SOCK` — those run
//! under `#[serial]` so they cannot race each other. Scripts-based tests
//! are gated on `cfg(unix)` + presence of `socat`/`nc`/`python3` in
//! `$PATH`; when none is available the test is skipped (see the hook
//! script's fallback chain in `raum-hooks/src/scripts.rs`).

#![cfg(unix)]

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use raum_core::agent::{AgentKind, SessionId, semver_lite};
use raum_core::harness::channel::NotificationChannel;
use raum_core::harness::codex::{CodexAdapter, OscScrapeChannel};
use raum_core::harness::event::{NotificationKind, Reliability};
use raum_core::harness::opencode_reply::HttpReplyReplier;
use raum_core::harness::opencode_sse::{OpenCodeSseChannel, new_pending_map};
use raum_core::harness::reply::{Decision, PermissionReplier, ReplyMode};
use raum_core::harness::setup::{
    ActionOutcome, SetupAction, SetupContext, SetupExecutor, SetupPlan,
};
use raum_core::harness::traits::NotificationSetup;
use raum_core::harness::{ClaudeCodeAdapter, default_registry};
use raum_hooks::{PendingKey, spawn_event_socket};
use serial_test::serial;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

const STEP_TIMEOUT: Duration = Duration::from_secs(5);

/// Sanity check: the default registry returns the three adapters the
/// plan covers. If a new harness is added, this list has to change and
/// so does the round-trip coverage — the assertion is a tripwire.
#[test]
#[allow(deprecated)]
fn default_registry_matches_plan() {
    let reg = default_registry();
    let kinds: Vec<AgentKind> = reg.iter().map(|a| a.kind()).collect();
    assert_eq!(
        kinds,
        vec![AgentKind::ClaudeCode, AgentKind::OpenCode, AgentKind::Codex]
    );
}

// -- shared helpers ----------------------------------------------------------

/// True iff at least one of `socat` / `nc` / `python3` is on `$PATH`. The
/// hook script's transport fallback chain requires at least one; when
/// none is available the script silently exits 0 and the test would
/// time out waiting for an event. We skip rather than fail in that
/// case — the dependency is documented in `docs/harnesses.md`.
fn has_any_socket_tool() -> bool {
    ["socat", "nc", "python3"]
        .iter()
        .any(|bin| which::which(bin).is_ok())
}

/// Run the per-harness `plan() + SetupExecutor::apply()` flow against a
/// tempdir-rooted hooks directory and return the absolute path to the
/// requested script. The tempdir stands in for both `$HOME` and the
/// project root; Codex plans are pinned to a supported version so the
/// dispatcher (`codex.sh`) + notify (`codex-notify.sh`) writes both
/// fire.
async fn prepare_hook_scripts(tmp: &tempfile::TempDir, script_name: &str) -> PathBuf {
    let hooks_dir = tmp.path().join("hooks");
    let ctx = SetupContext::new(
        hooks_dir.clone(),
        tmp.path().join("events.sock"),
        "roundtrip",
    )
    .with_project_dir(tmp.path().join("project"))
    .with_home_dir(tmp.path().join("home"));

    let kind = match script_name {
        "claude-code.sh" => AgentKind::ClaudeCode,
        "codex.sh" | "codex-notify.sh" => AgentKind::Codex,
        other => panic!("unsupported script name in roundtrip tests: {other}"),
    };

    let report = match kind {
        AgentKind::ClaudeCode => {
            let adapter = ClaudeCodeAdapter::new();
            let plan = adapter.plan(&ctx).await.expect("claude-code plan");
            SetupExecutor::new().apply(&plan)
        }
        AgentKind::Codex => {
            let adapter = CodexAdapter::with_paths(
                tmp.path().join("codex-config.toml"),
                tmp.path().join("project").join(".codex").join("hooks.json"),
                Some(semver_lite::Version {
                    major: 0,
                    minor: 120,
                    patch: 0,
                }),
            );
            let plan = adapter.plan(&ctx).await.expect("codex plan");
            SetupExecutor::new().apply(&plan)
        }
        other => panic!("unsupported harness kind: {other:?}"),
    };

    // AssertBinary is allowed to skip (CI rarely has the harness
    // binaries on $PATH); everything else must have applied.
    for action in &report.actions {
        if let ActionOutcome::Failed { error } = &action.outcome {
            panic!("install plan action failed: {:?} → {error}", action.action);
        }
    }

    let script = hooks_dir.join(script_name);
    assert!(script.exists(), "expected {} to exist", script.display());
    script
}

// -- Claude Code: fire-and-forget Notification -------------------------------

#[tokio::test]
#[serial]
async fn claude_code_notification_roundtrip_over_hook_script() {
    if !has_any_socket_tool() {
        eprintln!("skip: no socat/nc/python3 available");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let sock_path = tmp.path().join("events.sock");
    let mut handle = spawn_event_socket(&sock_path).await.unwrap();

    let script = prepare_hook_scripts(&tmp, "claude-code.sh").await;

    // Invoke claude-code.sh Notification with a canned JSON payload on
    // stdin. The script should build the envelope + forward over the
    // event socket. `RAUM_SESSION` is exported so `session_id` arrives
    // populated on the wire.
    let mut child = Command::new(&script)
        .arg("Notification")
        .env("RAUM_EVENT_SOCK", &sock_path)
        .env("RAUM_SESSION", "raum-session-1")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(b"{\"notification_type\":\"idle_prompt\"}")
            .await
            .unwrap();
        stdin.shutdown().await.ok();
    }
    let status = timeout(STEP_TIMEOUT, child.wait())
        .await
        .expect("script did not exit in time")
        .unwrap();
    assert!(status.success(), "hook script exited non-zero: {status:?}");

    let ev = timeout(STEP_TIMEOUT, handle.rx.recv())
        .await
        .expect("timed out waiting for Notification event")
        .expect("event socket rx closed");
    assert_eq!(ev.harness, "claude-code");
    assert_eq!(ev.event, "Notification");
    assert_eq!(ev.session_id.as_deref(), Some("raum-session-1"));
    // Payload is stdin, JSON-escaped by the script.
    assert!(ev.payload.is_string());
    assert!(
        ev.payload
            .as_str()
            .is_some_and(|s| s.contains("idle_prompt")),
        "payload={:?}",
        ev.payload
    );
    assert!(
        ev.request_id.is_none(),
        "Notification must not park a request"
    );
}

// -- Claude Code: blocking PermissionRequest ---------------------------------

#[tokio::test]
#[serial]
async fn claude_code_permission_request_replies_with_allow_decision_json() {
    if !has_any_socket_tool() {
        eprintln!("skip: no socat/nc/python3 available");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let sock_path = tmp.path().join("events.sock");
    let mut handle = spawn_event_socket(&sock_path).await.unwrap();

    let script = prepare_hook_scripts(&tmp, "claude-code.sh").await;

    // Spawn the script with a short timeout so a transport bug does
    // not wedge the test for 55 s. The test timeout is bounded by
    // `STEP_TIMEOUT`; this belt-and-braces keeps the subprocess from
    // hanging after the test asserts.
    let mut child = Command::new(&script)
        .arg("PermissionRequest")
        .env("RAUM_EVENT_SOCK", &sock_path)
        .env("RAUM_SESSION", "raum-session-1")
        .env("RAUM_HOOK_TIMEOUT_SECS", "10")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(b"{\"tool\":\"Bash\",\"command\":\"ls\"}")
            .await
            .unwrap();
        stdin.shutdown().await.ok();
    }

    // Wait for the PermissionRequest event on the socket. Grab the
    // generated request_id so we can reply on the same parked writer.
    let ev = timeout(STEP_TIMEOUT, handle.rx.recv())
        .await
        .expect("timed out waiting for PermissionRequest event")
        .expect("socket rx closed");
    assert_eq!(ev.event, "PermissionRequest");
    let request_id = ev.request_id.clone().expect("request_id must be set");
    assert_eq!(ev.session_id.as_deref(), Some("raum-session-1"));

    // Give the accept-loop a moment to park the writer.
    for _ in 0..50 {
        if !handle.pending.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(handle.pending.len(), 1);

    // Reply Allow; the script translates that into the Claude-Code
    // compatible JSON and exits 0.
    let key = PendingKey::new(Some("raum-session-1".into()), request_id);
    handle
        .pending
        .reply(&key, Decision::Allow.wire_tag())
        .await
        .expect("reply delivered");

    let out = timeout(STEP_TIMEOUT, child.wait_with_output())
        .await
        .expect("script did not exit in time")
        .unwrap();
    assert!(
        out.status.success(),
        "hook script exited non-zero: {:?}\nstdout={}\nstderr={}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    let stdout_json: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("script stdout must be JSON");
    assert_eq!(
        stdout_json["hookSpecificOutput"]["hookEventName"]
            .as_str()
            .unwrap(),
        "PermissionRequest"
    );
    assert_eq!(
        stdout_json["hookSpecificOutput"]["decision"]["behavior"]
            .as_str()
            .unwrap(),
        "allow"
    );
}

// -- Phase 6: project-scoped setup plan -------------------------------------

#[tokio::test]
async fn claude_code_project_scoped_plan_writes_under_project_dir() {
    // Production path: Claude Code's hooks land in the project's
    // `.claude/settings.local.json` — the officially-documented
    // personal / auto-gitignored layer. Shared `settings.json` must
    // stay untouched so raum never pollutes a team's repo.
    let tmp = tempfile::tempdir().unwrap();
    let fake_home = tmp.path().join("home");
    let project_dir = tmp.path().join("myproject");
    std::fs::create_dir_all(&fake_home).unwrap();
    std::fs::create_dir_all(&project_dir).unwrap();

    let adapter = ClaudeCodeAdapter::new();
    let ctx = SetupContext::new(
        tmp.path().join("hooks"),
        tmp.path().join("events.sock"),
        "demo",
    )
    .with_project_dir(project_dir.clone())
    .with_home_dir(fake_home.clone());
    let plan = <ClaudeCodeAdapter as NotificationSetup>::plan(&adapter, &ctx)
        .await
        .expect("plan");
    let report = SetupExecutor::new().apply(&plan);
    assert!(report.ok, "report: {report:?}");

    let project_settings = project_dir.join(".claude").join("settings.local.json");
    assert!(
        project_settings.exists(),
        "expected project settings at {}",
        project_settings.display()
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&project_settings).unwrap()).unwrap();
    assert!(parsed["hooks"]["PermissionRequest"].is_array());

    // Shared settings.json must never be created by raum.
    let shared = project_dir.join(".claude").join("settings.json");
    assert!(
        !shared.exists(),
        "shared settings.json must not be written by raum: {}",
        shared.display()
    );

    let legacy = fake_home.join(".claude").join("settings.json");
    assert!(
        !legacy.exists(),
        "legacy user-global path must not be written: {}",
        legacy.display()
    );
}

#[tokio::test]
async fn claude_code_plan_strips_legacy_raum_entries_on_migration() {
    use raum_core::config_io::managed_json::{MARKER_BEGIN, MARKER_KEY};
    let tmp = tempfile::tempdir().unwrap();
    let fake_home = tmp.path().join("home");
    let project_dir = tmp.path().join("proj");
    let legacy = fake_home.join(".claude").join("settings.json");
    std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    // Legacy file with a user-authored entry and a raum-managed entry.
    let original = serde_json::json!({
        "theme": "dark",
        "hooks": {
            "Notification": [
                { "matcher": "user-kept", "hooks": [{ "type":"command", "command":"/kept.sh" }] },
                { MARKER_KEY: MARKER_BEGIN, "matcher": ".*", "hooks": [] }
            ]
        }
    });
    std::fs::write(&legacy, serde_json::to_string_pretty(&original).unwrap()).unwrap();

    let adapter = ClaudeCodeAdapter::new();
    let ctx = SetupContext::new(
        tmp.path().join("hooks"),
        tmp.path().join("events.sock"),
        "demo",
    )
    .with_project_dir(project_dir.clone())
    .with_home_dir(fake_home.clone());
    let plan = <ClaudeCodeAdapter as NotificationSetup>::plan(&adapter, &ctx)
        .await
        .expect("plan");
    let report = SetupExecutor::new().apply(&plan);
    assert!(report.ok, "report: {report:?}");

    // User entry preserved byte-for-byte, raum entry stripped.
    let parsed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&legacy).unwrap()).unwrap();
    assert_eq!(parsed["theme"].as_str().unwrap(), "dark");
    let notif = parsed["hooks"]["Notification"].as_array().unwrap();
    assert_eq!(notif.len(), 1);
    assert_eq!(notif[0]["matcher"].as_str().unwrap(), "user-kept");
}

#[tokio::test]
async fn two_projects_coexist_with_independent_claude_settings() {
    let tmp = tempfile::tempdir().unwrap();
    let fake_home = tmp.path().join("home");
    std::fs::create_dir_all(&fake_home).unwrap();
    let a = tmp.path().join("proj-a");
    let b = tmp.path().join("proj-b");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();

    let adapter = ClaudeCodeAdapter::new();
    for dir in [&a, &b] {
        let ctx = SetupContext::new(
            tmp.path().join("hooks"),
            tmp.path().join("events.sock"),
            "demo",
        )
        .with_project_dir(dir.clone())
        .with_home_dir(fake_home.clone());
        let plan = <ClaudeCodeAdapter as NotificationSetup>::plan(&adapter, &ctx)
            .await
            .expect("plan");
        let report = SetupExecutor::new().apply(&plan);
        assert!(report.ok, "{dir:?}: {report:?}");
    }
    assert!(a.join(".claude").join("settings.local.json").exists());
    assert!(b.join(".claude").join("settings.local.json").exists());
}

// -- Claude Code plan is a pure function; ensure SetupExecutor + selftest
//    accept a tempdir-rooted fake $HOME. Exercises the write side that
//    the subprocess tests rely on indirectly.
#[tokio::test]
async fn claude_code_setup_plan_applies_cleanly_under_tempdir_home() {
    let tmp = tempfile::tempdir().unwrap();
    let settings = tmp.path().join(".claude").join("settings.json");
    std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let adapter = ClaudeCodeAdapter::with_settings_path(settings.clone());
    let ctx = SetupContext::new(
        tmp.path().join("hooks"),
        tmp.path().join("events.sock"),
        "roundtrip",
    );
    let plan = <ClaudeCodeAdapter as NotificationSetup>::plan(&adapter, &ctx)
        .await
        .expect("plan");
    let report = SetupExecutor::new().apply(&plan);
    assert!(report.ok, "report: {report:?}");
    for action in &report.actions {
        match &action.outcome {
            ActionOutcome::Applied | ActionOutcome::Skipped { .. } => {}
            ActionOutcome::Failed { error } => {
                panic!("action {:?} failed: {error}", action.action);
            }
        }
    }
    let raw = std::fs::read_to_string(&settings).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(parsed["hooks"]["PermissionRequest"].is_array());
}

// -- Codex: notify script ----------------------------------------------------

#[tokio::test]
#[serial]
async fn codex_notify_script_forwards_argv_payload_to_event_socket() {
    if !has_any_socket_tool() {
        eprintln!("skip: no socat/nc/python3 available");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let sock_path = tmp.path().join("events.sock");
    let mut handle = spawn_event_socket(&sock_path).await.unwrap();

    let script = prepare_hook_scripts(&tmp, "codex-notify.sh").await;

    // Codex calls the notify script with the payload as argv[1]. We
    // explicitly pin stdin to null so BSD `nc` (macOS) sees immediate
    // EOF and closes its write side — without that, the codex-notify
    // script can block on nc waiting for stdin that never closes.
    let payload = "{\"type\":\"agent-turn-complete\"}";
    let out = timeout(
        STEP_TIMEOUT,
        Command::new(&script)
            .arg(payload)
            .env("RAUM_EVENT_SOCK", &sock_path)
            .env("RAUM_SESSION", "raum-codex-1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .expect("codex-notify timed out")
    .unwrap();
    assert!(
        out.status.success(),
        "codex-notify failed: status={:?} stdout={:?} stderr={:?}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    let ev = timeout(STEP_TIMEOUT, handle.rx.recv())
        .await
        .expect("timed out waiting for codex-notify event")
        .expect("socket rx closed");
    assert_eq!(ev.harness, "codex");
    assert_eq!(ev.event, "Notification");
    assert_eq!(ev.session_id.as_deref(), Some("raum-codex-1"));
    // The raw JSON from Codex is embedded verbatim as the payload.
    assert_eq!(
        ev.payload["type"].as_str(),
        Some("agent-turn-complete"),
        "payload shape: {}",
        ev.payload
    );
}

// -- Codex: lifecycle hook dispatcher ----------------------------------------

#[tokio::test]
#[serial]
async fn codex_hook_dispatcher_forwards_lifecycle_events_to_event_socket() {
    if !has_any_socket_tool() {
        eprintln!("skip: no socat/nc/python3 available");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let sock_path = tmp.path().join("events.sock");
    let mut handle = spawn_event_socket(&sock_path).await.unwrap();

    let script = prepare_hook_scripts(&tmp, "codex.sh").await;

    for event_name in ["UserPromptSubmit", "Stop"] {
        let payload = match event_name {
            "UserPromptSubmit" => "{\"prompt\":\"hi\"}",
            "Stop" => "{\"last_assistant_message\":\"done\"}",
            other => panic!("unexpected event name {other}"),
        };
        let mut child = Command::new(&script)
            .arg(event_name)
            .env("RAUM_EVENT_SOCK", &sock_path)
            .env("RAUM_SESSION", "raum-codex-1")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(payload.as_bytes()).await.unwrap();
            stdin.shutdown().await.ok();
        }
        let status = timeout(STEP_TIMEOUT, child.wait())
            .await
            .expect("codex hook script did not exit in time")
            .unwrap();
        assert!(
            status.success(),
            "codex hook script exited non-zero: {status:?}"
        );

        let ev = timeout(STEP_TIMEOUT, handle.rx.recv())
            .await
            .expect("timed out waiting for codex hook event")
            .expect("socket rx closed");
        assert_eq!(ev.harness, "codex");
        assert_eq!(ev.event, event_name);
        assert_eq!(ev.session_id.as_deref(), Some("raum-codex-1"));
        assert!(
            ev.payload.is_string(),
            "hook payload should arrive as a JSON string"
        );
    }
}

// -- Codex: plan() under tempdir-rooted paths --------------------------------

#[tokio::test]
async fn codex_plan_produces_expected_actions_under_tempdir() {
    let tmp = tempfile::tempdir().unwrap();
    let adapter = CodexAdapter::with_paths(
        tmp.path().join("config.toml"),
        tmp.path().join("hooks.json"),
        Some(semver_lite::Version {
            major: 0,
            minor: 120,
            patch: 0,
        }),
    );
    let ctx = SetupContext::new(
        tmp.path().join("hooks"),
        tmp.path().join("events.sock"),
        "codex-roundtrip",
    );
    let plan = <CodexAdapter as NotificationSetup>::plan(&adapter, &ctx)
        .await
        .expect("plan");
    let report = SetupExecutor::new().apply(&plan);
    assert!(report.ok, "report: {report:?}");
    // hooks.json must be present + contain the lifecycle entries.
    // SessionStart is intentionally absent (see `RAUM_CODEX_HOOK_EVENTS`):
    // subscribing would arm the silence heuristic on boot and falsely
    // promote `Idle → Working` off Codex's TUI startup redraw.
    let hooks_json = std::fs::read_to_string(tmp.path().join("hooks.json")).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&hooks_json).unwrap();
    assert!(parsed["hooks"]["SessionStart"].is_null());
    assert!(parsed["hooks"]["UserPromptSubmit"].is_array());
    assert!(parsed["hooks"]["Stop"].is_array());
    assert!(parsed["hooks"]["PreToolUse"].is_null());
    assert!(parsed["hooks"]["PostToolUse"].is_null());
    let config_toml = std::fs::read_to_string(tmp.path().join("config.toml")).unwrap();
    assert!(config_toml.contains("notifications = true"));
    assert!(config_toml.contains("notification_method = \"osc9\""));
    // The plan wrote a shell script for notify under the tempdir hooks dir.
    let notify = tmp.path().join("hooks").join("codex-notify.sh");
    assert!(notify.exists(), "expected {} to exist", notify.display());
}

// -- Codex: OSC 9 byte-stream parser -----------------------------------------

#[tokio::test]
async fn codex_osc9_stream_emits_permission_needed_and_turn_end() {
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    let (client, server) = tokio::io::duplex(4096);
    let session_id = SessionId::new("raum-osc");
    let channel: Box<dyn NotificationChannel> =
        Box::new(OscScrapeChannel::with_source(session_id.clone(), client));
    let (tx, mut rx) = mpsc::channel(8);
    let cancel = CancellationToken::new();
    let cancel2 = cancel.clone();
    let task = tokio::spawn(async move { channel.run(tx, cancel2).await });

    let mut server = server;
    // Two OSC 9 events back to back. The parser must emit two
    // NotificationEvents mapped correctly onto kind.
    server
        .write_all(b"\x1b]9;approval-requested\x07\x1b]9;agent-turn-complete\x07")
        .await
        .unwrap();
    server.flush().await.unwrap();

    let ev1 = timeout(STEP_TIMEOUT, rx.recv())
        .await
        .expect("osc9 did not emit first event")
        .expect("sink closed");
    assert_eq!(ev1.kind, NotificationKind::PermissionNeeded);
    assert_eq!(ev1.session_id, session_id);
    assert_eq!(ev1.harness, AgentKind::Codex);
    assert_eq!(ev1.source.as_str(), "osc9");
    assert_eq!(ev1.reliability, Reliability::EventDriven);

    let ev2 = timeout(STEP_TIMEOUT, rx.recv())
        .await
        .expect("osc9 did not emit second event")
        .expect("sink closed");
    assert_eq!(ev2.kind, NotificationKind::TurnEnd);

    cancel.cancel();
    drop(server);
    let _ = task.await;
}

// -- OpenCode: SSE stream + HTTP reply against wiremock ----------------------

#[tokio::test]
async fn opencode_sse_emits_permission_and_reply_then_http_replier_posts_allow() {
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;

    // SSE stream — permission.asked followed by permission.replied.
    let sse_body = concat!(
        "data: {\"type\":\"permission.asked\",\"properties\":{\"id\":\"perm-42\",\"sessionID\":\"sess-42\",\"permission\":\"bash\",\"patterns\":[\"ls *\"],\"metadata\":{},\"always\":[]}}\n\n",
        "data: {\"type\":\"permission.replied\",\"properties\":{\"sessionID\":\"sess-42\",\"requestID\":\"perm-42\",\"reply\":\"once\"}}\n\n",
    );
    Mock::given(method("GET"))
        .and(path("/event"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(sse_body),
        )
        .mount(&server)
        .await;

    // Reply endpoint: assert raum posts `{ "reply": "once" }`.
    Mock::given(method("POST"))
        .and(path("/permission/perm-42/reply"))
        .and(body_json(serde_json::json!({ "reply": "once" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(true))
        .mount(&server)
        .await;

    let pending = new_pending_map();
    let fallback = SessionId::new("raum-default");
    let channel = OpenCodeSseChannel::new(server.uri(), pending.clone(), fallback);

    let (tx, mut rx) = mpsc::channel(8);
    let cancel = CancellationToken::new();
    let cancel2 = cancel.clone();
    let task = tokio::spawn(async move { Box::new(channel).run(tx, cancel2).await });

    // 1. permission.asked → PermissionNeeded, request_id = perm-42.
    let ev = timeout(STEP_TIMEOUT, rx.recv())
        .await
        .expect("sse stream stalled waiting for permission.asked")
        .expect("sink closed");
    assert_eq!(ev.kind, NotificationKind::PermissionNeeded);
    assert_eq!(ev.harness, AgentKind::OpenCode);
    assert_eq!(ev.reliability, Reliability::Deterministic);
    assert_eq!(
        ev.request_id.as_ref().map(|r| r.as_str().to_string()),
        Some("perm-42".to_string())
    );
    assert_eq!(ev.session_id, SessionId::new("sess-42"));

    // 2. permission.replied → TurnEnd.
    let ev = timeout(STEP_TIMEOUT, rx.recv())
        .await
        .expect("sse stream stalled waiting for permission.replied")
        .expect("sink closed");
    assert_eq!(ev.kind, NotificationKind::TurnEnd);

    // Now exercise HttpReplyReplier against the same wiremock server.
    let replier = HttpReplyReplier::new(server.uri(), pending);
    assert_eq!(replier.mode(), ReplyMode::HttpReply);
    replier
        .reply(
            &raum_core::harness::event::PermissionRequestId::new("perm-42"),
            Decision::Allow,
        )
        .await
        .expect("POST succeeded");

    cancel.cancel();
    let _ = task.await;
}

#[tokio::test]
async fn opencode_sse_emits_question_waiting_and_resume_events() {
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;

    let sse_body = concat!(
        "data: {\"type\":\"question.asked\",\"properties\":{\"id\":\"q-42\",\"sessionID\":\"sess-42\",\"questions\":[{\"question\":\"Continue?\",\"header\":\"Confirm\",\"options\":[{\"label\":\"Yes\",\"description\":\"Proceed\"}]}]}}\n\n",
        "data: {\"type\":\"question.replied\",\"properties\":{\"sessionID\":\"sess-42\",\"requestID\":\"q-42\",\"answers\":[[\"Yes\"]]}}\n\n",
        "data: {\"type\":\"question.rejected\",\"properties\":{\"sessionID\":\"sess-42\",\"requestID\":\"q-42\"}}\n\n",
    );
    Mock::given(method("GET"))
        .and(path("/event"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(sse_body),
        )
        .mount(&server)
        .await;

    let pending = new_pending_map();
    let fallback = SessionId::new("raum-default");
    let channel = OpenCodeSseChannel::new(server.uri(), pending, fallback);

    let (tx, mut rx) = mpsc::channel(8);
    let cancel = CancellationToken::new();
    let cancel2 = cancel.clone();
    let task = tokio::spawn(async move { Box::new(channel).run(tx, cancel2).await });

    let ev = timeout(STEP_TIMEOUT, rx.recv())
        .await
        .expect("sse stream stalled waiting for question.asked")
        .expect("sink closed");
    assert_eq!(ev.kind, NotificationKind::IdlePromptNeeded);
    assert_eq!(ev.harness, AgentKind::OpenCode);
    assert_eq!(ev.reliability, Reliability::Deterministic);
    assert_eq!(ev.session_id, SessionId::new("sess-42"));
    assert!(ev.request_id.is_none());

    let ev = timeout(STEP_TIMEOUT, rx.recv())
        .await
        .expect("sse stream stalled waiting for question.replied")
        .expect("sink closed");
    assert_eq!(ev.kind, NotificationKind::TurnStart);
    assert_eq!(ev.session_id, SessionId::new("sess-42"));

    let ev = timeout(STEP_TIMEOUT, rx.recv())
        .await
        .expect("sse stream stalled waiting for question.rejected")
        .expect("sink closed");
    assert_eq!(ev.kind, NotificationKind::TurnStart);
    assert_eq!(ev.session_id, SessionId::new("sess-42"));

    cancel.cancel();
    let _ = task.await;
}

// The plan action enum is re-exported from `harness::setup`; keep a
// compile-time use so the import graph stays honest.
#[allow(dead_code)]
fn _plan_types_in_use(_a: SetupAction, _p: SetupPlan) {}
