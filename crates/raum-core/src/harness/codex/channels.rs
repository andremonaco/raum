//! Notification channels emitted by the Codex adapter.
//!
//! Phase 3 wires:
//!
//! * [`OscScrapeChannel`] — tails an arbitrary byte source for OSC 9
//!   escape sequences and forwards the parsed payload as a
//!   [`NotificationEvent`]. Uses [`Osc9Parser`] for the BEL/ST state
//!   machine.
//! * [`SilenceChannel`] — heuristic placeholder; reports
//!   `Reliability::Heuristic` and parks on `cancel` until the Phase 5
//!   supervisor wires real silence-detection.
//! * [`install_codex_hooks_json`] — writes a managed Codex `hooks.json`
//!   pointing at the dispatcher script. Exposed for integration tests
//!   and the deprecated install path.

use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use crate::agent::{AgentKind, SessionId};
use crate::config_io::managed_json::{self, ManagedCodexHooks};
use crate::harness::channel::{ChannelError, ChannelHealth, NotificationChannel, NotificationSink};
use crate::harness::event::{
    NotificationEvent, NotificationKind, Reliability, SourceId, classify_notification_kind,
};

use super::RAUM_CODEX_HOOK_EVENTS;
use super::planner::codex_hook_entry;

/// Note attached to channel helpers that exist for parser/unit-test coverage
/// but are not spawned by the live Codex adapter path.
const PHASE5_NOTE: &str =
    "awaiting Phase 5 supervisor wiring: src-tauri must fan HookEvent rx into NotificationSink";

/// OSC 9 scraper channel. Tails a byte source (typically the tmux
/// pane stream) for `\x1b]9;<payload>\x07` escape sequences and maps
/// the payload into [`NotificationKind`] values.
///
/// Phase 3 defines the parser + a test-only constructor that accepts an
/// in-memory byte stream. The adapter-facing `new()` has no byte source
/// available yet and reports `ChannelHealth::Unavailable`; Phase 5
/// wires it to `raum-tmux`'s pane-stream coalescer.
pub struct OscScrapeChannel {
    session_id: SessionId,
    // Wrapped in `Arc<tokio::sync::Mutex<...>>` so `OscScrapeChannel` is
    // `Sync` (async_trait captures `&self` in a `Send` future, which
    // requires the type to be `Sync`). `run()` takes the source out of
    // the option before reading, so there is never contention in
    // practice — the mutex is there solely to satisfy the `Sync` bound.
    source: Arc<tokio::sync::Mutex<Option<OscByteSource>>>,
    health: Arc<std::sync::Mutex<ChannelHealth>>,
}

/// Type-erased async byte source for the OSC 9 scraper. Wraps any
/// `AsyncRead + Send + Unpin + 'static`. `run()` pulls bytes off this
/// until EOF or `cancel` fires.
type OscByteSource = Box<dyn tokio::io::AsyncRead + Send + Unpin + 'static>;

impl std::fmt::Debug for OscScrapeChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `source` holds an async trait object (no `Debug`) and `health`
        // sits behind a sync mutex we do not want to block on from a
        // formatter. Intentionally elide both.
        f.debug_struct("OscScrapeChannel")
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

impl OscScrapeChannel {
    /// Construct a channel with no byte source. `run()` will park on
    /// `cancel` immediately and `health()` reports
    /// [`ChannelHealth::Unavailable`] — intended for the adapter's
    /// default `HarnessRuntime::channels` return value until the Phase
    /// 5 tmux wiring lands.
    #[must_use]
    pub fn new(session_id: SessionId) -> Self {
        Self {
            session_id,
            source: Arc::new(tokio::sync::Mutex::new(None)),
            health: Arc::new(std::sync::Mutex::new(ChannelHealth::Unavailable {
                reason: format!("{PHASE5_NOTE} (+tmux byte-source handle)"),
            })),
        }
    }

