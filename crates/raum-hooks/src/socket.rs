//! Event UDS server. Spawns at `~/.config/raum/state/events.sock`.
//!
//! The server accepts newline-delimited JSON events from harness hook
//! scripts and delivers them into a bounded mpsc. Phase 2 extends the
//! wire type with optional `session_id` and `request_id` fields and
//! adds a pending-request registry so `PermissionRequest` connections
//! can be parked server-side until the user answers in the UI. The
//! registry's `reply` API writes a single decision line back onto the
//! parked connection, which the hook script reads on stdin and
//! translates into the Claude-Code-compatible stdout JSON.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, unix::OwnedWriteHalf};
use tokio::sync::mpsc;
use tracing::{debug, warn};

pub const RAUM_EVENT_SOCK_ENV: &str = "RAUM_EVENT_SOCK";
pub const RAUM_SESSION_ENV: &str = "RAUM_SESSION";
/// Project context injected into each pane's tmux env so the `raum` CLI
/// (e.g. `raum worktree create <branch>`) can resolve which project/worktree it
/// is running inside without a round-trip to the running app.
pub const RAUM_PROJECT_SLUG_ENV: &str = "RAUM_PROJECT_SLUG";
pub const RAUM_PROJECT_ROOT_ENV: &str = "RAUM_PROJECT_ROOT";
pub const RAUM_WORKTREE_ID_ENV: &str = "RAUM_WORKTREE_ID";
pub const PER_AGENT_BACKLOG: usize = 8_000;

/// Synthetic event emitted by the socket server itself when a parked
/// `PermissionRequest` was still unanswered [`PERMISSION_GC_AFTER`] after
/// parking — i.e. the hook script hit its client-side timeout (and answered
/// "ask" to the harness) or was killed. Consumers use it to garbage-collect
/// any per-request UI state (pending-permission badges) and to re-arm the
/// session's activity heuristic; it must never be classified as a state
/// transition of its own.
pub const PERMISSION_EXPIRED_EVENT: &str = "PermissionExpired";

/// How long a parked `PermissionRequest` may sit unanswered before the
/// sweeper drops its writer and emits [`PERMISSION_EXPIRED_EVENT`].
///
/// Deliberately a **deadline**, not a connection-close trigger: read-half
/// EOF is not evidence the client stopped waiting. The socat fallback path
/// (`printf … | socat -T… - UNIX-CONNECT:…`, used when python3 is absent)
/// half-closes the socket's write side the moment its stdin drains — the
/// server sees EOF milliseconds after the request while the client is still
/// blocked reading its decision line. Reaping on EOF would drop the writer
/// out from under that live client and dismiss a prompt the user never
/// answered. The deadline sits above every client-side wait (default 85 s,
/// `DEFAULT_PERMISSION_TIMEOUT_SECS` in raum-core) so by the time it fires
/// the script has provably given up. Tests pass an explicit deadline via
/// [`spawn_event_socket_with_gc`] — a global test-mode shortening would
/// race the park-then-assert tests, whose writers must stay parked across
/// multi-hundred-ms poll windows. Changing either value must preserve that
/// ordering: the script has to give up first, or the advertised answer
/// window is really this deadline.
const PERMISSION_GC_AFTER: std::time::Duration = std::time::Duration::from_secs(90);

/// A single hook event delivered over the UDS.
///
/// Phase 2 added `session_id` (populated from `$RAUM_SESSION` in the
/// hook script, so the state machine can route the event to a specific
/// session rather than broadcast by harness) and `request_id`
/// (populated for `PermissionRequest` events so the Tauri side can
/// correlate the user's click with the parked hook connection).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HookEvent {
    pub harness: String,
    pub event: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub reliability: Option<String>,
    #[serde(default)]
    pub payload: serde_json::Value,
}

#[derive(Debug, Error)]
pub enum ReplyError {
    #[error("unknown (session_id, request_id) pair: ({0:?}, {1})")]
    UnknownRequest(Option<String>, String),
    #[error("transport: {0}")]
    Transport(String),
}

/// True when an I/O error kind means the peer has already torn the
/// connection down. Used to treat a best-effort `shutdown()` after a
/// successful reply-write as delivered rather than failed: a hook-script
/// client that reads its decision line and exits at once (e.g.
/// `nc … | head -n1`) closes the socket before our half-close runs, which
/// macOS surfaces as `ENOTCONN` and Linux as `EPIPE`. Neither is a
/// delivery failure — the decision bytes were already flushed.
fn is_peer_gone(kind: std::io::ErrorKind) -> bool {
    matches!(
        kind,
        std::io::ErrorKind::NotConnected | std::io::ErrorKind::BrokenPipe
    )
}

