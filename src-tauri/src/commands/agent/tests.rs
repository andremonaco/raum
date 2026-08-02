#![allow(deprecated)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use raum_core::agent::{AgentAdapter, AgentKind, SessionId};
use raum_core::agent_state::{AgentStateMachine, HookEvent as CoreHookEvent};
use raum_hooks::HookEvent;

use super::persistence::seed_session_activity_for_persisted_state;
use super::registry::AgentRegistry;
use super::runtime::{agent_kind_from_wire, build_permission_notification_event};

#[test]
fn registry_lists_three_adapters_by_default() {
    let r = AgentRegistry::with_defaults();
    let list = r.list();
    assert_eq!(list.len(), 3);
    assert!(list.iter().all(|i| i.session_id.is_none()));
}

#[test]
fn registry_finds_adapter_by_kind() {
    let r = AgentRegistry::with_defaults();
    assert!(r.find_adapter(AgentKind::ClaudeCode).is_some());
    assert!(r.find_adapter(AgentKind::OpenCode).is_some());
    assert!(r.find_adapter(AgentKind::Codex).is_some());
    assert!(r.find_adapter(AgentKind::Shell).is_none());
}

#[test]
fn state_for_missing_session_returns_none() {
    let r = AgentRegistry::with_defaults();
    assert!(r.state_for("raum-missing").is_none());
}

#[test]
fn registering_machine_exposes_state() {
    let mut r = AgentRegistry::with_defaults();
    let m = AgentStateMachine::new(SessionId::new("raum-abc"), AgentKind::ClaudeCode);
    r.register_machine(m);
    assert_eq!(
        r.state_for("raum-abc"),
        Some(raum_core::agent::AgentState::Idle)
    );
}

#[test]
fn register_machine_if_absent_preserves_existing_state() {
    let mut r = AgentRegistry::with_defaults();
    // First register: seeded to Working.
    let seeded = AgentStateMachine::new(SessionId::new("raum-abc"), AgentKind::ClaudeCode)
        .with_initial_state(raum_core::agent::AgentState::Working);
    assert!(r.register_machine_if_absent(seeded));
    assert_eq!(
        r.state_for("raum-abc"),
        Some(raum_core::agent::AgentState::Working),
    );

    // Second register: a fresh `Idle` machine must NOT clobber the
    // existing `Working` one. The return value signals that the
    // insert was skipped.
    let fresh = AgentStateMachine::new(SessionId::new("raum-abc"), AgentKind::ClaudeCode);
    assert!(!r.register_machine_if_absent(fresh));
    assert_eq!(
        r.state_for("raum-abc"),
        Some(raum_core::agent::AgentState::Working),
    );
}

#[test]
fn set_silence_only_toggles_existing_machine() {
    let mut r = AgentRegistry::with_defaults();
    r.register_machine(AgentStateMachine::new(
        SessionId::new("raum-cc"),
        AgentKind::ClaudeCode,
    ));
    assert!(r.set_silence_only("raum-cc", true));
    // Unknown session: no-op, returns false.
    assert!(!r.set_silence_only("raum-missing", true));
}

#[test]
fn agent_kind_wire_mapping_covers_every_harness_filename() {
    // Mirrors the harness tag each hook script / channel identifies
    // itself as on the wire — the drain loop must accept every
    // tag (including "opencode" which arrives via SSE rather than
    // a shell script).
    assert_eq!(agent_kind_from_wire("shell"), Some(AgentKind::Shell));
    assert_eq!(
        agent_kind_from_wire("claude-code"),
        Some(AgentKind::ClaudeCode)
    );
    assert_eq!(agent_kind_from_wire("codex"), Some(AgentKind::Codex));
    assert_eq!(agent_kind_from_wire("opencode"), Some(AgentKind::OpenCode));
    assert_eq!(agent_kind_from_wire("unknown-harness"), None);
}

fn claude_event(name: &str) -> CoreHookEvent {
    CoreHookEvent {
        harness: "claude-code".into(),
        event: name.into(),
        source: None,
        reliability: None,
        payload: serde_json::Value::Null,
    }
}

/// Fixture: two Claude machines (different projects in real life) plus one
/// OpenCode machine — the minimal registry where a broadcast would flip
/// more than one pane.
fn registry_with_two_claude_machines() -> AgentRegistry {
    let mut r = AgentRegistry::with_defaults();
    r.register_machine(AgentStateMachine::new(
        SessionId::new("raum-cc-1"),
        AgentKind::ClaudeCode,
    ));
    r.register_machine(AgentStateMachine::new(
        SessionId::new("raum-cc-2"),
        AgentKind::ClaudeCode,
    ));
    r.register_machine(AgentStateMachine::new(
        SessionId::new("raum-oc-1"),
        AgentKind::OpenCode,
    ));
    r
}

