//! Codex rollout discovery and parsing.

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Deserialize;
use serde_json::Value;
use tracing::warn;

use super::transcript_contains_prompt;

/// Codex stores rollouts under `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<uuid>.jsonl`.
/// The first line of each rollout is a `session_meta` event whose
/// payload carries the `cwd` the session was launched in, so we walk the
/// date hierarchy, match by cwd, and pick the newest match.
///
/// "Newest" is by file mtime across the whole tree, not by day directory:
/// `codex resume` appends to the rollout of the day the session was
/// *created*, so a resumed old session outranks a newer-dated sibling. See
/// [`newest_rollout_by`] — candidates are cheaply enumerated first and only
/// opened until the first match.
pub(super) fn discover_codex_transcript(cwd: &Path, home_dir: &Path) -> Option<PathBuf> {
    let cwd_str = cwd.to_str()?;
    newest_rollout_by(home_dir, |path| {
        codex_rollout_matches_cwd(path, cwd_str).then(|| path.to_path_buf())
    })
}

pub(super) fn discover_codex_session_id_by_prompt(
    cwd: &Path,
    home_dir: &Path,
    prompt: &str,
) -> Option<String> {
    let cwd_str = cwd.to_str()?;
    newest_rollout_by(home_dir, |path| {
        if !codex_rollout_matches_cwd(path, cwd_str) {
            return None;
        }
        if !transcript_contains_prompt(&parse_codex_user_prompts(path), prompt) {
            return None;
        }
        codex_session_id_from_rollout(path)
            .or_else(|| codex_session_id_from_filename(path))
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
    })
}

/// Walk `~/.codex/sessions/<Y>/<M>/<D>/`, collect every `rollout-*.jsonl`
/// with its mtime, then apply `pick` to the candidates newest-mtime-first
/// and return the first value it produces.
///
/// The day hierarchy records when a session was *created*, but `codex
/// resume` appends to the original file — so an older day can hold the
/// most recently touched rollout and day order alone cannot decide the
/// winner. Ordering by mtime across the whole tree keeps that rule while
/// still opening/parsing only as many rollouts as it takes to hit the
/// first match (the old walk parsed the first line of *every* rollout the
/// user had ever recorded, oldest first, on every call).
fn newest_rollout_by<T, F>(home_dir: &Path, mut pick: F) -> Option<T>
where
    F: FnMut(&Path) -> Option<T>,
{
    let sessions = home_dir.join(".codex").join("sessions");
    if !sessions.is_dir() {
        return None;
    }

    let mut candidates: Vec<(SystemTime, PathBuf)> = Vec::new();
    for year in subdirs_newest_first(&sessions) {
        for month in subdirs_newest_first(&year) {
            for day in subdirs_newest_first(&month) {
                let Ok(files) = std::fs::read_dir(&day) else {
                    continue;
                };
                for entry in files.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                        continue;
                    }
                    let is_rollout = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|s| s.starts_with("rollout-"));
                    if !is_rollout {
                        continue;
                    }
                    let modified = entry
                        .metadata()
                        .and_then(|m| m.modified())
                        .unwrap_or(SystemTime::UNIX_EPOCH);
                    candidates.push((modified, path));
                }
            }
        }
    }
    // Newest mtime first; the descending directory walk above already put
    // same-mtime siblings in newest-day order, so this stays stable there.
    candidates.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    candidates.into_iter().find_map(|(_, path)| pick(&path))
}

/// Immediate subdirectories of `dir`, sorted by name descending. Codex's
/// `YYYY` / `MM` / `DD` names are zero-padded, so descending name order is
/// descending chronological order.
pub(super) fn subdirs_newest_first(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect();
    out.sort_unstable_by(|a, b| b.file_name().cmp(&a.file_name()));
    out
}

/// Read just the first line of `path` and check whether the
/// `session_meta` event reports the session was launched in `cwd`. Two
/// shapes seen across Codex versions: `{payload: {cwd}}` or `{cwd}`.
pub(super) fn codex_rollout_matches_cwd(path: &Path, cwd: &str) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut reader = std::io::BufReader::new(file);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return false;
    }
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return false;
    };
    value
        .pointer("/payload/cwd")
        .or_else(|| value.pointer("/cwd"))
        .and_then(|v| v.as_str())
        == Some(cwd)
}