/// Shared registry of parked `PermissionRequest` connections. The
/// event socket task inserts an entry when a `PermissionRequest` event
/// arrives with a `request_id`; the Tauri side calls
/// [`Self::reply`] to emit a decision line back to the hook script.
///
/// Keys are `(session_id, request_id)` so two sessions sharing the
/// same harness can't collide on a colliding generated id. `session_id`
/// is optional only for pre-Phase-2 scripts that have not yet picked
/// up the `$RAUM_SESSION` export; the matching lookup falls back to
/// any session once.
#[derive(Debug, Default, Clone)]
pub struct PendingRequests {
    inner: Arc<Mutex<HashMap<PendingKey, OwnedWriteHalf>>>,
}

/// Composite key for the pending-request registry.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PendingKey {
    pub session_id: Option<String>,
    pub request_id: String,
}

impl PendingKey {
    #[must_use]
    pub fn new(session_id: Option<String>, request_id: impl Into<String>) -> Self {
        Self {
            session_id,
            request_id: request_id.into(),
        }
    }
}

impl PendingRequests {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Park `writer` against `key`. Overwrites any existing entry with
    /// the same key — the old writer is dropped, which on Unix closes
    /// the connection and lets the hook script error out of its read.
    pub fn park(&self, key: PendingKey, writer: OwnedWriteHalf) {
        if let Ok(mut g) = self.inner.lock() {
            g.insert(key, writer);
        }
    }

    /// Remove the writer for `key` without replying. Used when the
    /// connection goes away for other reasons (shutdown, timeout).
    pub fn drop_key(&self, key: &PendingKey) -> bool {
        self.inner.lock().is_ok_and(|mut g| g.remove(key).is_some())
    }

    /// Remove every parked writer whose key matches `session_id`.
    /// Dropping the writer closes the UDS connection, which unblocks
    /// the hook script's `read` with EOF. Returns the number of
    /// entries evicted. Used when the user aborts an interactive
    /// question — the harness will cancel its own prompt and any
    /// remaining parked writers for the session become stale.
    pub fn drop_session(&self, session_id: &str) -> usize {
        let Ok(mut g) = self.inner.lock() else {
            return 0;
        };
        let before = g.len();
        g.retain(|key, _| key.session_id.as_deref() != Some(session_id));
        before - g.len()
    }

