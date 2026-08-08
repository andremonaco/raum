//! Runtime wiring: hook-event socket drain, bridge task, session-runtime
//! registration, and the fast spawn-time preflight.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use raum_core::agent::{AgentKind, SessionId};
use raum_core::agent_state::{
    AgentStateChanged, AgentStateMachine, HookEvent as CoreHookEvent, PromptEntry, PromptUpdated,
    extract_harness_session_id, extract_user_prompt,
};
use raum_core::harness::setup::{SetupContext, which_cached};
use raum_core::harness::traits::SessionSpec;
use raum_core::harness::{Reliability, decode_payload};
use raum_core::paths;
use raum_hooks::HookEvent;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use super::persistence::{
    persist_last_prompt, persist_last_state, seed_session_activity_for_persisted_state,
};
use super::registry::AgentEventBus;
use super::spawn::emit_missing_binary_notification;
use crate::commands::harness_runtime::{SessionRuntime, harness_wire_name, spawn_channel_task};
use crate::state::AppHandleState;

/// Map a wire-format harness string (as emitted by the hook scripts in
/// `raum-hooks`) to the typed [`AgentKind`]. Returns `None` for unknown
/// harnesses so the drain loop can log-and-drop without panicking.
pub(super) fn agent_kind_from_wire(s: &str) -> Option<AgentKind> {
    match s {
        "shell" => Some(AgentKind::Shell),
        "claude-code" => Some(AgentKind::ClaudeCode),
        "codex" => Some(AgentKind::Codex),
        "opencode" => Some(AgentKind::OpenCode),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(super) struct PermissionNotificationEvent {
    pub harness: String,
    pub event: String,
    pub source: Option<String>,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
    pub permission_key: String,
    pub payload: serde_json::Value,
}

fn fallback_permission_key(ev: &HookEvent) -> String {
    let mut hasher = DefaultHasher::new();
    ev.harness.hash(&mut hasher);
    ev.event.hash(&mut hasher);
    ev.source.hash(&mut hasher);
    ev.payload.to_string().hash(&mut hasher);
    format!("legacy-{:016x}", hasher.finish())
}

pub(super) fn build_permission_notification_event(
    ev: &HookEvent,
) -> Option<PermissionNotificationEvent> {
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
/// Routing is session-scoped via `AgentRegistry::route_hook_event`: an
/// event with an unknown session id reaches at most the *sole* machine of
/// its harness and is otherwise dropped — never broadcast (see the routing
/// rationale on `route_hook_event`).
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
        // Synthetic socket-server GC signal: a parked PermissionRequest
        // expired unanswered (hook script timed out to "ask" or died).
        // Short-circuit BEFORE the registry block — this is load-bearing:
        // in `silence_only` mode `on_hook_event` treats *any* event name as
        // activity and would promote the machine to Working regardless of
        // the classifier's `PermissionExpired => None`. Also before the
        // `last_hook_at` diagnostic stamp: this event is raum's own, and
        // recording it would make the Harness Health panel report a live
        // hook pipeline using an event no harness ever emits. Here we (a)
        // re-arm output-based recovery so the machine can leave `Waiting`
        // once the user answers in the harness's own TUI and output flows,
        // and (b) tell the frontend to drop the stale pending-permission
        // badge entry.
        if ev.event == raum_hooks::PERMISSION_EXPIRED_EVENT {
            if let Ok(mut registry) = state.agents.lock() {
                // Route-aware: covers the session-less legacy case via the
                // sole-machine rule, mirroring `route_hook_event`.
                registry.arm_activity_for_permission_expiry(kind, ev.session_id.as_deref());
            }
            let permission_key = ev.request_id.clone().or_else(|| ev.session_id.clone());
            if let Some(permission_key) = permission_key {
                let payload = serde_json::json!({
                    "session_id": ev.session_id,
                    "permission_key": permission_key,
                });
                if let Err(e) = app.emit("permission-expired", &payload) {
                    warn!(error = %e, "permission-expired emit failed");
                }
            }
            continue;
        }
        // Diagnostic surface: record "we received a hook from X at T"
        // so the Harness Health panel can tell the user whether the
        // pipeline is dead or merely quiet. (After the PermissionExpired
        // short-circuit — only genuine harness traffic counts.)
        if let Ok(mut slot) = state.last_hook_at.lock() {
            *slot = Some(crate::state::LastHook {
                at_unix: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs()),
                harness: ev.harness.clone(),
                event: ev.event.clone(),
            });
        }
        // Try to capture the harness's *own* session id from the
        // payload of *every* hook event, not just UserPromptSubmit.
        // Both Claude Code and Codex emit `session_id` in every hook
        // payload, so any activity (state transitions, permission
        // requests, Stop, etc.) can backfill the id for sessions that
        // submitted their first prompt before this code shipped.
        // `update_session_harness_id` is sticky once set, so this is
        // a cheap idempotent attempt.
        //
        // For UserPromptSubmit only: this also produces a
        // `PromptUpdated` to drive the `pane:prompt-updated` broadcast.
        // What one drained hook event produced while the registry lock was
        // held (a struct rather than a tuple purely for clippy's
        // type-complexity budget).
        struct Drained {
            changes: Vec<AgentStateChanged>,
            prompt_update: Option<PromptUpdated>,
            harness_session_id: Option<(String, String)>,
            /// Whether `route_target` resolved a machine — gates the
            /// permission notification below.
            routable: bool,
        }
        let Drained {
            changes,
            prompt_update,
            harness_session_id,
            routable,
        } = {
            let Ok(mut registry) = state.agents.lock() else {
                warn!("event-socket drain: agent registry lock poisoned; dropping event");
                continue;
            };
            // `None` = unroutable (dropped); `Some` = reached a machine.
            // Every session-keyed side effect below is gated on the SAME
            // decision: an id `route_target` refused (stale, or resolving
            // to a different harness's machine) must not record prompts
            // onto the wrong machine or insert phantom rows into
            // sessions.toml via `update_session_harness_id`.
            let routed = registry.route_hook_event(kind, ev.session_id.as_deref(), &core_event);
            let routable = routed.is_some();
            let changes = routed.unwrap_or_default();
            // The harness pipes its full hook payload to the script
            // (Claude on stdin, Codex on argv). The forwarder
            // JSON-encodes that as a string, so `ev.payload` is a
            // `Value::String("{...}")` rather than a parsed object.
            // `decode_payload` unwraps that wrapper.
            let decoded = decode_payload(&ev.payload);
            let harness_session_id = if routable {
                ev.session_id
                    .as_deref()
                    .zip(extract_harness_session_id(kind, decoded.as_ref()))
                    .map(|(sid, hid)| (sid.to_string(), hid))
            } else {
                None
            };
            // The `session_id` route is strict — without it,
            // broadcast routing can't distinguish multiple Claude
            // panes, so we silently skip the prompt update rather
            // than over-write the wrong tab's subtitle.
            let prompt_update = if routable && ev.event == "UserPromptSubmit" {
                let extracted = extract_user_prompt(kind, decoded.as_ref());
                debug!(
                    harness = %ev.harness,
                    session_id = ?ev.session_id,
                    has_prompt = extracted.is_some(),
                    has_harness_id = harness_session_id.is_some(),
                    payload_kind = if ev.payload.is_string() { "string" } else { "object" },
                    "UserPromptSubmit prompt extraction",
                );
                ev.session_id
                    .as_deref()
                    .zip(extracted)
                    .and_then(|(sid, text)| {
                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_or(0, |d| d.as_millis() as u64);
                        registry.record_user_prompt(sid, text, now_ms)
                    })
            } else {
                None
            };
            Drained {
                changes,
                prompt_update,
                harness_session_id,
                routable,
            }
        };
        // Persist `harness_session_id` BEFORE emitting any prompt
        // update on the bus. The bridge task that re-emits
        // `pane:prompt-updated` runs concurrently, so emitting first
        // races the frontend's fetch against this disk write — the
        // fetch can land before the id is persisted, fall through to
        // the directory-newest fallback, and surface the wrong Task.
        // Strict ordering here makes the fetch deterministic.
        if let Some((session_id, harness_id)) = harness_session_id {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64);
            match state.config_store.lock() {
                Ok(store) => {
                    if let Err(e) =
                        store.update_session_harness_id(&session_id, kind, &harness_id, now_ms)
                    {
                        warn!(
                            error = %e,
                            session_id = %session_id,
                            "persist harness_session_id failed",
                        );
                    }
                }
                Err(_) => warn!(
                    session_id = %session_id,
                    "persist harness_session_id: config_store lock poisoned",
                ),
            }
        }
        for change in changes {
            // Broadcast buffer fills silently when the bridge task is
            // behind; the `ensure_bridge_running` task logs the lag.
            let _ = bus.tx.send(change);
        }
        if let Some(update) = prompt_update {
            let _ = bus.prompt_tx.send(update);
        }

        // Surface permission-needed events to the webview. Some harnesses
        // provide a replyable `request_id`; others are observation-only and
        // should still produce a focus-the-pane notification.
        //
        // Gate: routable (a machine will enter `waiting`, whose exit clears
        // the badge) OR replyable (`request_id` present — the request is
        // parked, so the user can answer it from the UI even when no state
        // machine exists, e.g. an adopted orphan/ghost session; and if
        // ignored, the socket sweeper's `PermissionExpired` clears the
        // badge). Only an unroutable AND unreplyable request is suppressed:
        // no pane would ever show it as waiting and nothing could ever
        // clear its badge.
        if routable || ev.request_id.is_some() {
            if let Some(payload) = build_permission_notification_event(&ev) {
                if let Err(e) = app.emit("notification-event", &payload) {
                    warn!(error=%e, "notification-event emit failed");
                }
            }
        } else if ev.event == "PermissionRequest" {
            debug!(
                harness = %ev.harness,
                session_id = ?ev.session_id,
                "permission request for unroutable, unreplyable session; notification suppressed",
            );
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
    let mut prompt_rx = bus.prompt_tx.subscribe();
    let app = app.clone();
    let prompt_app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(change) => {
                    // Persist first so `agent_snapshot` / `agent_list`
                    // callers that race with the emit see the new state.
                    persist_last_state(&app, &change).await;
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
    tauri::async_runtime::spawn(async move {
        loop {
            match prompt_rx.recv().await {
                Ok(update) => {
                    persist_last_prompt(&prompt_app, &update).await;
                    if let Err(e) = prompt_app.emit("pane:prompt-updated", &update) {
                        warn!(error=%e, "pane:prompt-updated emit failed");
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!(dropped = n, "prompt event bus lagged");
                }
            }
        }
    });
    let _ = SPAWNED.set(());
}

/// Fast spawn-time preflight for `terminal_spawn`.
///
/// This intentionally avoids version probing, `git worktree list`, setup-plan
/// writes, and selftests. Those are useful health checks, but they should not
/// sit between the user's click and the harness process starting. We still
/// verify the binary exists and do a cheap on-disk scan so sessions with hooks
/// missing can start in silence-fallback mode until the background refresh
/// catches up.
/// `spawn_blocking` wrapper around [`prepare_harness_launch_fast`] for the
/// async spawn/reattach commands. The preflight resolves `$PATH` and reads
/// each harness's managed config, so it must not run on a tokio worker —
/// every pane spawn goes through here.
pub async fn prepare_harness_launch_fast_async<R: Runtime>(
    app: &AppHandle<R>,
    harness: AgentKind,
    project_slug: Option<String>,
    project_dir: PathBuf,
) -> Result<super::spawn::AgentSpawnReport, String> {
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        let state: tauri::State<'_, AppHandleState> = app.state();
        prepare_harness_launch_fast(&app, &state, harness, project_slug.as_deref(), project_dir)
    })
    .await
    .map_err(|e| format!("harness preflight task failed: {e}"))?
}

pub fn prepare_harness_launch_fast<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppHandleState,
    harness: AgentKind,
    project_slug: Option<&str>,
    project_dir: PathBuf,
) -> Result<super::spawn::AgentSpawnReport, String> {
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

    if !which_cached(adapter.binary_path()) {
        info!(
            binary = adapter.binary_path(),
            harness = ?harness,
            "prepare_harness_launch_fast: binary missing on PATH"
        );
        emit_missing_binary_notification(app, adapter.binary_path(), harness);
        return Ok(super::spawn::AgentSpawnReport {
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

    Ok(super::spawn::AgentSpawnReport {
        session_id: String::new(),
        binary_missing: false,
        binary: adapter.binary_path().to_string(),
        version_ok: None,
        version_raw: None,
        hook_fallback,
        supports_native_events: adapter.supports_native_events(),
    })
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
    let (persisted_state, persisted_prompt) =
        state
            .config_store
            .lock()
            .ok()
            .map_or((None, None), |store| {
                (
                    store.last_session_state(session_id),
                    store.last_session_prompt(session_id),
                )
            });

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
        if let Some((text, submitted_at_ms)) = persisted_prompt.clone() {
            machine.seed_last_prompt(PromptEntry {
                text,
                submitted_at_ms,
            });
        }
        if silence_only {
            machine.set_silence_only(true);
        }
        let newly_inserted = registry.register_machine_if_absent(machine);
        if !newly_inserted {
            registry.set_silence_only(session_id, silence_only);
            // Reattach to a pre-populated machine — only seed the prompt
            // if the machine doesn't already carry one, so a live submit
            // that arrived between bootstrap and reattach isn't clobbered.
            if let Some((text, submitted_at_ms)) = persisted_prompt
                && registry.last_prompt(session_id).is_none()
            {
                registry.seed_last_prompt(
                    session_id,
                    PromptEntry {
                        text,
                        submitted_at_ms,
                    },
                );
            }
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
            // This is a replayed persisted seed, not a live transition — the
            // frontend suppresses notification side effects (sound, banner)
            // so a reload/restart doesn't fire stale "finished" chimes.
            seeded: true,
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
