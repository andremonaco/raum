//! OpenCode transcript + session discovery helpers.

use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use tokio::process::Command;
use tracing::warn;

use super::TRANSCRIPT_HTTP_TIMEOUT;

/// Upper bound on how long we wait for `opencode session list --format json`
/// during recovery. The CLI should answer from local storage quickly; if it
/// stalls, recovery should degrade to "unavailable" instead of hanging the
/// pane bootstrap.
const SESSION_LIST_CLI_TIMEOUT: Duration = Duration::from_millis(1500);

/// Pull user prompts from a running OpenCode session via its local HTTP
/// API. Two GETs:
///
///   1. `GET <base>:<port>/session?directory=<cwd>&limit=1` — returns the
///      most-recently-updated session whose `directory` matches. We take
///      the first id.
///   2. `GET <base>:<port>/session/<id>/message` — returns
///      `MessageV2.WithParts[]` oldest-first. We pull the text out of every
///      `info.role == "user"` entry whose parts contain non-synthetic
///      `text` blocks.
///
/// `base_url` is parameterised so tests can point at a `wiremock::MockServer`
/// instead of `127.0.0.1`. Production callers pass `"http://127.0.0.1"`.
pub(super) async fn read_opencode_user_prompts(
    base_url: &str,
    port: u16,
    cwd: &Path,
) -> Vec<String> {
    let Some(cwd_str) = cwd.to_str() else {
        return Vec::new();
    };
    let client = match reqwest::Client::builder()
        .timeout(TRANSCRIPT_HTTP_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            warn!(error = %e, "opencode reqwest client build failed");
            return Vec::new();
        }
    };

    // 1) Look up the session id for this cwd.
    let list_url = format!("{base_url}:{port}/session");
    let session_id = match client
        .get(&list_url)
        .query(&[("directory", cwd_str), ("limit", "1")])
        .send()
        .await
    {
        Ok(resp) => match resp.json::<Vec<Value>>().await {
            Ok(arr) => arr
                .into_iter()
                .next()
                .and_then(|s| s.get("id").and_then(|v| v.as_str()).map(str::to_string)),
            Err(_) => None,
        },
        Err(e) => {
            // Not running, refused, or timed out — overlay falls back to
            // the "no original task" hint without a noisy error.
            warn!(port, error = %e, "opencode session list request failed");
            return Vec::new();
        }
    };
    let Some(id) = session_id else {
        return Vec::new();
    };

    // 2) Fetch all messages for that session and extract user prompts.
    let msg_url = format!("{base_url}:{port}/session/{id}/message");
    let messages = match client.get(&msg_url).send().await {
        Ok(resp) => resp.json::<Vec<Value>>().await.unwrap_or_default(),
        Err(e) => {
            warn!(port, error = %e, "opencode message list request failed");
            return Vec::new();
        }
    };

    let mut out = Vec::new();
    for msg in messages {
        if msg.pointer("/info/role").and_then(|v| v.as_str()) != Some("user") {
            continue;
        }
        let Some(parts) = msg.get("parts").and_then(|v| v.as_array()) else {
            continue;
        };
        let mut combined = String::new();
        for part in parts {
            if part.get("type").and_then(|v| v.as_str()) != Some("text") {
                continue;
            }
            // Synthetic text parts are inserted by OpenCode itself
            // (system context, tool framing) — skip them so only what
            // the user actually typed survives.
            if part.get("synthetic").and_then(|v| v.as_bool()) == Some(true) {
                continue;
            }
            let Some(text) = part.get("text").and_then(|v| v.as_str()) else {
                continue;
            };
            if !combined.is_empty() {
                combined.push('\n');
            }
            combined.push_str(text);
        }
        let trimmed = combined.trim();
        if !trimmed.is_empty() {
            out.push(trimmed.to_string());
        }
    }
    out
}

/// Best-effort OpenCode session-id discovery from the CLI's local session
/// store. Used by dead-pane recovery when the resumable `sessionID` was not
/// persisted yet but we still know the pane cwd.
///
/// Runs `opencode session list --format json` in `cwd`, then selects the
/// newest session whose `directory` matches exactly. Returns `None` on any
/// failure (binary missing, timeout, invalid JSON, no match).
pub async fn discover_opencode_session_id_via_cli(cwd: &Path) -> Option<String> {
    let resolved = match which::which("opencode") {
        Ok(path) => path,
        Err(_) => return None,
    };
    let output = match tokio::time::timeout(
        SESSION_LIST_CLI_TIMEOUT,
        Command::new(&resolved)
            .args(["session", "list", "--format", "json"])
            .current_dir(cwd)
            .output(),
    )
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            warn!(error = %e, cwd = %cwd.display(), "opencode session list failed");
            return None;
        }
        Err(_) => {
            warn!(cwd = %cwd.display(), "opencode session list timed out");
            return None;
        }
    };
    if !output.status.success() {
        warn!(
            cwd = %cwd.display(),
            status = ?output.status.code(),
            stderr = %String::from_utf8_lossy(&output.stderr),
            "opencode session list exited non-zero",
        );
        return None;
    }
    let stdout = match String::from_utf8(output.stdout) {
        Ok(stdout) => stdout,
        Err(e) => {
            warn!(error = %e, cwd = %cwd.display(), "opencode session list stdout was not utf-8");
            return None;
        }
    };
    session_id_for_directory_from_list_json(&stdout, cwd)
}

pub(super) fn session_id_for_directory_from_list_json(raw: &str, cwd: &Path) -> Option<String> {
    let sessions = serde_json::from_str::<Vec<Value>>(raw).ok()?;
    let cwd_str = cwd.to_str()?;
    let mut best_id: Option<String> = None;
    let mut best_key: (bool, i64) = (false, i64::MIN);

    for (idx, session) in sessions.into_iter().enumerate() {
        if !session_directory_matches(&session, cwd_str) {
            continue;
        }
        let Some(id) = session_id_from_value(&session) else {
            continue;
        };
        let key = match session_updated_key(&session) {
            Some(updated) => (true, updated),
            // The CLI list appears newest-first; preserve that order when
            // timestamps are absent, but let any real timestamp outrank an
            // order-only guess.
            None => (false, -(idx as i64)),
        };
        if key > best_key {
            best_key = key;
            best_id = Some(id);
        }
    }

    best_id
}

fn session_directory_matches(session: &Value, cwd: &str) -> bool {
    session
        .get("directory")
        .and_then(Value::as_str)
        .or_else(|| session.get("cwd").and_then(Value::as_str))
        .or_else(|| {
            session
                .pointer("/project/directory")
                .and_then(Value::as_str)
        })
        .is_some_and(|dir| dir == cwd)
}

fn session_id_from_value(session: &Value) -> Option<String> {
    session
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| session.get("sessionID").and_then(Value::as_str))
        .or_else(|| session.get("session_id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn session_updated_key(session: &Value) -> Option<i64> {
    session
        .pointer("/time/updated")
        .and_then(Value::as_i64)
        .or_else(|| session.pointer("/time/created").and_then(Value::as_i64))
        .or_else(|| session.get("updatedAt").and_then(Value::as_i64))
        .or_else(|| session.get("updated_at").and_then(Value::as_i64))
        .or_else(|| session.get("createdAt").and_then(Value::as_i64))
        .or_else(|| session.get("created_at").and_then(Value::as_i64))
}
