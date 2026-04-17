//! Notification channel trait (Phase 2, per-harness notification plan).
//!
//! A [`NotificationChannel`] owns one async task that publishes
//! [`crate::harness::event::NotificationEvent`] values into a shared
//! [`NotificationSink`]. Phase 2 introduces only the trait surface and the
//! type aliases; Phase 3/4 land the concrete channels
//! (`UnixSocketChannel`, `OpenCodeSseChannel`, `OscScrapeChannel`,
//! `SilenceChannel`).

use async_trait::async_trait;
use thiserror::Error;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::harness::event::{NotificationEvent, Reliability};

/// Destination every channel publishes into. A bounded mpsc is used so
/// backpressure on the consumer side eventually blocks the channel task
/// instead of losing events silently.
pub type NotificationSink = mpsc::Sender<NotificationEvent>;

/// Errors a channel surfaces. Kept opaque so concrete impls can map
/// transport-specific detail (socket closed, HTTP 4xx, parser panic) to
/// one enum the supervisor understands.
#[derive(Debug, Error)]
pub enum ChannelError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("closed: {0}")]
    Closed(String),
    #[error("transport: {0}")]
    Transport(String),
}

/// Runtime-health summary a channel exposes. The Harness Health panel
/// renders this; the supervisor uses it to decide whether to re-spawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChannelHealth {
    /// Channel is subscribed and delivering events.
    Live,
    /// Channel is reachable but degraded (e.g. OpenCode SSE reconnecting).
    Degraded,
    /// Channel failed to subscribe or lost connection with no retries left.
    Failed,
    /// Channel has not been run yet.
    NotStarted,
}

/// A notification source. Each concrete impl owns exactly one async task
/// that runs until `cancel` fires or the channel completes naturally.
#[async_trait]
pub trait NotificationChannel: Send + 'static {
    /// Stable, ASCII-only identifier for this channel (`"claude-hooks"`,
    /// `"opencode-sse"`, `"osc9"`, `"silence"`). Rendered in logs and
    /// the Harness Health panel.
    fn id(&self) -> &'static str;

    /// How deterministic events emitted by this channel are. Becomes the
    /// `reliability` field on every `NotificationEvent` the channel
    /// publishes.
    fn reliability(&self) -> Reliability;

    /// Run until `cancel` fires or a terminal error occurs. Consumes the
    /// channel so impls can move resources into the task without
    /// juggling lifetimes. Errors propagate to the supervisor which
    /// decides whether to restart.
    async fn run(
        self: Box<Self>,
        sink: NotificationSink,
        cancel: CancellationToken,
    ) -> Result<(), ChannelError>;

    /// Current health snapshot. Polled by the Harness Health panel.
    async fn health(&self) -> ChannelHealth;
}

#[cfg(test)]
mod tests {
    use super::*;

    struct DummyChannel;

    #[async_trait]
    impl NotificationChannel for DummyChannel {
        fn id(&self) -> &'static str {
            "dummy"
        }
        fn reliability(&self) -> Reliability {
            Reliability::Deterministic
        }
        async fn run(
            self: Box<Self>,
            _sink: NotificationSink,
            cancel: CancellationToken,
        ) -> Result<(), ChannelError> {
            cancel.cancelled().await;
            Ok(())
        }
        async fn health(&self) -> ChannelHealth {
            ChannelHealth::Live
        }
    }

    #[tokio::test]
    async fn dummy_channel_respects_cancel() {
        let (tx, _rx) = mpsc::channel(1);
        let cancel = CancellationToken::new();
        let cancel_clone = cancel.clone();
        let handle = tokio::spawn(async move {
            Box::new(DummyChannel).run(tx, cancel_clone).await.unwrap();
        });
        cancel.cancel();
        handle.await.unwrap();
    }

    #[test]
    fn channel_health_equality() {
        assert_eq!(ChannelHealth::Live, ChannelHealth::Live);
        assert_ne!(ChannelHealth::Live, ChannelHealth::Failed);
    }
}
