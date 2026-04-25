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
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use raum_core::agent::{AgentAdapter, AgentKind, SessionId};
use raum_core::agent_state::{AgentStateChanged, AgentStateMachine, HookEvent as CoreHookEvent};
use raum_core::harness::setup::{SetupContext, SetupExecutor};
use raum_core::harness::traits::SessionSpec;
use raum_core::harness::{Reliability, decode_payload, default_registry};
use raum_core::paths;
use raum_hooks::HookEvent;
use raum_hydration::worktree_list as git_worktree_list;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::commands::harness_runtime::{SessionRuntime, harness_wire_name, spawn_channel_task};
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

    /// Clobbering register (inserts unconditionally). Production callers
    /// should prefer `register_machine_if_absent` so a pre-populated
    /// machine (e.g. from the startup rehydrate task) isn't reset to
    /// its seed on a later reattach. Kept for tests that want to force
    /// a specific state into the registry.
    #[cfg(test)]
    pub fn register_machine(&mut self, machine: AgentStateMachine) {
        self.machines
            .insert(machine.session_id().as_str().to_string(), machine);
    }

    /// Idempotent counterpart to `register_machine`: inserts `machine` only
    /// when no entry exists for its session_id. Returns `true` when the
    /// machine was inserted, `false` when an entry already existed (the
    /// caller's `machine` is dropped in that case). Used by the reattach
    /// path so a state machine pre-populated by the startup rehydrate
    /// bootstrap keeps any in-flight transitions instead of being reset to
    /// the `last_state` seed a second time.
    pub fn register_machine_if_absent(&mut self, machine: AgentStateMachine) -> bool {
        let sid = machine.session_id().as_str().to_string();
        if self.machines.contains_key(&sid) {
            return false;
        }
        self.machines.insert(sid, machine);
        true
    }

    /// Flip the silence-only fallback flag on an existing machine without
    /// otherwise touching its state. Used on reattach to re-sync the flag
    /// when the hook-installed status changed between startup rehydrate
    /// (where the event socket may not have been bound yet) and the user
    /// actually opening a pane. Returns `true` iff the machine existed.
    pub fn set_silence_only(&mut self, session_id: &str, silence_only: bool) -> bool {
        let Some(machine) = self.machines.get_mut(session_id) else {
            return false;
        };
        machine.set_silence_only(silence_only);
        true
    }

    /// Drop the state machine for a session. Called by `terminal_kill` so
    /// the silence-tick task doesn't keep emitting heuristic transitions
    /// on a dead session id.
    pub fn remove_machine(&mut self, session_id: &str) -> bool {
        self.machines.remove(session_id).is_some()
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

    /// Walk every registered machine and advance it via the silence
    /// heuristic. Machines without a recorded `last_output_at` are
    /// skipped — they are still spinning up, or the PTY tap has not
    /// fired yet. Used by the silence-tick task in
    /// [`spawn_silence_tick`] so the UI can recover activity / idle
    /// state when a harness-native event path is unavailable.
    pub fn tick_silence_all(
        &mut self,
        last_output_at: &HashMap<String, Instant>,
        now: Instant,
    ) -> Vec<AgentStateChanged> {
        let mut out = Vec::new();
        for (sid, machine) in self.machines.iter_mut() {
            let Some(last) = last_output_at.get(sid) else {
                continue;
            };
            let age = now.saturating_duration_since(*last);
            if let Some(change) = machine.tick_silence(age) {
                out.push(change);
            }
        }
        out
    }

    #[must_use]
    pub fn state_for(&self, session_id: &str) -> Option<raum_core::agent::AgentState> {
        self.machines.get(session_id).map(|m| m.state())
    }

    /// The user submitting input is the first trustworthy signal that a future
    /// burst of PTY output belongs to a real turn rather than startup or
    /// attach redraw. This arms output-based recovery for sessions whose
    /// follow-up start hook is missed.
    pub fn arm_activity_for_submit(&mut self, session_id: &str) -> bool {
        let Some(machine) = self.machines.get_mut(session_id) else {
            return false;
        };
        machine.arm_activity();
        true
    }

    /// The user pressed the abort key (Ctrl-C) in this pane. No harness
    /// emits a cancellation hook, so this synthetic signal is the only way
    /// the state machine can return to `Idle` without waiting for the full
    /// silence heuristic. Working/Waiting → Idle; other states are left
    /// alone (terminal semantics preserved).
    pub fn abort_session(&mut self, session_id: &str) -> Option<AgentStateChanged> {
        self.machines.get_mut(session_id)?.on_user_abort()
    }

    /// The user answered a permission prompt for this session. Demote
    /// Waiting → Working so the NEXT `PermissionRequest` produces a
    /// visible state transition (without this, the machine sticks at
    /// Waiting and every subsequent request is a silent no-op).
    pub fn on_permission_reply(&mut self, session_id: &str) -> Option<AgentStateChanged> {
        self.machines.get_mut(session_id)?.on_permission_reply()
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct PermissionNotificationEvent {
    harness: String,
    event: String,
    source: Option<String>,
    session_id: Option<String>,
    request_id: Option<String>,
    permission_key: String,
    payload: serde_json::Value,
}

fn fallback_permission_key(ev: &HookEvent) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    ev.harness.hash(&mut hasher);
    ev.event.hash(&mut hasher);
    ev.source.hash(&mut hasher);
    ev.payload.to_string().hash(&mut hasher);
    format!("legacy-{:016x}", hasher.finish())
}

fn build_permission_notification_event(ev: &HookEvent) -> Option<PermissionNotificationEvent> {
    if ev.event != "PermissionRequest" {
        return None;
    }
    let permission_key = ev
        .request_id
        .clone()
        .or_else(|| ev.session_id.clone())
        .unwrap_or_else(|| fallback_permission_key(ev));
    Some(PermissionNotificationEvent {
        harness: ev.harness.clone(),
        event: ev.event.clone(),
        source: ev.source.clone(),
        session_id: ev.session_id.clone(),
        request_id: ev.request_id.clone(),
        permission_key,
        payload: decode_payload(&ev.payload).into_owned(),
    })
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
            source: ev.source.clone(),
            reliability: ev.reliability.as_deref().and_then(Reliability::from_label),
            payload: ev.payload.clone(),
        };
        let state: tauri::State<'_, crate::state::AppHandleState> = app.state();
        // Diagnostic surface: record "we received a hook from X at T"
        // so the Harness Health panel can tell the user whether the
        // pipeline is dead or merely quiet.
        if let Ok(mut slot) = state.last_hook_at.lock() {
            *slot = Some(crate::state::LastHook {
                at_unix: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs()),
                harness: ev.harness.clone(),
                event: ev.event.clone(),
            });
        }
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

        // Surface every permission-needed event to the webview. Some
        // harnesses provide a replyable `request_id`; others are observation-
        // only and should still produce a focus-the-pane notification.
        if let Some(payload) = build_permission_notification_event(&ev) {
            if let Err(e) = app.emit("notification-event", &payload) {
                warn!(error=%e, "notification-event emit failed");
            }
        }
    }
}

