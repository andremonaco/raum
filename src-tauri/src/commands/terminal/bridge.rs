//! PTY bridge + pane-death monitor + pane-context watcher. The shared
//! "open a tmux client and start streaming" plumbing used by both
//! `terminal_spawn` and `terminal_reattach`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use raum_core::AgentKind;
use raum_core::harness::codex::{Osc9Parser, classify_osc9_payload};
use raum_core::harness::{NotificationKind, Reliability};
use raum_tmux::{PaneSnapshot, TerminalBridge, TmuxManager, attach_via_control, attach_via_pty};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::commands::agent::cleanup_harness_session;
use crate::state::AppHandleState;

use super::entry::{
    PaneContextPayload, TerminalEntry, emit_agent_session_removed,
    emit_terminal_pane_context_changed, emit_terminal_session_removed,
    emit_terminal_session_upserted, shutdown_removed_entry,
};
use super::helpers::{SessionActivityMap, now_unix_secs};
use super::{
    PANE_CONTEXT_DEBOUNCE_MS, PANE_CONTEXT_IDLE_REFRESH_MS, SNAPSHOT_REPLAY_CHUNK_BYTES,
    XTERM_SCROLLBACK,
};

pub(super) fn forward_codex_osc9_event(
    session_id: &str,
    channel_tx: &mpsc::Sender<raum_hooks::HookEvent>,
    kind: NotificationKind,
    payload: String,
) {
    let wire = raum_hooks::HookEvent {
        harness: "codex".into(),
        event: kind.wire_event_name().into(),
        session_id: Some(session_id.to_string()),
        request_id: None,
        source: Some("osc9".into()),
        reliability: Some(Reliability::EventDriven.label().into()),
        payload: serde_json::Value::String(payload),
    };
    if let Err(err) = channel_tx.try_send(wire) {
        tracing::warn!(
            session_id = %session_id,
            error = %err,
            "terminal: dropping Codex OSC 9 event",
        );
    }
}

pub(super) fn should_emit_pane_context_change(
    previous: Option<&PaneContextPayload>,
    next: &PaneContextPayload,
) -> bool {
    previous != Some(next)
}

pub(super) fn spawn_pane_context_monitor<R: Runtime>(
    app: AppHandle<R>,
    tmux: Arc<TmuxManager>,
    session_id: String,
) -> (tokio::sync::mpsc::Sender<()>, JoinHandle<()>) {
    let (dirty_tx, mut dirty_rx) = tokio::sync::mpsc::channel::<()>(1);
    let task = tokio::spawn(async move {
        let mut last_emitted: Option<PaneContextPayload> = None;
        let mut idle_tick = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_millis(PANE_CONTEXT_IDLE_REFRESH_MS),
            Duration::from_millis(PANE_CONTEXT_IDLE_REFRESH_MS),
        );
        idle_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                maybe_dirty = dirty_rx.recv() => {
                    if maybe_dirty.is_none() {
                        break;
                    }

                    let debounce_deadline =
                        tokio::time::Instant::now() + Duration::from_millis(PANE_CONTEXT_DEBOUNCE_MS);
                    let delay = tokio::time::sleep_until(debounce_deadline);
                    tokio::pin!(delay);
                    loop {
                        tokio::select! {
                            maybe_more = dirty_rx.recv() => {
                                if maybe_more.is_none() {
                                    return;
                                }
                                delay.as_mut().reset(
                                    tokio::time::Instant::now()
                                        + Duration::from_millis(PANE_CONTEXT_DEBOUNCE_MS),
                                );
                            }
                            _ = &mut delay => break,
                        }
                    }
                }
                _ = idle_tick.tick() => {}
            }

            let fetch_tmux = tmux.clone();
            let fetch_session_id = session_id.clone();
            let fetched =
                tokio::task::spawn_blocking(move || fetch_tmux.pane_context(&fetch_session_id))
                    .await;
            let Ok(Ok(ctx)) = fetched else {
                continue;
            };
            let next = PaneContextPayload::from(ctx);
            if !should_emit_pane_context_change(last_emitted.as_ref(), &next) {
                continue;
            }
            emit_terminal_pane_context_changed(&app, &session_id, next.clone());
            last_emitted = Some(next);
        }
    });
    (dirty_tx, task)
}

