//! Cross-harness review feature support: brief rendering and best-effort
//! transcript path discovery.
//!
//! When the user drops one harness pane onto another, raum spawns a fresh
//! reviewer harness in the reviewed harness's worktree and seeds it with a
//! short "review brief". The brief deliberately does not prime the reviewer:
//! it hands over a pointer to the reviewed harness's own session log on disk
//! plus the list of files that were touched, and lets the reviewer dig into
//! git (recent commits, open working tree) and form its own view.
//!
//! The brief is intentionally *small* (no full-conversation dump, no replay of
//! the original instructions) so it works across every harness CLI we support
//! — every supported CLI accepts a positional first prompt argument.

pub mod brief;
pub mod inject;
pub mod transcript;

pub use brief::{BriefInputs, render_review_brief};
pub use inject::inject_opencode_brief;
pub use transcript::{
    discover_claude_session_id, discover_codex_session_id, discover_opencode_session_id_via_cli,
    discover_session_id_by_prompt, discover_transcript_path, harness_session_id_matches_cwd,
    read_session_user_prompts, read_session_user_prompts_for_id,
};