/// Ensure the bridge task that re-emits `AgentStateChanged` records onto the
/// Tauri event bus is running. Idempotent — the `OnceLock` guarantees the
/// task is spawned at most once per process.
///
/// Each transition is persisted into `state/sessions.toml` **before** we
/// emit `agent-state-changed` so any frontend reload that races with a
/// live transition can't observe an emit whose state isn't yet on disk
/// (the reloaded frontend would then snapshot a stale `last_state` and
/// miss the transition entirely since the broadcast buffer doesn't
/// replay).
pub fn ensure_bridge_running<R: Runtime>(app: &AppHandle<R>, bus: &AgentEventBus) {
    static SPAWNED: OnceLock<()> = OnceLock::new();
    if SPAWNED.get().is_some() {
        return;
    }
    let mut rx = bus.tx.subscribe();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(change) => {
                    // Persist first so `agent_snapshot` / `agent_list`
                    // callers that race with the emit see the new state.
                    persist_last_state(&app, &change);
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

fn persist_last_state<R: Runtime>(app: &AppHandle<R>, change: &AgentStateChanged) {
    let state: tauri::State<'_, AppHandleState> = app.state();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    let store = match state.config_store.lock() {
        Ok(g) => g,
        Err(_) => {
            warn!("persist last_state: config_store lock poisoned");
            return;
        }
    };
    if let Err(e) = store.update_session_last_state(
        change.session_id.as_str(),
        change.harness,
        change.to,
        now_ms,
    ) {
        warn!(error=%e, session_id=%change.session_id.as_str(), "persist last_state failed");
    }
}

fn seed_session_activity_for_persisted_state(
    session_activity: &Arc<Mutex<HashMap<String, Instant>>>,
    session_id: &str,
    persisted_state: Option<raum_core::agent::AgentState>,
) {
    let Ok(mut activity) = session_activity.lock() else {
        warn!(
            session_id = %session_id,
            "seed persisted state: session_activity lock poisoned"
        );
        return;
    };
    if persisted_state == Some(raum_core::agent::AgentState::Working) {
        // Reattached sessions can be seeded from the last persisted state
        // before any fresh PTY bytes arrive. Seed a synthetic "last output"
        // timestamp so the silence tick can age a stale Working seed back to
        // Idle instead of leaving it stuck forever on cold boot.
        activity.insert(session_id.to_string(), Instant::now());
    }
}

/// Silence-heuristic tick interval. 250 ms is well below the state
/// machine's 500 ms silence threshold, so fallback state recovery
/// reacts within a tick of a meaningful PTY activity/silence change.
const SILENCE_TICK_INTERVAL: Duration = Duration::from_millis(250);

/// Spawn the periodic silence-tick task. Idempotent: guarded by a
/// `OnceLock` so repeated calls during hot-reload test paths are safe.
///
/// Reads `session_activity` timestamps (updated by the PTY bytes
/// callback in `commands::terminal::open_bridge_and_monitor`) and
/// walks every registered state machine through
/// [`AgentRegistry::tick_silence_all`]. Resulting transitions are
/// published onto [`AgentEventBus`] the same way hook-driven
/// transitions are, so the frontend `agent-state-changed` listener
/// treats them uniformly.
///
/// This is the only path that can recover `Idle -> Working`,
/// `Waiting -> Working`, `Completed -> Working`, and `Working -> Idle`
/// when the harness-native notification path never fires. Deterministic
/// "needs input" remains event-driven.
pub fn spawn_silence_tick<R: Runtime>(app: &AppHandle<R>) {
    static SPAWNED: OnceLock<()> = OnceLock::new();
    if SPAWNED.get().is_some() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(SILENCE_TICK_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let state: tauri::State<'_, crate::state::AppHandleState> = app.state();
            let activity_snapshot: HashMap<String, Instant> = {
                match state.session_activity.lock() {
                    Ok(g) => g.clone(),
                    Err(_) => {
                        warn!("silence-tick: session_activity lock poisoned; skipping tick");
                        continue;
                    }
                }
            };
            let now = Instant::now();
            let changes: Vec<AgentStateChanged> = {
                let Ok(mut registry) = state.agents.lock() else {
                    warn!("silence-tick: agent registry lock poisoned; skipping tick");
                    continue;
                };
                registry.tick_silence_all(&activity_snapshot, now)
            };
            if changes.is_empty() {
                continue;
            }
            let bus = &state.agent_events;
            for change in changes {
                // Broadcast only; persistence + emit happen in the
                // bridge task (see `ensure_bridge_running`) so there
                // is exactly one persist per transition regardless of
                // whether the transition originated from a hook, SSE,
                // or the silence heuristic.
                let _ = bus.tx.send(change);
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

/// Atomic snapshot returned to the frontend on mount / after ⌘R. Combines
/// `agent_list()` + `terminal_list()` into a single round-trip so the
/// frontend can seed both stores before any memo computes a count — the
/// two-invoke sequence `refreshAgents().then(refreshTerminals)` leaves
/// the memos rendering `0 0 0` for the round-trip window, which is the
/// visible symptom users report after cmd+r even when the backend has
/// live state.
///
/// Callers are expected to:
///   1. attach their `agent-state-changed` / `terminal-session-*` listeners,
///   2. buffer events arriving between attach and this call's result,
///   3. apply this snapshot in bulk,
///   4. flush the buffer on top.
#[derive(Debug, Serialize)]
pub struct AgentSnapshot {
    pub agents: Vec<AgentListItem>,
    pub terminals: Vec<crate::commands::terminal::TerminalListItem>,
}

#[tauri::command]
pub fn agent_snapshot(state: tauri::State<'_, AppHandleState>) -> Result<AgentSnapshot, String> {
    // Acquire both locks before reading so we can't serve an agent list
    // referencing a terminal that was removed between the two reads.
    let agents = state
        .agents
        .lock()
        .map_err(|e| format!("agent registry lock: {e}"))?
        .list();
    let terminals = state
        .terminals
        .lock()
        .map_err(|e| format!("terminals lock: {e}"))?
        .list();
    Ok(AgentSnapshot { agents, terminals })
}

/// Snapshot of the hook-event pipeline health. Consumed by the Harness
/// Health panel in the settings modal to surface whether the UDS
/// socket bound successfully and whether any hook has ever fired.
///
/// Answers the common "why isn't the busy indicator moving?" question
/// without asking the user to read logs. In dev builds the hook
/// dispatcher script silently exits on transport failures; the
/// `scripts_written` + `transports_available` + `env_raum_event_sock`
/// triad lets the UI spot each common failure mode (no socat / missing
/// script / env var never exported / harness started before config
/// install).
#[derive(Debug, Serialize)]
pub struct HooksDiagnostics {
    pub socket_bound: bool,
    pub socket_path: Option<String>,
    pub last_hook_at_unix: Option<u64>,
    pub last_hook_harness: Option<String>,
    pub last_hook_event: Option<String>,
    /// `RAUM_EVENT_SOCK` value as currently exported to raum's
    /// environment. Child harnesses inherit this via tmux `-e`; if it's
    /// `None`, every subsequent harness spawn will fall back to the
    /// silence heuristic because the scripts early-exit on empty
    /// `$RAUM_EVENT_SOCK`.
    pub env_raum_event_sock: Option<String>,
    /// Per-script disposition: does the dispatcher exist, is it
    /// executable (mode 0700), and can the runtime resolve at least
    /// one transport (`socat` / `nc` / `python3`)? Empty list when the
    /// hooks dir hasn't been populated yet.
    pub scripts_written: Vec<HookScriptStatus>,
    /// Runtime transports the hook dispatcher scripts fall back onto
    /// in the `socat → nc → python3` order. A script with **none**
    /// available silently exits 0 on every hook invocation and is the
    /// canonical "why aren't hooks firing in dev?" failure mode on
    /// hosts that don't ship one of the three.
    pub transports_available: TransportProbe,
}

/// Per-harness script status surfaced to the Harness Health panel.
#[derive(Debug, Serialize)]
pub struct HookScriptStatus {
    pub harness: String,
    pub path: String,
    pub exists: bool,
    /// POSIX mode bits of the script file (e.g. `0o700`). `None` when
    /// the file is missing.
    pub mode: Option<u32>,
    /// `true` iff `mode & 0o100 == 0o100` — the owner-exec bit is set.
    pub executable: bool,
}

/// Availability of the three transports the hook dispatcher script
/// falls back through. `any()` returning false means the script will
/// silently exit 0 on every invocation.
#[derive(Debug, Serialize, Default)]
pub struct TransportProbe {
    pub socat: bool,
    pub nc: bool,
    pub python3: bool,
}

impl TransportProbe {
    #[must_use]
    pub fn probe() -> Self {
        Self {
            socat: which::which("socat").is_ok(),
            nc: which::which("nc").is_ok(),
            python3: which::which("python3").is_ok(),
        }
    }
}

fn script_status(harness: &str, hooks_dir: &std::path::Path) -> HookScriptStatus {
    let path = hooks_dir.join(format!("{harness}.sh"));
    let meta = std::fs::metadata(&path).ok();
    let exists = meta.is_some();
    let mode = meta.as_ref().map(|m| {
        use std::os::unix::fs::PermissionsExt;
        m.permissions().mode() & 0o777
    });
    let executable = mode.is_some_and(|m| m & 0o100 == 0o100);
    HookScriptStatus {
        harness: harness.to_string(),
        path: path.to_string_lossy().into_owned(),
        exists,
        mode,
        executable,
    }
}

#[tauri::command]
pub fn hooks_diagnostics(state: tauri::State<'_, AppHandleState>) -> HooksDiagnostics {
    let (socket_bound, socket_path) = match state.event_socket.lock() {
        Ok(g) => match g.as_ref() {
            Some(h) => (true, Some(h.path.to_string_lossy().into_owned())),
            None => (false, None),
        },
        Err(_) => (false, None),
    };
    let (last_hook_at_unix, last_hook_harness, last_hook_event) = match state.last_hook_at.lock() {
        Ok(g) => match g.as_ref() {
            Some(lh) => (
                Some(lh.at_unix),
                Some(lh.harness.clone()),
                Some(lh.event.clone()),
            ),
            None => (None, None, None),
        },
        Err(_) => (None, None, None),
    };
    let env_raum_event_sock = std::env::var(raum_hooks::RAUM_EVENT_SOCK_ENV).ok();
    let hooks_dir = paths::hooks_dir();
    let scripts_written = vec![
        script_status("claude-code", &hooks_dir),
        script_status("codex", &hooks_dir),
        script_status("codex-notify", &hooks_dir),
    ];
    let transports_available = TransportProbe::probe();
    HooksDiagnostics {
        socket_bound,
        socket_path,
        last_hook_at_unix,
        last_hook_harness,
        last_hook_event,
        env_raum_event_sock,
        scripts_written,
        transports_available,
    }
}

/// Synthetic round-trip test for the hook-event UDS pipeline.
///
/// Writes a sentinel `HookEvent` to the bound socket and waits up to
/// 2 s for the `last_hook_at` timestamp in [`AppHandleState`] to update
/// past the pre-call snapshot. Returns whether the round-trip
/// succeeded plus enough detail for the UI to render a one-line result.
///
/// This is the surface the Harness Health "Run selftest" button pokes —
/// it proves the socket is bound AND the drain task is running, without
/// requiring the user to install a harness first.
#[derive(Debug, Serialize)]
pub struct HooksSelftestReport {
    pub ok: bool,
    pub detail: String,
    pub elapsed_ms: u64,
    pub socket_path: Option<String>,
    pub transport_used: Option<String>,
}

#[tauri::command]
pub async fn hooks_selftest<R: Runtime>(app: AppHandle<R>) -> Result<HooksSelftestReport, String> {
    use std::time::Instant;
    use tokio::io::AsyncWriteExt;
    use tokio::net::UnixStream;

    let started = Instant::now();
    let state: tauri::State<'_, AppHandleState> = app.state();
    let socket_path: Option<std::path::PathBuf> = state
        .event_socket
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|h| h.path.clone()));
    let Some(path) = socket_path else {
        return Ok(HooksSelftestReport {
            ok: false,
            detail: "event socket is not bound".into(),
            elapsed_ms: elapsed_ms(started),
            socket_path: None,
            transport_used: None,
        });
    };
    let path_display = path.to_string_lossy().into_owned();

    // Snapshot the pre-write timestamp so we can detect the synthetic
    // event landing without relying on wall-clock comparisons that
    // could fold into an already-recent timestamp.
    let before: Option<u64> = state
        .last_hook_at
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|lh| lh.at_unix));

    // Tag the synthetic event distinctly so the drain loop's warn/log
    // surfaces identify it, and any classification logic can ignore it.
    let payload = serde_json::json!({
        "harness": "shell",
        "event": "raum-selftest",
        "session_id": null,
        "source": "hooks_selftest",
        "reliability": "deterministic",
        "payload": { "selftest": true },
    });
    let mut line = payload.to_string();
    line.push('\n');

    let send_result = async {
        let mut stream = UnixStream::connect(&path).await?;
        stream.write_all(line.as_bytes()).await?;
        stream.flush().await?;
        Ok::<(), std::io::Error>(())
    }
    .await;

    if let Err(e) = send_result {
        return Ok(HooksSelftestReport {
            ok: false,
            detail: format!("connect/write failed: {e}"),
            elapsed_ms: elapsed_ms(started),
            socket_path: Some(path_display),
            transport_used: Some("tokio::UnixStream".into()),
        });
    }

    // Poll the diagnostic timestamp for up to 2 s.
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        let observed: Option<u64> = state
            .last_hook_at
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|lh| lh.at_unix));
        if observed.is_some() && observed != before {
            return Ok(HooksSelftestReport {
                ok: true,
                detail: "round-trip ok".into(),
                elapsed_ms: elapsed_ms(started),
                socket_path: Some(path_display),
                transport_used: Some("tokio::UnixStream".into()),
            });
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    Ok(HooksSelftestReport {
        ok: false,
        detail: "event written but drain never observed it (drain stalled?)".into(),
        elapsed_ms: elapsed_ms(started),
        socket_path: Some(path_display),
        transport_used: Some("tokio::UnixStream".into()),
    })
}

