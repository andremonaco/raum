/**
 * GitHub integration (via the `gh` CLI) — wire types shared by every frontend
 * consumer. These mirror the Rust structs in `src-tauri/src/commands/github/types.rs`
 * (serde `rename_all = "camelCase"`). Keep both sides in lockstep.
 *
 * See `docs/proposals/github-pr-status.md` for the feature design.
 */

/** Normalised state bucket shared by PR checks, deployments and releases. */
export type CheckBucket = "pass" | "fail" | "pending" | "skipped" | "cancelled";

export interface Check {
  name: string;
  bucket: CheckBucket;
  /** Link to the run / details page. Null for status contexts without a target URL. */
  url: string | null;
  /** Workflow name for CheckRun items; null for StatusContext items. */
  workflow: string | null;
  startedAt: string | null;
  completedAt: string | null;
  description: string | null;
}

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

export type MergeStateStatus =
  | "CLEAN"
  | "BEHIND"
  | "BLOCKED"
  | "DIRTY"
  | "DRAFT"
  | "HAS_HOOKS"
  | "UNSTABLE"
  | "UNKNOWN";

export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export type PrState = "OPEN" | "CLOSED" | "MERGED";

export interface ChecksSummary {
  total: number;
  pass: number;
  fail: number;
  pending: number;
  skipped: number;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: PrState;
  isDraft: boolean;
  author: string | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  reviewDecision: ReviewDecision;
  mergeable: Mergeable;
  mergeStateStatus: MergeStateStatus;
  /** Failed first, then pending, then passed, then skipped. */
  checks: Check[];
  checksSummary: ChecksSummary;
  /** Rollup of `checks`: fail if any failed, pending if any pending, pass otherwise
   *  (skipped when there are no checks at all). */
  rollup: CheckBucket;
  updatedAt: string;
}

/** Search-result shape (`gh pr list --search`). */
export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  author: string | null;
  isDraft: boolean;
  reviewDecision: ReviewDecision;
  rollup: CheckBucket;
  checksSummary: ChecksSummary;
  updatedAt: string;
  /** Worktree path that has `headRefName` checked out, if any. */
  worktreePath: string | null;
}

export interface DeploymentEnv {
  environment: string;
  /** Raw GraphQL DeploymentState (ACTIVE, PENDING, IN_PROGRESS, FAILURE, …). */
  state: string;
  bucket: CheckBucket;
  ref: string | null;
  /** Abbreviated commit oid. */
  sha: string | null;
  message: string | null;
  createdAt: string;
  updatedAt: string;
  environmentUrl: string | null;
  logUrl: string | null;
}

export interface Release {
  tagName: string;
  name: string | null;
  publishedAt: string | null;
  isLatest: boolean;
  isDraft: boolean;
  isPrerelease: boolean;
  url: string;
}

export type MergeMethod = "squash" | "rebase" | "merge";

export interface MergePolicy {
  squash: boolean;
  rebase: boolean;
  mergeCommit: boolean;
  deleteBranchOnMerge: boolean;
  autoMergeAllowed: boolean;
  defaultMethod: MergeMethod;
}

export interface MergeOutcome {
  ok: boolean;
  /** True when `--auto` was used and GitHub accepted the auto-merge request. */
  autoMergeEnabled: boolean;
  message: string;
}

export interface GhStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
  /** Hosts `gh auth status` reports as logged in (e.g. "github.com"). */
  hosts: string[];
  error: string | null;
}

/* ---------- Tauri events ---------- */

/** `github-pr-changed` — emitted only when the cached PR for a path differs. */
export interface GithubPrChangedPayload {
  path: string;
  /** Null when the branch has no open PR. */
  pr: PullRequest | null;
  /** False when the worktree's remote is not a gh-authenticated GitHub host or gh is
   *  unavailable; consumers hide all PR chrome for the path. */
  available: boolean;
}

export type PrTransitionKind =
  | "checks_passed"
  | "checks_failed"
  | "review_approved"
  | "changes_requested"
  | "merged";

/** `github-pr-transition` — a notification-worthy edge crossed. */
export interface GithubPrTransitionPayload {
  path: string;
  kind: PrTransitionKind;
  pr: PullRequest;
}

/** `github-deployments-changed` */
export interface GithubDeploymentsChangedPayload {
  slug: string;
  environments: DeploymentEnv[];
}

/** `github-prs-changed` — every open PR of the active project, newest first. */
export interface GithubPrsChangedPayload {
  slug: string;
  prs: PullRequestSummary[];
}

/** `github-releases-changed` */
export interface GithubReleasesChangedPayload {
  slug: string;
  releases: Release[];
}

/** `github-deployment-transition` — environment left `pending` (to pass or fail). */
export interface GithubDeploymentTransitionPayload {
  slug: string;
  environment: string;
  bucket: CheckBucket;
  env: DeploymentEnv;
}

/* ---------- Tauri command names + arg shapes ---------- */

export const GITHUB_COMMANDS = {
  /** () => GhStatus */
  status: "github_status",
  /** { paths: string[] } => void — full set reconciliation of PR-polled worktree paths */
  prSubscribe: "github_pr_subscribe",
  /** { path: string } => void */
  prRefresh: "github_pr_refresh",
  /** { projectSlug: string; query: string; limit: number } => PullRequestSummary[] */
  prSearch: "github_pr_search",
  /** { path: string } => MergePolicy */
  mergePolicy: "github_merge_policy",
  /** { path: string; number: number; method: MergeMethod; deleteBranch: boolean; auto: boolean } => MergeOutcome */
  prMerge: "github_pr_merge",
  /** { slug: string | null } => void — deployments + releases polling for the active project */
  repoSubscribe: "github_repo_subscribe",
  /** { slug: string } => void */
  repoRefresh: "github_repo_refresh",
} as const;
