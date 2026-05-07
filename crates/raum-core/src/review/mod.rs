//! Cross-harness review feature support: brief rendering and best-effort
//! transcript path discovery.
//!
//! When the user drops one harness pane onto another, raum spawns a fresh
//! reviewer harness in the reviewed harness's worktree and seeds it with a
//! short "review brief" — a list of the prompts the reviewed harness
//! received, the files it touched, and a pointer to its own transcript file
//! on disk for self-exploration.
//!
//! The brief is intentionally *small* (no full-conversation dump) so it works
//! across every harness CLI we support — every supported CLI accepts a
//! positional first prompt argument.

pub mod brief;
pub mod inject;
pub mod transcript;

pub use brief::{BriefInputs, render_review_brief};
pub use inject::inject_opencode_brief;
pub use transcript::{
    discover_claude_session_id, discover_codex_session_id, discover_session_id_by_prompt,
    discover_transcript_path, harness_session_id_matches_cwd, read_session_user_prompts,
    read_session_user_prompts_for_id,
};