fn elapsed_ms(start: std::time::Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
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

pub async fn prepare_harness_launch<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppHandleState,
    harness: AgentKind,
    project_slug: Option<&str>,
    project_dir: PathBuf,
) -> Result<AgentSpawnReport, String> {
    ensure_bridge_running(app, &state.agent_events);

    let adapter = {
        let registry = state
            .agents
            .lock()
            .map_err(|e| format!("agent registry lock: {e}"))?;
        registry
            .find_adapter(harness)
            .ok_or_else(|| format!("no adapter registered for {:?}", harness))?
    };

    if which::which(adapter.binary_path()).is_err() {
        info!(
            binary = adapter.binary_path(),
            harness = ?harness,
            "prepare_harness_launch: binary missing on PATH"
        );
        emit_missing_binary_notification(app, adapter.binary_path(), harness);
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

    let mut hook_fallback = state
        .channel_event_tx
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .is_none();
    let hooks_dir = paths::hooks_dir();
    let event_sock = paths::event_socket_path();
    let home_dir = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    // Pre-declare every worktree + the project root as Codex-trusted so
    // the spawn-time managed-TOML regenerate does not wipe Codex's
    // per-path trust acceptance on each launch. `git worktree list`
    // errors (e.g. not a git repo) degrade to root-only trust.
    let worktree_paths: Vec<PathBuf> = if project_dir.as_os_str().is_empty() {
        Vec::new()
    } else {
        match git_worktree_list(&project_dir) {
            Ok(entries) => entries.into_iter().map(|e| e.path).collect(),
            Err(e) => {
                warn!(
                    project_dir = %project_dir.display(),
                    error = %e,
                    "git worktree list failed; skipping worktree trust entries",
                );
                Vec::new()
            }
        }
    };
    let ctx = SetupContext::new(
        hooks_dir.clone(),
        event_sock.clone(),
        project_slug.unwrap_or_default().to_string(),
    )
    .with_project_dir(project_dir)
    .with_home_dir(home_dir)
    .with_worktree_paths(worktree_paths);

    if adapter.supports_native_events() {
        match state.harness_runtimes.plan(harness, &ctx).await {
            Ok(plan) => {
                let report = SetupExecutor::new().apply(&plan);
                if !report.ok {
                    hook_fallback = true;
                    warn!(
                        harness = ?harness,
                        "setup plan has failed actions; falling back to silence heuristic",
                    );
                }
                if let Err(e) = app.emit("harness-setup-report", &report) {
                    warn!(error=%e, "harness-setup-report emit failed");
                }
            }
            Err(e) => {
                warn!(error=%e, "setup plan failed to build");
                hook_fallback = true;
                let _ = app.emit(
                    "harness-setup-report",
                    serde_json::json!({
                        "harness": harness,
                        "ok": false,
                        "actions": [],
                        "error": e.to_string(),
                    }),
                );
            }
        }

        let selftest = state.harness_runtimes.selftest(harness, &ctx).await;
        if let Err(e) = app.emit("harness-selftest-report", &selftest) {
            warn!(error=%e, "harness-selftest-report emit failed");
        }
    }

    Ok(AgentSpawnReport {
        session_id: String::new(),
        binary_missing: false,
        binary: adapter.binary_path().to_string(),
        version_ok,
        version_raw,
        hook_fallback,
        supports_native_events: adapter.supports_native_events(),
    })
}

/// Fast spawn-time preflight for `terminal_spawn`.
///
/// This intentionally avoids version probing, `git worktree list`, setup-plan
/// writes, and selftests. Those are useful health checks, but they should not
/// sit between the user's click and the harness process starting. We still
/// verify the binary exists and do a cheap on-disk scan so sessions with hooks
/// missing can start in silence-fallback mode until the background refresh
/// catches up.
pub fn prepare_harness_launch_fast<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppHandleState,
    harness: AgentKind,
    project_slug: Option<&str>,
    project_dir: PathBuf,
) -> Result<AgentSpawnReport, String> {
    ensure_bridge_running(app, &state.agent_events);

    let adapter = {
        let registry = state
            .agents
            .lock()
            .map_err(|e| format!("agent registry lock: {e}"))?;
        registry
            .find_adapter(harness)
            .ok_or_else(|| format!("no adapter registered for {:?}", harness))?
    };

    if which::which(adapter.binary_path()).is_err() {
        info!(
            binary = adapter.binary_path(),
            harness = ?harness,
            "prepare_harness_launch_fast: binary missing on PATH"
        );
        emit_missing_binary_notification(app, adapter.binary_path(), harness);
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

    let mut hook_fallback = state
        .channel_event_tx
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .is_none();

    if adapter.supports_native_events() && !hook_fallback {
        let home_dir = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
        let ctx = SetupContext::new(
            paths::hooks_dir(),
            paths::event_socket_path(),
            project_slug.unwrap_or_default().to_string(),
        )
        .with_project_dir(project_dir)
        .with_home_dir(home_dir);
        let scan = state.harness_runtimes.scan(harness, &ctx);
        hook_fallback = !scan.raum_hooks_installed;
    }

    Ok(AgentSpawnReport {
        session_id: String::new(),
        binary_missing: false,
        binary: adapter.binary_path().to_string(),
        version_ok: None,
        version_raw: None,
        hook_fallback,
        supports_native_events: adapter.supports_native_events(),
    })
}

pub fn spawn_harness_launch_refresh<R: Runtime + 'static>(
    app: AppHandle<R>,
    harness: AgentKind,
    project_slug: Option<String>,
    project_dir: PathBuf,
) {
    tauri::async_runtime::spawn(async move {
        let state: tauri::State<'_, AppHandleState> = app.state();
        if let Err(e) =
            prepare_harness_launch(&app, &state, harness, project_slug.as_deref(), project_dir)
                .await
        {
            warn!(
                harness = ?harness,
                error = %e,
                "background harness launch refresh failed"
            );
        }
    });
}