pub(super) fn build_snapshot_replay(snapshot: PaneSnapshot) -> Vec<u8> {
    let mut replay = snapshot.normal;
    if let Some(alternate) = snapshot.alternate {
        // Restore the durable normal history first, then switch xterm into the
        // alternate buffer and paint the visible TUI frame. The live tmux
        // client that attaches immediately afterwards will redraw the current
        // screen again, but writing this first preserves the normal buffer for
        // history browsing while keeping the user-facing pane on the live TUI.
        replay.extend_from_slice(b"\x1b[?1049h\x1b[H\x1b[2J");
        replay.extend(alternate);
    }
    replay
}

pub(super) fn send_snapshot_replay_chunks(
    on_data: &Channel<InvokeResponseBody>,
    session_id: &str,
    replay: Vec<u8>,
) -> bool {
    if replay.is_empty() {
        return true;
    }
    for chunk in replay.chunks(SNAPSHOT_REPLAY_CHUNK_BYTES) {
        if on_data
            .send(InvokeResponseBody::Raw(chunk.to_vec()))
            .is_err()
        {
            tracing::warn!(
                session_id = %session_id,
                "terminal_reattach: snapshot replay dropped (channel closed)"
            );
            return false;
        }
    }
    true
}

/// Open a PTY-attached `tmux attach-session` client and spawn the
/// pane-death monitor. Does NOT touch [`super::registry::TerminalRegistry`] —
/// the caller decides whether the returned handles become a fresh entry
/// (insert) or replace the live fields of an existing one
/// ([`super::registry::TerminalRegistry::replace_bridge`]). Shared between
/// [`super::spawn::terminal_spawn`] and [`super::reattach::terminal_reattach`].
#[allow(clippy::too_many_arguments)]
pub(super) async fn open_bridge_and_monitor<R: Runtime>(
    app: AppHandle<R>,
    tmux: Arc<TmuxManager>,
    session_id: String,
    kind: AgentKind,
    on_data: Channel<InvokeResponseBody>,
    cols: u16,
    rows: u16,
    session_activity: SessionActivityMap,
    channel_event_tx: Option<mpsc::Sender<raum_hooks::HookEvent>>,
    pane_context_dirty_tx: Option<tokio::sync::mpsc::Sender<()>>,
) -> Result<(TerminalBridge, Arc<AtomicBool>), String> {
    let bridge_output_cancelled = Arc::new(AtomicBool::new(false));
    let output_cancel_for_data = bridge_output_cancelled.clone();
    let channel_for_data = on_data.clone();
    let data_app = app.clone();
    let data_session_id_for_lost = session_id.clone();
    let exit_app = app.clone();
    let exit_id = session_id.clone();
    let activity_for_data = session_activity.clone();
    let activity_session_id = session_id.clone();
    let mut osc9_parser = (kind == AgentKind::Codex).then(Osc9Parser::new);
    let pane_context_dirty_for_data = pane_context_dirty_tx;

    // Sync the tmux window to the size the PTY is about to open at. With
    // `window-size manual` per session, tmux only resizes on explicit
    // `resize-window`; on reattach (or the first attach for a brand-new
    // session that we just created with a different `-x -y` than the user's
    // current xterm) the window can be stale. Fire-and-forget — failures
    // here just mean we'll see the hatched padding until the next user
    // resize event corrects it.
    {
        let tmux_for_sync = tmux.clone();
        let id_for_sync = session_id.clone();
        let _ = tokio::task::spawn_blocking(move || {
            tmux_for_sync.resize(&id_for_sync, u32::from(cols), u32::from(rows))
        })
        .await;
    }

    let mgr_for_attach = tmux.clone();
    let id_for_attach = session_id.clone();
    let bridge = tokio::task::spawn_blocking(move || {
        let on_data: raum_tmux::DataSink = Box::new(move |bytes| {
            if output_cancel_for_data.load(Ordering::SeqCst) {
                return false;
            }
            if let (Some(parser), Some(tx)) = (osc9_parser.as_mut(), channel_event_tx.as_ref()) {
                for payload in parser.feed(&bytes) {
                    if let Some(kind) = classify_osc9_payload(&payload) {
                        forward_codex_osc9_event(&activity_session_id, tx, kind, payload);
                    }
                }
            }
            // Tap the output stream so the silence-heuristic tick
            // (commands::agent::spawn_silence_tick) can flip a
            // `Working` machine to `Waiting` after the coalesced
            // stream goes quiet, even when hooks never fire.
            if let Ok(mut map) = activity_for_data.lock() {
                map.insert(activity_session_id.clone(), Instant::now());
            }
            if let Some(tx) = pane_context_dirty_for_data.as_ref() {
                let _ = tx.try_send(());
            }
            // Fail-loud send: if the WebView's `Channel<Raw>` is gone
            // (component unmount, page reload, app shutdown), the
            // previous `.is_ok()` swallowed the byte and ground on
            // silently — making "lost output" reports impossible to
            // diagnose. Now we log + emit `terminal:bridge-lost`
            // (mirroring the on_exit path) and return false so the
            // PTY bridge tears down cleanly.
            if let Err(err) = channel_for_data.send(InvokeResponseBody::Raw(bytes)) {
                tracing::warn!(
                    session_id = %data_session_id_for_lost,
                    error = %err,
                    "terminal bridge: channel send failed, terminating",
                );
                let _ = data_app.emit(
                    "terminal:bridge-lost",
                    serde_json::json!({
                        "sessionId": &data_session_id_for_lost,
                        "exitCode": serde_json::Value::Null,
                    }),
                );
                return false;
            }
            true
        });
        let on_exit: raum_tmux::ExitSink = Box::new(move |exit_code| {
            // Attached client exited unexpectedly — the bridge wasn't
            // silenced via `shutdown_silent`, so this is an outer tmux-client
            // failure, not proof that the inner shell or harness exited.
            // Keep this distinct from `terminal:process-exited`; the
            // frontend can reattach this pane in place when the tmux session
            // is still alive.
            let _ = exit_app.emit(
                "terminal:bridge-lost",
                serde_json::json!({ "sessionId": &exit_id, "exitCode": exit_code }),
            );
        });
        if control_transport_enabled() {
            attach_via_control(&mgr_for_attach, &id_for_attach, rows, on_data, on_exit)
                .map(TerminalBridge::Control)
                .map_err(|e| format!("control attach: {e}"))
        } else {
            attach_via_pty(
                &mgr_for_attach,
                &id_for_attach,
                cols,
                rows,
                on_data,
                on_exit,
            )
            .map(TerminalBridge::Pty)
            .map_err(|e| format!("pty attach: {e}"))
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking join: {e}"))??;

    Ok((bridge, bridge_output_cancelled))
}

/// Whether new bridges use the lossless control-mode transport (the
/// default). `RAUM_TERMINAL_TRANSPORT=pty` reverts to the legacy PTY-wrapped
/// rendered client — kept as an escape hatch while control mode bakes.
///
/// The control transport paints its own initial frame in-band (an
/// escape-preserving capture replayed before live output), so callers that
/// would otherwise pre-send a snapshot replay must skip it when this is on.
pub(super) fn control_transport_enabled() -> bool {
    std::env::var("RAUM_TERMINAL_TRANSPORT").map_or(true, |v| !v.eq_ignore_ascii_case("pty"))
}

/// Pane-death monitor: polls tmux every 300 ms for natural process exit so we
/// can emit `terminal:process-exited` even when the attached client is still
/// happily rendering an empty pane (remain-on-exit). Aborted by `terminal_kill`
/// so an explicit close never fires a spurious overlay.
///
/// One of these runs per live pane, so the probe is
/// [`TmuxManager::check_pane_dead_polled`] — a shared, briefly-cached
/// `list-panes -a` — rather than a per-session `display-message` fork on every
/// tick from every pane.
///
/// ponytail: still one task per pane on its own timer, just sharing a cached
/// listing — so it is ~1–2 tmux forks per 300 ms regardless of pane count, not
/// zero. The real fix is `%pane-died`/`%exit` off the control-mode connection
/// the bridge already holds, which drops both the polling and the forks; that
/// is a transport-layer change and deliberately out of scope here.
pub(super) fn spawn_pane_death_monitor<R: Runtime>(
    app: AppHandle<R>,
    tmux: Arc<TmuxManager>,
    session_id: String,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(300)).await;
            let id = session_id.clone();
            let tmux_for_check = tmux.clone();
            match tokio::task::spawn_blocking(move || tmux_for_check.check_pane_dead_polled(&id))
                .await
            {
                Ok(Ok(Some(exit_code))) => {
                    let _ = app.emit(
                        "terminal:process-exited",
                        serde_json::json!({ "sessionId": &session_id, "exitCode": exit_code }),
                    );
                    let id2 = session_id.clone();
                    let tmux_for_kill = tmux.clone();
                    let _ =
                        tokio::task::spawn_blocking(move || tmux_for_kill.kill_session(&id2)).await;
                    let state: tauri::State<'_, AppHandleState> = app.state();
                    let removed = match state.terminals.lock() {
                        Ok(mut reg) => reg.remove(&session_id),
                        Err(e) => {
                            tracing::warn!(
                                session_id = %session_id,
                                error = %e,
                                "terminal monitor: terminals lock poisoned during cleanup"
                            );
                            None
                        }
                    };
                    if let Some(entry) = removed {
                        shutdown_removed_entry(entry, false);
                    }
                    cleanup_harness_session(&state, &session_id);
                    if let Err(e) = raum_core::snapshot_store::delete_for_session(&session_id) {
                        tracing::warn!(
                            session_id = %session_id,
                            error = %e,
                            "terminal monitor: failed to delete terminal snapshot"
                        );
                    }
                    emit_terminal_session_removed(&app, &session_id);
                    emit_agent_session_removed(&app, &session_id);
                    break;
                }
                Ok(Ok(None)) => { /* pane still alive — keep polling */ }
                _ => break, // session killed externally (terminal_kill) or I/O error
            }
        }
    })
}

