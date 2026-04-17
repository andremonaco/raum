//! Agent commands (§7). Owned by Wave 2C.
//!
//! Exposes:
//!
//! * `agent_list()` — registered adapters + currently-tracked session states.
//! * `agent_spawn(project_slug, worktree_id, harness)` — prepare to launch an
//!   agent harness. Performs missing-binary (§7.9) and minimum-version (§7.10)
//!   preflight and emits `agent-state-changed` / `version-warning` /
//!   `hook-fallback` events as needed. The actual tmux session creation is
//!   delegated to `terminal_spawn`; this command is responsible for adapter
//!   preflight.
//! * `agent_state(session_id)` — current `AgentState` for a tracked session.
//!
//! State propagation: the state machine in `raum-core::agent_state` publishes
//! `AgentStateChanged` records onto a tokio broadcast channel owned by
//! `AppHandleState`. A background task (registered on first use) re-emits those
//! records to the webview via `app.emit("agent-state-changed", …)`.
//!
//! The existing consumer of `raum_core::AgentAdapter` continues to use it via
//! the Phase-2 deprecation shim; `#![allow(deprecated)]` keeps the callsite
//! warning-free until the src-tauri migration to the split trait surface
//! completes in a follow-up change.
#![allow(deprecated)]

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use raum_core::agent::{AgentAdapter, AgentError, AgentKind, SessionId};
use raum_core::agent_state::{AgentStateChanged, AgentStateMachine, HookEvent as CoreHookEvent};
use raum_core::harness::default_registry;
use raum_core::paths;
use raum_hooks::HookEvent;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::{broadcast, mpsc};
use tracing::{info, warn};

use crate::state::AppHandleState;

/// Number of `AgentStateChanged` records the broadcast channel buffers before
/// slow subscribers start losing events. 256 is comfortable for bursty hook
/// traffic while keeping memory bounded.
pub const AGENT_EVENT_CHANNEL_CAPACITY: usize = 256;

/// Rendered adapter descriptor for the top-row UI.
#[derive(Debug, Serialize)]
pub struct AgentListItem {
    pub session_id: Option<String>,
    pub harness: AgentKind,
    pub state: raum_core::agent::AgentState,
    pub supports_native_events: bool,
}

/// Shared agent registry + state-machine map. Stored behind `Arc<Mutex<_>>`
/// inside `AppHandleState` (additive field; safe to add to alongside other
/// Wave-2 owners).
#[derive(Default)]
pub struct AgentRegistry {
    adapters: Vec<Arc<dyn AgentAdapter>>,
    machines: HashMap<String, AgentStateMachine>,
}

impl std::fmt::Debug for AgentRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentRegistry")
            .field("adapter_count", &self.adapters.len())
            .field("machine_count", &self.machines.len())
            .finish()
    }
}

impl AgentRegistry {
    #[must_use]
    pub fn with_defaults() -> Self {
        Self {
            adapters: default_registry(),
            machines: HashMap::new(),
        }
    }

    #[must_use]
    pub fn find_adapter(&self, kind: AgentKind) -> Option<Arc<dyn AgentAdapter>> {
        self.adapters.iter().find(|a| a.kind() == kind).cloned()
    }

    #[must_use]
    #[allow(dead_code)]
    pub fn adapters(&self) -> &[Arc<dyn AgentAdapter>] {
        &self.adapters
    }

    pub fn register_machine(&mut self, machine: AgentStateMachine) {
        self.machines
            .insert(machine.session_id().as_str().to_string(), machine);
    }

    /// Apply a hook event to every state machine whose harness matches
    /// `kind`. Returns the subset of resulting transitions (`None` when
    /// the machine's state did not change). Called by the event-socket
    /// drain task when no session_id is present on the wire (legacy
    /// fire-and-forget events).
    pub fn apply_hook_to_matching(
        &mut self,
        kind: AgentKind,
        event: &CoreHookEvent,
    ) -> Vec<AgentStateChanged> {
        let mut out = Vec::new();
        for machine in self.machines.values_mut() {
            if machine.harness() != kind {
                continue;
            }
            if let Some(change) = machine.on_hook_event(event) {
                out.push(change);
            }
        }
        out
    }

