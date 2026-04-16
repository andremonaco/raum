//! Codex adapter (§7.5).
//!
//! Codex has no hook system, so `install_hooks` is a no-op. The adapter
//! advertises structured stdout events via the `CODEX_JSON=1` environment
//! variable on spawn; raum then parses newline-delimited JSON events off the
//! stdout pipe (via tmux `pipe-pane`).

use std::path::Path;

use async_trait::async_trait;
use serde::Deserialize;
use tracing::warn;

use crate::agent::{
    AgentAdapter, AgentError, AgentKind, SessionId, SpawnOptions, VersionReport, semver_lite,
};

/// Environment variable Codex inspects to emit structured stdout events.
pub const CODEX_JSON_ENV: &str = "CODEX_JSON";

#[derive(Debug, Clone, Default)]
pub struct CodexAdapter;

impl CodexAdapter {
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// The env additions Codex needs when launched under raum. Callers (tmux
    /// layer) should splat this onto the child environment before `exec`.
    #[must_use]
    pub fn spawn_env(&self) -> Vec<(String, String)> {
        vec![(CODEX_JSON_ENV.to_string(), "1".to_string())]
    }
}

#[async_trait]
impl AgentAdapter for CodexAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Codex
    }

    fn binary_path(&self) -> &'static str {
        "codex"
    }

    async fn spawn(&self, _opts: SpawnOptions) -> Result<SessionId, AgentError> {
        which::which(self.binary_path()).map_err(|_| AgentError::BinaryMissing {
            binary: self.binary_path().to_string(),
        })?;
        Err(AgentError::Spawn(
            "spawn is owned by the tmux layer; CodexAdapter only validates preconditions".into(),
        ))
    }

    async fn install_hooks(&self, _hooks_dir: &Path) -> Result<(), AgentError> {
        // Codex has no hook config; structured events come from stdout (§7.5).
        Ok(())
    }

    fn supports_native_events(&self) -> bool {
        true
    }

    async fn detect_version(&self) -> Result<VersionReport, AgentError> {
        super::claude_code::run_version(self.binary_path(), &self.minimum_version()).await
    }

    fn minimum_version(&self) -> semver_lite::Version {
        semver_lite::Version {
            major: 0,
            minor: 1,
            patch: 0,
        }
    }
}

/// Event emitted on Codex's JSON stream. The shape mirrors
/// `raum_hooks::HookEvent` so downstream consumers (the state machine in
/// `agent_state`) can treat both sources uniformly.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CodexEvent {
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// Minimal parser that accepts an append-only byte buffer and returns one
/// logical event per complete newline-terminated JSON line. Partial trailing
/// lines are preserved across calls (the caller feeds the leftover back into
/// the next buffer).
///
/// This is intentionally simple: Codex is well-behaved and produces one event
/// per line; the coalescer layer above (§3.3) ensures we never get mid-UTF-8
/// splits here because tmux pipe-pane writes full newlines.
#[derive(Debug, Default)]
pub struct EventStreamParser {
    leftover: Vec<u8>,
}

impl EventStreamParser {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk of bytes; return every event contained in this chunk plus
    /// any previously-buffered partial line.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<CodexEvent> {
        let mut buf = std::mem::take(&mut self.leftover);
        buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        let mut start = 0usize;
        for (i, b) in buf.iter().enumerate() {
            if *b == b'\n' {
                let line = &buf[start..i];
                start = i + 1;
                if line.iter().all(|c| c.is_ascii_whitespace()) {
                    continue;
                }
                match serde_json::from_slice::<CodexEvent>(line) {
                    Ok(ev) => out.push(ev),
                    Err(e) => {
                        warn!(error=%e, raw=%String::from_utf8_lossy(line), "bad codex event");
                    }
                }
            }
        }
        self.leftover = buf[start..].to_vec();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn install_hooks_is_noop() {
        let adapter = CodexAdapter::new();
        let dir = tempfile::tempdir().unwrap();
        adapter.install_hooks(dir.path()).await.unwrap();
        // No files created.
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
    }

    #[test]
    fn supports_native_events_is_true() {
        assert!(CodexAdapter::new().supports_native_events());
    }

    #[test]
    fn spawn_env_sets_codex_json() {
        let env = CodexAdapter::new().spawn_env();
        assert!(env.iter().any(|(k, v)| k == CODEX_JSON_ENV && v == "1"));
    }

    #[test]
    fn parser_reads_single_line() {
        let mut p = EventStreamParser::new();
        let evs = p.feed(b"{\"event\":\"Working\",\"payload\":null}\n");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].event, "Working");
    }

    #[test]
    fn parser_reads_multiple_lines_in_one_feed() {
        let mut p = EventStreamParser::new();
        let evs =
            p.feed(b"{\"event\":\"Working\"}\n{\"event\":\"Notification\",\"payload\":\"x\"}\n");
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].event, "Working");
        assert_eq!(evs[1].event, "Notification");
        assert_eq!(evs[1].payload, serde_json::Value::String("x".to_string()));
    }

    #[test]
    fn parser_buffers_partial_line_across_feeds() {
        let mut p = EventStreamParser::new();
        let a = p.feed(b"{\"event\":\"Work");
        assert!(a.is_empty());
        let b = p.feed(b"ing\"}\n");
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].event, "Working");
    }

    #[test]
    fn parser_skips_blank_lines() {
        let mut p = EventStreamParser::new();
        let evs = p.feed(b"\n   \n{\"event\":\"Stop\"}\n");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].event, "Stop");
    }

    #[test]
    fn parser_drops_malformed_json_and_keeps_going() {
        let mut p = EventStreamParser::new();
        let evs = p.feed(b"not json\n{\"event\":\"Stop\"}\n");
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].event, "Stop");
    }
}
