//! Permission reply command (Phase 2, per-harness notification plan).
//!
//! Exposes a single Tauri command `reply_permission(request_id,
//! decision)` that can deliver a decision back to a parked harness
//! permission request. The default notification UX is focus-only, so
//! this command is currently retained as a transport surface rather
//! than being called from desktop notifications.

use raum_core::harness::Decision;
use raum_hooks::PendingKey;
use serde::Deserialize;
use tauri::{Emitter, Manager};
use tracing::{info, warn};

use crate::commands::harness_runtime::deliver_decision;
use crate::state::AppHandleState;

/// Request body passed from the webview.
#[derive(Debug, Deserialize)]
pub struct ReplyPermissionArgs {
    pub request_id: String,
    /// Optional session id — Phase 2 hook scripts include it, pre-
    /// Phase-2 scripts do not. The registry falls back to a
    /// session-less lookup when this is `None`.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Kebab-case decision tag — `allow`, `allow-and-remember`,
    /// `deny`, or `ask`. Matches [`Decision::wire_tag`] on the Rust
    /// side.
    pub decision: String,
}

/// Reply to a parked permission request. Idempotent: a second call
/// with the same `request_id` returns `Ok(false)` because the
/// underlying writer is already consumed.
#[tauri::command]
pub async fn reply_permission(
    app: tauri::AppHandle,
    args: ReplyPermissionArgs,
) -> Result<bool, String> {
    // Validate the decision tag up front so we don't wake a parked
    // connection just to reject its decision.
    let Some(decision) = Decision::from_wire_tag(&args.decision) else {
        return Err(format!("unknown decision tag: {}", args.decision));
    };

    let state: tauri::State<'_, AppHandleState> = app.state();

    // Demote the state machine Waiting → Working so the NEXT
    // `PermissionRequest` produces a visible state transition. Without
    // this, the machine gets stuck at Waiting and every follow-up
    // request is a silent Waiting → Waiting no-op. We do this BEFORE
    // dispatching the reply so the transition is already visible by
    // the time the harness starts emitting new PTY output.
    if let Some(session_id) = &args.session_id {
        let change = {
            let Ok(mut agents) = state.agents.lock() else {
                warn!("reply_permission: agent registry lock poisoned");
                return Err("agent registry lock poisoned".into());
            };
            agents.on_permission_reply(session_id)
        };
        if let Some(change) = change
            && let Err(e) = app.emit("agent-state-changed", &change)
        {
            warn!(error = %e, "agent-state-changed emit on permission reply failed");
        }
    }

    // Phase 6: prefer the harness-runtime replier when we have a
    // session id. The replier dispatches on the adapter's configured
    // transport (HTTP POST for OpenCode, synchronous hook for Claude
    // Code, `None` for Codex). When no replier is registered for this
    // session — either because the harness is observation-only or the
    // session predates the per-session registry — fall through to the
    // raum-hooks `PendingRequests` path so the pre-Phase-6 behaviour
    // is preserved.
    if let Some(session_id) = &args.session_id {
        match deliver_decision(
            &state.harness_runtimes,
            session_id,
            &args.request_id,
            decision,
        )
        .await
        {
            Ok(true) => {
                info!(
                    request_id = %args.request_id,
                    session_id = %session_id,
                    decision = %decision.wire_tag(),
                    "reply_permission: delivered via harness runtime replier",
                );
                return Ok(true);
            }
            Ok(false) => {
                // No replier registered for this session; fall through
                // to the raum-hooks socket path. This handles Claude
                // Code (hook-response replier not yet wired through the
                // harness runtime) and Codex (observation-only — the
                // socket path also returns UnknownRequest, which maps
                // to `Ok(false)` below).
            }
            Err(e) => {
                warn!(error=%e, "reply_permission: harness-runtime replier failed");
                return Err(e.to_string());
            }
        }
    }

    // Legacy path: walk the raum-hooks pending-request registry. This
    // is the transport Claude Code's hook script uses (blocking on
    // stdin for the decision line).
    let pending = {
        let Ok(slot) = state.event_socket.lock() else {
            return Err("event_socket slot poisoned".into());
        };
        slot.as_ref().map(|h| h.pending.clone())
    };
    let Some(pending) = pending else {
        return Err("event socket not bound; raum is running in silence-heuristic fallback".into());
    };

    let key = PendingKey::new(args.session_id.clone(), args.request_id.clone());
    match pending.reply(&key, decision.wire_tag()).await {
        Ok(()) => {
            info!(
                request_id = %args.request_id,
                session_id = ?args.session_id,
                decision = %decision.wire_tag(),
                "reply_permission: delivered via raum-hooks socket",
            );
            Ok(true)
        }
        Err(raum_hooks::SocketReplyError::UnknownRequest(_, _)) => {
            // Benign — the request was either already answered, or
            // raum was restarted between fire and reply. The webview
            // can dismiss the notification; we return `false` so it
            // knows nothing was delivered.
            Ok(false)
        }
        Err(e) => {
            warn!(error=%e, "reply_permission: transport error");
            Err(e.to_string())
        }
    }
}
