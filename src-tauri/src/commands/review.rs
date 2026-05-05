//! Cross-harness review feature commands.
//!
//! The frontend orchestrates the actual pane swap (kill the source pane,
//! re-spawn a new harness in its grid cell). The backend's job is split in
//! two thin commands:
//!
//! 1. [`prepare_review`] — gathers the inputs (prompt log, git diff, branch,
//!    transcript path), renders the brief, and returns the spawn payload
//!    the frontend should hand back to the existing `terminal_spawn`.
//! 2. [`record_review_link`] — once the new reviewer session is live, the
//!    frontend calls this to register the link and fire the
//!    `review:linked` Tauri event.
//!
//! Splitting it this way avoids reinventing the spawn pipeline (PTY bridge
//! attach, harness-runtime registration, monitor-task setup) on the backend
//! side; we reuse the existing flow.
//!
//! [`clear_review_link`] is called when one of the linked panes closes so the
//! frontend can drop the linked-state badge.

use std::path::{Path, PathBuf};
use std::process::Command;

use raum_core::AgentKind;
use raum_core::review::{
    BriefInputs, discover_transcript_path, read_session_user_prompts,
    read_session_user_prompts_for_id, render_review_brief,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};
use tracing::{debug, warn};

use crate::commands::agent::resolve_project_dir;
use crate::state::AppHandleState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSpawnPayload {
    /// Initial prompt to feed the new reviewer harness on launch. The
    /// frontend forwards this verbatim into `terminal_spawn`'s
    /// `initial_prompt` field.
    pub initial_prompt: String,
    /// Harness kind to spawn for the reviewer pane (= the original
    /// reviewer pane's kind).
    pub reviewer_kind: AgentKind,
    /// Project + worktree the reviewer should run in. **Same as the
    /// reviewed pane's worktree** — the whole point of the feature is
    /// that the reviewer sees the same code.
    pub project_slug: String,
    pub worktree_id: Option<String>,
    /// Echoed back so the frontend can pair the response with the
    /// session it should associate as "reviewed".
    pub reviewed_session_id: String,
    /// Reviewer's existing session id, returned for symmetry with
    /// `reviewed_session_id`. The frontend kills this session before
    /// spawning the new one.
    pub reviewer_session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareReviewArgs {
    /// The pane being dragged onto another pane. Becomes the new reviewer.
    pub reviewer_session_id: String,
    /// The pane being dropped on. Its work will be reviewed.
    pub reviewed_session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordReviewLinkArgs {
    /// Session id of the freshly spawned reviewer harness (post-spawn,
    /// not the dragged-source's old id).
    pub reviewer_session_id: String,
    /// Session id of the harness being reviewed.
    pub reviewed_session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearReviewLinkArgs {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFirstPromptArgs {
    pub session_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReviewLinkedPayload {
    reviewer_session_id: String,
    reviewed_session_id: String,
}

/// Gather inputs and render the review brief. Returns a spawn payload the
/// frontend hands to its existing `terminal_spawn` call.
///
/// Errors are returned as plain strings so the frontend can render them as
/// toasts without typed error juggling.
#[tauri::command]
pub async fn prepare_review<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AppHandleState>,
    args: PrepareReviewArgs,
) -> Result<ReviewSpawnPayload, String> {
    if args.reviewer_session_id == args.reviewed_session_id {
        return Err("Cannot review a pane against itself.".to_string());
    }

    // Snapshot identity + per-pane metadata under the registry lock, then
    // drop it before doing I/O. We never await while holding the lock.
    let (
        reviewer_kind,
        reviewed_kind,
        reviewed_project_slug,
        reviewed_worktree_id,
        reviewed_opencode_port,
    ) = {
        let reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        let reviewer = reg
            .item(&args.reviewer_session_id)
            .ok_or_else(|| "Reviewer pane no longer exists.".to_string())?;
        let reviewed = reg
            .item(&args.reviewed_session_id)
            .ok_or_else(|| "Reviewed pane no longer exists.".to_string())?;
        // OpenCode lives behind a local HTTP API; we pinned the port at
        // launch and stored it on the tracked session row. The transcript
        // reader needs it to query the server's session endpoints.
        let opencode_port = read_opencode_port_for_session(&state, &args.reviewed_session_id);
        (
            reviewer.kind,
            reviewed.kind,
            reviewed.project_slug.clone(),
            reviewed.worktree_id.clone(),
            opencode_port,
        )
    };

    if reviewer_kind == AgentKind::Shell {
        return Err("A plain shell can't review another harness.".to_string());
    }
    if reviewed_kind == AgentKind::Shell {
        return Err(
            "A plain shell pane has no recorded prompts to review. Drop on a harness pane instead."
                .to_string(),
        );
    }
    let Some(project_slug) = reviewed_project_slug else {
        return Err("Reviewed pane has no associated project.".to_string());
    };

    // Resolve the worktree directory. This is where the reviewer will
    // also run, so it has access to the same code and git state.
    let cwd = resolve_project_dir(&state, Some(&project_slug), reviewed_worktree_id.as_deref());
    if cwd.as_os_str().is_empty() || !cwd.is_dir() {
        return Err("Reviewed pane's worktree directory is unavailable.".to_string());
    }

    // Read prompts directly from the harness's own on-disk transcript
    // (Claude Code / Codex) or local HTTP API (OpenCode). raum no longer
    // maintains its own prompt log — the harness's storage is the single
    // source of truth (`raum_core::review::transcript`).
    let home_dir = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let prompts =
        read_session_user_prompts(reviewed_kind, &cwd, &home_dir, reviewed_opencode_port).await;

    // Git probes (cheap; bounded by the worktree's own git tree size).
    let branch = detect_branch(&cwd).unwrap_or_else(|| "HEAD".to_string());
    let base = detect_base_branch(&cwd).unwrap_or_else(|| "main".to_string());
    let files_changed = git_changed_files(&cwd, &base);
    let commits_ahead = git_commits_ahead(&cwd, &base);

    let transcript_path = discover_transcript_path(reviewed_kind, &cwd, &home_dir);
    let reviewed_harness_label = harness_display_name(reviewed_kind);

    let initial_prompt = render_review_brief(&BriefInputs {
        prompts: &prompts,
        files_changed: &files_changed,
        branch: &branch,
        base: &base,
        commits_ahead,
        transcript_path: transcript_path.as_deref(),
        reviewed_harness: reviewed_harness_label,
    });
    debug!(
        reviewer_session_id = %args.reviewer_session_id,
        reviewed_session_id = %args.reviewed_session_id,
        prompts = prompts.len(),
        files = files_changed.len(),
        brief_bytes = initial_prompt.len(),
        "prepared review brief",
    );

    Ok(ReviewSpawnPayload {
        initial_prompt,
        reviewer_kind,
        project_slug,
        worktree_id: reviewed_worktree_id,
        reviewed_session_id: args.reviewed_session_id,
        reviewer_session_id: args.reviewer_session_id,
    })
}

/// Record a fresh review link. Called by the frontend right after it has
/// successfully spawned the new reviewer pane. Emits `review:linked` so any
/// other UI surface that cares about linked state updates immediately.
#[tauri::command]
pub fn record_review_link<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppHandleState>,
    args: RecordReviewLinkArgs,
) -> Result<(), String> {
    {
        let mut links = state
            .review_links
            .lock()
            .map_err(|e| format!("review_links lock: {e}"))?;
        links.insert(
            args.reviewer_session_id.clone(),
            args.reviewed_session_id.clone(),
        );
    }
    let payload = ReviewLinkedPayload {
        reviewer_session_id: args.reviewer_session_id,
        reviewed_session_id: args.reviewed_session_id,
    };
    if let Err(e) = app.emit("review:linked", &payload) {
        warn!(error = %e, "review:linked emit failed");
    }
    Ok(())
}

/// Drop any review links touching `session_id` (whether as reviewer or as
/// reviewed). Called by the frontend on session-closed events so the badges
/// disappear when one side of the pair goes away.
#[tauri::command]
pub fn clear_review_link<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppHandleState>,
    args: ClearReviewLinkArgs,
) -> Result<(), String> {
    let removed: Vec<(String, String)> = {
        let mut links = state
            .review_links
            .lock()
            .map_err(|e| format!("review_links lock: {e}"))?;
        let mut victims: Vec<(String, String)> = Vec::new();
        // Drop the entry where this session is the reviewer.
        if let Some(reviewed) = links.remove(&args.session_id) {
            victims.push((args.session_id.clone(), reviewed));
        }
        // And any entry where it's the reviewed side.
        let other_keys: Vec<String> = links
            .iter()
            .filter_map(|(k, v)| {
                if v == &args.session_id {
                    Some(k.clone())
                } else {
                    None
                }
            })
            .collect();
        for k in other_keys {
            if let Some(reviewed) = links.remove(&k) {
                victims.push((k, reviewed));
            }
        }
        victims
    };
    for (reviewer, reviewed) in removed {
        let payload = ReviewLinkedPayload {
            reviewer_session_id: reviewer,
            reviewed_session_id: reviewed,
        };
        if let Err(e) = app.emit("review:unlinked", &payload) {
            warn!(error = %e, "review:unlinked emit failed");
        }
    }
    Ok(())
}

/// Return the *first* user prompt of the harness session running in the
/// given pane, or `None` if it can't be read. Used by the prompt-overlay
/// banner (Task + Latest) and the cross-harness review snap overlay to
/// show the original task the session was asked to perform — not whatever
/// the user typed most recently.
///
/// Resolution order:
///
///   1. **Targeted lookup by harness session id** (Claude Code, Codex).
///      When raum has captured the harness's own UUID from a hook payload
///      (`update_session_harness_id`), we open exactly that transcript file
///      — deterministic across multi-pane worktrees.
///   2. **cwd-newest fallback**. When no harness id is captured (legacy
///      sessions from before that field shipped) or the by-id reader has no
///      branch for this kind (OpenCode — there's no on-disk file keyed by
///      session id; it lives behind the local HTTP API), fall through to
///      [`read_session_user_prompts`], which picks the newest jsonl in the
///      worktree (Claude / Codex) or queries the local HTTP server
///      (OpenCode). Safe in practice because the frontend defers this fetch
///      until our own `UserPromptSubmit` hook has fired, which makes our
///      transcript the most-recently-modified file in the worktree.
#[tauri::command]
pub async fn session_first_prompt<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AppHandleState>,
    args: SessionFirstPromptArgs,
) -> Result<Option<String>, String> {
    // Resolve the session's harness kind, worktree, and (for OpenCode)
    // its pinned HTTP port under the registry lock, dropping the guard
    // before any await.
    let (kind, project_slug, worktree_id, opencode_port) = {
        let reg = state
            .terminals
            .lock()
            .map_err(|e| format!("terminals lock: {e}"))?;
        let Some(item) = reg.item(&args.session_id) else {
            return Ok(None);
        };
        let port = read_opencode_port_for_session(&state, &args.session_id);
        (
            item.kind,
            item.project_slug.clone(),
            item.worktree_id.clone(),
            port,
        )
    };
    let Some(slug) = project_slug else {
        return Ok(None);
    };
    let cwd = resolve_project_dir(&state, Some(&slug), worktree_id.as_deref());
    if cwd.as_os_str().is_empty() {
        return Ok(None);
    }
    let home_dir = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));

    // 1) Try the deterministic by-id reader when raum has captured the
    //    harness UUID. This is the only branch that's bullet-proof when
    //    several panes share a worktree.
    let harness_session_id = {
        let store = state
            .config_store
            .lock()
            .map_err(|e| format!("config_store lock: {e}"))?;
        store.last_session_harness_id(&args.session_id)
    };
    if let Some(id) = harness_session_id.as_deref() {
        let prompts = read_session_user_prompts_for_id(kind, &cwd, &home_dir, id, opencode_port);
        if let Some(first) = prompts.into_iter().next() {
            return Ok(Some(first));
        }
        // Fall through: by-id reader returned empty. Two cases hit this
        // path — OpenCode (which has no on-disk file keyed by session
        // id; the by-id reader is a stub there) and a captured id whose
        // transcript file the harness hasn't flushed yet.
    }

    // 2) cwd-newest fallback. Picks the newest jsonl in the worktree
    //    (Claude / Codex) or queries the local HTTP server (OpenCode).
    //    The frontend gates this fetch on `lastPrompt()` so by the time
    //    we land here our hook has fired and our transcript is the
    //    most-recently-modified — the multi-pane race the strict
    //    policy used to guard against is effectively closed.
    let prompts = read_session_user_prompts(kind, &cwd, &home_dir, opencode_port).await;
    Ok(prompts.into_iter().next())
}

