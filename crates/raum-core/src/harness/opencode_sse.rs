//! OpenCode SSE notification channel (Phase 4, per-harness notification
//! plan).
//!
//! Subscribes to `GET /event` on the local OpenCode HTTP server and maps
//! the relevant bus events into [`NotificationEvent`]s:
//!
//! * `permission.asked` → [`NotificationKind::PermissionNeeded`] with
//!   `request_id` set to OpenCode's `properties.id`
//!   (OpenCode's [`PermissionRequest`] schema uses `id`, not
//!   `permissionID` — confirmed against
//!   `packages/opencode/src/permission/index.ts`).
//! * `permission.replied` → [`NotificationKind::TurnEnd`] (clears the
//!   pending request).
//! * `session.idle` (deprecated alias retained for back-compat) and
//!   `session.status` with `status.type == "idle"` → idle signal; we do
//!   not synthesise a `PermissionNeeded` from idle, only a `TurnEnd`
//!   so the state machine leaves `Working` when the turn completes.
//!
//! Reconnects with exponential backoff (500 ms → 30 s) whenever the
//! stream disconnects; resets the backoff after receiving any well-
//! formed event.
//!
//! # Why a hand-rolled SSE parser?
//!
//! The plan deliberately avoids pulling in `eventsource-client` for a
//! 30-line framing format. OpenCode's server emits
//! `data: <json>\n\n` via `hono/streaming`'s `writeSSE` — no `id:` or
//! `event:` preambles, no multiline data field. The parser below
//! handles both the canonical framing and multi-line `data:` (joined
//! with `\n`) to stay robust against future server changes.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc::error::SendTimeoutError;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::agent::{AgentKind, SessionId};
use crate::harness::channel::{ChannelError, ChannelHealth, NotificationChannel, NotificationSink};
use crate::harness::event::{
    NotificationEvent, NotificationKind, PermissionRequestId, Reliability, SourceId,
};

/// Stable channel identifier. Rendered in logs + Harness Health UI.
pub const CHANNEL_ID: &str = "opencode-sse";

/// Initial reconnect delay. Doubles on each failure up to
/// [`MAX_RECONNECT_DELAY`], resets to this value on a well-formed event.
const INITIAL_RECONNECT_DELAY: Duration = Duration::from_millis(500);

/// Upper bound on the reconnect delay. Keeps raum from polling the
/// OpenCode socket more than once every 30 s while the server is down.
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);

/// Shared map from OpenCode permission request id → session id, populated
/// by the channel as `permission.asked` events arrive and consumed by the
/// HTTP replier so `POST /permission/:id/reply` can resolve which session
/// the reply belongs to.
///
/// OpenCode's `POST /permission/:requestID/reply` endpoint does not need
/// the session id in the URL — it is kept here anyway because the
/// [`NotificationEvent`] wire type already carries a `SessionId`, and
/// consumers (the Tauri state machine, the dock UI) key their rendering
/// off it. Keeping a map lets the replier log/validate the lookup
/// without an extra round trip.
pub type PendingRequestMap = Arc<Mutex<HashMap<PermissionRequestId, SessionId>>>;

/// Create an empty pending-request map. Both the channel and the HTTP
/// replier hold a clone and share the state.
#[must_use]
pub fn new_pending_map() -> PendingRequestMap {
    Arc::new(Mutex::new(HashMap::new()))
}

/// SSE channel tuned to the OpenCode server. Owns a `reqwest::Client`
/// and a shared [`PendingRequestMap`].
#[allow(missing_debug_implementations)]
pub struct OpenCodeSseChannel {
    base_url: String,
    client: reqwest::Client,
    pending: PendingRequestMap,
    /// Fallback session id used when OpenCode emits an event we cannot
    /// scope to a real session (e.g. `server.connected`). The runtime
    /// wires this from the [`SessionSpec`] so the UI's notification
    /// cards map onto the right tile.
    fallback_session: SessionId,
    health: Arc<Mutex<ChannelHealth>>,
}

