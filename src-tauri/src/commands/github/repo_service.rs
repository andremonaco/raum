//! Repo-wide deployments and releases for the active project.
//!
//! Neither stream is branch-scoped, so unlike the PR service this runs exactly
//! two tasks total — not two per worktree — and only for the project the user
//! currently has open. Activating a project starts them; switching away or
//! passing `None` stops them. That is the same rule the `.git` watcher and the
//! working-tree watcher follow: a backgrounded repo costs nothing.
//!
//! Deployments have no `gh` subcommand and the REST shape costs one call per
//! environment, so raum asks GraphQL once and groups the answer itself: newest
//! deployment per environment, capped at the most recently deployed handful
//! plus any environment whose ref is a branch the project has checked out
//! somewhere (preview-per-PR repos otherwise bury the interesting rows).
//! Deployment states map onto the same pass/fail/pending/skipped buckets as PR
//! checks, so one glyph set serves both.
//!
//! Both tasks emit only on diff, pause while the window is unfocused, and poll
//! hot (10 s) only while something is actually in flight.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{Emitter, Manager};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use super::gh::{self, Remote};
use super::search::{PR_LIST_FIELDS, finish as summarise_prs};
use super::types::{
    CheckBucket, DeploymentEnv, DeploymentTransitionPayload, DeploymentsChangedPayload,
    DeploymentsResponse, PrsChangedPayload, PullRequestSummary, RawDeployment, RawPr, RawRelease,
    Release, ReleasesChangedPayload,
};
use crate::state::AppHandleState;

/// Any deployment still in flight — the state someone is watching.
const TICK_DEPLOY_HOT: Duration = Duration::from_secs(10);

/// Every environment settled.
const TICK_DEPLOY_SETTLED: Duration = Duration::from_secs(120);

/// Releases change rarely; focus gain covers the impatient case.
const TICK_RELEASES: Duration = Duration::from_secs(300);

/// Open pull requests of the whole repo. The per-worktree PR service already
/// polls the branches raum has checked out at 10 s while they run, so this
/// list only needs to catch PRs opened or merged elsewhere.
const TICK_PRS: Duration = Duration::from_secs(60);

/// How many open PRs the list fetches. Enough for the sidebar; Spotlight
/// search covers the long tail.
const PRS_LIMIT: &str = "30";

/// A call failed — back off without going all the way to idle.
const TICK_ERROR: Duration = Duration::from_secs(60);

/// How many environments the section shows before the branch-match rule is the
/// only way in. Repos that deploy a preview per pull request otherwise push
/// every real environment off the list.
const MAX_ENVS: usize = 8;

/// The deployments query from `docs/proposals/github-pr-status.md`. One round
/// trip returns everything the section renders, including the latest status'
/// log and environment URLs.
const DEPLOYMENTS_QUERY: &str = r"
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    deployments(first: 30, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        environment state createdAt updatedAt
        ref { name }
        commit { abbreviatedOid messageHeadline }
        latestStatus { state description logUrl environmentUrl }
      }
    }
  }
}
";

#[derive(Debug)]
struct Active {
    slug: String,
    deployments: tauri::async_runtime::JoinHandle<()>,
    releases: tauri::async_runtime::JoinHandle<()>,
    prs: tauri::async_runtime::JoinHandle<()>,
    deployments_tx: mpsc::UnboundedSender<()>,
    releases_tx: mpsc::UnboundedSender<()>,
    prs_tx: mpsc::UnboundedSender<()>,
}

impl Active {
    fn abort(&self) {
        self.deployments.abort();
        self.releases.abort();
        self.prs.abort();
    }

    fn nudge_all(&self) {
        let _ = self.deployments_tx.send(());
        let _ = self.releases_tx.send(());
        let _ = self.prs_tx.send(());
    }
}

#[derive(Debug)]
struct ServiceInner {
    app: tauri::AppHandle,
    active: Mutex<Option<Active>>,
    focused: AtomicBool,
}

/// Cheap-to-clone handle stored on [`AppHandleState`].
#[derive(Debug, Clone)]
pub struct GithubRepoService {
    inner: Arc<ServiceInner>,
}

/// Everything a task needs to talk to one repo.
#[derive(Debug, Clone)]
struct RepoContext {
    slug: String,
    root: PathBuf,
    remote: Remote,
}

