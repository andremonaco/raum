//! Direct readers for each harness's own on-disk transcript.
//!
//! Every supported harness already persists its conversation to disk in some
//! form — Claude Code's `~/.claude/projects/<encoded-cwd>/<session>.jsonl`,
//! Codex's `~/.codex/sessions/...` rollouts, OpenCode's HTTP-fronted store.
//! This module is raum's single primitive for reading **user prompts** out
//! of those files, used by both:
//!
//!   * the cross-harness review brief (full chronological list)
//!   * the snap overlay (just the first prompt)
//!
//! The primitive returns Vec<String> in chronological order. Anything we
//! can't read (file missing, format changed, harness uses HTTP) is
//! degraded gracefully to an empty Vec — the caller then falls back to
//! "no prompts available, work from the diff".
//!
//! **Per-harness coverage today:**
//!   * Claude Code: implemented. Newest jsonl in the encoded-cwd dir,
//!     filtered for top-level user messages.
//!   * Codex: implemented. Walks `~/.codex/sessions/<Y>/<M>/<D>/`,
//!     matches each rollout's `session_meta.cwd` against the supplied
//!     cwd, picks the newest match, and parses `response_item` /
//!     `user_message` events.
//!   * OpenCode: implemented via the local HTTP server raum already
//!     pins on `--port`. Two GETs: `GET /session?directory=<cwd>&limit=1`
//!     for the active session id, then `GET /session/<id>/message` for
//!     the messages. Tight 500 ms timeouts so a stalled server doesn't
//!     hang the snap UI. Falls back to empty if the server is unreachable.
//!   * Shell: never has prompts.

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::Value;
use tracing::warn;

use crate::agent::AgentKind;

/// Hard cap on how long any per-harness lookup may take. The snap overlay
/// blocks on this — anything longer than ~500 ms feels broken.
const TRANSCRIPT_HTTP_TIMEOUT: Duration = Duration::from_millis(500);

/// Cap on prompts returned to a caller. Long-running sessions can have
/// hundreds of turns; the brief renderer doesn't need all of them, and
/// inlining a giant list defeats the point of a small launch-time prompt.
pub const MAX_USER_PROMPTS_RETURNED: usize = 200;

/// Read the user prompts of the harness session running in `cwd`, in
/// chronological order. Best-effort — returns an empty Vec on any failure
/// (file missing, parse error, harness server unreachable).
///
/// * `home_dir` is parameterised so tests can point at a `tempdir()` instead
///   of the real `$HOME`. Production callers pass `dirs::home_dir()`.
/// * `opencode_port` is consulted only for `AgentKind::OpenCode` — it's
///   the local HTTP port raum pinned for the harness via `--port`. Other
///   kinds ignore it.
///
/// Async because the OpenCode arm hits the local HTTP server. The other
/// kinds do sync filesystem work and resolve immediately.
pub async fn read_session_user_prompts(
    kind: AgentKind,
    cwd: &Path,
    home_dir: &Path,
    opencode_port: Option<u16>,
) -> Vec<String> {
    match kind {
        AgentKind::ClaudeCode => {
            let Some(path) = discover_claude_code_transcript(cwd, home_dir) else {
                return Vec::new();
            };
            let mut prompts = parse_claude_user_prompts(&path);
            cap_in_place(&mut prompts);
            prompts
        }
        AgentKind::Codex => {
            let Some(path) = discover_codex_transcript(cwd, home_dir) else {
                return Vec::new();
            };
            let mut prompts = parse_codex_user_prompts(&path);
            cap_in_place(&mut prompts);
            prompts
        }
        AgentKind::OpenCode => {
            let Some(port) = opencode_port else {
                return Vec::new();
            };
            let mut prompts = read_opencode_user_prompts("http://127.0.0.1", port, cwd).await;
            cap_in_place(&mut prompts);
            prompts
        }
        AgentKind::Shell => Vec::new(),
    }
}

/// Best-effort transcript-file discovery, used by the review brief's
/// "pointer to the full conversation" line. Returns the absolute path of
/// the transcript on disk, or `None` if it can't be located.
#[must_use]
pub fn discover_transcript_path(kind: AgentKind, cwd: &Path, home_dir: &Path) -> Option<PathBuf> {
    match kind {
        AgentKind::ClaudeCode => discover_claude_code_transcript(cwd, home_dir),
        AgentKind::Codex => discover_codex_transcript(cwd, home_dir),
        AgentKind::OpenCode | AgentKind::Shell => None,
    }
}

/// Resolve the Codex session id for the newest rollout launched in
/// `cwd`. This is the same cwd-scoped discovery used for prompt
/// extraction, but returns the resumable id Codex expects in
/// `codex resume <id>`.
///
/// Production use case: older raum builds did not always capture
/// Codex's own session id from hooks, so a recovered pane may have a
/// tracked raum session but no persisted `harness_session_id`. Codex
/// writes the id into the rollout's `session_meta` event and embeds it
/// as the filename suffix; this helper recovers it before falling back
/// to a fresh launch.
#[must_use]
pub fn discover_codex_session_id(cwd: &Path, home_dir: &Path) -> Option<String> {
    let path = discover_codex_transcript(cwd, home_dir)?;
    codex_session_id_from_rollout(&path)
        .or_else(|| codex_session_id_from_filename(&path))
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
}