    /// Write `decision` (followed by a newline) to the parked writer
    /// for `key` and drop it. Returns `Err` when no matching key is
    /// registered, or when the write itself failed. A best-effort
    /// `shutdown()` that fails only because the client already read the
    /// decision and closed (see [`is_peer_gone`]) still counts as
    /// delivered.
    pub async fn reply(&self, key: &PendingKey, decision: &str) -> Result<(), ReplyError> {
        let writer = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| ReplyError::Transport("pending map poisoned".into()))?;
            if let Some(w) = guard.remove(key) {
                Some(w)
            } else if key.session_id.is_some() {
                // Phase 2 fallback: some scripts may emit without
                // `session_id`; try the session-less variant with the
                // same request id before giving up.
                let fallback = PendingKey {
                    session_id: None,
                    request_id: key.request_id.clone(),
                };
                guard.remove(&fallback)
            } else {
                None
            }
        };
        let Some(mut writer) = writer else {
            return Err(ReplyError::UnknownRequest(
                key.session_id.clone(),
                key.request_id.clone(),
            ));
        };
        let mut line = decision.to_string();
        if !line.ends_with('\n') {
            line.push('\n');
        }
        // A failed write IS a delivery failure: the decision never reached the
        // hook script, which then falls back to "ask". Surface it.
        writer
            .write_all(line.as_bytes())
            .await
            .map_err(|e| ReplyError::Transport(e.to_string()))?;
        // The decision bytes are now in the kernel socket buffer — the peer
        // reads them even if it closes immediately after. The explicit
        // `shutdown()` is best-effort half-close cleanup, NOT part of delivery:
        // a well-behaved client that reads its one line and exits (the
        // production `nc … | head -n1` path — `head` closes after line 1, `nc`
        // tears down the socket) can disconnect before this runs, so macOS
        // reports `ENOTCONN` (and Linux `EPIPE`). Those "peer already gone"
        // kinds mean the reply landed and the client left, not a failure —
        // swallow them. Dropping `writer` on return closes our half regardless.
        // Any other shutdown error is still surfaced.
        if let Err(e) = writer.shutdown().await {
            if !is_peer_gone(e.kind()) {
                return Err(ReplyError::Transport(e.to_string()));
            }
            debug!(error=%e, "reply: peer closed after reading decision; treating as delivered");
        }
        Ok(())
    }

    /// Number of currently-parked requests. Diagnostics only.
    pub fn len(&self) -> usize {
        self.inner.lock().map_or(0, |g| g.len())
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Socket handle returned from [`spawn_event_socket`]. Includes the
/// event receiver, the socket path, the accept task handle, and the
/// pending-request registry.
#[derive(Debug)]
pub struct EventSocketHandle {
    pub rx: mpsc::Receiver<HookEvent>,
    pub path: std::path::PathBuf,
    pub pending: PendingRequests,
    _task: tokio::task::JoinHandle<()>,
}

/// Bind the UDS and spawn the accept loop. Each accepted connection
/// is parsed line-by-line; a single connection may send multiple
/// events. When an event carries a `request_id` (i.e. a blocking
/// `PermissionRequest`), the writer half of the connection is parked
/// on [`PendingRequests`] for the Tauri side to reply on, guarded by a
/// [`PERMISSION_GC_AFTER`] deadline sweeper.
///
/// Sync on purpose (nothing here awaits — bind is synchronous), but must
/// be called from within a tokio runtime: it spawns the accept task.
pub fn spawn_event_socket(path: &Path) -> Result<EventSocketHandle, std::io::Error> {
    spawn_event_socket_with_gc(path, PERMISSION_GC_AFTER)
}

/// [`spawn_event_socket`] with an explicit sweeper deadline. Tests use
/// short deadlines to exercise the expiry path and long ones to keep
/// writers parked across their assertion windows.
pub fn spawn_event_socket_with_gc(
    path: &Path,
    gc_after: std::time::Duration,
) -> Result<EventSocketHandle, std::io::Error> {
    if path.exists() {
        std::fs::remove_file(path).ok();
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let listener = UnixListener::bind(path)?;
    let (tx, rx) = mpsc::channel::<HookEvent>(PER_AGENT_BACKLOG);
    let path_owned = path.to_path_buf();
    let pending = PendingRequests::new();
    let pending_for_task = pending.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, _addr)) = listener.accept().await else {
                continue;
            };
            let tx = tx.clone();
            let pending = pending_for_task.clone();
            tokio::spawn(async move {
                let (read_half, write_half) = stream.into_split();
                let mut reader = BufReader::new(read_half);
                let mut write_half_slot = Some(write_half);
                let mut line = String::new();
                while let Ok(n) = reader.read_line(&mut line).await {
                    if n == 0 {
                        break;
                    }
                    match serde_json::from_str::<HookEvent>(line.trim()) {
                        Ok(ev) => {
                            debug!(?ev, "hook event");
                            let has_request_id = ev.request_id.is_some();
                            if let Some(req_id) = ev.request_id.as_deref() {
                                if let Some(wh) = write_half_slot.take() {
                                    let key =
                                        PendingKey::new(ev.session_id.clone(), req_id.to_string());
                                    pending.park(key.clone(), wh);
                                    spawn_permission_sweeper(
                                        pending.clone(),
                                        tx.clone(),
                                        key,
                                        ev.harness.clone(),
                                        gc_after,
                                    );
                                }
                            }
                            let send_ok = tx.send(ev).await.is_ok();
                            // Fire-and-forget (no request_id): close the whole
                            // connection from the server side. Shell hooks use
                            // `nc -U` / `socat - UNIX-CONNECT` which, without
                            // `-N` / `-u`, keep the socket open after stdin
                            // EOF; the client only exits once the peer closes
                            // *both* halves. Dropping our write half alone
                            // leaves the connection half-open and the script
                            // hangs. Breaking out drops the read half too,
                            // closing the socket and letting the script exit.
                            if !has_request_id {
                                break;
                            }
                            if !send_ok {
                                break;
                            }
                        }
                        Err(e) => warn!(error=%e, raw=%line.trim(), "bad hook event"),
                    }
                    line.clear();
                }
                // Any writer still held here is freed on drop — which
                // closes the socket and makes the hook script's read
                // return EOF. This path fires when the script wrote
                // its request then immediately EOF'd its stdin (rare
                // but possible for buggy scripts).
                //
                // Deliberately NO parked-writer GC here: read-half EOF is
                // not proof the client stopped waiting (the socat fallback
                // half-closes immediately after sending — see
                // [`PERMISSION_GC_AFTER`]). Unanswered parked writers are
                // reaped by the per-request deadline sweeper instead.
                drop(write_half_slot);
            });
        }
    });
    Ok(EventSocketHandle {
        rx,
        path: path_owned,
        pending,
        _task: task,
    })
}