    /// Phase-2 session-scoped routing: apply `event` to only the
    /// machine matching `session_id`, if one exists. Falls back to
    /// broadcasting by harness when the session is unknown — some
    /// hook events race the spawn path and arrive before
    /// `agent_spawn` has registered the state machine.
    pub fn apply_hook_for_session(
        &mut self,
        kind: AgentKind,
        session_id: &str,
        event: &CoreHookEvent,
    ) -> Vec<AgentStateChanged> {
        if let Some(machine) = self.machines.get_mut(session_id) {
            if machine.harness() == kind {
                if let Some(change) = machine.on_hook_event(event) {
                    return vec![change];
                }
                return Vec::new();
            }
        }
        self.apply_hook_to_matching(kind, event)
    }

    #[must_use]
    pub fn state_for(&self, session_id: &str) -> Option<raum_core::agent::AgentState> {
        self.machines.get(session_id).map(|m| m.state())
    }

    #[must_use]
    pub fn list(&self) -> Vec<AgentListItem> {
        let mut out = Vec::new();
        for adapter in &self.adapters {
            out.push(AgentListItem {
                session_id: None,
                harness: adapter.kind(),
                state: raum_core::agent::AgentState::Idle,
                supports_native_events: adapter.supports_native_events(),
            });
        }
        for (id, machine) in &self.machines {
            out.push(AgentListItem {
                session_id: Some(id.clone()),
                harness: machine.harness(),
                state: machine.state(),
                supports_native_events: self
                    .find_adapter(machine.harness())
                    .is_some_and(|a| a.supports_native_events()),
            });
        }
        out
    }
}

/// Broadcast channel owner. Instantiated lazily via `OnceLock` so we don't
/// need to touch `AppHandleState::default()` unnecessarily — the first call
/// to any agent command populates the channel and spawns the re-emit task.
pub struct AgentEventBus {
    pub tx: broadcast::Sender<AgentStateChanged>,
}

impl std::fmt::Debug for AgentEventBus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentEventBus")
            .field("receiver_count", &self.tx.receiver_count())
            .finish()
    }
}

impl AgentEventBus {
    #[must_use]
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(AGENT_EVENT_CHANNEL_CAPACITY);
        Self { tx }
    }
}

impl Default for AgentEventBus {
    fn default() -> Self {
        Self::new()
    }
}

/// Map a wire-format harness string (as emitted by the hook scripts in
/// `raum-hooks`) to the typed [`AgentKind`]. Returns `None` for unknown
/// harnesses so the drain loop can log-and-drop without panicking.
fn agent_kind_from_wire(s: &str) -> Option<AgentKind> {
    match s {
        "shell" => Some(AgentKind::Shell),
        "claude-code" => Some(AgentKind::ClaudeCode),
        "codex" => Some(AgentKind::Codex),
        "opencode" => Some(AgentKind::OpenCode),
        _ => None,
    }
}

/// Drain the hook-event UDS socket into the per-session state machines
/// and broadcast the resulting transitions onto [`AgentEventBus`].
///
/// Wiring (Phase 1):
/// 1. `raum_hooks::spawn_event_socket` produces [`HookEvent`] values.
/// 2. This loop converts each event to a `raum-core::agent_state::HookEvent`
///    and feeds every registered state machine whose harness matches.
/// 3. Resulting `AgentStateChanged` records go onto the broadcast bus;
///    `ensure_bridge_running` re-emits them as `agent-state-changed`
///    events to the Tauri webview.
///
/// Runs until `rx` closes. The caller owns spawning; invoke it once from
/// Tauri `setup` after `spawn_event_socket` binds the UDS socket.
///
/// Routing is currently broadcast-by-harness — the hook-event wire
/// shape does not yet carry a session id, so every machine with the
/// matching `AgentKind` advances. This is a Phase 1 limitation; Phase 2
/// adds session-scoped routing once `raum-hooks` embeds `$RAUM_SESSION`
/// in the event payload.
pub async fn drive_event_socket<R: Runtime>(
    mut rx: mpsc::Receiver<HookEvent>,
    bus: AgentEventBus,
    app: AppHandle<R>,
) {
    while let Some(ev) = rx.recv().await {
        let Some(kind) = agent_kind_from_wire(&ev.harness) else {
            warn!(
                harness = %ev.harness,
                event = %ev.event,
                "event-socket drain: unknown harness, dropping event",
            );
            continue;
        };
        let core_event = CoreHookEvent {
            harness: ev.harness.clone(),
            event: ev.event.clone(),
            payload: ev.payload.clone(),
        };
        let state: tauri::State<'_, crate::state::AppHandleState> = app.state();
        let changes: Vec<AgentStateChanged> = {
            let Ok(mut registry) = state.agents.lock() else {
                warn!("event-socket drain: agent registry lock poisoned; dropping event");
                continue;
            };
            match ev.session_id.as_deref() {
                Some(sid) => registry.apply_hook_for_session(kind, sid, &core_event),
                None => registry.apply_hook_to_matching(kind, &core_event),
            }
        };
        for change in changes {
            // Broadcast buffer fills silently when the bridge task is
            // behind; the `ensure_bridge_running` task logs the lag.
            let _ = bus.tx.send(change);
        }

        // Phase 2: surface `PermissionRequest` events to the webview
        // with enough context (request_id + session_id + payload) for
        // the frontend to render action buttons and call
        // `reply_permission`. Observation-only events don't need this
        // channel — they already travel via `agent-state-changed`.
        if ev.event == "PermissionRequest"
            && let Some(req_id) = ev.request_id.as_deref()
        {
            let payload = serde_json::json!({
                "harness": ev.harness,
                "event": ev.event,
                "session_id": ev.session_id,
                "request_id": req_id,
                "payload": ev.payload,
            });
            if let Err(e) = app.emit("notification-event", &payload) {
                warn!(error=%e, "notification-event emit failed");
            }
        }
    }
}

