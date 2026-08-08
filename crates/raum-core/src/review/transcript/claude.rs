//! Claude Code transcript discovery and parsing.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::Value;
use tracing::warn;

use super::transcript_contains_prompt;

/// Claude Code stores per-project transcripts under
/// `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where the encoded
/// form replaces `/` with `-` (so `/Users/foo/repo` → `-Users-foo-repo`).
/// We pick the most-recently-modified `*.jsonl` in that directory because
/// Claude Code rotates session files and the active one is always the
/// freshest.
pub(super) fn discover_claude_code_transcript(cwd: &Path, home_dir: &Path) -> Option<PathBuf> {
    let encoded = encode_cwd_for_claude(cwd)?;
    let dir = home_dir.join(".claude").join("projects").join(&encoded);
    newest_jsonl_in(&dir)
}

pub(super) fn discover_claude_session_id_by_prompt(
    cwd: &Path,
    home_dir: &Path,
    prompt: &str,
) -> Option<String> {
    let encoded = encode_cwd_for_claude(cwd)?;
    let dir = home_dir.join(".claude").join("projects").join(&encoded);
    let mut best: Option<(String, SystemTime)> = None;
    let entries = std::fs::read_dir(&dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        if !transcript_contains_prompt(&parse_claude_user_prompts(&path), prompt) {
            continue;
        }
        let Some(id) = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
        else {
            continue;
        };
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        match &best {
            Some((_, t)) if *t >= modified => {}
            _ => best = Some((id, modified)),
        }
    }
    best.map(|(id, _)| id)
}

/// Claude Code's actual on-disk encoding rule — verified against
/// `~/.claude/projects/` on real installations:
///
///   * Every `/` is replaced with `-`.
///   * Every `.` is replaced with `-` too. So a worktree at
///     `/Users/x/repo/.raum/feat` lives at `-Users-x-repo--raum-feat`
///     (the dot in `.raum` becomes the second dash of the `--`).
///
/// Without the `.` rule, lookups for any worktree containing a hidden
/// directory like `.raum`, `.git`, or a dotfile project name silently
/// miss — that was the symptom that made the snap overlay show
/// "no original task" on otherwise-tracked Claude Code sessions.
pub(super) fn encode_cwd_for_claude(cwd: &Path) -> Option<String> {
    let s = cwd.to_str()?;
    if s.is_empty() {
        return None;
    }
    let encoded: String = s
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect();
    Some(encoded)
}

fn newest_jsonl_in(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(PathBuf, SystemTime)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        match &best {
            Some((_, t)) if *t >= modified => {}
            _ => best = Some((path, modified)),
        }
    }
    best.map(|(p, _)| p)
}

/// Parse a Claude Code session jsonl and pull out user prompts in order.
///
/// Each line is a JSON object. Real user prompts have `type == "user"` and
/// `message.content` is either:
///   * a plain string — `{"content": "the prompt"}`
///   * an array of content blocks like `[{"type": "text", "text": "..."}]`
///
/// Tool results from the assistant turn are *also* tagged `type: "user"`
/// (because Claude Code surfaces them as user-role observations), but their
/// content array contains a `tool_result` block. We exclude any entry whose
/// content array contains a `tool_result` so only typed prompts come
/// through.
pub(super) fn parse_claude_user_prompts(jsonl_path: &Path) -> Vec<String> {
    let raw = match std::fs::read_to_string(jsonl_path) {
        Ok(r) => r,
        Err(e) => {
            warn!(path = %jsonl_path.display(), error = %e, "claude transcript read failed");
            return Vec::new();
        }
    };
    let mut out: Vec<String> = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let entry: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if entry.get("type").and_then(|v| v.as_str()) != Some("user") {
            continue;
        }
        let Some(content) = entry.get("message").and_then(|m| m.get("content")) else {
            continue;
        };
        if let Some(text) = extract_user_prompt_text(content) {
            out.push(text);
        }
    }
    out
}

