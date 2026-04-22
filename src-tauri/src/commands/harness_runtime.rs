//! Per-session harness-runtime registry (Phase 6).
//!
//! `AgentRegistry` in `commands::agent` owns the deprecated
//! `AgentAdapter` trait objects for the legacy spawn/preflight path.
//! Phase 6 wires the new trait surface (`NotificationSetup` / `HarnessRuntime`)
//! into the live app so raum actually runs the channels + replier an
//! adapter exposes. To avoid rewriting `AgentRegistry`, this module
//! keeps a parallel typed registry keyed by `AgentKind` that the
//! `agent_spawn` command reaches for when it needs to call `plan()`,
//! `selftest()`, `channels()`, or `replier()`.
//!
//! # Lifecycle
//!
//! 1. `agent_spawn` resolves the adapter via [`HarnessRuntimeRegistry::for_kind`]
//!    (an `enum` dispatch, not a trait object — each adapter has a
//!    different `HarnessRuntime::channels` return shape under the hood
//!    so a single `dyn` would require yet another shim layer).
//! 2. It calls `plan(&ctx).await?` + `SetupExecutor::new().apply(&plan)`.
//! 3. It builds a `SessionSpec` and calls `channels(&spec)` + `replier(&spec)`.
//! 4. Every channel is spawned on the tokio runtime holding a
//!    `CancellationToken` kept in [`SessionRuntime`]. The events are
//!    translated into `raum_hooks::HookEvent` values and fed into the
//!    existing `drive_event_socket` pipeline so one codepath owns the
//!    agent-state transition.
//! 5. The replier is stashed on [`SessionRuntime`] so
//!    `reply_permission` can dispatch on it.
//!
//! A session ends when either `agent_spawn` is called again with the
//! same session id (replace), `terminal_kill` runs, or the app shuts
//! down. Every endpoint calls [`HarnessRuntimeRegistry::end_session`]
//! to cancel the tokens + drop the replier; unrepleied permission
//! requests fall back to the harness's native TUI (Claude Code) or
//! time out (OpenCode). See the plan's "Edge cases" section.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use raum_core::agent::AgentKind;
use raum_core::harness::channel::NotificationChannel;
use raum_core::harness::event::NotificationEvent;
use raum_core::harness::reply::{Decision, PermissionReplier, ReplyError};
use raum_core::harness::setup::{
    ScanReport, SetupContext, SetupError, SetupExecutor, SetupPlan, SetupReport,
};
use raum_core::harness::traits::{HarnessRuntime, NotificationSetup, SessionSpec};
use raum_core::harness::{ClaudeCodeAdapter, CodexAdapter, OpenCodeAdapter};
use raum_hooks::HookEvent as WireHookEvent;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

/// Typed harness-runtime registry. Holds one shared instance per
/// adapter so stateful pieces (OpenCode's pending-request map) survive
/// across sessions of the same project.
#[derive(Clone)]
pub struct HarnessRuntimeRegistry {
    claude_code: Arc<ClaudeCodeAdapter>,
    opencode: Arc<OpenCodeAdapter>,
    codex: Arc<CodexAdapter>,
    /// Per-session state — channels' cancel tokens + repliers.
    sessions: Arc<Mutex<HashMap<String, SessionRuntime>>>,
}

impl std::fmt::Debug for HarnessRuntimeRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HarnessRuntimeRegistry")
            .field(
                "session_count",
                &self.sessions.lock().map_or(0, |g| g.len()),
            )
            .finish_non_exhaustive()
    }
}