/// Ensure the bridge task that re-emits `AgentStateChanged` records onto the
/// Tauri event bus is running. Idempotent — the `OnceLock` guarantees the
/// task is spawned at most once per process.
pub fn ensure_bridge_running<R: Runtime>(app: &AppHandle<R>, bus: &AgentEventBus) {
    static SPAWNED: OnceLock<()> = OnceLock::new();
    if SPAWNED.get().is_some() {
        return;
    }
    let mut rx = bus.tx.subscribe();
    let app = app.clone();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(change) => {
                    if let Err(e) = app.emit("agent-state-changed", &change) {
                        warn!(error=%e, "agent-state-changed emit failed");
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!(dropped = n, "agent event bus lagged");
                }
            }
        }
    });
    let _ = SPAWNED.set(());
}

// ---- Tauri commands --------------------------------------------------------

#[tauri::command]
pub fn agent_list(state: tauri::State<'_, AppHandleState>) -> Vec<AgentListItem> {
    let registry = state.agents.lock().expect("agent registry poisoned");
    registry.list()
}

#[tauri::command]
pub fn agent_state(
    state: tauri::State<'_, AppHandleState>,
    session_id: String,
) -> Option<raum_core::agent::AgentState> {
    state
        .agents
        .lock()
        .expect("agent registry poisoned")
        .state_for(&session_id)
}

#[derive(Debug, Serialize)]
pub struct AgentSpawnReport {
    pub session_id: String,
    pub binary_missing: bool,
    pub binary: String,
    pub version_ok: Option<bool>,
    pub version_raw: Option<String>,
    pub hook_fallback: bool,
    pub supports_native_events: bool,
}

#[tauri::command]
pub async fn agent_spawn<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
    worktree_id: String,
    harness: AgentKind,
) -> Result<AgentSpawnReport, String> {
    // Ensure bridge task is running once per process.
    ensure_bridge_running(&app, &state.agent_events);

    let adapter = {
        let registry = state.agents.lock().expect("agent registry poisoned");
        registry
            .find_adapter(harness)
            .ok_or_else(|| format!("no adapter registered for {:?}", harness))?
    };

    // §7.9 — missing-binary detection.
    if which::which(adapter.binary_path()).is_err() {
        info!(
            binary = adapter.binary_path(),
            "agent_spawn: binary missing on PATH"
        );
        emit_missing_binary_notification(&app, adapter.binary_path(), harness);
        return Ok(AgentSpawnReport {
            session_id: String::new(),
            binary_missing: true,
            binary: adapter.binary_path().to_string(),
            version_ok: None,
            version_raw: None,
            hook_fallback: false,
            supports_native_events: adapter.supports_native_events(),
        });
    }

    // §7.10 — minimum-version warning (non-blocking).
    let version = adapter.detect_version().await.ok();
    let (version_ok, version_raw) = match &version {
        Some(v) => {
            if matches!(v.at_or_above_minimum, Some(false) | None) {
                let _ = app.emit(
                    "version-warning",
                    serde_json::json!({
                        "harness": harness,
                        "raw": v.raw,
                        "parsed": v.parsed.as_ref().map(|p| format!("{}.{}.{}", p.major, p.minor, p.patch)),
                        "minimum": {
                            "major": adapter.minimum_version().major,
                            "minor": adapter.minimum_version().minor,
                            "patch": adapter.minimum_version().patch,
                        },
                    }),
                );
            }
            (v.at_or_above_minimum, Some(v.raw.clone()))
        }
        None => (None, None),
    };

    // §7.11 — attempt hook install; on failure, fall back to silence heuristic.
    let hooks_dir = paths::hooks_dir();
    let mut hook_fallback = false;
    if adapter.supports_native_events() {
        if let Err(AgentError::HookInstall(msg)) = adapter.install_hooks(&hooks_dir).await {
            warn!(error = %msg, "hook install failed; falling back to silence heuristic");
            hook_fallback = true;
            let _ = app.emit(
                "hook-fallback",
                serde_json::json!({
                    "harness": harness,
                    "reason": msg,
                }),
            );
        }
    }

    // Register a state machine for this session.
    let session_id = format!(
        "raum-{project_slug}-{worktree_id}-{}",
        harness.binary_name()
    );
    let mut machine = AgentStateMachine::new(SessionId::new(session_id.clone()), harness);
    if hook_fallback {
        machine.set_silence_only(true);
    }
    {
        let mut registry = state.agents.lock().expect("agent registry poisoned");
        registry.register_machine(machine);
    }

    Ok(AgentSpawnReport {
        session_id,
        binary_missing: false,
        binary: adapter.binary_path().to_string(),
        version_ok,
        version_raw,
        hook_fallback,
        supports_native_events: adapter.supports_native_events(),
    })
}

