//! Pure renderer for the cross-harness review brief.
//!
//! No I/O. The caller (the `start_review` Tauri command) gathers the inputs —
//! prompt log, `git diff --name-only`, branch/base, optional transcript path —
//! and hands them to [`render_review_brief`], which produces the single string
//! the new reviewer harness sees as its first prompt.

use std::fmt::Write as _;
use std::path::Path;

/// Cap on how many touched files we list verbatim before collapsing the rest
/// into a "+N more" footer. Reviewers can always run `git diff --stat` for
/// the full list.
pub const MAX_FILES_LISTED: usize = 100;

/// Inputs to [`render_review_brief`]. Borrows everything so the caller keeps
/// ownership; the renderer is pure and produces a fresh `String`.
#[derive(Debug, Clone)]
pub struct BriefInputs<'a> {
    /// Chronological user prompts that the reviewed harness received,
    /// straight from its own on-disk transcript. Empty is allowed — the
    /// brief omits the section.
    pub prompts: &'a [String],
    /// Files changed in the worktree relative to `base`. Already filtered
    /// down to the diff between `base` and HEAD by the caller.
    pub files_changed: &'a [String],
    /// The current branch the reviewed harness was working on.
    pub branch: &'a str,
    /// Base branch the worktree was forked from (typically `main`).
    pub base: &'a str,
    /// Number of commits ahead of `base`. Surfaced verbatim in the brief.
    pub commits_ahead: usize,
    /// Absolute path to the harness's own transcript file, if discovered.
    /// `None` is fine — the brief simply omits the pointer line.
    pub transcript_path: Option<&'a Path>,
    /// Display name of the harness being reviewed (e.g. "Claude Code"). Used
    /// only in the prose, not for behavior.
    pub reviewed_harness: &'a str,
}

/// Render the brief. The output is plain markdown so the reviewer can
/// re-render it nicely in any chat UI.
#[must_use]
pub fn render_review_brief(inputs: &BriefInputs<'_>) -> String {
    let mut out = String::with_capacity(2048);
    out.push_str("Please review the work of your colleague (a ");
    out.push_str(inputs.reviewed_harness);
    out.push_str(" session).\n\n");

    if inputs.prompts.is_empty() {
        out.push_str(
            "No user prompts could be read from that session's transcript on \
             disk — the harness may not write its conversation in a format \
             raum knows how to read yet, or the file was rotated away. \
             Inspect the diff directly and proceed.\n\n",
        );
    } else {
        out.push_str("These were the instructions it received, in order:\n\n");
        for (i, prompt) in inputs.prompts.iter().enumerate() {
            let _ = writeln!(out, "{}. {}", i + 1, indent_continuation(prompt));
        }
        out.push('\n');
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
            "No files have changed in the worktree yet. If the colleague \
             reported being done, double-check whether the changes were \
             actually written to disk.\n\n",
        );
    } else {
        let listed = inputs.files_changed.len().min(MAX_FILES_LISTED);
        out.push_str("Files changed:\n\n");
        for path in &inputs.files_changed[..listed] {
            let _ = writeln!(out, "- `{path}`");
        }
        if inputs.files_changed.len() > listed {
            let _ = writeln!(
                out,
                "- … and {} more (run `git diff --stat {}...HEAD` for the full list).",
                inputs.files_changed.len() - listed,
                inputs.base,
            );
        }
        out.push('\n');
    }

    if let Some(path) = inputs.transcript_path {
        let _ = writeln!(
            out,
            "Full implementation conversation (read it if you want more context): \
             `{}`\n",
            path.display(),
        );
    }

    let _ = writeln!(
        out,
        "Was the task implemented successfully? Are there any blind spots? \
         Read the diff with `git diff {}...HEAD`, dig through the touched \
         code, and form your own view before reporting. Come back with \
         concrete improvements or gaps — or, if it's good, just approve.",
        inputs.base,
    );

    out
}

