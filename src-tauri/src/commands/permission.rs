//! Permission reply command (Phase 2, per-harness notification plan).
//!
//! Exposes a single Tauri command `reply_permission(request_id,
//! decision)` that the frontend invokes when the user clicks an
//! "Allow / Allow & remember / Deny / Ask" action on a permission
//! notification. The command resolves the parked hook connection for
//! `(session_id, request_id)` out of [`raum_hooks::PendingRequests`]
//! and writes the decision string back on it. The hook script then
//! prints the Claude-Code-compatible JSON to stdout and exits, which
//! makes Claude use the decision instead of showing its own TUI
//! prompt.

use raum_core::harness::Decision;
use raum_hooks::PendingKey;
use serde::Deserialize;
use tauri::Manager;
use tracing::{info, warn};

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

    // Grab the pending-request registry from the event socket handle
    // stashed on managed state.
    let state: tauri::State<'_, AppHandleState> = app.state();
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
                "reply_permission: delivered",
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