impl OpenCodeSseChannel {
    #[must_use]
    pub fn new(
        base_url: impl Into<String>,
        pending: PendingRequestMap,
        fallback_session: SessionId,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            client: reqwest::Client::builder()
                // SSE streams are long-lived; never impose a total timeout.
                // We rely on `CancellationToken` + read-level timeouts
                // instead.
                .pool_idle_timeout(Duration::from_secs(90))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            pending,
            fallback_session,
            health: Arc::new(Mutex::new(ChannelHealth::NotStarted)),
        }
    }

    #[must_use]
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Publicly visible setter used by tests that want to inject a
    /// custom client (wiremock does not yet speak SSE via reqwest in
    /// a way our code pokes, so the real `reqwest::Client` is used
    /// against the wiremock server directly).
    #[must_use]
    pub fn with_client(mut self, client: reqwest::Client) -> Self {
        self.client = client;
        self
    }
}

#[async_trait]
impl NotificationChannel for OpenCodeSseChannel {
    fn id(&self) -> &'static str {
        CHANNEL_ID
    }

    fn reliability(&self) -> Reliability {
        // OpenCode emits structured bus events; the mapping is direct
        // (1 `permission.asked` → 1 `PermissionNeeded`) so we can
        // honestly claim `Deterministic` reliability.
        Reliability::Deterministic
    }

    async fn run(
        self: Box<Self>,
        sink: NotificationSink,
        cancel: CancellationToken,
    ) -> Result<(), ChannelError> {
        let me = *self;
        let base = me.base_url.clone();
        let client = me.client.clone();
        let pending = me.pending.clone();
        let fallback = me.fallback_session.clone();
        let health = me.health.clone();

        let mut delay = INITIAL_RECONNECT_DELAY;
        loop {
            if cancel.is_cancelled() {
                return Ok(());
            }
            let url = format!("{}/event", base.trim_end_matches('/'));
            debug!(target: "opencode_sse", url=%url, "connecting");
            let resp = client.get(&url).send().await;
            let stream = match resp {
                Ok(r) if r.status().is_success() => {
                    info!(target: "opencode_sse", url=%url, "connected");
                    *health.lock() = ChannelHealth::Live;
                    r.bytes_stream()
                }
                Ok(r) => {
                    warn!(target: "opencode_sse", status=%r.status(), "non-2xx; backing off");
                    *health.lock() = ChannelHealth::Degraded;
                    backoff(&mut delay, &cancel).await;
                    continue;
                }
                Err(e) => {
                    warn!(target: "opencode_sse", error=%e, "connect failed; backing off");
                    *health.lock() = ChannelHealth::Degraded;
                    backoff(&mut delay, &cancel).await;
                    continue;
                }
            };

            // Drive the SSE parser. The helper returns `Ok(false)` when
            // the server closes the stream cleanly and `Err(...)` on an
            // I/O error; either way we fall back through the outer
            // reconnect loop.
            let outcome = drive_stream(stream, &sink, &pending, &fallback, &cancel, || {
                delay = INITIAL_RECONNECT_DELAY;
            })
            .await;
            if cancel.is_cancelled() {
                return Ok(());
            }
            match outcome {
                Ok(()) => {
                    debug!(target: "opencode_sse", "stream ended; reconnecting");
                    *health.lock() = ChannelHealth::Degraded;
                }
                Err(e) => {
                    warn!(target: "opencode_sse", error=%e, "stream errored");
                    *health.lock() = ChannelHealth::Degraded;
                }
            }
            backoff(&mut delay, &cancel).await;
        }
    }

    async fn health(&self) -> ChannelHealth {
        self.health.lock().clone()
    }
}

async fn backoff(delay: &mut Duration, cancel: &CancellationToken) {
    let wait = *delay;
    *delay = (wait.saturating_mul(2)).min(MAX_RECONNECT_DELAY);
    tokio::select! {
        () = cancel.cancelled() => {},
        () = tokio::time::sleep(wait) => {},
    }
}

