//! Pull-request search for the spotlight dock.
//!
//! One `gh pr list --search` per query, scoped to the active project's repo.
//! A query that is just a number (`123` or `#123`) is tried as a direct PR
//! lookup first, because that is what people type when they already know which
//! PR they want; anything else — and a number that matches no PR — falls
//! through to the search.
//!
//! Each result carries the worktree path that has its head branch checked out,
//! when there is one, so activating a row can focus that worktree instead of
//! opening a browser.

use std::collections::HashMap;
use std::path::PathBuf;

use tracing::warn;

use super::gh;
use super::types::{PullRequestSummary, RawPr};
use crate::state::AppHandleState;

/// The fields a search row renders.
pub(super) const PR_LIST_FIELDS: &str =
    "number,title,url,headRefName,author,isDraft,reviewDecision,statusCheckRollup,updatedAt";

/// Search the active project's open pull requests. Returns an empty list — not
/// an error — when the project has no GitHub remote raum may query.
#[tauri::command]
pub async fn github_pr_search(
    state: tauri::State<'_, AppHandleState>,
    project_slug: String,
    query: String,
    limit: u32,
) -> Result<Vec<PullRequestSummary>, String> {
    let root = project_root(&state, &project_slug)?;
    let root_str = root.to_string_lossy().into_owned();
    if gh::resolve(&root_str).await.is_none() {
        return Ok(Vec::new());
    }

    let query = query.trim().to_string();
    let limit = limit.clamp(1, 100).to_string();

    // `#123` / `123` — ask for that PR directly.
    if let Some(number) = pr_number(&query) {
        match gh::json::<RawPr>(&root, &["pr", "view", &number, "--json", PR_LIST_FIELDS]).await {
            Ok(Some(raw)) => return Ok(finish(vec![raw], &root)),
            Ok(None) => {}
            Err(e) => warn!(query = %query, error = %e, "github_pr_search: pr view failed"),
        }
    }

    let raw: Vec<RawPr> = gh::json(
        &root,
        &[
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            &limit,
            "--search",
            &query,
            "--json",
            PR_LIST_FIELDS,
        ],
    )
    .await?
    .unwrap_or_default();
    Ok(finish(raw, &root))
}

/// `123` or `#123` → the bare number; anything else → `None`.
pub(super) fn pr_number(query: &str) -> Option<String> {
    let digits = query.trim().strip_prefix('#').unwrap_or(query.trim());
    (!digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())).then(|| digits.to_string())
}

/// Attach the local worktree path for every result whose head branch is
/// checked out somewhere in this project.
pub(super) fn finish(raw: Vec<RawPr>, root: &std::path::Path) -> Vec<PullRequestSummary> {
    let by_branch = branch_paths(root);
    raw.into_iter()
        .map(|pr| {
            let path = by_branch.get(&pr.head_ref_name).cloned();
            pr.into_summary(path)
        })
        .collect()
}

fn branch_paths(root: &std::path::Path) -> HashMap<String, String> {
    raum_hydration::worktree_list(root)
        .map(|entries| {
            entries
                .into_iter()
                .filter_map(|e| Some((e.branch?, e.path.to_string_lossy().into_owned())))
                .collect()
        })
        .unwrap_or_default()
}

/// Root path of `slug`. The config-store guard is dropped before any await —
/// it is a std mutex and must not cross one.
fn project_root(state: &AppHandleState, slug: &str) -> Result<PathBuf, String> {
    let store = state.config_store.lock().map_err(|e| e.to_string())?;
    store
        .read_project(slug)
        .map_err(|e| format!("read_project: {e}"))?
        .map(|p| p.root_path)
        .ok_or_else(|| format!("project not found: {slug}"))
}