/// The attention-storm regression test: one stray `Stop` without a session
/// id must not flip every Claude pane to Completed across all projects.
#[test]
fn unknown_session_with_multiple_machines_drops_event() {
    let mut r = registry_with_two_claude_machines();
    let routed = r.route_hook_event(AgentKind::ClaudeCode, None, &claude_event("Stop"));
    assert!(routed.is_none(), "no broadcast for a session-less event");
    for sid in ["raum-cc-1", "raum-cc-2", "raum-oc-1"] {
        assert_eq!(
            r.state_for(sid),
            Some(raum_core::agent::AgentState::Idle),
            "{sid} must be untouched",
        );
    }
}

#[test]
fn stale_session_id_with_multiple_machines_drops_event() {
    let mut r = registry_with_two_claude_machines();
    let routed = r.route_hook_event(
        AgentKind::ClaudeCode,
        Some("raum-gone"),
        &claude_event("Stop"),
    );
    assert!(routed.is_none());
    assert_eq!(
        r.state_for("raum-cc-1"),
        Some(raum_core::agent::AgentState::Idle),
    );
    assert_eq!(
        r.state_for("raum-cc-2"),
        Some(raum_core::agent::AgentState::Idle),
    );
}

/// A concrete-but-unknown session id must NOT fall back to the sole
/// machine: a stale `$RAUM_SESSION` (killed pane A whose dying harness
/// fires a last `Stop`) would otherwise flip the unrelated surviving pane.
/// Only a truly session-less event may use the sole-machine route.
#[test]
fn stale_session_id_with_single_machine_drops_event() {
    let mut r = AgentRegistry::with_defaults();
    r.register_machine(AgentStateMachine::new(
        SessionId::new("raum-cc-survivor"),
        AgentKind::ClaudeCode,
    ));
    let routed = r.route_hook_event(
        AgentKind::ClaudeCode,
        Some("raum-cc-killed"),
        &claude_event("Stop"),
    );
    assert!(routed.is_none());
    assert_eq!(
        r.state_for("raum-cc-survivor"),
        Some(raum_core::agent::AgentState::Idle),
        "the survivor must not inherit the dead session's Stop",
    );
}

/// Legacy no-`$RAUM_SESSION` case: with exactly one machine of the harness
/// there is no ambiguity, so the event still routes.
#[test]
fn unknown_session_with_single_machine_routes_to_it() {
    let mut r = AgentRegistry::with_defaults();
    r.register_machine(AgentStateMachine::new(
        SessionId::new("raum-cc-only"),
        AgentKind::ClaudeCode,
    ));
    r.register_machine(AgentStateMachine::new(
        SessionId::new("raum-oc-1"),
        AgentKind::OpenCode,
    ));
    let changes = r
        .route_hook_event(AgentKind::ClaudeCode, None, &claude_event("Stop"))
        .expect("session-less event routes to the sole machine");
    assert_eq!(changes.len(), 1);
    assert_eq!(
        r.state_for("raum-cc-only"),
        Some(raum_core::agent::AgentState::Completed),
    );
    assert_eq!(
        r.state_for("raum-oc-1"),
        Some(raum_core::agent::AgentState::Idle),
        "other harness untouched",
    );
}

#[test]
fn known_session_routes_only_to_that_machine() {
    let mut r = registry_with_two_claude_machines();
    let changes = r
        .route_hook_event(
            AgentKind::ClaudeCode,
            Some("raum-cc-1"),
            &claude_event("UserPromptSubmit"),
        )
        .expect("known session routes");
    assert_eq!(changes.len(), 1);
    assert_eq!(
        r.state_for("raum-cc-1"),
        Some(raum_core::agent::AgentState::Working),
    );
    assert_eq!(
        r.state_for("raum-cc-2"),
        Some(raum_core::agent::AgentState::Idle),
        "sibling machine must be untouched",
    );
}

/// A session id resolving to a machine of a *different* harness is stale or
/// wrong — with multiple candidates the event must be dropped, not applied
/// to the mismatched machine and not broadcast.
#[test]
fn known_session_with_harness_mismatch_does_not_broadcast() {
    let mut r = registry_with_two_claude_machines();
    r.register_machine(AgentStateMachine::new(
        SessionId::new("raum-codex-1"),
        AgentKind::Codex,
    ));
    let routed = r.route_hook_event(
        AgentKind::ClaudeCode,
        Some("raum-codex-1"),
        &claude_event("Stop"),
    );
    assert!(routed.is_none());
    for sid in ["raum-cc-1", "raum-cc-2", "raum-codex-1"] {
        assert_eq!(
            r.state_for(sid),
            Some(raum_core::agent::AgentState::Idle),
            "{sid} must be untouched",
        );
    }
}