    /// Construct a channel from an arbitrary async byte source. Used by
    /// unit tests today and by the Phase 5 supervisor once the tmux
    /// byte tap is exposed.
    #[must_use]
    pub fn with_source<R>(session_id: SessionId, source: R) -> Self
    where
        R: tokio::io::AsyncRead + Send + Unpin + 'static,
    {
        Self {
            session_id,
            source: Arc::new(tokio::sync::Mutex::new(Some(Box::new(source)))),
            health: Arc::new(std::sync::Mutex::new(ChannelHealth::NotStarted)),
        }
    }
}

#[async_trait]
impl NotificationChannel for OscScrapeChannel {
    fn id(&self) -> &'static str {
        "osc9"
    }
    fn reliability(&self) -> Reliability {
        Reliability::EventDriven
    }

    async fn run(
        self: Box<Self>,
        sink: NotificationSink,
        cancel: CancellationToken,
    ) -> Result<(), ChannelError> {
        let Self {
            session_id,
            source,
            health,
        } = *self;
        let mut source = {
            let mut guard = source.lock().await;
            match guard.take() {
                Some(s) => s,
                None => {
                    // No byte tap; park on cancel so the supervisor can
                    // still treat this as a legal channel task.
                    drop(guard);
                    cancel.cancelled().await;
                    return Ok(());
                }
            }
        };
        if let Ok(mut g) = health.lock() {
            *g = ChannelHealth::Live;
        }
        let mut buf = [0u8; 4096];
        let mut parser = Osc9Parser::new();
        loop {
            tokio::select! {
                () = cancel.cancelled() => {
                    if let Ok(mut g) = health.lock() {
                        *g = ChannelHealth::NotStarted;
                    }
                    return Ok(());
                }
                read = source.read(&mut buf) => {
                    match read {
                        Ok(0) => {
                            if let Ok(mut g) = health.lock() {
                                *g = ChannelHealth::Failed;
                            }
                            return Ok(());
                        }
                        Ok(n) => {
                            for payload in parser.feed(&buf[..n]) {
                                if let Some(kind) = classify_osc9_payload(&payload) {
                                    let ev = NotificationEvent {
                                        session_id: session_id.clone(),
                                        harness: AgentKind::Codex,
                                        kind,
                                        source: SourceId::from("osc9"),
                                        reliability: Reliability::EventDriven,
                                        request_id: None,
                                        payload: Value::String(payload),
                                    };
                                    if sink.send(ev).await.is_err() {
                                        return Ok(());
                                    }
                                }
                            }
                        }
                        Err(e) => return Err(ChannelError::Io(e)),
                    }
                }
            }
        }
    }

    async fn health(&self) -> ChannelHealth {
        self.health
            .lock()
            .ok()
            .map_or(ChannelHealth::Failed, |g| g.clone())
    }
}

/// Stateful OSC 9 parser. Handles `\x1b]9;<payload>\x07` and its
/// 7-bit-safe `ST` terminator `\x1b\\`. Carries partial payloads
/// across `feed()` calls so byte boundaries inside a payload do not
/// drop events.
#[derive(Debug, Default)]
pub struct Osc9Parser {
    state: OscState,
    current: Vec<u8>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum OscState {
    /// Scanning for `\x1b`.
    #[default]
    Idle,
    /// Saw `\x1b`; expecting `]`.
    Esc,
    /// Saw `\x1b]`; expecting `9`.
    Oscb,
    /// Saw `\x1b]9`; expecting `;`.
    NineOsc,
    /// Inside the payload; terminates on `\x07` or `\x1b\\`.
    Payload,
    /// Inside payload, just saw `\x1b` — waiting for `\\` to
    /// finish the ST terminator.
    PayloadEsc,
}

impl Osc9Parser {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed `bytes` and return every complete OSC 9 payload found in
    /// this call. Partial payloads survive across calls.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in bytes {
            match self.state {
                OscState::Idle => {
                    if b == 0x1b {
                        self.state = OscState::Esc;
                    }
                }
                OscState::Esc => {
                    self.state = if b == b']' {
                        OscState::Oscb
                    } else {
                        OscState::Idle
                    };
                }
                OscState::Oscb => {
                    self.state = if b == b'9' {
                        OscState::NineOsc
                    } else {
                        OscState::Idle
                    };
                }
                OscState::NineOsc => {
                    if b == b';' {
                        self.current.clear();
                        self.state = OscState::Payload;
                    } else {
                        self.state = OscState::Idle;
                    }
                }
                OscState::Payload => match b {
                    0x07 => {
                        let payload = String::from_utf8_lossy(&self.current).into_owned();
                        out.push(payload);
                        self.current.clear();
                        self.state = OscState::Idle;
                    }
                    0x1b => {
                        self.state = OscState::PayloadEsc;
                    }
                    _ => self.current.push(b),
                },
                OscState::PayloadEsc => {
                    if b == b'\\' {
                        let payload = String::from_utf8_lossy(&self.current).into_owned();
                        out.push(payload);
                        self.current.clear();
                        self.state = OscState::Idle;
                    } else {
                        // Not an ST — fold the lone ESC back into the
                        // payload and continue.
                        self.current.push(0x1b);
                        if b == 0x07 {
                            let payload = String::from_utf8_lossy(&self.current).into_owned();
                            out.push(payload);
                            self.current.clear();
                            self.state = OscState::Idle;
                        } else {
                            self.current.push(b);
                            self.state = OscState::Payload;
                        }
                    }
                }
            }
        }
        out
    }
}

