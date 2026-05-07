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

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::agent::AgentKind;

mod claude;
mod codex;
mod opencode;

#[cfg(test)]
mod tests;

// `clean_claude_user_text` is consumed outside of `review/` (see
// `agent_state.rs`), so the existing path
// `crate::review::transcript::clean_claude_user_text` must keep
// resolving after the split.
pub(crate) use claude::clean_claude_user_text;

/// Hard cap on how long any per-harness lookup may take. The snap overlay
/// blocks on this — anything longer than ~500 ms feels broken.
pub(super) const TRANSCRIPT_HTTP_TIMEOUT: Duration = Duration::from_millis(500);

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
            let Some(path) = claude::discover_claude_code_transcript(cwd, home_dir) else {
                return Vec::new();
            };
            let mut prompts = claude::parse_claude_user_prompts(&path);
            cap_in_place(&mut prompts);
            prompts
        }
        AgentKind::Codex => {
            let Some(path) = codex::discover_codex_transcript(cwd, home_dir) else {
                return Vec::new();
            };
            let mut prompts = codex::parse_codex_user_prompts(&path);
            cap_in_place(&mut prompts);
            prompts
        }
        AgentKind::OpenCode => {
            let Some(port) = opencode_port else {
                return Vec::new();
            };
            let mut prompts =
                opencode::read_opencode_user_prompts("http://127.0.0.1", port, cwd).await;
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
        AgentKind::ClaudeCode => claude::discover_claude_code_transcript(cwd, home_dir),
        AgentKind::Codex => codex::discover_codex_transcript(cwd, home_dir),
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
    let path = codex::discover_codex_transcript(cwd, home_dir)?;
    codex::codex_session_id_from_rollout(&path)
        .or_else(|| codex::codex_session_id_from_filename(&path))
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
}

/// Resolve the Claude Code session id for the newest transcript launched in
/// `cwd`. Claude stores each session as `<session-id>.jsonl`, so the filename
/// stem is the value accepted by `claude --resume <id>`.
#[must_use]
pub fn discover_claude_session_id(cwd: &Path, home_dir: &Path) -> Option<String> {
    let path = claude::discover_claude_code_transcript(cwd, home_dir)?;
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
        AgentKind::ClaudeCode => {
            claude::discover_claude_session_id_by_prompt(cwd, home_dir, target)
        }
        AgentKind::Codex => codex::discover_codex_session_id_by_prompt(cwd, home_dir, target),
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
                    .is_some_and(|cwd| codex::codex_rollout_matches_cwd(&path, cwd))
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
        AgentKind::ClaudeCode => claude::parse_claude_user_prompts(&path),
        AgentKind::Codex => codex::parse_codex_user_prompts(&path),
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
    let encoded = claude::encode_cwd_for_claude(cwd)?;
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

pub(super) fn transcript_contains_prompt(prompts: Vec<String>, target: &str) -> bool {
    let target = target.trim();
    if target.is_empty() {
        return false;
    }
    prompts.into_iter().any(|prompt| {
        let prompt = prompt.trim();
        prompt == target || prompt.contains(target) || target.contains(prompt)
    })
}