pub fn infer_reattach_hook_fallback(
    state: &AppHandleState,
    harness: AgentKind,
    project_slug: Option<&str>,
    project_dir: PathBuf,
) -> bool {
    let event_path_available = state
        .channel_event_tx
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .is_some();
    if !event_path_available {
        return true;
    }
    if !matches!(harness, AgentKind::ClaudeCode | AgentKind::Codex) {
        return false;
    }

    let home_dir = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    let ctx = SetupContext::new(
        paths::hooks_dir(),
        paths::event_socket_path(),
        project_slug.unwrap_or_default().to_string(),
    )
    .with_project_dir(project_dir)
    .with_home_dir(home_dir);
    !state
        .harness_runtimes
        .scan(harness, &ctx)
        .raum_hooks_installed
}

/// Knobs for `register_harness_session_runtime_opts`. Defaults reproduce
/// the original `register_harness_session_runtime` behaviour.
///
/// The rehydrate bootstrap calls the opts variant with defaults (it owns
/// the first register, so channels must spawn and the seed emit must
/// fire). The `terminal_reattach` path sets both flags to `true` so the
/// state machine left in place by the bootstrap keeps any in-flight
/// transitions, and the channel subscriptions started at bootstrap keep
/// running.
#[derive(Debug, Default, Clone, Copy)]
pub struct RegisterOptions {
    /// When `true`, skip the `harness_runtimes.register_session(...)`
    /// tail if a live `SessionRuntime` is already registered for this
    /// session id. Prevents tearing down hook-channel + SSE + HTTP
    /// replier tasks that the startup rehydrate task already spawned.
    pub skip_channels_if_present: bool,
    /// When `true`, suppress the synthetic `agent-state-changed` emit
    /// that normally fires on reattach when the persisted seed is
    /// non-`Idle`. The bootstrap emits that event itself, and a
    /// duplicate emit on the subsequent `terminal_reattach` call would
    /// confuse the frontend's state transition tracker.
    pub skip_seed_emit: bool,
    /// Session-scoped OpenCode server port. When present, the runtime uses it
    /// instead of guessing the default/random OpenCode port.
    pub opencode_port: Option<u16>,
}