#[must_use]
pub fn classify_osc9_payload(payload: &str) -> Option<NotificationKind> {
    // Codex's `tui.notifications` emits payloads like:
    //   approval-requested: shell tool ...
    //   agent-turn-complete
    // We match on prefixes so future subtype suffixes do not break us.
    let lower = payload.to_ascii_lowercase();
    if lower.contains("approval-requested") {
        Some(NotificationKind::PermissionNeeded)
    } else if lower.contains("agent-turn-complete") {
        Some(NotificationKind::TurnEnd)
    } else {
        // Unknown OSC 9 payloads are ignored: this is a heuristic
        // channel and we do not want to emit synthetic TurnStart
        // events from arbitrary terminal-emitted OSCs (other TUIs
        // unrelated to Codex also use OSC 9 for growl-style toasts).
        let _ = classify_notification_kind(payload);
        None
    }
}

/// Silence heuristic channel — last-resort detection. Reports
/// `Heuristic` reliability; no actual implementation until the Phase 5
/// supervisor wires it up. Present here so
/// `HarnessRuntime::channels()` returns a stable set.
#[derive(Debug)]
pub struct SilenceChannel {
    session_id: SessionId,
    health: Arc<Mutex<ChannelHealth>>,
}

impl SilenceChannel {
    #[must_use]
    pub fn new(session_id: SessionId) -> Self {
        Self {
            session_id,
            health: Arc::new(Mutex::new(ChannelHealth::Unavailable {
                reason: PHASE5_NOTE.into(),
            })),
        }
    }
}

#[async_trait]
impl NotificationChannel for SilenceChannel {
    fn id(&self) -> &'static str {
        "silence"
    }
    fn reliability(&self) -> Reliability {
        Reliability::Heuristic
    }
    async fn run(
        self: Box<Self>,
        _sink: NotificationSink,
        cancel: CancellationToken,
    ) -> Result<(), ChannelError> {
        let _ = self.session_id;
        cancel.cancelled().await;
        Ok(())
    }
    async fn health(&self) -> ChannelHealth {
        self.health
            .lock()
            .ok()
            .map_or(ChannelHealth::Failed, |g| g.clone())
    }
}

/// Install a Codex hooks.json at `path` pointing at `hook_script`.
/// Exposed as a pure function so integration tests / deprecated install
/// paths can reach the managed-JSON helper without recreating the plan.
pub fn install_codex_hooks_json(path: &Path, hook_script: &Path) -> std::io::Result<()> {
    managed_json::apply_managed_codex_hooks(&ManagedCodexHooks {
        path,
        events: RAUM_CODEX_HOOK_EVENTS,
        make_entry: &|event| codex_hook_entry(event, hook_script),
    })
    .map_err(|e| match e {
        managed_json::ManagedJsonError::Io(err) => err,
        managed_json::ManagedJsonError::InvalidJson(err) => std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("hooks.json is not valid JSON: {err}"),
        ),
        managed_json::ManagedJsonError::Serialize(err) => std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("serialize hooks.json failed: {err}"),
        ),
    })
}