/// Multi-line prompts get continuation lines indented so the numbered list
/// stays readable in markdown.
fn indent_continuation(text: &str) -> String {
    let trimmed = text.trim();
    if !trimmed.contains('\n') {
        return trimmed.to_string();
    }
    let mut lines = trimmed.lines();
    let first = lines.next().unwrap_or("").to_string();
    let rest: Vec<String> = lines.map(|l| format!("   {l}")).collect();
    if rest.is_empty() {
        first
    } else {
        format!("{first}\n{}", rest.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn s(text: &str) -> String {
        text.to_string()
    }

    #[test]
    fn renders_full_brief_with_all_sections() {
        let prompts = vec![
            s("add a function `foo` that returns 42"),
            s("now make it async"),
            s("write a test for it"),
        ];
        let files = vec!["src/foo.rs".to_string(), "src/lib.rs".to_string()];
        let xpath = PathBuf::from("/Users/andre/.claude/projects/-x/abc.jsonl");
        let inputs = BriefInputs {
            prompts: &prompts,
            files_changed: &files,
            branch: "feat/foo",
            base: "main",
            commits_ahead: 2,
            transcript_path: Some(&xpath),
            reviewed_harness: "Claude Code",
        };
        let out = render_review_brief(&inputs);
        assert!(out.contains("Claude Code"));
        assert!(out.contains("1. add a function"));
        assert!(out.contains("3. write a test"));
        assert!(out.contains("`feat/foo`"));
        assert!(out.contains("(base: `main`, 2 commits ahead)"));
        assert!(out.contains("`src/foo.rs`"));
        assert!(out.contains("/Users/andre/.claude/projects/-x/abc.jsonl"));
        assert!(out.contains("git diff main...HEAD"));
    }

    #[test]
    fn singular_commit_grammar() {
        let inputs = BriefInputs {
            prompts: &[],
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
    fn empty_prompts_section_still_actionable() {
        let inputs = BriefInputs {
            prompts: &[],
            files_changed: &["a.rs".to_string()],
            branch: "x",
            base: "main",
            commits_ahead: 1,
            transcript_path: None,
            reviewed_harness: "Codex",
        };
        let out = render_review_brief(&inputs);
        assert!(out.contains("No user prompts could be read"));
        assert!(out.contains("`a.rs`"));
        assert!(!out.contains("instructions it received"));
    }

    #[test]
    fn empty_files_section_warns() {
        let prompts = vec![s("do something")];
        let inputs = BriefInputs {
            prompts: &prompts,
            files_changed: &[],
            branch: "x",
            base: "main",
            commits_ahead: 0,
            transcript_path: None,
            reviewed_harness: "Codex",
        };
        let out = render_review_brief(&inputs);
        assert!(out.contains("No files have changed"));
        assert!(out.contains("0 commits ahead"));
    }

    #[test]
    fn missing_transcript_omits_pointer_line() {
        let prompts = vec![s("hi")];
        let inputs = BriefInputs {
            prompts: &prompts,
            files_changed: &["a".into()],
            branch: "b",
            base: "main",
            commits_ahead: 1,
            transcript_path: None,
            reviewed_harness: "OpenCode",
        };
        let out = render_review_brief(&inputs);
        assert!(!out.contains("Full implementation conversation"));
    }

    #[test]
    fn long_file_list_collapses_to_more_footer() {
        let files: Vec<String> = (0..MAX_FILES_LISTED + 7)
            .map(|i| format!("src/file_{i:03}.rs"))
            .collect();
        let inputs = BriefInputs {
            prompts: &[],
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
    }

    #[test]
    fn multi_line_prompt_indents_continuation() {
        let prompts = vec![s("first line\nsecond line\nthird line")];
        let inputs = BriefInputs {
            prompts: &prompts,
            files_changed: &[],
            branch: "x",
            base: "main",
            commits_ahead: 0,
            transcript_path: None,
            reviewed_harness: "Codex",
        };
        let out = render_review_brief(&inputs);
        assert!(out.contains("1. first line\n   second line\n   third line\n"));
    }
}