/// Per-request deadline sweeper: after `gc_after`, if the request is
/// *still parked* (never replied), drop its writer — closing the
/// connection, which is a no-op if the client already left — and emit the
/// synthetic [`PERMISSION_EXPIRED_EVENT`] so the app can clear per-request
/// UI state and re-arm the session's activity heuristic. A replied request
/// was removed from the registry by `reply()`, so `drop_key` returns false
/// and nothing is emitted. Best-effort: a full channel just loses the GC
/// signal, never blocks anything.
fn spawn_permission_sweeper(
    pending: PendingRequests,
    tx: mpsc::Sender<HookEvent>,
    key: PendingKey,
    harness: String,
    gc_after: std::time::Duration,
) {
    tokio::spawn(async move {
        tokio::time::sleep(gc_after).await;
        if !pending.drop_key(&key) {
            return;
        }
        debug!(
            ?key,
            "permission request expired unanswered; writer collected"
        );
        let _ = tx
            .send(HookEvent {
                harness,
                event: PERMISSION_EXPIRED_EVENT.to_string(),
                session_id: key.session_id.clone(),
                request_id: Some(key.request_id.clone()),
                source: Some("raum-socket".to_string()),
                reliability: None,
                payload: serde_json::Value::Null,
            })
            .await;
    });
}