/// Resolve the Claude Code session id for the newest transcript launched in
/// `cwd`. Claude stores each session as `<session-id>.jsonl`, so the filename
/// stem is the value accepted by `claude --resume <id>`.
#[must_use]
pub fn discover_claude_session_id(cwd: &Path, home_dir: &Path) -> Option<String> {
    let path = discover_claude_code_transcript(cwd, home_dir)?;
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

/// Resolve a provider session id by matching a persisted raum prompt against
/// transcripts in `cwd`.
///
/// This is narrower than the cwd-newest helpers above: if several raum panes
/// share one worktree, the newest transcript may belong to a sibling pane.
/// Matching the pane's own last prompt gives legacy rows without a captured
/// `harness_session_id` a recoverable path without silently replaying another
/// conversation.
#[must_use]
pub fn discover_session_id_by_prompt(
    kind: AgentKind,
    cwd: &Path,
    home_dir: &Path,
    prompt: &str,
) -> Option<String> {
    let target = prompt.trim();
    if target.is_empty() {
        return None;
    }
    match kind {
        AgentKind::ClaudeCode => discover_claude_session_id_by_prompt(cwd, home_dir, target),
        AgentKind::Codex => discover_codex_session_id_by_prompt(cwd, home_dir, target),
        AgentKind::OpenCode | AgentKind::Shell => None,
    }
}

/// Validate that a captured provider session id belongs to `cwd`.
///
/// Used by reconnect/replay code as a last line of defense against older
/// cwd-newest fallback bugs: if multiple panes share one worktree, a guessed
/// id can point at a sibling session. In that case replay must fail visibly
/// instead of resuming the wrong conversation.
#[must_use]
pub fn harness_session_id_matches_cwd(
    kind: AgentKind,
    cwd: &Path,
    home_dir: &Path,
    harness_session_id: &str,
) -> bool {
    match kind {
        AgentKind::ClaudeCode => {
            claude_transcript_path_for_id(cwd, home_dir, harness_session_id).is_some()
        }
        AgentKind::Codex => codex_transcript_path_for_id(cwd, home_dir, harness_session_id)
            .is_some_and(|path| {
                cwd.to_str()
                    .is_some_and(|cwd| codex_rollout_matches_cwd(&path, cwd))
            }),
        AgentKind::OpenCode | AgentKind::Shell => true,
    }
}

/// Like [`read_session_user_prompts`] but targets the harness session
/// whose own session id matches `harness_session_id` instead of
/// picking the newest jsonl in the worktree directory.
///
/// Why it exists: the directory-newest heuristic returns the same
/// transcript file for every raum pane sharing one worktree, so a
/// post-restart pane overlay surfaces another session's "Task". When
/// raum has captured the harness session id from a `UserPromptSubmit`
/// hook (see `extract_harness_session_id` /
/// `ConfigStore::update_session_harness_id`), this function uses it to
/// open the exact file.
///
/// **No fallback**: if the targeted file is missing — e.g. Claude
/// hasn't written its jsonl yet on a fresh session, the user manually
/// deleted it, or the captured id is stale — we return an empty Vec
/// rather than fall through to "newest in directory". The fallback
/// would surface a sibling session's prompts as ours, which is the
/// exact bug this function exists to fix. For OpenCode (no on-disk
/// transcript by id) and Shell (no transcript at all), this also
/// returns empty.
///
/// `_opencode_port` is accepted for signature symmetry with
/// [`read_session_user_prompts`] but unused — OpenCode has no
/// per-session id we can resolve to a transcript file.
pub fn read_session_user_prompts_for_id(
    kind: AgentKind,
    cwd: &Path,
    home_dir: &Path,
    harness_session_id: &str,
    _opencode_port: Option<u16>,
) -> Vec<String> {
    let direct = match kind {
        AgentKind::ClaudeCode => claude_transcript_path_for_id(cwd, home_dir, harness_session_id),
        AgentKind::Codex => codex_transcript_path_for_id(cwd, home_dir, harness_session_id),
        AgentKind::OpenCode | AgentKind::Shell => None,
    };
    let Some(path) = direct else {
        return Vec::new();
    };
    let mut prompts = match kind {
        AgentKind::ClaudeCode => parse_claude_user_prompts(&path),
        AgentKind::Codex => parse_codex_user_prompts(&path),
        // Unreachable: the per-kind branch above only returns a path
        // for kinds that have a parser.
        _ => Vec::new(),
    };
    cap_in_place(&mut prompts);
    prompts
}

/// Direct path lookup for a Claude Code session by its UUID. Returns
/// `Some(path)` only when the corresponding `<id>.jsonl` exists under
/// the worktree's encoded project directory. Cheap — single
/// `metadata()` call, no directory scan.
fn claude_transcript_path_for_id(cwd: &Path, home_dir: &Path, id: &str) -> Option<PathBuf> {
    let encoded = encode_cwd_for_claude(cwd)?;
    let path = home_dir
        .join(".claude")
        .join("projects")
        .join(&encoded)
        .join(format!("{id}.jsonl"));
    path.is_file().then_some(path)
}

/// Walk Codex's `~/.codex/sessions/<YYYY>/<MM>/<DD>/` tree looking for
/// a rollout whose filename ends with `-<id>.jsonl` (Codex's stable
/// embed of the session id). Cheap because Codex scopes rollouts by
/// date and we abort on the first match.
fn codex_transcript_path_for_id(_cwd: &Path, home_dir: &Path, id: &str) -> Option<PathBuf> {
    let sessions = home_dir.join(".codex").join("sessions");
    if !sessions.is_dir() {
        return None;
    }
    let suffix = format!("-{id}.jsonl");
    let years = std::fs::read_dir(&sessions).ok()?;
    for year in years.flatten() {
        let yp = year.path();
        if !yp.is_dir() {
            continue;
        }
        let Ok(months) = std::fs::read_dir(&yp) else {
            continue;
        };
        for month in months.flatten() {
            let mp = month.path();
            if !mp.is_dir() {
                continue;
            }
            let Ok(days) = std::fs::read_dir(&mp) else {
                continue;
            };
            for day in days.flatten() {
                let dp = day.path();
                if !dp.is_dir() {
                    continue;
                }
                let Ok(files) = std::fs::read_dir(&dp) else {
                    continue;
                };
                for entry in files.flatten() {
                    let p = entry.path();
                    let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
                        continue;
                    };
                    if name.ends_with(&suffix) {
                        return Some(p);
                    }
                }
            }
        }
    }
    None
}