impl GithubRepoService {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            inner: Arc::new(ServiceInner {
                app,
                active: Mutex::new(None),
                focused: AtomicBool::new(true),
            }),
        }
    }

    /// Point the repo tasks at `slug`, or stop them with `None`. Re-passing the
    /// already-active slug just triggers a refresh, so the frontend can push
    /// the current project on focus to self-heal.
    pub fn set_active(&self, slug: Option<String>) {
        let Ok(mut active) = self.inner.active.lock() else {
            warn!("github_repo: active mutex poisoned");
            return;
        };
        match (&*active, &slug) {
            (Some(cur), Some(next)) if &cur.slug == next => {
                cur.nudge_all();
                return;
            }
            _ => {}
        }
        if let Some(prev) = active.take() {
            prev.abort();
            debug!(slug = %prev.slug, "github_repo: stopped");
        }
        let Some(slug) = slug else { return };

        let (deployments_tx, deployments_rx) = mpsc::unbounded_channel();
        let (releases_tx, releases_rx) = mpsc::unbounded_channel();
        let (prs_tx, prs_rx) = mpsc::unbounded_channel();
        let inner = self.inner.clone();
        let deployments = spawn_repo_task(
            inner.clone(),
            slug.clone(),
            deployments_rx,
            RepoStream::Deployments,
        );
        let releases = spawn_repo_task(
            inner.clone(),
            slug.clone(),
            releases_rx,
            RepoStream::Releases,
        );
        let prs = spawn_repo_task(inner, slug.clone(), prs_rx, RepoStream::PullRequests);
        info!(slug = %slug, "github_repo: started");
        *active = Some(Active {
            slug,
            deployments,
            releases,
            prs,
            deployments_tx,
            releases_tx,
            prs_tx,
        });
    }

    /// Manual refresh. Ignored when `slug` is not the active project — a
    /// background repo has no tasks to nudge.
    pub fn trigger(&self, slug: &str) {
        let Ok(active) = self.inner.active.lock() else {
            return;
        };
        if let Some(cur) = active.as_ref()
            && cur.slug == slug
        {
            cur.nudge_all();
        }
    }

    /// Record main-window focus; gaining it refreshes both streams.
    pub fn set_focused(&self, focused: bool) {
        self.inner.focused.store(focused, Ordering::Relaxed);
        if !focused {
            return;
        }
        let Ok(active) = self.inner.active.lock() else {
            return;
        };
        if let Some(cur) = active.as_ref() {
            cur.nudge_all();
        }
    }
}

/// Which repo stream a task runs. They share the whole loop — resolve,
/// recompute, diff, emit, adaptive sleep — and differ only in the recompute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RepoStream {
    Deployments,
    Releases,
    PullRequests,
}

/// Resolve `slug` to its root path and GitHub remote. `None` when the project
/// is gone from the config, has no GitHub `origin`, or `gh` is not logged into
/// that host — in every case the section stays empty rather than guessing.
async fn repo_context(app: &tauri::AppHandle, slug: &str) -> Option<RepoContext> {
    let root = {
        let state = app.try_state::<AppHandleState>()?;
        let store = state.config_store.lock().ok()?;
        store.read_project(slug).ok().flatten()?.root_path
    };
    let remote = gh::resolve(&root.to_string_lossy()).await?;
    Some(RepoContext {
        slug: slug.to_string(),
        root,
        remote,
    })
}

fn spawn_repo_task(
    inner: Arc<ServiceInner>,
    slug: String,
    mut trigger_rx: mpsc::UnboundedReceiver<()>,
    stream: RepoStream,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut envs: Option<Vec<DeploymentEnv>> = None;
        let mut releases: Option<Vec<Release>> = None;
        let mut prs: Option<Vec<PullRequestSummary>> = None;

        loop {
            let tick = match repo_context(&inner.app, &slug).await {
                Some(ctx) => match stream {
                    RepoStream::Deployments => refresh_deployments(&inner, &ctx, &mut envs).await,
                    RepoStream::Releases => refresh_releases(&inner, &ctx, &mut releases).await,
                    RepoStream::PullRequests => refresh_prs(&inner, &ctx, &mut prs).await,
                },
                // Not a GitHub repo raum may query: idle, but stay alive so a
                // later `gh auth login` is picked up.
                None => TICK_RELEASES,
            };

            loop {
                tokio::select! {
                    maybe = trigger_rx.recv() => {
                        if maybe.is_none() { return }
                        break;
                    }
                    () = tokio::time::sleep(tick) => {
                        if inner.focused.load(Ordering::Relaxed) {
                            break;
                        }
                        // Backgrounded: keep sleeping, spawn nothing.
                    }
                }
            }
        }
    })
}