/// Export the event socket path via `RAUM_EVENT_SOCK` so child processes
/// (harness agents launched under raum's control) inherit it and can write
/// hook events back to us.
///
/// Intended to be called once, very early, from the single-threaded startup
/// path before any harness is spawned. The Rust 2024 edition marks
/// [`std::env::set_var`] as `unsafe` purely to advertise the thread-safety
/// caveat; here the caller is expected to honor that contract.
#[allow(unsafe_code)]
pub fn set_env(handle: &EventSocketHandle) {
    // SAFETY: invoked at startup before other threads race on the environment,
    // and the value is borrowed for the duration of the call.
    unsafe {
        std::env::set_var(RAUM_EVENT_SOCK_ENV, handle.path.as_os_str());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use tokio::io::AsyncWriteExt;
    use tokio::net::UnixStream;

    #[tokio::test]
    async fn set_env_exports_socket_path() {
        let dir = tempdir().unwrap();
        let sock_path = dir.path().join("events.sock");
        let handle = spawn_event_socket(&sock_path).unwrap();
        set_env(&handle);
        let got = std::env::var(RAUM_EVENT_SOCK_ENV).unwrap();
        assert_eq!(std::path::PathBuf::from(got), handle.path);
    }

    #[tokio::test]
    async fn delivers_parsed_hook_event_over_uds() {
        let dir = tempdir().unwrap();
        let sock_path = dir.path().join("events.sock");
        let mut handle = spawn_event_socket(&sock_path).unwrap();

        let mut client = UnixStream::connect(&sock_path).await.unwrap();
        client
            .write_all(
                b"{\"harness\":\"claude-code\",\"event\":\"Notification\",\"payload\":\"hi\"}\n",
            )
            .await
            .unwrap();
        client.flush().await.unwrap();
        drop(client);

        let ev = tokio::time::timeout(std::time::Duration::from_secs(2), handle.rx.recv())
            .await
            .expect("timed out waiting for hook event")
            .expect("channel closed before event arrived");
        assert_eq!(ev.harness, "claude-code");
        assert_eq!(ev.event, "Notification");
        assert_eq!(ev.payload, serde_json::Value::String("hi".to_string()));
        assert!(ev.session_id.is_none());
        assert!(ev.request_id.is_none());
    }

    #[tokio::test]
    async fn malformed_line_is_dropped_connection_stays_open() {
        let dir = tempdir().unwrap();
        let sock_path = dir.path().join("events.sock");
        let mut handle = spawn_event_socket(&sock_path).unwrap();

        let mut client = UnixStream::connect(&sock_path).await.unwrap();
        // A malformed JSON line, followed by a valid one on the same connection.
        client.write_all(b"this is not json\n").await.unwrap();
        client
            .write_all(b"{\"harness\":\"codex\",\"event\":\"Stop\",\"payload\":null}\n")
            .await
            .unwrap();
        client.flush().await.unwrap();
        drop(client);

        let ev = tokio::time::timeout(std::time::Duration::from_secs(2), handle.rx.recv())
            .await
            .expect("timed out waiting for hook event")
            .expect("channel closed before event arrived");
        assert_eq!(ev.harness, "codex");
        assert_eq!(ev.event, "Stop");
        assert_eq!(ev.payload, serde_json::Value::Null);
    }

    #[tokio::test]
    async fn permission_request_parks_writer_and_reply_delivers_decision() {
        let dir = tempdir().unwrap();
        let sock_path = dir.path().join("events.sock");
        let mut handle = spawn_event_socket(&sock_path).unwrap();

        let client = UnixStream::connect(&sock_path).await.unwrap();
        let (client_read, mut client_write) = client.into_split();

        // Send a PermissionRequest carrying both session_id and request_id.
        let raw = "{\"harness\":\"claude-code\",\"event\":\"PermissionRequest\",\
                   \"session_id\":\"raum-abc\",\"request_id\":\"req-1\",\"payload\":{}}\n";
        client_write.write_all(raw.as_bytes()).await.unwrap();
        client_write.flush().await.unwrap();

        // The event reaches the consumer.
        let ev = tokio::time::timeout(std::time::Duration::from_secs(2), handle.rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ev.request_id.as_deref(), Some("req-1"));
        assert_eq!(ev.session_id.as_deref(), Some("raum-abc"));

        // At least one request must be parked by now.
        // (spawn_event_socket's per-connection task runs concurrently;
        // give it a single yield to finish parking.)
        for _ in 0..50 {
            if !handle.pending.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(handle.pending.len(), 1);

        // Reply — expect the client to read a single decision line.
        let key = PendingKey::new(Some("raum-abc".into()), "req-1");
        handle.pending.reply(&key, "allow").await.unwrap();

        let mut reader = tokio::io::BufReader::new(client_read);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert_eq!(line.trim(), "allow");

        // Registry emptied after reply.
        assert!(handle.pending.is_empty());
    }

    #[test]
    fn is_peer_gone_classifies_post_read_close_kinds() {
        use std::io::ErrorKind;
        // A client that read its decision then closed (macOS `ENOTCONN`,
        // Linux `EPIPE`) has still received the reply — shutdown swallows
        // these so `reply()` reports success instead of a spurious flake.
        assert!(is_peer_gone(ErrorKind::NotConnected));
        assert!(is_peer_gone(ErrorKind::BrokenPipe));
        // Genuine failures must still surface.
        assert!(!is_peer_gone(ErrorKind::PermissionDenied));
        assert!(!is_peer_gone(ErrorKind::ConnectionRefused));
        assert!(!is_peer_gone(ErrorKind::Other));
    }

    #[tokio::test]
    async fn reply_unknown_request_errors() {
        let dir = tempdir().unwrap();
        let sock_path = dir.path().join("events.sock");
        let handle = spawn_event_socket(&sock_path).unwrap();
        let key = PendingKey::new(Some("raum-abc".into()), "nope");
        let err = handle.pending.reply(&key, "allow").await.unwrap_err();
        assert!(matches!(err, ReplyError::UnknownRequest(_, _)));
    }

    #[tokio::test]
    async fn reply_falls_back_to_session_less_key() {
        // Pre-Phase-2 hook scripts that do not export session_id still
        // park their writer with session_id=None. A caller replying with
        // a session_id should still find them.
        let dir = tempdir().unwrap();
        let sock_path = dir.path().join("events.sock");
        let mut handle = spawn_event_socket(&sock_path).unwrap();

        let client = UnixStream::connect(&sock_path).await.unwrap();
        let (client_read, mut client_write) = client.into_split();
        let raw = b"{\"harness\":\"claude-code\",\"event\":\"PermissionRequest\",\
                    \"request_id\":\"legacy\",\"payload\":{}}\n";
        client_write.write_all(raw).await.unwrap();
        client_write.flush().await.unwrap();

        let _ev = tokio::time::timeout(std::time::Duration::from_secs(2), handle.rx.recv())
            .await
            .unwrap()
            .unwrap();
        for _ in 0..50 {
            if !handle.pending.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        let key = PendingKey::new(Some("raum-new".into()), "legacy");
        handle.pending.reply(&key, "deny").await.unwrap();

        let mut reader = tokio::io::BufReader::new(client_read);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert_eq!(line.trim(), "deny");
    }

    #[tokio::test]
    async fn drop_session_evicts_only_matching_session() {
        let dir = tempdir().unwrap();
        let sock_path = dir.path().join("events.sock");
        let handle = spawn_event_socket(&sock_path).unwrap();

        // Park three writers: two for session "a", one for session "b",
        // plus one session-less entry.
        for (sid, rid) in [
            (Some("a"), "r1"),
            (Some("a"), "r2"),
            (Some("b"), "r3"),
            (None, "legacy"),
        ] {
            let client = UnixStream::connect(&sock_path).await.unwrap();
            let (_r, mut w) = client.into_split();
            let raw = match sid {
                Some(s) => format!(
                    "{{\"harness\":\"claude-code\",\"event\":\"PermissionRequest\",\
                     \"session_id\":\"{s}\",\"request_id\":\"{rid}\",\"payload\":{{}}}}\n"
                ),
                None => format!(
                    "{{\"harness\":\"claude-code\",\"event\":\"PermissionRequest\",\
                     \"request_id\":\"{rid}\",\"payload\":{{}}}}\n"
                ),
            };
            w.write_all(raw.as_bytes()).await.unwrap();
            w.flush().await.unwrap();
            // Leak the write half so the connection stays alive until we evict it.
            std::mem::forget(w);
        }

        for _ in 0..50 {
            if handle.pending.len() == 4 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(handle.pending.len(), 4);

        let evicted = handle.pending.drop_session("a");
        assert_eq!(evicted, 2);
        assert_eq!(handle.pending.len(), 2);

        // Session "b" and the legacy session-less entry survive.
        assert!(
            handle
                .pending
                .drop_key(&PendingKey::new(Some("b".into()), "r3"))
        );
        assert!(handle.pending.drop_key(&PendingKey::new(None, "legacy")));
        assert!(handle.pending.is_empty());
    }

    #[tokio::test]
    async fn expired_permission_request_collects_writer_and_emits_expiry() {
        let dir = tempdir().unwrap();
        let sock_path = dir.path().join("events.sock");
        // Short explicit deadline: this test IS the expiry path.
        let mut handle =
            spawn_event_socket_with_gc(&sock_path, std::time::Duration::from_millis(200)).unwrap();

        let client = UnixStream::connect(&sock_path).await.unwrap();
        let (client_read, mut client_write) = client.into_split();
        let raw = "{\"harness\":\"claude-code\",\"event\":\"PermissionRequest\",\
                   \"session_id\":\"raum-exp\",\"request_id\":\"req-exp\",\"payload\":{}}\n";
        client_write.write_all(raw.as_bytes()).await.unwrap();
        client_write.flush().await.unwrap();

        let ev = tokio::time::timeout(std::time::Duration::from_secs(2), handle.rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ev.event, "PermissionRequest");
        for _ in 0..50 {
            if !handle.pending.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(handle.pending.len(), 1);

        // Client goes away without ever receiving a reply — the hook script
        // hit its timeout and exited. After the sweeper deadline the parked
        // writer must be collected and the synthetic expiry emitted with
        // the same ids. Note the trigger is the DEADLINE, not the
        // disconnect — the disconnect alone must do nothing (see the
        // half-close test below).
        drop(client_read);
        drop(client_write);

        let expiry = tokio::time::timeout(std::time::Duration::from_secs(2), handle.rx.recv())
            .await
            .expect("timed out waiting for expiry event")
            .expect("channel closed before expiry arrived");
        assert_eq!(expiry.event, PERMISSION_EXPIRED_EVENT);
        assert_eq!(expiry.harness, "claude-code");
        assert_eq!(expiry.session_id.as_deref(), Some("raum-exp"));
        assert_eq!(expiry.request_id.as_deref(), Some("req-exp"));
        assert_eq!(expiry.source.as_deref(), Some("raum-socket"));
        assert!(handle.pending.is_empty());
    }

    #[tokio::test]
    async fn replied_permission_request_emits_no_expiry() {
        let dir = tempdir().unwrap();
        let sock_path = dir.path().join("events.sock");
        // Deadline long enough that the reply below always lands first
        // (park + poll can take a few hundred ms on a loaded runner), but
        // short enough that the quiet window can span it and prove the
        // sweeper found nothing.
        let gc_after = std::time::Duration::from_secs(1);
        let mut handle = spawn_event_socket_with_gc(&sock_path, gc_after).unwrap();

        let client = UnixStream::connect(&sock_path).await.unwrap();
        let (client_read, mut client_write) = client.into_split();
        let raw = "{\"harness\":\"claude-code\",\"event\":\"PermissionRequest\",\
                   \"session_id\":\"raum-ok\",\"request_id\":\"req-ok\",\"payload\":{}}\n";
        client_write.write_all(raw.as_bytes()).await.unwrap();
        client_write.flush().await.unwrap();

        let _ev = tokio::time::timeout(std::time::Duration::from_secs(2), handle.rx.recv())
            .await
            .unwrap()
            .unwrap();
        for _ in 0..50 {
            if !handle.pending.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        let key = PendingKey::new(Some("raum-ok".into()), "req-ok");
        handle.pending.reply(&key, "allow").await.unwrap();

        // The client reads its decision and closes normally.
        let mut reader = tokio::io::BufReader::new(client_read);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert_eq!(line.trim(), "allow");
        drop(reader);
        drop(client_write);

        // An answered request must NOT produce an expiry event. The quiet
        // window deliberately spans the sweeper deadline, so this proves
        // the sweeper found nothing — not merely that the expiry hadn't
        // fired yet.
        let quiet = tokio::time::timeout(gc_after * 3, handle.rx.recv()).await;
        assert!(quiet.is_err(), "no event expected after a replied request");
        assert!(handle.pending.is_empty());
    }

    /// Regression test for the socat fallback: `printf … | socat -T - …`
    /// half-closes the socket's write side as soon as its stdin drains, so
    /// the server sees read-EOF milliseconds after the request while the
    /// client is still blocked reading its decision. The parked writer must
    /// survive that EOF — a reply landing before the sweeper deadline still
    /// has to reach the client.
    #[tokio::test]
    async fn half_closed_client_still_receives_reply() {
        let dir = tempdir().unwrap();
        let sock_path = dir.path().join("events.sock");
        // Long deadline: the writer must provably stay parked across the
        // read-EOF and the poll window below without sweeper interference.
        let mut handle =
            spawn_event_socket_with_gc(&sock_path, std::time::Duration::from_secs(60)).unwrap();

        let client = UnixStream::connect(&sock_path).await.unwrap();
        let (client_read, mut client_write) = client.into_split();
        let raw = "{\"harness\":\"claude-code\",\"event\":\"PermissionRequest\",\
                   \"session_id\":\"raum-socat\",\"request_id\":\"req-socat\",\"payload\":{}}\n";
        client_write.write_all(raw.as_bytes()).await.unwrap();
        client_write.flush().await.unwrap();
        // socat's stdin-EOF: write side closes, read side keeps waiting.
        drop(client_write);

        let _ev = tokio::time::timeout(std::time::Duration::from_secs(2), handle.rx.recv())
            .await
            .unwrap()
            .unwrap();
        for _ in 0..50 {
            if !handle.pending.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(
            handle.pending.len(),
            1,
            "writer must stay parked across read-EOF"
        );

        let key = PendingKey::new(Some("raum-socat".into()), "req-socat");
        handle.pending.reply(&key, "allow").await.unwrap();

        let mut reader = tokio::io::BufReader::new(client_read);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert_eq!(line.trim(), "allow");
        assert!(handle.pending.is_empty());
    }

    #[test]
    fn pending_key_equality_and_hash() {
        use std::collections::HashSet;
        let mut set = HashSet::new();
        set.insert(PendingKey::new(Some("s".into()), "r"));
        assert!(set.contains(&PendingKey::new(Some("s".into()), "r")));
        assert!(!set.contains(&PendingKey::new(Some("s".into()), "other")));
    }
}