// ---- helpers ---------------------------------------------------------------

/// Look up the pinned OpenCode HTTP port for a session id. Returns
/// `None` for non-OpenCode sessions or when the row hasn't been written
/// to `sessions.toml` yet (e.g. mid-spawn races). Best-effort — the
/// transcript reader handles `None` by returning empty.
fn read_opencode_port_for_session(
    state: &State<'_, AppHandleState>,
    session_id: &str,
) -> Option<u16> {
    let store = state.config_store.lock().ok()?;
    let sessions = store.read_sessions().ok()?;
    sessions
        .sessions
        .into_iter()
        .find(|s| s.session_id == session_id)
        .and_then(|s| s.opencode_port)
}

fn harness_display_name(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::ClaudeCode => "Claude Code",
        AgentKind::Codex => "Codex",
        AgentKind::OpenCode => "OpenCode",
        AgentKind::Shell => "shell",
    }
}

fn detect_branch(cwd: &Path) -> Option<String> {
    let out = Command::new("git")
        .current_dir(cwd)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// Best-effort base-branch detection. Tries `origin/HEAD`, falls back to
/// `main`, then `master`. None of these are guaranteed to exist; the brief
/// renderer still produces something useful with `commits_ahead = 0` and
/// an empty file list when this is wrong.
fn detect_base_branch(cwd: &Path) -> Option<String> {
    if let Ok(out) = Command::new("git")
        .current_dir(cwd)
        .args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .output()
        && out.status.success()
    {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if let Some(stripped) = s.strip_prefix("origin/") {
            return Some(stripped.to_string());
        }
        if !s.is_empty() {
            return Some(s);
        }
    }
    for candidate in ["main", "master"] {
        if Command::new("git")
            .current_dir(cwd)
            .args(["rev-parse", "--verify", candidate])
            .output()
            .is_ok_and(|o| o.status.success())
        {
            return Some(candidate.to_string());
        }
    }
    None
}

fn git_changed_files(cwd: &Path, base: &str) -> Vec<String> {
    let triple_dot = format!("{base}...HEAD");
    let out = match Command::new("git")
        .current_dir(cwd)
        .args(["diff", "--name-only", &triple_dot])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

fn git_commits_ahead(cwd: &Path, base: &str) -> usize {
    let range = format!("{base}..HEAD");
    let Ok(out) = Command::new("git")
        .current_dir(cwd)
        .args(["rev-list", "--count", &range])
        .output()
    else {
        return 0;
    };
    if !out.status.success() {
        return 0;
    }
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<usize>()
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command as StdCommand;
    use tempfile::tempdir;

    fn init_repo(dir: &Path) {
        let run = |args: &[&str]| {
            let s = StdCommand::new("git")
                .current_dir(dir)
                .args(args)
                .output()
                .expect("git");
            assert!(
                s.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&s.stderr)
            );
        };
        run(&["init", "--initial-branch=main"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        fs::write(dir.join("README.md"), "hi").unwrap();
        run(&["add", "."]);
        run(&["commit", "-m", "initial"]);
    }

    #[test]
    fn detect_branch_returns_main_on_fresh_repo() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        assert_eq!(detect_branch(dir.path()).as_deref(), Some("main"));
    }

    #[test]
    fn detect_base_branch_falls_back_to_main_without_remote() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        // No origin remote; fallback path should pick `main`.
        assert_eq!(detect_base_branch(dir.path()).as_deref(), Some("main"));
    }

    #[test]
    fn git_changed_files_lists_diff_against_base() {
        let dir = tempdir().unwrap();
        init_repo(dir.path());
        let run = |args: &[&str]| {
            StdCommand::new("git")
                .current_dir(dir.path())
                .args(args)
                .output()
                .expect("git");
        };
        run(&["checkout", "-b", "feat/x"]);
        fs::write(dir.path().join("new.rs"), "fn main() {}").unwrap();
        run(&["add", "new.rs"]);
        run(&["commit", "-m", "add new"]);
        let files = git_changed_files(dir.path(), "main");
        assert_eq!(files, vec!["new.rs".to_string()]);
        assert_eq!(git_commits_ahead(dir.path(), "main"), 1);
    }

    #[test]
    fn git_helpers_are_safe_outside_a_repo() {
        let dir = tempdir().unwrap();
        // No git init — every helper should degrade gracefully.
        assert!(detect_branch(dir.path()).is_none());
        assert!(detect_base_branch(dir.path()).is_none());
        assert!(git_changed_files(dir.path(), "main").is_empty());
        assert_eq!(git_commits_ahead(dir.path(), "main"), 0);
    }

    #[test]
    fn harness_display_names_cover_all_kinds() {
        assert_eq!(harness_display_name(AgentKind::ClaudeCode), "Claude Code");
        assert_eq!(harness_display_name(AgentKind::Codex), "Codex");
        assert_eq!(harness_display_name(AgentKind::OpenCode), "OpenCode");
        assert_eq!(harness_display_name(AgentKind::Shell), "shell");
    }
}