pub(super) fn codex_session_id_from_rollout(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value = serde_json::from_str::<Value>(trimmed).ok()?;
    value
        .pointer("/payload/id")
        .or_else(|| value.pointer("/id"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

pub(super) fn codex_session_id_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let id = stem.get(stem.len().checked_sub(36)?..)?.trim();
    if id.len() != 36 {
        return None;
    }
    let is_uuid_like = id.chars().enumerate().all(|(idx, ch)| match idx {
        8 | 13 | 18 | 23 => ch == '-',
        _ => ch.is_ascii_hexdigit(),
    });
    is_uuid_like.then(|| id.to_string())
}

/// Parse user prompts from a Codex rollout. Supports two event shapes:
///
/// Codex rollouts contain two parallel transcripts of "user" turns:
///
///   A. `event_msg` / `user_message` — emitted by the TUI **only when
///      the user actually types and submits a prompt**. This is the
///      clean signal we want.
///
///   B. `response_item` / `message` / `role=user` — the API-side
///      record sent to the model. Includes the typed prompts but
///      *also* synthetic context Codex injects on the user's behalf:
///        * the project's `AGENTS.md` text (always, on session start),
///        * `<turn_aborted>` notices when the user cancels,
///        * other system reminders the model needs.
///      Treating any of these as the "first user prompt" surfaces
///      AGENTS.md (or worse) in the per-pane overlay.
///
/// Strategy: walk both shapes in one pass; if any `event_msg`
/// prompts exist, return only those (newer Codex). Otherwise fall
/// back to the `response_item` shape with a synthetic-context filter
/// so the very oldest rollouts — which logged only the API shape —
/// still produce something useful.
pub(super) fn parse_codex_user_prompts(jsonl_path: &Path) -> Vec<String> {
    let file = match std::fs::File::open(jsonl_path) {
        Ok(f) => f,
        Err(e) => {
            warn!(path = %jsonl_path.display(), error = %e, "codex transcript read failed");
            return Vec::new();
        }
    };
    let mut event_prompts: Vec<String> = Vec::new();
    let mut response_prompts: Vec<String> = Vec::new();
    // Streamed line-by-line: rollouts grow to megabytes and the old
    // `read_to_string` held the whole file plus a full `Value` tree per line.
    for line in std::io::BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<RolloutLine>(trimmed) else {
            continue;
        };
        let Some(payload) = entry.payload else {
            continue;
        };
        let payload_type = payload.r#type.as_deref();

        // Shape A — clean signal, prefer when present.
        if payload_type == Some("user_message") {
            if let Some(text) = payload
                .message
                .as_ref()
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                event_prompts.push(text.to_string());
            }
            continue;
        }

        // Shape B — fallback; filter synthetic context.
        if entry.r#type.as_deref() == Some("response_item")
            && payload_type == Some("message")
            && payload.role.as_deref() == Some("user")
        {
            if let Some(text) = payload
                .content
                .as_ref()
                .and_then(extract_codex_content_blocks)
                .filter(|t| !is_synthetic_codex_user_text(t))
            {
                response_prompts.push(text);
            }
        }
    }
    if event_prompts.is_empty() {
        response_prompts
    } else {
        event_prompts
    }
}

/// The handful of fields [`parse_codex_user_prompts`] actually reads.
///
/// Deserializing into this instead of a full [`Value`] means the (frequently
/// enormous) assistant / tool-call lines are lexed past rather than
/// materialised as a JSON tree. `message` and `content` stay `Value` because
/// their shape varies across Codex versions and a stricter type here would
/// make an unrelated payload fail the whole line.
#[derive(Deserialize)]
struct RolloutLine {
    #[serde(default)]
    r#type: Option<String>,
    #[serde(default)]
    payload: Option<RolloutPayload>,
}

#[derive(Deserialize)]
struct RolloutPayload {
    #[serde(default)]
    r#type: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    message: Option<Value>,
    #[serde(default)]
    content: Option<Value>,
}

/// Recognises Codex's synthetic `role=user` injections so the rollout
/// fallback in `parse_codex_user_prompts` doesn't surface them as
/// typed prompts.
///
/// Markers picked by inspecting real `~/.codex/sessions/.../*.jsonl`
/// files written by Codex 0.125: AGENTS.md is injected verbatim with
/// a `# AGENTS.md instructions for <abs path>` header, and
/// turn-cancellation notices are wrapped in `<turn_aborted>`. New
/// markers can be added here as they appear.
fn is_synthetic_codex_user_text(text: &str) -> bool {
    let head = text.trim_start();
    head.starts_with("# AGENTS.md instructions") || head.starts_with("<turn_aborted>")
}

/// Codex content blocks are typed similarly to Claude's. We accept
/// `input_text` / `text` (user-typed) and skip `image` / `file` /
/// `tool_result` (observations).
fn extract_codex_content_blocks(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => {
            let trimmed = s.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Array(blocks) => {
            let mut combined = String::new();
            for block in blocks {
                let bt = block.get("type").and_then(|v| v.as_str());
                if bt != Some("input_text") && bt != Some("text") {
                    continue;
                }
                let Some(text) = block.get("text").and_then(|v| v.as_str()) else {
                    continue;
                };
                if !combined.is_empty() {
                    combined.push('\n');
                }
                combined.push_str(text);
            }
            let trimmed = combined.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        _ => None,
    }
}