/// Drive one SSE stream until EOF / error / cancel. Each well-formed
/// event invokes `on_event` (used here purely to reset the outer
/// reconnect backoff) and — for events we care about — pushes a
/// [`NotificationEvent`] into `sink`.
async fn drive_stream<S, F>(
    mut stream: S,
    sink: &NotificationSink,
    pending: &PendingRequestMap,
    fallback: &SessionId,
    cancel: &CancellationToken,
    mut on_event: F,
) -> Result<(), ChannelError>
where
    S: futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
    F: FnMut(),
{
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    loop {
        tokio::select! {
            () = cancel.cancelled() => return Ok(()),
            chunk = stream.next() => {
                let Some(chunk) = chunk else { return Ok(()) };
                let bytes = chunk.map_err(|e| ChannelError::Transport(format!("chunk: {e}")))?;
                buf.extend_from_slice(&bytes);

                // An SSE frame is terminated by a blank line — `\n\n` or
                // `\r\n\r\n` (hono/streaming writes `\n\n`).
                while let Some(end) = find_frame_end(&buf) {
                    let frame = buf.drain(..end.end).collect::<Vec<u8>>();
                    let frame = &frame[..end.frame_len];
                    let Ok(text) = std::str::from_utf8(frame) else { continue };
                    if let Some(data) = parse_data(text) {
                        on_event();
                        if let Some(ev) = translate(&data, pending, fallback) {
                            // `send_timeout` instead of `send` because the
                            // plan's sink is bounded; we'd rather drop an
                            // event than wedge the SSE task on a
                            // back-pressured consumer forever.
                            match sink
                                .send_timeout(ev, Duration::from_millis(250))
                                .await
                            {
                                Ok(()) => {}
                                Err(SendTimeoutError::Closed(_)) => return Ok(()),
                                Err(SendTimeoutError::Timeout(_)) => {
                                    warn!(target: "opencode_sse", "sink full; dropping event");
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[derive(Copy, Clone, Debug)]
struct FrameEnd {
    /// Length of the frame content (not including the terminator).
    frame_len: usize,
    /// Position past the terminator — how far to drain from the buffer.
    end: usize,
}

fn find_frame_end(buf: &[u8]) -> Option<FrameEnd> {
    // Look for `\n\n` or `\r\n\r\n`. Earliest match wins.
    let nn = find_seq(buf, b"\n\n");
    let crn = find_seq(buf, b"\r\n\r\n");
    match (nn, crn) {
        (Some(a), Some(b)) if a <= b => Some(FrameEnd {
            frame_len: a,
            end: a + 2,
        }),
        (Some(_), Some(b)) => Some(FrameEnd {
            frame_len: b,
            end: b + 4,
        }),
        (Some(a), None) => Some(FrameEnd {
            frame_len: a,
            end: a + 2,
        }),
        (None, Some(b)) => Some(FrameEnd {
            frame_len: b,
            end: b + 4,
        }),
        (None, None) => None,
    }
}

fn find_seq(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Extract the `data` payload from one SSE frame. Multi-line data is
/// joined with `\n`, per the SSE spec.
fn parse_data(text: &str) -> Option<String> {
    let mut data = String::new();
    let mut have = false;
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(rest) = line.strip_prefix("data:") {
            if have {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
            have = true;
        }
    }
    if have { Some(data) } else { None }
}

/// Strongly-typed subset of the OpenCode bus-event envelope. OpenCode
/// emits `{ "type": "<name>", "properties": {...} }` on every frame — see
/// `packages/opencode/src/bus/bus-event.ts`.
#[derive(Debug, Deserialize)]
struct Envelope<'a> {
    #[serde(borrow)]
    r#type: &'a str,
    #[serde(default)]
    properties: Value,
}

/// Map one OpenCode SSE event JSON string into a [`NotificationEvent`].
/// Returns `None` for events we do not surface (heartbeats,
/// `server.connected`, `message.*`, etc.).
fn translate(
    data: &str,
    pending: &PendingRequestMap,
    fallback: &SessionId,
) -> Option<NotificationEvent> {
    let env: Envelope<'_> = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(e) => {
            debug!(target: "opencode_sse", error=%e, "drop: invalid JSON envelope");
            return None;
        }
    };
    let source = SourceId::new(CHANNEL_ID);
    match env.r#type {
        "permission.asked" => {
            // Schema (confirmed against sst/opencode @ dev):
            //   { id: string, sessionID: string, permission: string,
            //     patterns: [string], metadata: {...}, always: [string],
            //     tool?: { messageID, callID } }
            let id = env
                .properties
                .get("id")
                .and_then(Value::as_str)?
                .to_string();
            let session = env
                .properties
                .get("sessionID")
                .and_then(Value::as_str)
                .map_or_else(|| fallback.clone(), SessionId::new);
            let req_id = PermissionRequestId::new(id);
            pending.lock().insert(req_id.clone(), session.clone());
            Some(NotificationEvent {
                session_id: session,
                harness: AgentKind::OpenCode,
                kind: NotificationKind::PermissionNeeded,
                source,
                reliability: Reliability::Deterministic,
                request_id: Some(req_id),
                payload: env.properties,
            })
        }
        "permission.replied" => {
            // Schema: { sessionID, requestID, reply }
            let req_raw = env
                .properties
                .get("requestID")
                .and_then(Value::as_str)
                .map(str::to_string);
            let session = env
                .properties
                .get("sessionID")
                .and_then(Value::as_str)
                .map_or_else(|| fallback.clone(), SessionId::new);
            if let Some(ref r) = req_raw {
                pending.lock().remove(&PermissionRequestId::new(r.clone()));
            }
            Some(NotificationEvent {
                session_id: session,
                harness: AgentKind::OpenCode,
                kind: NotificationKind::TurnEnd,
                source,
                reliability: Reliability::Deterministic,
                request_id: req_raw.map(PermissionRequestId::new),
                payload: env.properties,
            })
        }
        "session.idle" => {
            // Deprecated-but-still-emitted per
            // `packages/opencode/src/session/status.ts`: fired whenever
            // a session transitions into the `idle` state. We surface
            // it as `TurnEnd` so the agent-state machine leaves
            // `Working`.
            let session = env
                .properties
                .get("sessionID")
                .and_then(Value::as_str)
                .map_or_else(|| fallback.clone(), SessionId::new);
            Some(NotificationEvent {
                session_id: session,
                harness: AgentKind::OpenCode,
                kind: NotificationKind::TurnEnd,
                source,
                reliability: Reliability::Deterministic,
                request_id: None,
                payload: env.properties,
            })
        }
        "session.status" => {
            // Modern equivalent of `session.idle`. Only surface the
            // `idle` transition — `busy` / `retry` are not "turn-end"
            // events.
            let idle = env
                .properties
                .get("status")
                .and_then(|s| s.get("type"))
                .and_then(Value::as_str)
                == Some("idle");
            if !idle {
                return None;
            }
            let session = env
                .properties
                .get("sessionID")
                .and_then(Value::as_str)
                .map_or_else(|| fallback.clone(), SessionId::new);
            Some(NotificationEvent {
                session_id: session,
                harness: AgentKind::OpenCode,
                kind: NotificationKind::TurnEnd,
                source,
                reliability: Reliability::Deterministic,
                request_id: None,
                payload: env.properties,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    #[test]
    fn parse_data_single_line() {
        assert_eq!(parse_data("data: hello").as_deref(), Some("hello"));
        assert_eq!(parse_data("data:hello").as_deref(), Some("hello"));
    }

    #[test]
    fn parse_data_multi_line_joined_with_newline() {
        let text = "data: one\ndata: two";
        assert_eq!(parse_data(text).as_deref(), Some("one\ntwo"));
    }

    #[test]
    fn parse_data_ignores_other_fields() {
        let text = "event: foo\nid: 123\ndata: payload";
        assert_eq!(parse_data(text).as_deref(), Some("payload"));
    }

    #[test]
    fn parse_data_none_when_no_data_field() {
        let text = "event: foo\nid: 123";
        assert_eq!(parse_data(text), None);
    }

    #[test]
    fn find_frame_end_nn() {
        let buf = b"data: a\n\n";
        let end = find_frame_end(buf).unwrap();
        assert_eq!(end.frame_len, 7);
        assert_eq!(end.end, 9);
    }

    #[test]
    fn find_frame_end_crlf() {
        let buf = b"data: a\r\n\r\nnext";
        let end = find_frame_end(buf).unwrap();
        assert_eq!(end.frame_len, 7);
        assert_eq!(end.end, 11);
    }

    #[test]
    fn translate_permission_asked_populates_pending_map() {
        let pending = new_pending_map();
        let fallback = SessionId::new("raum-default");
        let data = r#"{"type":"permission.asked","properties":{"id":"perm-1","sessionID":"sess-1","permission":"bash","patterns":["ls *"],"metadata":{},"always":[]}}"#;
        let ev = translate(data, &pending, &fallback).expect("event");
        assert_eq!(ev.kind, NotificationKind::PermissionNeeded);
        assert_eq!(ev.session_id, SessionId::new("sess-1"));
        assert_eq!(
            ev.request_id.as_ref().unwrap(),
            &PermissionRequestId::new("perm-1")
        );
        let map = pending.lock();
        assert_eq!(
            map.get(&PermissionRequestId::new("perm-1")).cloned(),
            Some(SessionId::new("sess-1"))
        );
    }

    #[test]
    fn translate_permission_replied_clears_pending() {
        let pending = new_pending_map();
        pending
            .lock()
            .insert(PermissionRequestId::new("perm-1"), SessionId::new("sess-1"));
        let fallback = SessionId::new("raum-default");
        let data = r#"{"type":"permission.replied","properties":{"sessionID":"sess-1","requestID":"perm-1","reply":"once"}}"#;
        let ev = translate(data, &pending, &fallback).expect("event");
        assert_eq!(ev.kind, NotificationKind::TurnEnd);
        assert!(pending.lock().is_empty());
    }

    #[test]
    fn translate_session_status_idle_is_turn_end() {
        let pending = new_pending_map();
        let fallback = SessionId::new("raum-default");
        let data = r#"{"type":"session.status","properties":{"sessionID":"sess-1","status":{"type":"idle"}}}"#;
        let ev = translate(data, &pending, &fallback).expect("event");
        assert_eq!(ev.kind, NotificationKind::TurnEnd);
    }

    #[test]
    fn translate_session_status_busy_dropped() {
        let pending = new_pending_map();
        let fallback = SessionId::new("raum-default");
        let data = r#"{"type":"session.status","properties":{"sessionID":"sess-1","status":{"type":"busy"}}}"#;
        assert!(translate(data, &pending, &fallback).is_none());
    }

    #[test]
    fn translate_session_idle_deprecated_alias() {
        let pending = new_pending_map();
        let fallback = SessionId::new("raum-default");
        let data = r#"{"type":"session.idle","properties":{"sessionID":"sess-1"}}"#;
        let ev = translate(data, &pending, &fallback).expect("event");
        assert_eq!(ev.kind, NotificationKind::TurnEnd);
    }

    #[test]
    fn translate_unknown_event_dropped() {
        let pending = new_pending_map();
        let fallback = SessionId::new("raum-default");
        let data = r#"{"type":"server.heartbeat","properties":{}}"#;
        assert!(translate(data, &pending, &fallback).is_none());
    }

    #[test]
    fn translate_invalid_json_dropped() {
        let pending = new_pending_map();
        let fallback = SessionId::new("raum-default");
        assert!(translate("{garbage", &pending, &fallback).is_none());
    }

    /// End-to-end integration test using wiremock. The server returns a
    /// canned SSE body with three events; we assert the channel emits
    /// two `NotificationEvent`s (`permission.asked` + `permission.replied`;
    /// the heartbeat is dropped).
    #[tokio::test]
    async fn channel_emits_expected_events_against_wiremock() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let body = concat!(
            "data: {\"type\":\"server.connected\",\"properties\":{}}\n\n",
            "data: {\"type\":\"permission.asked\",\"properties\":{\"id\":\"perm-1\",\"sessionID\":\"sess-1\",\"permission\":\"bash\",\"patterns\":[\"ls *\"],\"metadata\":{},\"always\":[]}}\n\n",
            "data: {\"type\":\"permission.replied\",\"properties\":{\"sessionID\":\"sess-1\",\"requestID\":\"perm-1\",\"reply\":\"once\"}}\n\n",
        );
        Mock::given(method("GET"))
            .and(path("/event"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(body),
            )
            .mount(&server)
            .await;

        let pending = new_pending_map();
        let fallback = SessionId::new("raum-default");
        let ch = OpenCodeSseChannel::new(server.uri(), pending.clone(), fallback);
        let (tx, mut rx) = mpsc::channel(16);
        let cancel = CancellationToken::new();

        let task_cancel = cancel.clone();
        let handle = tokio::spawn(async move {
            let _ = Box::new(ch).run(tx, task_cancel).await;
        });

        // First event — permission.asked.
        let ev = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("timeout")
            .expect("event");
        assert_eq!(ev.kind, NotificationKind::PermissionNeeded);
        assert_eq!(
            ev.request_id.as_ref().unwrap(),
            &PermissionRequestId::new("perm-1")
        );

        // Second event — permission.replied.
        let ev = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("timeout")
            .expect("event");
        assert_eq!(ev.kind, NotificationKind::TurnEnd);

        cancel.cancel();
        let _ = handle.await;
    }
}