/// Extract the typed-by-the-user portion of a Claude Code message
/// `content` field. Returns `None` for tool-result observations and other
/// non-prompt entries (including slash-command stubs whose body is
/// nothing but `<command-*>`/`<local-command-*>` machinery).
fn extract_user_prompt_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => clean_claude_user_text(s),
        Value::Array(blocks) => {
            // Skip the whole entry if any block is a tool_result — those
            // aren't user prompts.
            let has_tool_result = blocks
                .iter()
                .any(|b| b.get("type").and_then(|v| v.as_str()) == Some("tool_result"));
            if has_tool_result {
                return None;
            }
            let mut combined = String::new();
            for block in blocks {
                if block.get("type").and_then(|v| v.as_str()) != Some("text") {
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
            clean_claude_user_text(&combined)
        }
        _ => None,
    }
}

/// Strip Claude Code's slash-command wrapper tags
/// (`<command-name>`, `<command-message>`, `<command-args>`,
/// `<local-command-caveat>`, `<local-command-stdout>`,
/// `<local-command-stderr>`) and return what the user actually typed.
///
/// Why: when the user runs a slash command like `/clear`, Claude Code
/// records a user-role transcript entry whose content is a chunk of
/// these wrapper tags carrying the command output, not text the user
/// authored. Treating that as the "first user prompt" is misleading —
/// it surfaces as something like "&lt;local-command-caveat&gt;Caveat: …"
/// in any UI that picks the head of the prompt log. We strip the
/// known wrappers and, if nothing remains, signal "not a real
/// user-typed prompt" by returning `None` so the caller falls through
/// to the next entry.
///
/// Stripping is conservative: we only remove balanced pairs of the
/// known tag names. Any text the user typed before, between, or
/// after the wrappers (which is the typical case for the
/// `<local-command-caveat>` injection — caveat block followed by the
/// actual prompt) survives intact.
///
/// Implementation: one left-to-right pass with a cursor. Each step finds
/// the *earliest* open tag at or after the cursor and removes it together
/// with its matching close (or truncates when the close never comes). The
/// predecessor re-scanned all nine tags over the whole string once per
/// outer pass and rebuilt both tag literals with `format!` every time,
/// which is quadratic-to-cubic in the number of wrappers on a line.
pub(crate) fn clean_claude_user_text(text: &str) -> Option<String> {
    let mut out = text.to_string();
    let mut cursor = 0usize;
    while cursor < out.len() {
        // Earliest wrapper open at or after the cursor. Open tags all start
        // with `<` and no tag name is a suffix of another's, so a match is
        // never ambiguous.
        let Some((start, open, close)) = WRAPPER_TAGS
            .iter()
            .filter_map(|&(open, close)| {
                out[cursor..]
                    .find(open)
                    .map(|at| (cursor + at, open, close))
            })
            .min_by_key(|&(at, _, _)| at)
        else {
            break;
        };

        let Some(end_rel) = out[start + open.len()..].find(close) else {
            // Unclosed wrapper — drop everything from the open tag forward.
            // Anything after a never-closed tag in a transcript line is by
            // definition still inside the wrapper.
            out.truncate(start);
            break;
        };
        let end = start + open.len() + end_rel + close.len();
        out.replace_range(start..end, "");

        // Resume slightly *before* the splice so a tag literal formed by the
        // concatenation of the two surviving halves is still caught — that
        // is the only thing the old re-scan-from-the-top loop bought us.
        cursor = start.saturating_sub(LONGEST_WRAPPER_TAG);
        while cursor > 0 && !out.is_char_boundary(cursor) {
            cursor -= 1;
        }
    }
    let trimmed = out.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// `(open, close)` literals for every wrapper we strip. Consts rather than
/// per-iteration `format!` calls — the old code rebuilt all eighteen strings
/// on every pass of its rescan loop.
const WRAPPER_TAGS: &[(&str, &str)] = &[
    ("<command-name>", "</command-name>"),
    ("<command-message>", "</command-message>"),
    ("<command-args>", "</command-args>"),
    ("<command-stdout>", "</command-stdout>"),
    ("<command-stderr>", "</command-stderr>"),
    ("<local-command-caveat>", "</local-command-caveat>"),
    ("<local-command-stdout>", "</local-command-stdout>"),
    ("<local-command-stderr>", "</local-command-stderr>"),
    ("<local-command-name>", "</local-command-name>"),
];

/// Longest close literal (`</local-command-caveat>`). A tag literal created
/// by splicing two halves together must straddle the join, so rewinding this
/// far is enough to catch it.
const LONGEST_WRAPPER_TAG: usize = "</local-command-caveat>".len();
