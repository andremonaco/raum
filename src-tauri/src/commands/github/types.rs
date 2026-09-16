//! Wire types for the GitHub integration, plus the raw `gh --json` shapes they
//! are normalised from.
//!
//! Everything in the first half of this file crosses the Tauri IPC boundary and
//! is mirrored one-to-one by `frontend/src/lib/githubTypes.ts`. Both sides use
//! camelCase; keep them in lockstep.
//!
//! The second half holds the structs we decode `gh` output into. They stay
//! private to the backend: `gh pr view` and `gh pr list` return a
//! `statusCheckRollup` array whose items are either a `CheckRun` or a
//! `StatusContext`, discriminated by `__typename`, and the frontend should
//! never have to care about that. [`normalise_checks`] flattens both into one
//! [`Check`] list, and [`rollup_of`] reduces that list to the single glyph the
//! sidebar chip renders.

use serde::{Deserialize, Serialize};

/// Normalised state bucket shared by PR checks, deployments and releases.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum CheckBucket {
    Pass,
    Fail,
    Pending,
    Skipped,
    Cancelled,
}

impl CheckBucket {
    /// Display order inside a PR: what is broken first, what is still running
    /// next, then the boring green rows. Cancelled sorts with fail because that
    /// is how GitHub scores it — a cancelled run is not a passing run.
    fn rank(self) -> u8 {
        match self {
            CheckBucket::Fail => 0,
            CheckBucket::Cancelled => 1,
            CheckBucket::Pending => 2,
            CheckBucket::Pass => 3,
            CheckBucket::Skipped => 4,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    pub bucket: CheckBucket,
    /// Link to the run / details page. `None` for status contexts without a
    /// target URL.
    pub url: Option<String>,
    /// Workflow name for `CheckRun` items; `None` for `StatusContext` items.
    pub workflow: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub description: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChecksSummary {
    pub total: usize,
    pub pass: usize,
    pub fail: usize,
    pub pending: usize,
    pub skipped: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// `OPEN` / `CLOSED` / `MERGED`.
    pub state: String,
    pub is_draft: bool,
    pub author: Option<String>,
    pub base_ref_name: String,
    pub head_ref_name: String,
    pub head_ref_oid: String,
    /// `APPROVED` / `CHANGES_REQUESTED` / `REVIEW_REQUIRED`, or `None` when the
    /// PR needs no review. gh reports the last case as an empty string.
    pub review_decision: Option<String>,
    /// `MERGEABLE` / `CONFLICTING` / `UNKNOWN`.
    pub mergeable: String,
    /// `CLEAN` / `BEHIND` / `BLOCKED` / `DIRTY` / `DRAFT` / `HAS_HOOKS` /
    /// `UNSTABLE` / `UNKNOWN` — drives which merge buttons the sheet offers.
    pub merge_state_status: String,
    /// Failed first, then pending, then passed, then skipped.
    pub checks: Vec<Check>,
    pub checks_summary: ChecksSummary,
    pub rollup: CheckBucket,
    /// Commits on the head branch that are not on the base — what a merge
    /// would land. 0 when the record came from `gh pr list` (search).
    pub commit_count: usize,
    pub updated_at: String,
}

/// Search-result shape (`gh pr list --search`). A thinner PR: no merge state,
/// no per-check detail, just what a spotlight row renders.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSummary {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub head_ref_name: String,
    pub author: Option<String>,
    pub is_draft: bool,
    pub review_decision: Option<String>,
    pub rollup: CheckBucket,
    pub checks_summary: ChecksSummary,
    pub updated_at: String,
    /// Worktree path that has `head_ref_name` checked out, if any.
    pub worktree_path: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentEnv {
    pub environment: String,
    /// Raw GraphQL `DeploymentState` (`ACTIVE`, `PENDING`, `IN_PROGRESS`, …).
    pub state: String,
    pub bucket: CheckBucket,
    #[serde(rename = "ref")]
    pub git_ref: Option<String>,
    /// Abbreviated commit oid.
    pub sha: Option<String>,
    pub message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub environment_url: Option<String>,
    pub log_url: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub tag_name: String,
    pub name: Option<String>,
    pub published_at: Option<String>,
    pub is_latest: bool,
    pub is_draft: bool,
    pub is_prerelease: bool,
    pub url: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MergeMethod {
    Squash,
    Rebase,
    Merge,
}

impl MergeMethod {
    /// The `gh pr merge` flag that selects this method.
    pub fn flag(self) -> &'static str {
        match self {
            MergeMethod::Squash => "--squash",
            MergeMethod::Rebase => "--rebase",
            MergeMethod::Merge => "--merge",
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergePolicy {
    pub squash: bool,
    pub rebase: bool,
    pub merge_commit: bool,
    pub delete_branch_on_merge: bool,
    pub auto_merge_allowed: bool,
    pub default_method: MergeMethod,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub ok: bool,
    /// True when `--auto` was used and GitHub accepted the auto-merge request.
    pub auto_merge_enabled: bool,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    /// Hosts `gh auth status` reports as logged in (e.g. `github.com`).
    pub hosts: Vec<String>,
    pub error: Option<String>,
}

/* ---------- event payloads ---------- */

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrChangedPayload {
    pub path: String,
    pub pr: Option<PullRequest>,
    pub available: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrTransitionKind {
    ChecksPassed,
    ChecksFailed,
    ReviewApproved,
    ChangesRequested,
    Merged,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrTransitionPayload {
    pub path: String,
    pub kind: PrTransitionKind,
    pub pr: PullRequest,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentsChangedPayload {
    pub slug: String,
    pub environments: Vec<DeploymentEnv>,
}

/// `github-prs-changed` — every open pull request of the active project.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrsChangedPayload {
    pub slug: String,
    pub prs: Vec<PullRequestSummary>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleasesChangedPayload {
    pub slug: String,
    pub releases: Vec<Release>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentTransitionPayload {
    pub slug: String,
    pub environment: String,
    pub bucket: CheckBucket,
    pub env: DeploymentEnv,
}

/* ---------- raw `gh --json` input shapes ---------- */

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct RawAuthor {
    pub login: String,
}

/// One `gh pr view` / `gh pr list` record. Every field defaults so the same
/// struct decodes both call sites (the list form asks for fewer fields).
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct RawPr {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    pub author: Option<RawAuthor>,
    pub base_ref_name: String,
    pub head_ref_name: String,
    pub head_ref_oid: String,
    pub review_decision: String,
    pub mergeable: String,
    pub merge_state_status: String,
    pub status_check_rollup: Vec<RawCheck>,
    /// Only the length is used; the per-commit payload is skipped on decode.
    pub commits: Vec<serde::de::IgnoredAny>,
    pub updated_at: String,
}

/// A `statusCheckRollup` item. GitHub returns a union of `CheckRun` and
/// `StatusContext`; both are flattened here and told apart by `__typename`
/// (falling back to "has a `context` field" for gh versions that omit it).
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct RawCheck {
    #[serde(rename = "__typename")]
    pub typename: String,
    // CheckRun
    pub name: String,
    /// `QUEUED` / `IN_PROGRESS` / `COMPLETED`.
    pub status: String,
    /// `SUCCESS` / `FAILURE` / `SKIPPED` / `CANCELLED` / …
    pub conclusion: String,
    pub details_url: String,
    pub workflow_name: String,
    pub started_at: String,
    pub completed_at: String,
    // StatusContext
    pub context: String,
    /// `SUCCESS` / `PENDING` / `FAILURE` / `ERROR` / `EXPECTED`.
    pub state: String,
    pub target_url: String,
    pub description: String,
}

/// `gh api repos/{owner}/{repo}` — the REST repository object. Used instead of
/// `gh repo view --json` because that command has no `autoMergeAllowed` field
/// (verified against gh 2.93) while REST carries every merge setting the sheet
/// needs in one call.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub(super) struct RawRepo {
    pub allow_squash_merge: bool,
    pub allow_rebase_merge: bool,
    pub allow_merge_commit: bool,
    pub delete_branch_on_merge: bool,
    pub allow_auto_merge: bool,
}

/// `gh release list --json tagName,name,publishedAt,isLatest,isDraft,isPrerelease`.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct RawRelease {
    pub tag_name: String,
    pub name: String,
    pub published_at: String,
    pub is_latest: bool,
    pub is_draft: bool,
    pub is_prerelease: bool,
}

/* ---------- deployments GraphQL response ---------- */

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub(super) struct DeploymentsResponse {
    pub data: DeploymentsData,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub(super) struct DeploymentsData {
    pub repository: DeploymentsRepo,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub(super) struct DeploymentsRepo {
    pub deployments: DeploymentNodes,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub(super) struct DeploymentNodes {
    pub nodes: Vec<RawDeployment>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct RawDeployment {
    pub environment: String,
    pub state: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(rename = "ref")]
    pub git_ref: Option<RawRefName>,
    pub commit: Option<RawCommit>,
    pub latest_status: Option<RawDeploymentStatus>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct RawRefName {
    pub name: String,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct RawCommit {
    #[serde(deserialize_with = "null_string")]
    pub abbreviated_oid: String,
    #[serde(deserialize_with = "null_string")]
    pub message_headline: String,
}

/// `gh api graphql` hands back GitHub's raw JSON, where absent values are
/// `null` (unlike `gh … --json`, which omits them). Every nullable string in
/// the GraphQL shapes goes through [`null_string`] so a `null` `description`
/// cannot sink the whole deployments response.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct RawDeploymentStatus {
    #[serde(deserialize_with = "null_string")]
    pub state: String,
    #[serde(deserialize_with = "null_string")]
    pub description: String,
    #[serde(deserialize_with = "null_string")]
    pub log_url: String,
    #[serde(deserialize_with = "null_string")]
    pub environment_url: String,
}

/// Accept `null` where a `String` is expected and read it as empty.
fn null_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Option::<String>::deserialize(d).map(Option::unwrap_or_default)
}

/* ---------- normalisation ---------- */

fn some_unless_empty(s: String) -> Option<String> {
    (!s.is_empty()).then_some(s)
}

/// Bucket for a `CheckRun`: anything that has not completed is pending,
/// otherwise the conclusion decides. An unrecognised conclusion counts as a
/// failure — a check raum cannot read is not a check raum should call green.
fn check_run_bucket(status: &str, conclusion: &str) -> CheckBucket {
    if status != "COMPLETED" {
        return CheckBucket::Pending;
    }
    match conclusion {
        "SUCCESS" | "NEUTRAL" => CheckBucket::Pass,
        "SKIPPED" => CheckBucket::Skipped,
        "CANCELLED" | "STALE" => CheckBucket::Cancelled,
        _ => CheckBucket::Fail,
    }
}

/// Bucket for a `StatusContext` (the legacy commit-status API).
fn status_context_bucket(state: &str) -> CheckBucket {
    match state {
        "SUCCESS" => CheckBucket::Pass,
        "PENDING" | "EXPECTED" => CheckBucket::Pending,
        _ => CheckBucket::Fail,
    }
}

/// Deployment state → the same bucket set the checks use, so one glyph set
/// serves both surfaces.
pub(super) fn deployment_bucket(state: &str) -> CheckBucket {
    match state {
        "ACTIVE" | "SUCCESS" => CheckBucket::Pass,
        "FAILURE" | "ERROR" => CheckBucket::Fail,
        "PENDING" | "QUEUED" | "IN_PROGRESS" | "WAITING" => CheckBucket::Pending,
        _ => CheckBucket::Skipped,
    }
}

/// Flatten the `statusCheckRollup` union into one ordered [`Check`] list.
pub(super) fn normalise_checks(raw: Vec<RawCheck>) -> Vec<Check> {
    let mut checks: Vec<Check> = raw
        .into_iter()
        .map(|r| {
            let is_context =
                r.typename == "StatusContext" || (r.typename.is_empty() && !r.context.is_empty());
            if is_context {
                Check {
                    name: r.context,
                    bucket: status_context_bucket(&r.state),
                    url: some_unless_empty(r.target_url),
                    workflow: None,
                    started_at: None,
                    completed_at: None,
                    description: some_unless_empty(r.description),
                }
            } else {
                Check {
                    name: r.name,
                    bucket: check_run_bucket(&r.status, &r.conclusion),
                    url: some_unless_empty(r.details_url),
                    workflow: some_unless_empty(r.workflow_name),
                    started_at: some_unless_empty(r.started_at),
                    completed_at: some_unless_empty(r.completed_at),
                    description: some_unless_empty(r.description),
                }
            }
        })
        .collect();
    // Stable sort: rows inside a bucket keep the order GitHub returned them in.
    checks.sort_by_key(|c| c.bucket.rank());
    checks
}

/// One glyph for the whole PR. Empty check list means the repo runs no CI on
/// this branch, which is neither green nor red — `skipped`.
pub(super) fn rollup_of(checks: &[Check]) -> CheckBucket {
    if checks.is_empty() {
        return CheckBucket::Skipped;
    }
    if checks
        .iter()
        .any(|c| matches!(c.bucket, CheckBucket::Fail | CheckBucket::Cancelled))
    {
        CheckBucket::Fail
    } else if checks.iter().any(|c| c.bucket == CheckBucket::Pending) {
        CheckBucket::Pending
    } else {
        CheckBucket::Pass
    }
}

pub(super) fn summarise(checks: &[Check]) -> ChecksSummary {
    let mut s = ChecksSummary {
        total: checks.len(),
        ..ChecksSummary::default()
    };
    for c in checks {
        match c.bucket {
            CheckBucket::Pass => s.pass += 1,
            // A cancelled run counts against the PR, same as the rollup.
            CheckBucket::Fail | CheckBucket::Cancelled => s.fail += 1,
            CheckBucket::Pending => s.pending += 1,
            CheckBucket::Skipped => s.skipped += 1,
        }
    }
    s
}

impl RawPr {
    pub(super) fn into_pull_request(self) -> PullRequest {
        let author = self.author.map(|a| a.login).and_then(some_unless_empty);
        let checks = normalise_checks(self.status_check_rollup);
        let rollup = rollup_of(&checks);
        let checks_summary = summarise(&checks);
        PullRequest {
            number: self.number,
            title: self.title,
            url: self.url,
            state: if self.state.is_empty() {
                "OPEN".to_string()
            } else {
                self.state
            },
            is_draft: self.is_draft,
            author,
            base_ref_name: self.base_ref_name,
            head_ref_name: self.head_ref_name,
            head_ref_oid: self.head_ref_oid,
            review_decision: some_unless_empty(self.review_decision),
            mergeable: if self.mergeable.is_empty() {
                "UNKNOWN".to_string()
            } else {
                self.mergeable
            },
            merge_state_status: if self.merge_state_status.is_empty() {
                "UNKNOWN".to_string()
            } else {
                self.merge_state_status
            },
            checks,
            checks_summary,
            rollup,
            commit_count: self.commits.len(),
            updated_at: self.updated_at,
        }
    }

    pub(super) fn into_summary(self, worktree_path: Option<String>) -> PullRequestSummary {
        let author = self.author.map(|a| a.login).and_then(some_unless_empty);
        let checks = normalise_checks(self.status_check_rollup);
        PullRequestSummary {
            number: self.number,
            title: self.title,
            url: self.url,
            head_ref_name: self.head_ref_name,
            author,
            is_draft: self.is_draft,
            review_decision: some_unless_empty(self.review_decision),
            rollup: rollup_of(&checks),
            checks_summary: summarise(&checks),
            updated_at: self.updated_at,
            worktree_path,
        }
    }
}

impl RawDeployment {
    pub(super) fn into_env(self) -> DeploymentEnv {
        let status = self.latest_status.unwrap_or_default();
        let commit = self.commit.unwrap_or_default();
        DeploymentEnv {
            bucket: deployment_bucket(&self.state),
            environment: self.environment,
            state: self.state,
            git_ref: self.git_ref.map(|r| r.name).and_then(some_unless_empty),
            sha: some_unless_empty(commit.abbreviated_oid),
            message: some_unless_empty(commit.message_headline),
            created_at: self.created_at,
            updated_at: self.updated_at,
            environment_url: some_unless_empty(status.environment_url),
            log_url: some_unless_empty(status.log_url),
        }
    }
}

impl RawRelease {
    pub(super) fn into_release(self, host: &str, owner: &str, repo: &str) -> Release {
        let url = format!(
            "https://{host}/{owner}/{repo}/releases/tag/{tag}",
            tag = self.tag_name
        );
        Release {
            tag_name: self.tag_name,
            name: some_unless_empty(self.name),
            published_at: some_unless_empty(self.published_at),
            is_latest: self.is_latest,
            is_draft: self.is_draft,
            is_prerelease: self.is_prerelease,
            url,
        }
    }
}

impl RawRepo {
    pub(super) fn into_policy(self) -> MergePolicy {
        // gh reports the repo's allowed methods but not "the" default; GitHub's
        // own UI defaults to the first allowed of squash → rebase → merge.
        let default_method = if self.allow_squash_merge {
            MergeMethod::Squash
        } else if self.allow_rebase_merge {
            MergeMethod::Rebase
        } else {
            MergeMethod::Merge
        };
        MergePolicy {
            squash: self.allow_squash_merge,
            rebase: self.allow_rebase_merge,
            merge_commit: self.allow_merge_commit,
            delete_branch_on_merge: self.delete_branch_on_merge,
            auto_merge_allowed: self.allow_auto_merge,
            default_method,
        }
    }
}