/// One GraphQL round trip → the environment list, emitted on diff, plus a
/// transition event for every environment that just left `pending`.
async fn refresh_deployments(
    inner: &Arc<ServiceInner>,
    ctx: &RepoContext,
    cached: &mut Option<Vec<DeploymentEnv>>,
) -> Duration {
    let fresh = match fetch_deployments(ctx).await {
        Ok(envs) => envs,
        Err(e) => {
            warn!(slug = %ctx.slug, error = %e, "github_repo: deployments failed");
            return TICK_ERROR;
        }
    };
    if cached.as_ref() != Some(&fresh) {
        let payload = DeploymentsChangedPayload {
            slug: ctx.slug.clone(),
            environments: fresh.clone(),
        };
        if let Err(e) = inner.app.emit("github-deployments-changed", payload) {
            warn!(slug = %ctx.slug, error = %e, "github-deployments-changed emit failed");
        }
    }
    if let Some(prev) = cached.as_ref() {
        for env in settled_environments(prev, &fresh) {
            let payload = DeploymentTransitionPayload {
                slug: ctx.slug.clone(),
                environment: env.environment.clone(),
                bucket: env.bucket,
                env,
            };
            if let Err(e) = inner.app.emit("github-deployment-transition", payload) {
                warn!(slug = %ctx.slug, error = %e, "github-deployment-transition emit failed");
            }
        }
    }
    let hot = fresh.iter().any(|e| e.bucket == CheckBucket::Pending);
    *cached = Some(fresh);
    if hot {
        TICK_DEPLOY_HOT
    } else {
        TICK_DEPLOY_SETTLED
    }
}

async fn fetch_deployments(ctx: &RepoContext) -> Result<Vec<DeploymentEnv>, String> {
    let response: Option<DeploymentsResponse> = gh::json(
        &ctx.root,
        &[
            "api",
            "graphql",
            "-f",
            &format!("owner={}", ctx.remote.owner),
            "-f",
            &format!("name={}", ctx.remote.repo),
            "-f",
            &format!("query={DEPLOYMENTS_QUERY}"),
        ],
    )
    .await?;
    let nodes = response
        .unwrap_or_default()
        .data
        .repository
        .deployments
        .nodes;
    let mut envs = newest_per_environment(nodes);
    if envs.len() > MAX_ENVS {
        envs = cap_environments(envs, &checked_out_branches(&ctx.root));
    }
    Ok(envs)
}

/// Group deployments by environment, keep the newest of each, and sort the
/// result newest first. `createdAt` is ISO 8601, so string order is time order
/// and the caller needn't trust the connection's own ordering.
pub(super) fn newest_per_environment(nodes: Vec<RawDeployment>) -> Vec<DeploymentEnv> {
    let mut by_env: HashMap<String, RawDeployment> = HashMap::new();
    for node in nodes {
        match by_env.get(&node.environment) {
            Some(seen) if seen.created_at >= node.created_at => {}
            _ => {
                by_env.insert(node.environment.clone(), node);
            }
        }
    }
    let mut envs: Vec<DeploymentEnv> = by_env.into_values().map(RawDeployment::into_env).collect();
    envs.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.environment.cmp(&b.environment))
    });
    envs
}

/// Keep the [`MAX_ENVS`] most recently deployed environments plus every
/// environment deployed from a branch this project has checked out somewhere.
pub(super) fn cap_environments(
    envs: Vec<DeploymentEnv>,
    branches: &HashSet<String>,
) -> Vec<DeploymentEnv> {
    envs.into_iter()
        .enumerate()
        .filter(|(i, env)| {
            *i < MAX_ENVS
                || env
                    .git_ref
                    .as_ref()
                    .is_some_and(|r| branches.contains(r.as_str()))
        })
        .map(|(_, env)| env)
        .collect()
}