// Tests that mutate the process-wide environment serialize on this mutex so
// parallel test threads don't clobber each other's `PATH`. Poisoning is
// ignored so one failing test doesn't cascade into the others.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[allow(unsafe_code)]
fn set_path(v: &str) {
    // SAFETY: every call site holds `ENV_LOCK`.
    unsafe { std::env::set_var("PATH", v) }
}
#[allow(unsafe_code)]
fn restore_path(prev: Option<std::ffi::OsString>) {
    // SAFETY: every call site holds `ENV_LOCK`.
    unsafe {
        match prev {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
    }
}

#[test]
fn missing_binary_is_returned_under_empty_path() {
    // §7.9 test: with `PATH` scrubbed of every directory that could
    // plausibly contain the harness binary, `adapter.spawn` must return
    // `AgentError::BinaryMissing`.
    let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let adapter = raum_core::adapters::ClaudeCodeAdapter::new();
    let prev = std::env::var_os("PATH");
    set_path("/raum-test-nonexistent-path");
    let err = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(adapter.spawn(raum_core::agent::SpawnOptions {
            cwd: std::path::PathBuf::from("/tmp"),
            project_slug: "p".into(),
            worktree_id: "w".into(),
            extra_env: vec![],
        }));
    restore_path(prev);
    assert!(
        matches!(err, Err(raum_core::agent::AgentError::BinaryMissing { .. })),
        "expected BinaryMissing, got {err:?}"
    );
}

#[test]
fn submit_arming_applies_to_any_known_session() {
    let mut r = AgentRegistry::with_defaults();
    let live = AgentStateMachine::new(SessionId::new("raum-live"), AgentKind::ClaudeCode);
    let mut fallback = AgentStateMachine::new(SessionId::new("raum-fallback"), AgentKind::Codex);
    fallback.set_silence_only(true);
    r.register_machine(live);
    r.register_machine(fallback);

    assert!(r.arm_activity_for_submit("raum-live"));
    assert!(r.arm_activity_for_submit("raum-fallback"));
    assert!(!r.arm_activity_for_submit("raum-missing"));
}

#[test]
fn permission_notification_event_uses_request_id_as_key() {
    let ev = HookEvent {
        harness: "claude-code".into(),
        event: "PermissionRequest".into(),
        session_id: Some("raum-1".into()),
        request_id: Some("req-1".into()),
        source: Some("claude-hooks".into()),
        reliability: None,
        payload: serde_json::json!({ "tool_name": "Bash" }),
    };
    let payload = build_permission_notification_event(&ev).expect("permission payload");
    assert_eq!(payload.permission_key, "req-1");
    assert_eq!(payload.request_id.as_deref(), Some("req-1"));
    assert_eq!(payload.session_id.as_deref(), Some("raum-1"));
    assert_eq!(payload.payload["tool_name"].as_str(), Some("Bash"));
}

#[test]
fn permission_notification_event_falls_back_to_session_id_key() {
    let ev = HookEvent {
        harness: "codex".into(),
        event: "PermissionRequest".into(),
        session_id: Some("raum-codex-1".into()),
        request_id: None,
        source: Some("osc9".into()),
        reliability: None,
        payload: serde_json::Value::String("{\"type\":\"approval-requested\"}".into()),
    };
    let payload = build_permission_notification_event(&ev).expect("permission payload");
    assert_eq!(payload.permission_key, "raum-codex-1");
    assert!(payload.request_id.is_none());
    assert_eq!(payload.payload["type"].as_str(), Some("approval-requested"));
}

#[test]
fn persisted_working_state_seeds_session_activity() {
    let session_activity = Arc::new(Mutex::new(HashMap::new()));
    seed_session_activity_for_persisted_state(
        &session_activity,
        "raum-working",
        Some(raum_core::agent::AgentState::Working),
    );

    let activity = session_activity.lock().unwrap();
    assert!(activity.contains_key("raum-working"));
}

#[test]
fn non_working_persisted_state_does_not_seed_session_activity() {
    let session_activity = Arc::new(Mutex::new(HashMap::new()));
    seed_session_activity_for_persisted_state(
        &session_activity,
        "raum-idle",
        Some(raum_core::agent::AgentState::Idle),
    );
    seed_session_activity_for_persisted_state(&session_activity, "raum-none", None);

    let activity = session_activity.lock().unwrap();
    assert!(!activity.contains_key("raum-idle"));
    assert!(!activity.contains_key("raum-none"));
}