/// Backwards-compatible wrapper. Same signature as before the
/// `RegisterOptions` split; delegates with `RegisterOptions::default()`.
#[allow(clippy::too_many_arguments)]
pub fn register_harness_session_runtime<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppHandleState,
    harness: AgentKind,
    session_id: &str,
    project_slug: Option<&str>,
    worktree_id: Option<&str>,
    project_dir: PathBuf,
    hook_fallback: bool,
) -> Result<(), String> {
    register_harness_session_runtime_opts(
        app,
        state,
        harness,
        session_id,
        project_slug,
        worktree_id,
        project_dir,
        hook_fallback,
        RegisterOptions::default(),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn register_harness_session_runtime_opts<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppHandleState,
    harness: AgentKind,
    session_id: &str,
    project_slug: Option<&str>,
    worktree_id: Option<&str>,
    project_dir: PathBuf,
    hook_fallback: bool,
    opts: RegisterOptions,
) -> Result<(), String> {
    let channel_tx_opt: Option<mpsc::Sender<raum_hooks::HookEvent>> =
        state.channel_event_tx.lock().ok().and_then(|g| g.clone());

    // On reattach the tmux session survived the previous app run — if the
    // bridge task persisted a non-Idle state before we died, seed the fresh
    // machine with it so the `agent_state(session_id)` pull (issued by the
    // frontend right after `terminal_reattach` resolves) returns that state.
    // A live event (hook, SSE, silence tick) later overrides the seed, so
    // any stale value self-corrects within ≤500 ms.
    let persisted_state = state
        .config_store
        .lock()
        .ok()
        .and_then(|store| store.last_session_state(session_id));

    let silence_only = hook_fallback || channel_tx_opt.is_none();

    // Try to insert a fresh machine idempotently. If a machine already
    // exists (e.g. the startup rehydrate task registered one), keep it
    // and only re-sync the silence-only flag — this preserves any
    // transitions that fired between the bootstrap and the reattach.
    let inserted = {
        let mut registry = state
            .agents
            .lock()
            .map_err(|e| format!("agent registry lock: {e}"))?;
        let mut machine = AgentStateMachine::new(SessionId::new(session_id.to_string()), harness);
        if let Some(seed) = persisted_state {
            machine = machine.with_initial_state(seed);
        }
        if silence_only {
            machine.set_silence_only(true);
        }
        let newly_inserted = registry.register_machine_if_absent(machine);
        if !newly_inserted {
            registry.set_silence_only(session_id, silence_only);
        }
        newly_inserted
    };

    // Persist the session's project/worktree metadata so the next launch
    // can rehydrate it without relying on the active-layout grid. The call
    // is idempotent and preserves previously-written metadata, so hooks
    // that race ahead of this path via `update_session_last_state` (which
    // inserts with `project_slug: None`) get backfilled here.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    if let Ok(store) = state.config_store.lock()
        && let Err(e) = store.upsert_tracked_session(
            session_id,
            harness,
            project_slug,
            worktree_id,
            opts.opencode_port,
            now_ms,
        )
    {
        warn!(error=%e, session_id=%session_id, "upsert_tracked_session failed");
    }

    // Seeding the activity timestamp is only meaningful on the initial
    // register; if a machine was already present it also already had its
    // activity tracked by the prior registration.
    if inserted {
        seed_session_activity_for_persisted_state(
            &state.session_activity,
            session_id,
            persisted_state,
        );
    }

    // Best-effort: also fire a synthetic `agent-state-changed` so any
    // already-listening frontend subscriber updates immediately. The
    // reliable path is the post-`terminal_reattach` pull on the frontend
    // (see `hydrateHarnessStateAfterReattach` in terminal-pane.tsx) — this
    // emit can race with `listen()` registration, so it's additive only.
    //
    // Skip the emit when the caller asked us to (the rehydrate bootstrap
    // emits its own; the follow-up reattach would double-fire).
    if !opts.skip_seed_emit
        && let Some(seed) = persisted_state
        && seed != raum_core::agent::AgentState::Idle
    {
        let change = AgentStateChanged {
            session_id: SessionId::new(session_id.to_string()),
            harness,
            from: raum_core::agent::AgentState::Idle,
            to: seed,
            reliability: Reliability::Deterministic,
        };
        if let Err(e) = app.emit("agent-state-changed", &change) {
            warn!(error=%e, "seed agent-state-changed emit failed");
        }
    }

    // Channel setup. Skip when the caller opted in AND a live runtime
    // already exists for this session id — the reattach path uses this
    // flag to leave the bootstrap-registered SSE/http tasks alone.
    if opts.skip_channels_if_present && state.harness_runtimes.has_session(session_id) {
        return Ok(());
    }

    let spec = SessionSpec {
        session_id: SessionId::new(session_id.to_string()),
        project_slug: project_slug.unwrap_or_default().to_string(),
        worktree_id: worktree_id.unwrap_or_default().to_string(),
        cwd: project_dir,
        opencode_port: opts.opencode_port,
    };
    let (channels, replier) = state.harness_runtimes.channels_and_replier(harness, &spec);
    let cancel = CancellationToken::new();
    let mut channel_tasks: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    if let Some(channel_tx) = channel_tx_opt {
        let wire_name = harness_wire_name(harness);
        for channel in channels {
            let (sink_tx, sink_rx) = mpsc::channel(32);
            let cancel_child = cancel.child_token();
            let cancel_channel = cancel_child.clone();
            let channel_handle =
                tokio::spawn(async move { channel.run(sink_tx, cancel_channel).await });
            let forward = spawn_channel_task(
                session_id.to_string(),
                wire_name,
                sink_rx,
                channel_tx.clone(),
                cancel_child,
            );
            channel_tasks.push(tokio::spawn(async move {
                let _ = channel_handle.await;
            }));
            channel_tasks.push(forward);
        }
    } else {
        warn!(
            session_id = %session_id,
            harness = ?harness,
            "channel_event_tx not initialised; using silence-only fallback",
        );
    }

    state.harness_runtimes.register_session(
        session_id.to_string(),
        SessionRuntime {
            kind: harness,
            cancel,
            replier: replier.map(Arc::from),
            channel_tasks,
        },
    );

    Ok(())
}

pub fn cleanup_harness_session(state: &AppHandleState, session_id: &str) {
    state.harness_runtimes.end_session(session_id);
    if let Ok(mut map) = state.session_activity.lock() {
        map.remove(session_id);
    }
    if let Ok(store) = state.config_store.lock()
        && let Err(e) = store.forget_session(session_id)
    {
        warn!(error=%e, session_id=%session_id, "forget tracked session failed");
    }
    if let Ok(mut reg) = state.agents.lock() {
        reg.remove_machine(session_id);
    }
}

#[tauri::command]
pub async fn agent_spawn<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
    worktree_id: String,
    harness: AgentKind,
) -> Result<AgentSpawnReport, String> {
    let project_dir = resolve_project_dir(&state, Some(&project_slug), Some(&worktree_id));
    prepare_harness_launch(&app, &state, harness, Some(&project_slug), project_dir).await
}

