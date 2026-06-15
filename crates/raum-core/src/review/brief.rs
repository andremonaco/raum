//! Pure renderer for the cross-harness review brief.
//!
//! No I/O. The caller (the `prepare_review` Tauri command) gathers the inputs
//! — the changed-file list, branch/base, and a pointer to the reviewed
//! harness's own session log on disk — and hands them to
//! [`render_review_brief`], which produces the single string the new reviewer
//! harness sees as its first prompt.
//!
//! The brief deliberately does **not** prime the reviewer: it never replays
//! the instructions the colleague received or asks leading questions. It hands
//! over two things — the session log to read and the files that were touched —
//! and lets the reviewer dig into git and form its own view.

use std::fmt::Write as _;
use std::path::Path;

/// Cap on how many touched files we list verbatim before collapsing the rest
/// into a "+N more" footer. Reviewers can always run `git status` /
/// `git log --stat` for the full list.
pub const MAX_FILES_LISTED: usize = 100;

/// Inputs to [`render_review_brief`]. Borrows everything so the caller keeps
/// ownership; the renderer is pure and produces a fresh `String`.
#[derive(Debug, Clone)]
pub struct BriefInputs<'a> {
    /// Every file the reviewed colleague touched — committed since `base`
    /// and/or dirty in the working tree — already merged and deduped by the
    /// caller. This list plus the session log is the whole signal; the
    /// reviewer derives the actual changes from git itself. Empty is allowed
    /// and triggers a "nothing detected" warning.
    pub files_changed: &'a [String],
    /// The current branch the reviewed harness was working on.
    pub branch: &'a str,
    /// Base branch the worktree was forked from (typically `main`).
    pub base: &'a str,
    /// Number of commits ahead of `base`. Surfaced verbatim in the brief.
    pub commits_ahead: usize,
    /// Absolute path to the harness's own session log on disk, if one exists
    /// (Claude Code / Codex). `None` for harnesses with no on-disk transcript
    /// (OpenCode) — the brief then leans on the file list and git.
    pub transcript_path: Option<&'a Path>,
    /// Display name of the harness being reviewed (e.g. "Claude Code"). Used
    /// only in the prose, not for behavior.
    pub reviewed_harness: &'a str,
}

