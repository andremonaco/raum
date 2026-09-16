//! GitHub integration, driven entirely by the user's own `gh` CLI.
//!
//! Every worktree in raum maps to a branch and most branches end up as a pull
//! request, so "did CI go green, is it approved, can I merge" is the last
//! frequent reason to leave the app. This module answers those questions in
//! place: a PR per worktree with its checks and review state, the repo's
//! deployment environments and releases, search across open PRs, and a
//! one-click merge.
//!
//! The feature is opt-in and off until `gh` is installed and `gh auth status`
//! reports a host that matches the worktree's `origin` remote. raum stores no
//! token and opens no socket of its own — see [`gh`] for why that matters and
//! `docs/privacy.md` for the promise it keeps.
//!
//! * [`gh`] — the subprocess wrapper, remote parsing and the install/auth probe.
//! * [`types`] — the wire contract (mirrored by `frontend/src/lib/githubTypes.ts`)
//!   and the normalisation from gh's raw JSON.
//! * [`pr_service`] — per-worktree poll tasks with an adaptive tick.
//! * [`repo_service`] — deployments and releases for the active project.
//! * [`search`] — spotlight pull-request search.
//! * [`merge`] — repo merge policy and `gh pr merge`.

#![allow(dead_code)]

pub mod gh;
mod merge;
pub mod pr_service;
mod repo_service;
mod search;
mod types;

#[cfg(test)]
mod tests;

// Glob re-exports: `tauri::generate_handler!` resolves each command at the
// path `commands::github::<name>`, which needs both the function and its
// hidden `__cmd__<name>` shim visible here.
#[allow(unused_imports)]
pub use gh::*;
#[allow(unused_imports)]
pub use merge::*;
#[allow(unused_imports)]
pub use pr_service::*;
#[allow(unused_imports)]
pub use repo_service::*;
#[allow(unused_imports)]
pub use search::*;
// The wire types are only named across the IPC boundary, never by this crate.
#[allow(unused_imports)]
pub use types::*;
