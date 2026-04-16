//! Event UDS server (§7.6). Spawns at `~/.config/raum/state/events.sock`.
//! Filled in by Wave 1C.

use std::path::Path;

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::mpsc;
use tracing::{debug, warn};

pub const RAUM_EVENT_SOCK_ENV: &str = "RAUM_EVENT_SOCK";
pub const PER_AGENT_BACKLOG: usize = 8_000;

#[derive(Debug, Clone, Deserialize)]
pub struct HookEvent {
    pub harness: String,
    pub event: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

#[derive(Debug)]
pub struct EventSocketHandle {
    pub rx: mpsc::Receiver<HookEvent>,
    pub path: std::path::PathBuf,
    _task: tokio::task::JoinHandle<()>,
}

pub async fn spawn_event_socket(path: &Path) -> Result<EventSocketHandle, std::io::Error> {
    if path.exists() {
        std::fs::remove_file(path).ok();
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let listener = UnixListener::bind(path)?;
    let (tx, rx) = mpsc::channel::<HookEvent>(PER_AGENT_BACKLOG);
    let path_owned = path.to_path_buf();
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, _addr)) = listener.accept().await else {
                continue;
            };
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                while let Ok(n) = reader.read_line(&mut line).await {
                    if n == 0 {
                        break;
                    }
                    match serde_json::from_str::<HookEvent>(line.trim()) {
                        Ok(ev) => {
                            debug!(?ev, "hook event");
                            if tx.send(ev).await.is_err() {
                                break;
                            }
                        }
                        Err(e) => warn!(error=%e, raw=%line.trim(), "bad hook event"),
                    }
                    line.clear();
                }
            });
        }
    });
    Ok(EventSocketHandle {
        rx,
        path: path_owned,
        _task: task,
    })
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
        let handle = spawn_event_socket(&sock_path).await.unwrap();
        set_env(&handle);
        let got = std::env::var(RAUM_EVENT_SOCK_ENV).unwrap();
        assert_eq!(std::path::PathBuf::from(got), handle.path);
    }

    #[tokio::test]
    async fn delivers_parsed_hook_event_over_uds() {
        let dir = tempdir().unwrap();
        let sock_path = dir.path().join("events.sock");
        let mut handle = spawn_event_socket(&sock_path).await.unwrap();

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
    }

    #[tokio::test]
    async fn malformed_line_is_dropped_connection_stays_open() {
        let dir = tempdir().unwrap();
        let sock_path = dir.path().join("events.sock");
        let mut handle = spawn_event_socket(&sock_path).await.unwrap();

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
}