/// Trim a prompt list to [`MAX_USER_PROMPTS_RETURNED`], keeping the
/// chronologically newer tail (so the reviewer sees the most recent
/// instructions verbatim and the older context is implicit in the diff).
fn cap_in_place(prompts: &mut Vec<String>) {
    if prompts.len() > MAX_USER_PROMPTS_RETURNED {
        let drop = prompts.len() - MAX_USER_PROMPTS_RETURNED;
        prompts.drain(..drop);
    }
}

// ---- Claude Code ----------------------------------------------------------

/// Claude Code stores per-project transcripts under
/// `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where the encoded
/// form replaces `/` with `-` (so `/Users/foo/repo` → `-Users-foo-repo`).
/// We pick the most-recently-modified `*.jsonl` in that directory because
/// Claude Code rotates session files and the active one is always the
/// freshest.
fn discover_claude_code_transcript(cwd: &Path, home_dir: &Path) -> Option<PathBuf> {
    let encoded = encode_cwd_for_claude(cwd)?;
    let dir = home_dir.join(".claude").join("projects").join(&encoded);
    newest_jsonl_in(&dir)
}

fn discover_claude_session_id_by_prompt(
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
        if !transcript_contains_prompt(parse_claude_user_prompts(&path), prompt) {
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
fn encode_cwd_for_claude(cwd: &Path) -> Option<String> {
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
fn parse_claude_user_prompts(jsonl_path: &Path) -> Vec<String> {
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
pub(crate) fn clean_claude_user_text(text: &str) -> Option<String> {
    const WRAPPER_TAGS: &[&str] = &[
        "command-name",
        "command-message",
        "command-args",
        "command-stdout",
        "command-stderr",
        "local-command-caveat",
        "local-command-stdout",
        "local-command-stderr",
        "local-command-name",
    ];
    let mut out = text.to_string();
    let mut changed = true;
    // Outer loop handles nested or interleaved tags by re-scanning until
    // no more replacements happen.
    while changed {
        changed = false;
        for tag in WRAPPER_TAGS {
            let open = format!("<{tag}>");
            let close = format!("</{tag}>");
            while let Some(start) = out.find(&open) {
                if let Some(end_rel) = out[start + open.len()..].find(&close) {
                    let end = start + open.len() + end_rel + close.len();
                    out.replace_range(start..end, "");
                    changed = true;
                } else {
                    // Unclosed wrapper — drop everything from the open
                    // tag forward. Anything after a never-closed tag in
                    // a transcript line is by definition still inside
                    // the wrapper.
                    out.truncate(start);
                    changed = true;
                    break;
                }
            }
        }
    }
    let trimmed = out.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

// ---- Codex ----------------------------------------------------------------

/// Codex stores rollouts under `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<uuid>.jsonl`.
/// The first line of each rollout is a `session_meta` event whose
/// payload carries the `cwd` the session was launched in, so we walk the
/// date hierarchy, match by cwd, and pick the newest match.
fn discover_codex_transcript(cwd: &Path, home_dir: &Path) -> Option<PathBuf> {
    let sessions = home_dir.join(".codex").join("sessions");
    if !sessions.is_dir() {
        return None;
    }
    let cwd_str = cwd.to_str()?;

    let mut best: Option<(PathBuf, SystemTime)> = None;
    let mut consider = |path: PathBuf| {
        let modified = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        if !codex_rollout_matches_cwd(&path, cwd_str) {
            return;
        }
        match &best {
            Some((_, t)) if *t >= modified => {}
            _ => best = Some((path, modified)),
        }
    };

    // Walk year/month/day three deep. The structure is fixed by Codex.
    let Ok(years) = std::fs::read_dir(&sessions) else {
        return None;
    };
    for year in years.flatten() {
        if !year.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Ok(months) = std::fs::read_dir(year.path()) else {
            continue;
        };
        for month in months.flatten() {
            if !month.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let Ok(days) = std::fs::read_dir(month.path()) else {
                continue;
            };
            for day in days.flatten() {
                if !day.file_type().is_ok_and(|t| t.is_dir()) {
                    continue;
                }
                let Ok(files) = std::fs::read_dir(day.path()) else {
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
                    consider(path);
                }
            }
        }
    }
    best.map(|(p, _)| p)
}

fn discover_codex_session_id_by_prompt(
    cwd: &Path,
    home_dir: &Path,
    prompt: &str,
) -> Option<String> {
    let sessions = home_dir.join(".codex").join("sessions");
    if !sessions.is_dir() {
        return None;
    }
    let cwd_str = cwd.to_str()?;
    let mut best: Option<(String, SystemTime)> = None;
    let mut consider = |path: PathBuf| {
        if !codex_rollout_matches_cwd(&path, cwd_str) {
            return;
        }
        if !transcript_contains_prompt(parse_codex_user_prompts(&path), prompt) {
            return;
        }
        let Some(id) = codex_session_id_from_rollout(&path)
            .or_else(|| codex_session_id_from_filename(&path))
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
        else {
            return;
        };
        let modified = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        match &best {
            Some((_, t)) if *t >= modified => {}
            _ => best = Some((id, modified)),
        }
    };

    let Ok(years) = std::fs::read_dir(&sessions) else {
        return None;
    };
    for year in years.flatten() {
        if !year.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Ok(months) = std::fs::read_dir(year.path()) else {
            continue;
        };
        for month in months.flatten() {
            if !month.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let Ok(days) = std::fs::read_dir(month.path()) else {
                continue;
            };
            for day in days.flatten() {
                if !day.file_type().is_ok_and(|t| t.is_dir()) {
                    continue;
                }
                let Ok(files) = std::fs::read_dir(day.path()) else {
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
                    if is_rollout {
                        consider(path);
                    }
                }
            }
        }
    }
    best.map(|(id, _)| id)
}

fn transcript_contains_prompt(prompts: Vec<String>, target: &str) -> bool {
    let target = target.trim();
    if target.is_empty() {
        return false;
    }
    prompts.into_iter().any(|prompt| {
        let prompt = prompt.trim();
        prompt == target || prompt.contains(target) || target.contains(prompt)
    })
}

/// Read just the first line of `path` and check whether the
/// `session_meta` event reports the session was launched in `cwd`. Two
/// shapes seen across Codex versions: `{payload: {cwd}}` or `{cwd}`.
fn codex_rollout_matches_cwd(path: &Path, cwd: &str) -> bool {
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

fn codex_session_id_from_rollout(path: &Path) -> Option<String> {
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

fn codex_session_id_from_filename(path: &Path) -> Option<String> {
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
fn parse_codex_user_prompts(jsonl_path: &Path) -> Vec<String> {
    let raw = match std::fs::read_to_string(jsonl_path) {
        Ok(r) => r,
        Err(e) => {
            warn!(path = %jsonl_path.display(), error = %e, "codex transcript read failed");
            return Vec::new();
        }
    };
    let mut event_prompts: Vec<String> = Vec::new();
    let mut response_prompts: Vec<String> = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let entry: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some(payload) = entry.get("payload") else {
            continue;
        };
        let entry_type = entry.get("type").and_then(|v| v.as_str());
        let payload_type = payload.get("type").and_then(|v| v.as_str());

        // Shape A — clean signal, prefer when present.
        if payload_type == Some("user_message") {
            if let Some(text) = payload
                .get("message")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                event_prompts.push(text.to_string());
            }
            continue;
        }

        // Shape B — fallback; filter synthetic context.
        if entry_type == Some("response_item")
            && payload_type == Some("message")
            && payload.get("role").and_then(|v| v.as_str()) == Some("user")
        {
            if let Some(text) = payload
                .get("content")
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

// ---- OpenCode -------------------------------------------------------------

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
async fn read_opencode_user_prompts(base_url: &str, port: u16, cwd: &Path) -> Vec<String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::thread::sleep;
    use tempfile::tempdir;

    /// Set up a fake `$HOME/.claude/projects/<encoded>/` with a single
    /// jsonl and return (home, jsonl_path). Tests then write the jsonl
    /// content they want to parse. Mirrors the production encoding —
    /// both `/` and `.` collapse to `-`.
    fn fake_claude_home(cwd: &str) -> (tempfile::TempDir, PathBuf) {
        let home = tempdir().unwrap();
        let encoded: String = cwd
            .chars()
            .map(|c| if c == '/' || c == '.' { '-' } else { c })
            .collect();
        let dir = home.path().join(".claude").join("projects").join(encoded);
        fs::create_dir_all(&dir).unwrap();
        let jsonl = dir.join("aaaa.jsonl");
        (home, jsonl)
    }

    #[test]
    fn encodes_dotted_paths_with_dashes() {
        // Verified against a real installation: a worktree at
        // `/Users/x/repo/.raum/feat-cross-review` is stored under
        // `~/.claude/projects/-Users-x-repo--raum-feat-cross-review/`.
        // Without dot replacement, the lookup silently misses for every
        // worktree under a hidden directory.
        assert_eq!(
            encode_cwd_for_claude(Path::new("/Users/x/repo/.raum/feat-cross-review")).as_deref(),
            Some("-Users-x-repo--raum-feat-cross-review"),
        );
        assert_eq!(
            encode_cwd_for_claude(Path::new("/Users/x/Projekte/private/raum")).as_deref(),
            Some("-Users-x-Projekte-private-raum"),
        );
    }

    #[tokio::test]
    async fn finds_claude_transcript_for_dotted_worktree_path() {
        // End-to-end: worktree path with a hidden segment must resolve to
        // the right `~/.claude/projects/` directory and parse the prompts.
        let cwd = "/Users/x/repo/.raum/feat";
        let (home, jsonl) = fake_claude_home(cwd);
        fs::write(
            &jsonl,
            r#"{"type":"user","message":{"role":"user","content":"the dotted path one"}}
"#,
        )
        .unwrap();
        let prompts =
            read_session_user_prompts(AgentKind::ClaudeCode, Path::new(cwd), home.path(), None)
                .await;
        assert_eq!(prompts, vec!["the dotted path one"]);
    }

    #[test]
    fn discovers_newest_claude_jsonl() {
        let home = tempdir().unwrap();
        let cwd = Path::new("/Users/foo/myrepo");
        let proj_dir = home
            .path()
            .join(".claude")
            .join("projects")
            .join("-Users-foo-myrepo");
        fs::create_dir_all(&proj_dir).unwrap();

        let older = proj_dir.join("aaaa.jsonl");
        let newer = proj_dir.join("bbbb.jsonl");
        let unrelated = proj_dir.join("notes.txt");
        fs::write(&older, b"{}").unwrap();
        sleep(Duration::from_millis(50));
        fs::write(&newer, b"{}").unwrap();
        fs::write(&unrelated, b"hi").unwrap();

        let found = discover_transcript_path(AgentKind::ClaudeCode, cwd, home.path());
        assert_eq!(found.as_deref(), Some(newer.as_path()));
    }

    #[test]
    fn discover_claude_session_id_uses_newest_jsonl_stem() {
        let home = tempdir().unwrap();
        let cwd = Path::new("/Users/foo/myrepo");
        let proj_dir = home
            .path()
            .join(".claude")
            .join("projects")
            .join("-Users-foo-myrepo");
        fs::create_dir_all(&proj_dir).unwrap();

        fs::write(proj_dir.join("older-session.jsonl"), b"{}").unwrap();
        sleep(Duration::from_millis(50));
        fs::write(proj_dir.join("newer-session.jsonl"), b"{}").unwrap();

        assert_eq!(
            discover_claude_session_id(cwd, home.path()).as_deref(),
            Some("newer-session")
        );
    }

    #[test]
    fn discover_claude_session_id_by_prompt_disambiguates_shared_cwd() {
        let home = tempdir().unwrap();
        let cwd = Path::new("/Users/foo/myrepo");
        let proj_dir = home
            .path()
            .join(".claude")
            .join("projects")
            .join("-Users-foo-myrepo");
        fs::create_dir_all(&proj_dir).unwrap();

        fs::write(
            proj_dir.join("older-session.jsonl"),
            r#"{"type":"user","message":{"role":"user","content":"target prompt"}}
"#,
        )
        .unwrap();
        sleep(Duration::from_millis(50));
        fs::write(
            proj_dir.join("newer-sibling.jsonl"),
            r#"{"type":"user","message":{"role":"user","content":"different prompt"}}
"#,
        )
        .unwrap();

        assert_eq!(
            discover_claude_session_id(cwd, home.path()).as_deref(),
            Some("newer-sibling"),
        );
        assert_eq!(
            discover_session_id_by_prompt(AgentKind::ClaudeCode, cwd, home.path(), "target prompt")
                .as_deref(),
            Some("older-session"),
        );
    }

    #[tokio::test]
    async fn missing_project_dir_returns_no_prompts() {
        let home = tempdir().unwrap();
        let cwd = Path::new("/never/seen/before");
        assert!(
            read_session_user_prompts(AgentKind::ClaudeCode, cwd, home.path(), None)
                .await
                .is_empty()
        );
    }

    #[tokio::test]
    async fn parses_string_content_user_prompts_in_order() {
        let cwd = "/Users/foo/repo";
        let (home, jsonl) = fake_claude_home(cwd);
        fs::write(
            &jsonl,
            r#"{"type":"user","message":{"role":"user","content":"first prompt"}}
{"type":"assistant","message":{"role":"assistant","content":"hi"}}
{"type":"user","message":{"role":"user","content":"second prompt"}}
"#,
        )
        .unwrap();
        let prompts =
            read_session_user_prompts(AgentKind::ClaudeCode, Path::new(cwd), home.path(), None)
                .await;
        assert_eq!(prompts, vec!["first prompt", "second prompt"]);
    }

    #[tokio::test]
    async fn parses_text_block_array_content() {
        let cwd = "/Users/foo/repo";
        let (home, jsonl) = fake_claude_home(cwd);
        fs::write(
            &jsonl,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi there"}]}}
"#,
        )
        .unwrap();
        let prompts =
            read_session_user_prompts(AgentKind::ClaudeCode, Path::new(cwd), home.path(), None)
                .await;
        assert_eq!(prompts, vec!["hi there"]);
    }

    #[tokio::test]
    async fn skips_tool_result_entries() {
        let cwd = "/Users/foo/repo";
        let (home, jsonl) = fake_claude_home(cwd);
        fs::write(
            &jsonl,
            r#"{"type":"user","message":{"role":"user","content":"real one"}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"file bytes"}]}}
{"type":"user","message":{"role":"user","content":"another real"}}
"#,
        )
        .unwrap();
        let prompts =
            read_session_user_prompts(AgentKind::ClaudeCode, Path::new(cwd), home.path(), None)
                .await;
        assert_eq!(prompts, vec!["real one", "another real"]);
    }

    #[tokio::test]
    async fn skips_pure_slash_command_machinery() {
        // Real-world: a session that starts with `/clear` records a
        // user-role entry whose content is nothing but slash-command
        // wrapper tags. That should NOT be treated as the first user
        // prompt — the next entry should win.
        let cwd = "/Users/foo/repo";
        let (home, jsonl) = fake_claude_home(cwd);
        fs::write(
            &jsonl,
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"}}
{"type":"user","message":{"role":"user","content":"the real first prompt"}}
"#,
        )
        .unwrap();
        let prompts =
            read_session_user_prompts(AgentKind::ClaudeCode, Path::new(cwd), home.path(), None)
                .await;
        assert_eq!(prompts, vec!["the real first prompt"]);
    }

    #[tokio::test]
    async fn keeps_user_text_after_local_command_caveat() {
        // The `<local-command-caveat>...</local-command-caveat>` block
        // is injected ahead of a real user prompt after a slash
        // command runs. Strip the caveat, keep the prompt.
        let cwd = "/Users/foo/repo";
        let (home, jsonl) = fake_claude_home(cwd);
        fs::write(
            &jsonl,
            r#"{"type":"user","message":{"role":"user","content":"<local-command-caveat>Caveat: do not respond to these.</local-command-caveat>\nplease refactor the parser"}}
"#,
        )
        .unwrap();
        let prompts =
            read_session_user_prompts(AgentKind::ClaudeCode, Path::new(cwd), home.path(), None)
                .await;
        assert_eq!(prompts, vec!["please refactor the parser"]);
    }

    #[test]
    fn clean_claude_user_text_strips_balanced_wrappers() {
        let stripped = clean_claude_user_text(
            "<command-name>/clear</command-name>\n<command-args></command-args>",
        );
        assert_eq!(stripped, None);

        let kept = clean_claude_user_text(
            "<local-command-caveat>noise</local-command-caveat>\nactual prompt",
        );
        assert_eq!(kept.as_deref(), Some("actual prompt"));

        let plain = clean_claude_user_text("just a normal prompt");
        assert_eq!(plain.as_deref(), Some("just a normal prompt"));
    }

    #[tokio::test]
    async fn skips_blank_and_malformed_lines() {
        let cwd = "/Users/foo/repo";
        let (home, jsonl) = fake_claude_home(cwd);
        fs::write(
            &jsonl,
            "\n  \n{\"type\":\"user\",\"message\":{\"content\":\"good\"}}\nNOT JSON\n{\"type\":\"user\",\"message\":{\"content\":\"\"}}\n",
        )
        .unwrap();
        let prompts =
            read_session_user_prompts(AgentKind::ClaudeCode, Path::new(cwd), home.path(), None)
                .await;
        assert_eq!(prompts, vec!["good"]);
    }

    #[tokio::test]
    async fn caps_at_max_returned() {
        use std::fmt::Write as _;
        let cwd = "/Users/foo/repo";
        let (home, jsonl) = fake_claude_home(cwd);
        let total = MAX_USER_PROMPTS_RETURNED + 7;
        let mut content = String::new();
        for i in 0..total {
            let _ = writeln!(
                content,
                "{{\"type\":\"user\",\"message\":{{\"content\":\"p{i}\"}}}}",
            );
        }
        fs::write(&jsonl, content).unwrap();
        let prompts =
            read_session_user_prompts(AgentKind::ClaudeCode, Path::new(cwd), home.path(), None)
                .await;
        assert_eq!(prompts.len(), MAX_USER_PROMPTS_RETURNED);
        assert_eq!(prompts[0], "p7");
        assert_eq!(prompts.last().unwrap(), &format!("p{}", total - 1));
    }

    #[tokio::test]
    async fn shell_returns_empty() {
        let home = tempdir().unwrap();
        let cwd = Path::new("/anywhere");
        assert!(
            read_session_user_prompts(AgentKind::Shell, cwd, home.path(), None)
                .await
                .is_empty()
        );
    }

    #[tokio::test]
    async fn opencode_without_port_returns_empty() {
        let home = tempdir().unwrap();
        let cwd = Path::new("/anywhere");
        assert!(
            read_session_user_prompts(AgentKind::OpenCode, cwd, home.path(), None)
                .await
                .is_empty()
        );
    }

    // ---- OpenCode HTTP tests (wiremock) ---------------------------------

    #[tokio::test]
    async fn opencode_http_extracts_user_prompts_in_order() {
        use wiremock::matchers::{method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let cwd = "/Users/foo/repo";

        // First call: GET /session?directory=...&limit=1
        Mock::given(method("GET"))
            .and(path("/session"))
            .and(query_param("directory", cwd))
            .and(query_param("limit", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                { "id": "ses_abc", "directory": cwd, "title": "demo" }
            ])))
            .mount(&server)
            .await;

        // Second call: GET /session/ses_abc/message
        Mock::given(method("GET"))
            .and(path("/session/ses_abc/message"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {
                    "info": { "role": "user", "time": { "created": 1 } },
                    "parts": [
                        { "type": "text", "text": "first prompt", "synthetic": false }
                    ]
                },
                {
                    "info": { "role": "assistant", "time": { "created": 2 } },
                    "parts": [{ "type": "text", "text": "an answer" }]
                },
                {
                    "info": { "role": "user", "time": { "created": 3 } },
                    "parts": [
                        { "type": "text", "text": "context", "synthetic": true },
                        { "type": "text", "text": "follow-up" }
                    ]
                }
            ])))
            .mount(&server)
            .await;

        // Wiremock binds on a random port and returns "http://127.0.0.1:<port>".
        // Split that into the base + port that our function takes separately.
        let url = server.uri();
        let (base, port) = parse_wiremock_uri(&url);

        let prompts = read_opencode_user_prompts(&base, port, Path::new(cwd)).await;
        assert_eq!(prompts, vec!["first prompt", "follow-up"]);
    }

    #[tokio::test]
    async fn opencode_http_no_session_for_cwd_returns_empty() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/session"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server)
            .await;

        let (base, port) = parse_wiremock_uri(&server.uri());
        let prompts = read_opencode_user_prompts(&base, port, Path::new("/Users/x/repo")).await;
        assert!(prompts.is_empty());
    }

    #[tokio::test]
    async fn opencode_http_skips_synthetic_only_messages() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/session"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{ "id": "s1" }])),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/session/s1/message"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {
                    "info": { "role": "user" },
                    "parts": [{ "type": "text", "text": "synthetic only", "synthetic": true }]
                },
                {
                    "info": { "role": "user" },
                    "parts": [{ "type": "text", "text": "real" }]
                }
            ])))
            .mount(&server)
            .await;

        let (base, port) = parse_wiremock_uri(&server.uri());
        let prompts = read_opencode_user_prompts(&base, port, Path::new("/anywhere")).await;
        assert_eq!(prompts, vec!["real"]);
    }

    #[tokio::test]
    async fn opencode_unreachable_server_returns_empty() {
        // Localhost port that's almost certainly closed. The 500 ms
        // timeout caps how long we block.
        let prompts =
            read_opencode_user_prompts("http://127.0.0.1", 1, Path::new("/anywhere")).await;
        assert!(prompts.is_empty());
    }

    /// Pull `("http://host", port)` out of a `http://127.0.0.1:NNNN` uri
    /// — wiremock doesn't expose port directly. Helper for the OpenCode
    /// HTTP tests.
    fn parse_wiremock_uri(uri: &str) -> (String, u16) {
        let stripped = uri.strip_prefix("http://").unwrap();
        let (host, port) = stripped.split_once(':').unwrap();
        (format!("http://{host}"), port.parse().unwrap())
    }

    /// Set up a fake `$HOME/.codex/sessions/2026/04/29/rollout-test.jsonl`
    /// with the given content + session_meta cwd. Returns (home, jsonl).
    fn fake_codex_rollout(cwd: &str, content: &str) -> (tempfile::TempDir, PathBuf) {
        let home = tempdir().unwrap();
        let dir = home
            .path()
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("04")
            .join("29");
        fs::create_dir_all(&dir).unwrap();
        let jsonl = dir.join("rollout-abcd.jsonl");
        let session_meta = format!(
            "{{\"timestamp\":\"2026-04-29T12:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"abcd\",\"cwd\":\"{cwd}\"}}}}\n"
        );
        let body = format!("{session_meta}{content}");
        fs::write(&jsonl, body).unwrap();
        (home, jsonl)
    }

    #[tokio::test]
    async fn codex_response_item_message_user_role_is_extracted() {
        let cwd = "/Users/foo/repo";
        let (home, _jsonl) = fake_codex_rollout(
            cwd,
            "{\"timestamp\":\"...\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"first task\"}]}}\n\
{\"timestamp\":\"...\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\"}]}}\n\
{\"timestamp\":\"...\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"follow-up\"}]}}\n",
        );
        let prompts =
            read_session_user_prompts(AgentKind::Codex, Path::new(cwd), home.path(), None).await;
        assert_eq!(prompts, vec!["first task", "follow-up"]);
    }

    #[tokio::test]
    async fn codex_legacy_user_message_event_is_extracted() {
        let cwd = "/Users/foo/repo";
        let (home, _) = fake_codex_rollout(
            cwd,
            "{\"timestamp\":\"...\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"hello\"}}\n",
        );
        let prompts =
            read_session_user_prompts(AgentKind::Codex, Path::new(cwd), home.path(), None).await;
        assert_eq!(prompts, vec!["hello"]);
    }

    #[tokio::test]
    async fn codex_picks_newest_matching_cwd() {
        let cwd = "/Users/foo/repo";
        let home = tempdir().unwrap();
        let dir = home
            .path()
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("04")
            .join("29");
        fs::create_dir_all(&dir).unwrap();

        // Older rollout for our cwd.
        let older = dir.join("rollout-aaaa.jsonl");
        fs::write(
            &older,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"{cwd}\"}}}}\n\
{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"old\"}}]}}}}\n",
            ),
        )
        .unwrap();
        sleep(Duration::from_millis(50));

        // Rollout for a *different* cwd — must be ignored even though it's newer.
        let other = dir.join("rollout-bbbb.jsonl");
        fs::write(
            &other,
            "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/elsewhere\"}}\n\
{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"unrelated\"}]}}\n",
        )
        .unwrap();
        sleep(Duration::from_millis(50));

        // Newer rollout for our cwd — wins.
        let newer = dir.join("rollout-cccc.jsonl");
        fs::write(
            &newer,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"{cwd}\"}}}}\n\
{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"new\"}}]}}}}\n",
            ),
        )
        .unwrap();

        let prompts =
            read_session_user_prompts(AgentKind::Codex, Path::new(cwd), home.path(), None).await;
        assert_eq!(prompts, vec!["new"]);
    }

    #[test]
    fn codex_session_id_discovery_reads_newest_matching_rollout_meta() {
        let cwd = "/Users/foo/repo";
        let home = tempdir().unwrap();
        let dir = home
            .path()
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("04")
            .join("29");
        fs::create_dir_all(&dir).unwrap();

        let older = dir.join("rollout-2026-04-29T10-00-00-old-id.jsonl");
        fs::write(
            &older,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"old-id\",\"cwd\":\"{cwd}\"}}}}\n"
            ),
        )
        .unwrap();
        sleep(Duration::from_millis(50));

        let other = dir.join("rollout-2026-04-29T11-00-00-other-id.jsonl");
        fs::write(
            &other,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"other-id\",\"cwd\":\"/elsewhere\"}}\n",
        )
        .unwrap();
        sleep(Duration::from_millis(50));

        let newer = dir.join("rollout-2026-04-29T12-00-00-new-id.jsonl");
        fs::write(
            &newer,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"new-id\",\"cwd\":\"{cwd}\"}}}}\n"
            ),
        )
        .unwrap();

        assert_eq!(
            discover_codex_session_id(Path::new(cwd), home.path()).as_deref(),
            Some("new-id"),
        );
    }

    #[test]
    fn codex_session_id_discovery_falls_back_to_uuid_filename_suffix() {
        let cwd = "/Users/foo/repo";
        let home = tempdir().unwrap();
        let dir = home
            .path()
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("04")
            .join("29");
        fs::create_dir_all(&dir).unwrap();

        let id = "123e4567-e89b-12d3-a456-426614174000";
        let rollout = dir.join(format!("rollout-2026-04-29T12-00-00-{id}.jsonl"));
        fs::write(
            &rollout,
            format!("{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"{cwd}\"}}}}\n"),
        )
        .unwrap();

        assert_eq!(
            discover_codex_session_id(Path::new(cwd), home.path()).as_deref(),
            Some(id),
        );
    }

    #[test]
    fn discover_codex_session_id_by_prompt_disambiguates_shared_cwd() {
        let cwd = "/Users/foo/repo";
        let home = tempdir().unwrap();
        let dir = home
            .path()
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("04")
            .join("29");
        fs::create_dir_all(&dir).unwrap();

        let older_id = "11111111-1111-1111-1111-111111111111";
        let older = dir.join(format!("rollout-2026-04-29T10-00-00-{older_id}.jsonl"));
        fs::write(
            &older,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"{cwd}\"}}}}\n\
{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"target prompt\"}}}}\n"
            ),
        )
        .unwrap();
        sleep(Duration::from_millis(50));

        let newer_id = "22222222-2222-2222-2222-222222222222";
        let newer = dir.join(format!("rollout-2026-04-29T11-00-00-{newer_id}.jsonl"));
        fs::write(
            &newer,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"{cwd}\"}}}}\n\
{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"different prompt\"}}}}\n"
            ),
        )
        .unwrap();

        assert_eq!(
            discover_codex_session_id(Path::new(cwd), home.path()).as_deref(),
            Some(newer_id),
        );
        assert_eq!(
            discover_session_id_by_prompt(
                AgentKind::Codex,
                Path::new(cwd),
                home.path(),
                "target prompt"
            )
            .as_deref(),
            Some(older_id),
        );
    }

    #[tokio::test]
    async fn codex_skips_synthetic_agents_md_injection() {
        // Real-world: every newer Codex rollout starts with a
        // synthetic `role=user` message whose content is the project's
        // AGENTS.md text. That MUST NOT surface as the first user
        // prompt — the typed prompt should win.
        let cwd = "/Users/foo/repo";
        let (home, _) = fake_codex_rollout(
            cwd,
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"# AGENTS.md instructions for /Users/foo/repo\\n\\n<INSTRUCTIONS>...\"}]}}\n\
{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"the real first prompt\"}]}}\n\
{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"the real first prompt\"}}\n",
        );
        let prompts =
            read_session_user_prompts(AgentKind::Codex, Path::new(cwd), home.path(), None).await;
        assert_eq!(prompts, vec!["the real first prompt"]);
    }

    #[tokio::test]
    async fn codex_skips_turn_aborted_synthetic_blocks() {
        // After a Ctrl-C cancel Codex injects a `<turn_aborted>`
        // notice as a `role=user` message. Filter the same way as
        // AGENTS.md so the next typed prompt wins.
        let cwd = "/Users/foo/repo";
        let (home, _) = fake_codex_rollout(
            cwd,
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<turn_aborted>\\nthe user interrupted\\n</turn_aborted>\"}]}}\n\
{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"try again\"}]}}\n",
        );
        let prompts =
            read_session_user_prompts(AgentKind::Codex, Path::new(cwd), home.path(), None).await;
        assert_eq!(prompts, vec!["try again"]);
    }

    #[tokio::test]
    async fn codex_prefers_event_msg_when_both_shapes_present() {
        // Newer Codex logs the same typed prompt under BOTH shapes.
        // Without de-duplication we'd surface every prompt twice.
        // Preferring `event_msg` also implicitly drops the AGENTS.md
        // injection, which only appears under the `response_item`
        // shape.
        let cwd = "/Users/foo/repo";
        let (home, _) = fake_codex_rollout(
            cwd,
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"# AGENTS.md instructions for /Users/foo/repo\\n...\"}]}}\n\
{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"first\"}]}}\n\
{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"first\"}}\n\
{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"second\"}]}}\n\
{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"second\"}}\n",
        );
        let prompts =
            read_session_user_prompts(AgentKind::Codex, Path::new(cwd), home.path(), None).await;
        assert_eq!(prompts, vec!["first", "second"]);
    }

    #[tokio::test]
    async fn codex_ignores_assistant_and_tool_blocks() {
        let cwd = "/Users/foo/repo";
        let (home, _) = fake_codex_rollout(
            cwd,
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"real\"}]}}\n\
{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"ls\"}}\n\
{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"output\":\"...\"}}\n",
        );
        let prompts =
            read_session_user_prompts(AgentKind::Codex, Path::new(cwd), home.path(), None).await;
        assert_eq!(prompts, vec!["real"]);
    }

    #[tokio::test]
    async fn codex_missing_session_dir_returns_empty() {
        let home = tempdir().unwrap();
        let cwd = Path::new("/Users/foo/repo");
        assert!(
            read_session_user_prompts(AgentKind::Codex, cwd, home.path(), None)
                .await
                .is_empty()
        );
    }

    #[tokio::test]
    async fn empty_cwd_yields_nothing() {
        let home = tempdir().unwrap();
        assert_eq!(encode_cwd_for_claude(Path::new("")), None);
        assert!(
            read_session_user_prompts(AgentKind::ClaudeCode, Path::new(""), home.path(), None)
                .await
                .is_empty()
        );
    }

    #[test]
    fn claude_id_lookup_picks_exact_jsonl_even_when_others_are_newer() {
        // Multi-pane regression: previously every pane in the same
        // worktree resolved to the same "newest jsonl". With the
        // captured harness session id, the lookup targets exactly the
        // file Claude assigned to that pane.
        let cwd = "/Users/foo/repo";
        let home = tempdir().unwrap();
        let encoded: String = cwd
            .chars()
            .map(|c| if c == '/' || c == '.' { '-' } else { c })
            .collect();
        let dir = home.path().join(".claude").join("projects").join(encoded);
        fs::create_dir_all(&dir).unwrap();

        // Older jsonl that belongs to *our* session.
        let ours = dir.join("aaaa-1111.jsonl");
        fs::write(
            &ours,
            r#"{"type":"user","message":{"role":"user","content":"my real task"}}
"#,
        )
        .unwrap();
        sleep(Duration::from_millis(50));

        // Newer jsonl from a different session in the same worktree.
        // This is the file the directory-newest heuristic would pick.
        let other = dir.join("bbbb-2222.jsonl");
        fs::write(
            &other,
            r#"{"type":"user","message":{"role":"user","content":"someone else's task"}}
"#,
        )
        .unwrap();

        let prompts = read_session_user_prompts_for_id(
            AgentKind::ClaudeCode,
            Path::new(cwd),
            home.path(),
            "aaaa-1111",
            None,
        );
        assert_eq!(prompts, vec!["my real task"]);
    }

    #[test]
    fn claude_id_lookup_returns_empty_when_file_missing() {
        // No fallback to newest-jsonl: if the captured id doesn't
        // resolve to a file we return empty rather than surface a
        // sibling session's prompts. Falling back was the original bug
        // — multiple panes sharing one worktree all saw the same
        // "newest" jsonl as their Task.
        let cwd = "/Users/foo/repo";
        let (home, jsonl) = fake_claude_home(cwd);
        fs::write(
            &jsonl,
            r#"{"type":"user","message":{"role":"user","content":"some other session's prompt"}}
"#,
        )
        .unwrap();

        let prompts = read_session_user_prompts_for_id(
            AgentKind::ClaudeCode,
            Path::new(cwd),
            home.path(),
            "missing-id",
            None,
        );
        assert!(
            prompts.is_empty(),
            "expected empty Vec, got {prompts:?} — fallback would surface another session's prompts",
        );
    }

    #[test]
    fn codex_id_lookup_picks_rollout_by_filename_suffix() {
        // Codex rollout filenames embed the session id as the trailing
        // segment before `.jsonl`. The id-targeted lookup walks the
        // YYYY/MM/DD tree until it hits the matching file.
        let cwd = "/Users/foo/repo";
        let home = tempdir().unwrap();
        let dir = home
            .path()
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("04")
            .join("29");
        fs::create_dir_all(&dir).unwrap();

        // Other rollout in the same date — must not be picked even if
        // it happens to live next to ours.
        let other = dir.join("rollout-2026-04-29T10-00-00-other-id.jsonl");
        fs::write(
            &other,
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"unrelated\"}}\n",
        )
        .unwrap();

        // Ours: id matches the suffix the lookup targets.
        let ours = dir.join("rollout-2026-04-29T11-00-00-target-id.jsonl");
        fs::write(
            &ours,
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"target task\"}}\n",
        )
        .unwrap();

        let prompts = read_session_user_prompts_for_id(
            AgentKind::Codex,
            Path::new(cwd),
            home.path(),
            "target-id",
            None,
        );
        assert_eq!(prompts, vec!["target task"]);
    }
}
