//! OpenCode HTTP-based transcript reader.

use std::path::Path;

use serde_json::Value;
use tracing::warn;

use super::TRANSCRIPT_HTTP_TIMEOUT;

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