/// Phase 6 — Tauri command that runs the harness selftest on demand
/// (bound to the "Run again" button in the Harness Health panel).
/// Emits `harness-selftest-report` with the result so the frontend
/// store subscribes once rather than juggling response values.
#[tauri::command]
pub async fn harness_selftest<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    harness: AgentKind,
    project_slug: Option<String>,
    worktree_id: Option<String>,
) -> Result<raum_core::harness::SelftestReport, String> {
    let slug = project_slug.unwrap_or_default();
    let project_dir = resolve_project_dir(&state, Some(&slug), worktree_id.as_deref());
    let home_dir = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    let ctx = SetupContext::new(paths::hooks_dir(), paths::event_socket_path(), slug)
        .with_project_dir(project_dir)
        .with_home_dir(home_dir);
    let report = state.harness_runtimes.selftest(harness, &ctx).await;
    if let Err(e) = app.emit("harness-selftest-report", &report) {
        warn!(error=%e, "harness-selftest-report emit failed");
    }
    Ok(report)
}

/// Resolve the absolute project/worktree directory for a spawn.
///
/// Reads the project record via [`raum_core::store::ConfigStore`]. When the
/// caller supplies a `worktree_id` that resolves to an existing directory it
/// wins over the project root — this is what lets the sidebar's selected
/// worktree drive the cwd of hotkey-spawned harnesses. Returns an empty
/// `PathBuf` when the project is not registered or the store is unreachable
/// — the adapter's `plan()` treats an empty `project_dir` as "legacy
/// user-global path", which is the right fallback for first-run / shell-only
/// paths where there's nothing per-project to scope to yet.
pub(crate) fn resolve_project_dir(
    state: &AppHandleState,
    project_slug: Option<&str>,
    worktree_id: Option<&str>,
) -> PathBuf {
    let Some(slug) = project_slug else {
        return PathBuf::new();
    };
    let Ok(store) = state.config_store.lock() else {
        return PathBuf::new();
    };
    let project = match store.read_project(slug) {
        Ok(Some(project)) => project,
        _ => return PathBuf::new(),
    };
    if let Some(id) = worktree_id {
        let candidate = PathBuf::from(id);
        if candidate.is_dir() {
            return candidate;
        }
    }
    project.root_path
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
            source: None,
            reliability: None,
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
            matches!(err, Err(raum_core::agent::AgentError::BinaryMissing { .. })),
            "expected BinaryMissing, got {err:?}"
        );
    }

    #[test]
    fn submit_arming_applies_to_any_known_session() {
        let mut r = AgentRegistry::with_defaults();
        let live = AgentStateMachine::new(SessionId::new("raum-live"), AgentKind::ClaudeCode);
        let mut fallback =
            AgentStateMachine::new(SessionId::new("raum-fallback"), AgentKind::Codex);
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
}