/// `terminal_spawn` path: open a bridge + monitor and insert a fresh
/// entry into the registry. See [`open_bridge_and_monitor`] for the
/// shared pty/monitor setup.
#[allow(clippy::too_many_arguments)]
pub(super) async fn attach_pipeline<R: Runtime>(
    app: AppHandle<R>,
    state: &AppHandleState,
    session_id: String,
    kind: AgentKind,
    project_slug: Option<String>,
    worktree_id: Option<String>,
    tmux: Arc<TmuxManager>,
    on_data: Channel<InvokeResponseBody>,
    cols: u16,
    rows: u16,
    start_monitor: bool,
) -> Result<(), String> {
    let app_handle = app.clone();
    let (pane_context_dirty_tx, context_task) = if matches!(kind, AgentKind::Shell) {
        (None, None)
    } else {
        let (dirty_tx, task) =
            spawn_pane_context_monitor(app.clone(), tmux.clone(), session_id.clone());
        (Some(dirty_tx), Some(task))
    };
    let (bridge, bridge_output_cancelled) = open_bridge_and_monitor(
        app,
        tmux.clone(),
        session_id.clone(),
        kind,
        on_data,
        cols,
        rows,
        state.session_activity.clone(),
        state.channel_event_tx.lock().ok().and_then(|g| g.clone()),
        pane_context_dirty_tx,
    )
    .await
    .inspect_err(|_| {
        if let Some(task) = context_task.as_ref() {
            task.abort();
        }
    })?;

    let monitor_task = start_monitor
        .then(|| spawn_pane_death_monitor(app_handle.clone(), tmux, session_id.clone()));
    let entry = TerminalEntry {
        session_id: session_id.clone(),
        project_slug,
        worktree_id,
        kind,
        created_unix: now_unix_secs(),
        bridge,
        bridge_output_cancelled,
        monitor_task,
        context_task,
        last_cols: cols,
        last_rows: rows,
    };
    let item = entry.list_item();

    {
        let mut reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        reg.insert(entry);
    }
    emit_terminal_session_upserted(&app_handle, &item);

    tracing::info!(
        session_id = %session_id,
        cols, rows,
        xterm_scrollback = XTERM_SCROLLBACK,
        "attach_pipeline: pty bridge ready"
    );

    Ok(())
}