fn emit_missing_binary_notification<R: Runtime>(
    app: &AppHandle<R>,
    binary: &str,
    harness: AgentKind,
) {
    // §7.9 — non-blocking. We emit a webview event carrying the install hint;
    // the frontend renders this as a toast via `tauri-plugin-notification` (or
    // an inline banner, if the user denied OS notifications earlier, per §11.4).
    let install_hint = install_hint_for(harness);
    let payload = serde_json::json!({
        "harness": harness,
        "binary": binary,
        "install_hint": install_hint,
        "title": "raum: harness not installed",
        "body": format!("`{binary}` is not on $PATH.\n{install_hint}"),
    });
    if let Err(e) = app.emit("agent-binary-missing", &payload) {
        warn!(error=%e, "agent-binary-missing emit failed");
    }
}

fn install_hint_for(harness: AgentKind) -> &'static str {
    match harness {
        AgentKind::ClaudeCode => "Install Claude Code: https://docs.claude.com/en/docs/claude-code",
        AgentKind::Codex => "Install Codex: https://github.com/openai/codex",
        AgentKind::OpenCode => "Install OpenCode: https://opencode.ai",
        AgentKind::Shell => "Install a POSIX shell (sh)",
    }
}

// The `AgentRegistry` / `AgentEventBus` fields are exposed through
// `state::AppHandleState`; see that module for the wiring.

#[cfg(test)]
mod tests {
    use super::*;

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
    fn agent_kind_wire_mapping_covers_every_harness_filename() {
        // Mirrors `raum_hooks::scripts::harness_filename` (private but
        // stable): the drain loop must accept every harness the hook
        // scripts can identify themselves as.
        assert_eq!(agent_kind_from_wire("shell"), Some(AgentKind::Shell));
        assert_eq!(
            agent_kind_from_wire("claude-code"),
            Some(AgentKind::ClaudeCode)
        );
        assert_eq!(agent_kind_from_wire("codex"), Some(AgentKind::Codex));
        assert_eq!(agent_kind_from_wire("opencode"), Some(AgentKind::OpenCode));
        assert_eq!(agent_kind_from_wire("unknown-harness"), None);
    }

    #[test]
    fn apply_hook_to_matching_advances_machines_of_matching_harness() {
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

        let event = CoreHookEvent {
            harness: "claude-code".into(),
            event: "UserPromptSubmit".into(),
            payload: serde_json::Value::Null,
        };
        let changes = r.apply_hook_to_matching(AgentKind::ClaudeCode, &event);
        assert_eq!(changes.len(), 2, "both CC machines must advance");
        assert!(changes.iter().all(|c| c.harness == AgentKind::ClaudeCode));
        assert_eq!(
            r.state_for("raum-oc-1"),
            Some(raum_core::agent::AgentState::Idle),
            "OpenCode machine must be untouched",
        );
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
            matches!(err, Err(AgentError::BinaryMissing { .. })),
            "expected BinaryMissing, got {err:?}"
        );
    }
}