/// Render the brief. The output is plain markdown so the reviewer can
/// re-render it nicely in any chat UI.
#[must_use]
pub fn render_review_brief(inputs: &BriefInputs<'_>) -> String {
    let mut out = String::with_capacity(1024);
    let _ = writeln!(
        out,
        "Please review the work your colleague (a {} session) just did.\n",
        inputs.reviewed_harness,
    );

    // Point at the session log — don't summarize it or replay the prompts.
    // The reviewer reads it to learn what the colleague was asked to do and
    // how they got there, then forms its own view.
    if let Some(path) = inputs.transcript_path {
        let _ = writeln!(
            out,
            "Their full session log is on disk — read it to see what they were \
             asked to do and how they got there:\n\n`{}`\n",
            path.display(),
        );
    } else {
        out.push_str(
            "No on-disk session log is available for this harness, so work \
             from the changed files and git state below.\n\n",
        );
    }

    let _ = writeln!(
        out,
        "Branch: `{}` (base: `{}`, {} {} ahead).\n",
        inputs.branch,
        inputs.base,
        inputs.commits_ahead,
        if inputs.commits_ahead == 1 {
            "commit"
        } else {
            "commits"
        },
    );

    if inputs.files_changed.is_empty() {
        out.push_str(
            "No changed files were detected — committed or in the working \
             tree. Before concluding there's nothing to review, double-check \
             with `git status` and `git log`: the base branch may be wrong, or \
             your colleague may be working in a different worktree than \
             expected.\n\n",
        );
    } else {
        let listed = inputs.files_changed.len().min(MAX_FILES_LISTED);
        out.push_str("Files your colleague changed:\n\n");
        for path in &inputs.files_changed[..listed] {
            let _ = writeln!(out, "- `{path}`");
        }
        if inputs.files_changed.len() > listed {
            let _ = writeln!(
                out,
                "- … and {} more (run `git status` and `git log --stat` for the full list).",
                inputs.files_changed.len() - listed,
            );
        }
        out.push('\n');
    }

    out.push_str(
        "To see what actually changed, inspect those files and the diffs \
         behind them: check the recent commits that touched them \
         (`git log -p -- <file>`) and the open working tree (`git status`, \
         `git diff HEAD`). Form your own view of whether the work is sound, \
         then report back.",
    );

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn s(text: &str) -> String {
        text.to_string()
    }

    #[test]
    fn renders_full_brief_without_priming() {
        let files = vec!["src/foo.rs".to_string(), "src/lib.rs".to_string()];
        let xpath = PathBuf::from("/Users/andre/.claude/projects/-x/abc.jsonl");
        let inputs = BriefInputs {
            files_changed: &files,
            branch: "feat/foo",
            base: "main",
            commits_ahead: 2,
            transcript_path: Some(&xpath),
            reviewed_harness: "Claude Code",
        };
        let out = render_review_brief(&inputs);
        assert!(out.contains("Claude Code"));
        assert!(out.contains("`feat/foo`"));
        assert!(out.contains("(base: `main`, 2 commits ahead)"));
        assert!(out.contains("Files your colleague changed"));
        assert!(out.contains("`src/foo.rs`"));
        assert!(out.contains("/Users/andre/.claude/projects/-x/abc.jsonl"));
        assert!(out.contains("git log -p"));
        assert!(out.contains("git diff HEAD"));
        // Must not prime the reviewer with the original instructions or
        // leading questions.
        assert!(!out.contains("instructions it received"));
        assert!(!out.contains("implemented successfully"));
        assert!(!out.contains("blind spots"));
    }

    #[test]
    fn singular_commit_grammar() {
        let inputs = BriefInputs {
            files_changed: &[],
            branch: "x",
            base: "main",
            commits_ahead: 1,
            transcript_path: None,
            reviewed_harness: "Codex",
        };
        let out = render_review_brief(&inputs);
        assert!(
            out.contains("1 commit ahead"),
            "expected singular commit, got: {out}",
        );
    }

    #[test]
    fn lists_changed_files() {
        let files = vec!["src/done.rs".to_string(), "src/wip.rs".to_string()];
        let inputs = BriefInputs {
            files_changed: &files,
            branch: "feat/mix",
            base: "main",
            commits_ahead: 1,
            transcript_path: None,
            reviewed_harness: "Codex",
        };
        let out = render_review_brief(&inputs);
        assert!(out.contains("Files your colleague changed"));
        assert!(out.contains("`src/done.rs`"));
        assert!(out.contains("`src/wip.rs`"));
        assert!(!out.contains("No changed files were detected"));
    }

    #[test]
    fn empty_files_section_warns() {
        let inputs = BriefInputs {
            files_changed: &[],
            branch: "x",
            base: "main",
            commits_ahead: 0,
            transcript_path: None,
            reviewed_harness: "Codex",
        };
        let out = render_review_brief(&inputs);
        assert!(out.contains("No changed files were detected"));
        assert!(out.contains("0 commits ahead"));
    }

    #[test]
    fn present_transcript_points_at_the_log() {
        let files = vec![s("a.rs")];
        let xpath = PathBuf::from("/home/u/.codex/sessions/2026/06/14/rollout-abc.jsonl");
        let inputs = BriefInputs {
            files_changed: &files,
            branch: "b",
            base: "main",
            commits_ahead: 1,
            transcript_path: Some(&xpath),
            reviewed_harness: "Codex",
        };
        let out = render_review_brief(&inputs);
        assert!(out.contains("session log is on disk"));
        assert!(out.contains("rollout-abc.jsonl"));
        assert!(!out.contains("No on-disk session log"));
    }

    #[test]
    fn missing_transcript_renders_fallback_note() {
        let files = vec![s("a.rs")];
        let inputs = BriefInputs {
            files_changed: &files,
            branch: "b",
            base: "main",
            commits_ahead: 1,
            transcript_path: None,
            reviewed_harness: "OpenCode",
        };
        let out = render_review_brief(&inputs);
        assert!(out.contains("No on-disk session log is available"));
        assert!(!out.contains("session log is on disk"));
        // The file list is still the fallback signal.
        assert!(out.contains("`a.rs`"));
    }

    #[test]
    fn long_file_list_collapses_to_more_footer() {
        let files: Vec<String> = (0..MAX_FILES_LISTED + 7)
            .map(|i| format!("src/file_{i:03}.rs"))
            .collect();
        let inputs = BriefInputs {
            files_changed: &files,
            branch: "b",
            base: "main",
            commits_ahead: 1,
            transcript_path: None,
            reviewed_harness: "Codex",
        };
        let out = render_review_brief(&inputs);
        assert!(out.contains(&format!("`src/file_{:03}.rs`", MAX_FILES_LISTED - 1)));
        assert!(!out.contains(&format!("`src/file_{MAX_FILES_LISTED:03}.rs`")));
        assert!(out.contains("and 7 more"));
        assert!(out.contains("git log --stat"));
    }
}