/// Branches checked out in any of the project's worktrees — the rows the user
/// is most likely to care about.
fn checked_out_branches(root: &std::path::Path) -> HashSet<String> {
    raum_hydration::worktree_list(root)
        .map(|entries| entries.into_iter().filter_map(|e| e.branch).collect())
        .unwrap_or_default()
}

/// Environments that were pending last tick and are not any more — a deploy
/// just finished, green or red.
pub(super) fn settled_environments(
    prev: &[DeploymentEnv],
    next: &[DeploymentEnv],
) -> Vec<DeploymentEnv> {
    next.iter()
        .filter(|env| {
            env.bucket != CheckBucket::Pending
                && prev
                    .iter()
                    .any(|p| p.environment == env.environment && p.bucket == CheckBucket::Pending)
        })
        .cloned()
        .collect()
}

async fn refresh_releases(
    inner: &Arc<ServiceInner>,
    ctx: &RepoContext,
    cached: &mut Option<Vec<Release>>,
) -> Duration {
    let raw: Result<Option<Vec<RawRelease>>, String> = gh::json(
        &ctx.root,
        &[
            "release",
            "list",
            "--limit",
            "10",
            "--json",
            "tagName,name,publishedAt,isLatest,isDraft,isPrerelease",
        ],
    )
    .await;
    let raw = match raw {
        Ok(raw) => raw.unwrap_or_default(),
        Err(e) => {
            warn!(slug = %ctx.slug, error = %e, "github_repo: releases failed");
            return TICK_ERROR;
        }
    };
    let fresh: Vec<Release> = raw
        .into_iter()
        .map(|r| r.into_release(&ctx.remote.host, &ctx.remote.owner, &ctx.remote.repo))
        .collect();
    if cached.as_ref() != Some(&fresh) {
        let payload = ReleasesChangedPayload {
            slug: ctx.slug.clone(),
            releases: fresh.clone(),
        };
        if let Err(e) = inner.app.emit("github-releases-changed", payload) {
            warn!(slug = %ctx.slug, error = %e, "github-releases-changed emit failed");
        }
    }
    *cached = Some(fresh);
    TICK_RELEASES
}

/// Every open PR of the repo, emitted on diff. Rows carry the worktree path
/// that has the branch checked out so the sidebar can jump there.
async fn refresh_prs(
    inner: &Arc<ServiceInner>,
    ctx: &RepoContext,
    cached: &mut Option<Vec<PullRequestSummary>>,
) -> Duration {
    let raw: Result<Option<Vec<RawPr>>, String> = gh::json(
        &ctx.root,
        &[
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            PRS_LIMIT,
            "--json",
            PR_LIST_FIELDS,
        ],
    )
    .await;
    let raw = match raw {
        Ok(raw) => raw.unwrap_or_default(),
        Err(e) => {
            warn!(slug = %ctx.slug, error = %e, "github_repo: pr list failed");
            return TICK_ERROR;
        }
    };
    let fresh = summarise_prs(raw, &ctx.root);
    if cached.as_ref() != Some(&fresh) {
        let payload = PrsChangedPayload {
            slug: ctx.slug.clone(),
            prs: fresh.clone(),
        };
        if let Err(e) = inner.app.emit("github-prs-changed", payload) {
            warn!(slug = %ctx.slug, error = %e, "github-prs-changed emit failed");
        }
    }
    *cached = Some(fresh);
    TICK_PRS
}

fn service_handle(state: &AppHandleState) -> Option<GithubRepoService> {
    state
        .github_repo
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

/// Point the deployments + releases + open-PR tasks at the active project. `None` stops
/// them (no project selected).
#[tauri::command]
pub fn github_repo_subscribe(
    state: tauri::State<'_, AppHandleState>,
    slug: Option<String>,
) -> Result<(), String> {
    if let Some(svc) = service_handle(&state) {
        svc.set_active(slug);
    }
    Ok(())
}

/// Manual refresh of every repo stream.
#[tauri::command]
pub fn github_repo_refresh(
    state: tauri::State<'_, AppHandleState>,
    slug: String,
) -> Result<(), String> {
    if let Some(svc) = service_handle(&state) {
        svc.trigger(&slug);
    }
    Ok(())
}