impl Default for HarnessRuntimeRegistry {
    fn default() -> Self {
        Self {
            claude_code: Arc::new(ClaudeCodeAdapter::new()),
            opencode: Arc::new(OpenCodeAdapter::new()),
            codex: Arc::new(CodexAdapter::new()),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Runtime state kept for one live session.
pub struct SessionRuntime {
    pub kind: AgentKind,
    /// Cancel tokens for every spawned channel (one per channel).
    pub cancel: CancellationToken,
    /// Replier handle. `None` for observation-only harnesses (Codex).
    pub replier: Option<Arc<dyn PermissionReplier>>,
    /// Keep join-handles out of the public surface; hold them so
    /// abort-on-drop semantics fire when the registry entry is removed.
    #[allow(dead_code)]
    pub channel_tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl std::fmt::Debug for SessionRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionRuntime")
            .field("kind", &self.kind)
            .field("replier_available", &self.replier.is_some())
            .field("channels", &self.channel_tasks.len())
            .finish_non_exhaustive()
    }
}

impl HarnessRuntimeRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Build a fresh plan for `kind` against `ctx` and return it. The
    /// caller is responsible for applying it through `SetupExecutor`.
    pub async fn plan(&self, kind: AgentKind, ctx: &SetupContext) -> Result<SetupPlan, SetupError> {
        match kind {
            AgentKind::ClaudeCode => self.claude_code.plan(ctx).await,
            AgentKind::OpenCode => self.opencode.plan(ctx).await,
            AgentKind::Codex => self.codex.plan(ctx).await,
            AgentKind::Shell => Ok(SetupPlan::default()),
        }
    }

    /// Pure-read scan: inspect the on-disk state of every managed
    /// config file for `kind` without spawning subprocesses or writing
    /// anything. Shell has no setup to scan so it returns a synthetic
    /// "ready" report.
    #[must_use]
    pub fn scan(&self, kind: AgentKind, ctx: &SetupContext) -> ScanReport {
        match kind {
            AgentKind::ClaudeCode => self.claude_code.scan(ctx),
            AgentKind::Codex => self.codex.scan(ctx),
            AgentKind::OpenCode => self.opencode.scan(ctx),
            AgentKind::Shell => ScanReport {
                harness: AgentKind::Shell,
                binary: "sh".into(),
                binary_on_path: which::which("sh").is_ok(),
                raum_hooks_installed: true,
                config_paths: Vec::new(),
                reason_if_not_installed: None,
                note: Some("Shell sessions do not receive native notifications".into()),
            },
        }
    }

    /// On-demand install: build the plan and apply it. Returns the
    /// resulting [`SetupReport`] and leaves the filesystem in the
    /// post-apply state. Callers are expected to emit
    /// `harness-setup-report` themselves so the frontend store updates
    /// in the same shape as a spawn-driven install.
    pub async fn install(
        &self,
        kind: AgentKind,
        ctx: &SetupContext,
    ) -> Result<SetupReport, SetupError> {
        let plan = self.plan(kind, ctx).await?;
        Ok(SetupExecutor::new().apply(&plan))
    }

    /// Run the harness-specific selftest and return its report.
    pub async fn selftest(
        &self,
        kind: AgentKind,
        ctx: &SetupContext,
    ) -> raum_core::harness::SelftestReport {
        match kind {
            AgentKind::ClaudeCode => self.claude_code.selftest(ctx).await,
            AgentKind::OpenCode => self.opencode.selftest(ctx).await,
            AgentKind::Codex => self.codex.selftest(ctx).await,
            AgentKind::Shell => raum_core::harness::SelftestReport::ok(
                AgentKind::Shell,
                "no selftest for shell harness",
                0,
            ),
        }
    }

    /// Build per-session channels + replier. `kind == Shell` yields an
    /// empty vec + `None` because shells have no native notifications.
    #[must_use]
    #[allow(clippy::type_complexity)]
    pub fn channels_and_replier(
        &self,
        kind: AgentKind,
        spec: &SessionSpec,
    ) -> (
        Vec<Box<dyn NotificationChannel>>,
        Option<Box<dyn PermissionReplier>>,
    ) {
        match kind {
            AgentKind::ClaudeCode => (
                self.claude_code.channels(spec),
                self.claude_code.replier(spec),
            ),
            AgentKind::OpenCode => (self.opencode.channels(spec), self.opencode.replier(spec)),
            AgentKind::Codex => (self.codex.channels(spec), self.codex.replier(spec)),
            AgentKind::Shell => (Vec::new(), None),
        }
    }

    /// Resolve the replier for `session_id`, if one was registered.
    #[must_use]
    pub fn replier_for(&self, session_id: &str) -> Option<Arc<dyn PermissionReplier>> {
        self.sessions
            .lock()
            .ok()
            .and_then(|g| g.get(session_id).and_then(|s| s.replier.clone()))
    }

    /// Register a new live session. Cancels + replaces any existing
    /// entry for the same session id.
    pub fn register_session(&self, session_id: String, runtime: SessionRuntime) {
        if let Ok(mut g) = self.sessions.lock() {
            if let Some(old) = g.insert(session_id, runtime) {
                old.cancel.cancel();
            }
        }
    }

    /// True when a live `SessionRuntime` is already registered for
    /// `session_id`. Used by the opts variant of
    /// `register_harness_session_runtime` to avoid tearing down
    /// in-flight channel subscriptions on re-register (the
    /// startup-rehydrate task spawns channels; the follow-up
    /// `terminal_reattach` should leave them alone).
    #[must_use]
    pub fn has_session(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .ok()
            .is_some_and(|g| g.contains_key(session_id))
    }

    /// End a session: cancel every channel task, drop the replier.
    pub fn end_session(&self, session_id: &str) {
        if let Ok(mut g) = self.sessions.lock()
            && let Some(entry) = g.remove(session_id)
        {
            entry.cancel.cancel();
        }
    }
}

/// Run a single channel's task. Translates `NotificationEvent`s from
/// the sink into `raum_hooks::HookEvent` values that the existing
/// `drive_event_socket` drain loop can consume — this keeps one
/// codepath responsible for state-machine transitions (the sink
/// forwarding bridge is purely additive; legacy UDS-delivered events
/// still work).
///
/// `bus_tx` is the broadcast sender that fan-outs `AgentStateChanged`
/// records; we go through `drive_event_socket` via a shared wire
/// event, rather than producing `AgentStateChanged` here, so every
/// event has the same provenance.
pub fn spawn_channel_task(
    session_id: String,
    harness_wire: &'static str,
    mut rx: mpsc::Receiver<NotificationEvent>,
    event_tx: mpsc::Sender<WireHookEvent>,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                () = cancel.cancelled() => return,
                ev = rx.recv() => {
                    let Some(ev) = ev else { return };
                    let wire = event_from_notification(&session_id, harness_wire, &ev);
                    if event_tx.send(wire).await.is_err() {
                        warn!(session = %session_id, "event-socket tx closed; channel task shutting down");
                        return;
                    }
                }
            }
        }
    })
}

