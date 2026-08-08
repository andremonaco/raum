//! Shared helpers used across the agent command surface and by sibling
//! command modules (`harness.rs`, `review.rs`, `terminal.rs`,
//! `agent_hydrate.rs`).

use std::path::PathBuf;

use tracing::warn;

use crate::state::AppHandleState;

pub fn cleanup_harness_session(state: &AppHandleState, session_id: &str) {
    state.harness_runtimes.end_session(session_id);
    state.session_activity.remove(session_id);
    if let Ok(store) = state.config_store.lock()
        && let Err(e) = store.forget_session(session_id)
    {
        warn!(error=%e, session_id=%session_id, "forget tracked session failed");
    }
    if let Ok(mut reg) = state.agents.lock() {
        reg.remove_machine(session_id);
    }
}

/// Resolve the absolute project/worktree directory for a spawn.
///
/// Reads the project record via [`raum_core::store::ConfigStore`]. When the
/// caller supplies a `worktree_id` that resolves to an existing directory it
/// wins over the project root — this is what lets the sidebar's selected
/// worktree drive the cwd of hotkey-spawned harnesses. Returns an empty
/// `PathBuf` when the project is not registered or the store is unreachable
/// — the adapter's `plan()` treats an empty `project_dir` as "legacy
/// user-global path", which is the right fallback for first-run / shell-only
/// paths where there's nothing per-project to scope to yet.
pub fn resolve_project_dir(
    state: &AppHandleState,
    project_slug: Option<&str>,
    worktree_id: Option<&str>,
) -> PathBuf {
    let Some(slug) = project_slug else {
        return PathBuf::new();
    };
    let Ok(store) = state.config_store.lock() else {
        return PathBuf::new();
    };
    let project = match store.read_project(slug) {
        Ok(Some(project)) => project,
        _ => return PathBuf::new(),
    };
    if let Some(id) = worktree_id {
        let candidate = PathBuf::from(id);
        if candidate.is_dir() {
            return candidate;
        }
    }
    project.root_path
}