/// Lower a typed [`NotificationEvent`] to the wire-compatible
/// `raum_hooks::HookEvent` the drain loop expects. The drain loop's
/// `classify_hook_event` maps the event-name string back into a
/// `NotificationKind` — we keep the names aligned here so round-
/// tripping lands in the right state-machine bucket.
fn event_from_notification(
    fallback_session: &str,
    harness_wire: &'static str,
    ev: &NotificationEvent,
) -> WireHookEvent {
    let event_name = ev.kind.wire_event_name();
    let session_id = if ev.session_id.as_str().is_empty() {
        Some(fallback_session.to_string())
    } else {
        Some(ev.session_id.as_str().to_string())
    };
    debug!(
        harness = %harness_wire,
        event = %event_name,
        session = ?session_id,
        source = %ev.source.as_str(),
        "notification → wire",
    );
    WireHookEvent {
        harness: harness_wire.to_string(),
        event: event_name.to_string(),
        session_id,
        request_id: ev.request_id.as_ref().map(|r| r.as_str().to_string()),
        source: Some(ev.source.as_str().to_string()),
        reliability: Some(ev.reliability.label().to_string()),
        payload: ev.payload.clone(),
    }
}

/// Wire name used on `HookEvent::harness` for a given `AgentKind`.
/// Matches `src-tauri::commands::agent::agent_kind_from_wire`.
#[must_use]
pub fn harness_wire_name(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::ClaudeCode => "claude-code",
        AgentKind::Codex => "codex",
        AgentKind::OpenCode => "opencode",
        AgentKind::Shell => "shell",
    }
}

/// Deliver a decision to the replier for `session_id`. Returns
/// `Ok(true)` on success, `Ok(false)` when no replier is registered
/// for the session (observation-only harness), and `Err` for transport
/// failures.
pub async fn deliver_decision(
    registry: &HarnessRuntimeRegistry,
    session_id: &str,
    request_id: &str,
    decision: Decision,
) -> Result<bool, ReplyError> {
    let Some(replier) = registry.replier_for(session_id) else {
        return Ok(false);
    };
    replier
        .reply(
            &raum_core::harness::event::PermissionRequestId::new(request_id.to_string()),
            decision,
        )
        .await
        .map(|()| true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harness_wire_name_mirrors_drain_loop_mapping() {
        assert_eq!(harness_wire_name(AgentKind::ClaudeCode), "claude-code");
        assert_eq!(harness_wire_name(AgentKind::Codex), "codex");
        assert_eq!(harness_wire_name(AgentKind::OpenCode), "opencode");
        assert_eq!(harness_wire_name(AgentKind::Shell), "shell");
    }

    #[test]
    fn registry_end_session_is_idempotent_on_missing_id() {
        let r = HarnessRuntimeRegistry::new();
        r.end_session("never-registered"); // must not panic
    }

    #[test]
    fn register_session_cancels_previous_entry() {
        use tokio::runtime::Builder;
        let rt = Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let r = HarnessRuntimeRegistry::new();
            let cancel_a = CancellationToken::new();
            let cancel_b = CancellationToken::new();
            r.register_session(
                "s1".into(),
                SessionRuntime {
                    kind: AgentKind::ClaudeCode,
                    cancel: cancel_a.clone(),
                    replier: None,
                    channel_tasks: Vec::new(),
                },
            );
            r.register_session(
                "s1".into(),
                SessionRuntime {
                    kind: AgentKind::ClaudeCode,
                    cancel: cancel_b.clone(),
                    replier: None,
                    channel_tasks: Vec::new(),
                },
            );
            assert!(cancel_a.is_cancelled(), "previous entry must be cancelled");
            assert!(!cancel_b.is_cancelled());
        });
    }

    #[test]
    fn notification_kind_to_wire_event_name() {
        use raum_core::harness::event::{
            NotificationEvent, NotificationKind, PermissionRequestId, Reliability, SourceId,
        };
        use serde_json::Value;
        let ev = NotificationEvent {
            session_id: raum_core::agent::SessionId::new(""),
            harness: AgentKind::ClaudeCode,
            kind: NotificationKind::PermissionNeeded,
            source: SourceId::from("claude-hooks"),
            reliability: Reliability::Deterministic,
            request_id: Some(PermissionRequestId::new("r1")),
            payload: Value::Null,
        };
        let wire = event_from_notification("fallback", "claude-code", &ev);
        assert_eq!(wire.event, "PermissionRequest");
        assert_eq!(wire.session_id.as_deref(), Some("fallback"));
        assert_eq!(wire.request_id.as_deref(), Some("r1"));
        assert_eq!(wire.source.as_deref(), Some("claude-hooks"));
        assert_eq!(wire.reliability.as_deref(), Some("deterministic"));
    }
}
