//! Fixture-driven tests for the GitHub integration.
//!
//! Everything here is pure: no network, no `gh` binary, no git repo. The
//! fixtures are verbatim shapes of what `gh --json` and the deployments
//! GraphQL query return, so a change in how raum normalises them shows up as a
//! failing assertion rather than as an empty section in the UI.

use super::gh::{self, GhOut};
use super::pr_service::{TICK_HOT, TICK_IDLE, TICK_SETTLED, tick_for, transitions};
use super::repo_service::{cap_environments, newest_per_environment, settled_environments};
use super::search::pr_number;
use super::types::{
    CheckBucket, DeploymentsResponse, PrTransitionKind, PullRequest, RawPr, RawRelease, RawRepo,
};

/* ---------- fixtures ---------- */

/// `gh pr view --json …` with a CheckRun + StatusContext mix, everything green.
const PR_VIEW_PASSING: &str = r#"{
  "number": 42,
  "title": "Coalesce PTY output",
  "url": "https://github.com/acme/raum/pull/42",
  "state": "OPEN",
  "isDraft": false,
  "author": { "login": "andre" },
  "baseRefName": "main",
  "headRefName": "feat/coalesce",
  "headRefOid": "1111111111111111111111111111111111111111",
  "reviewDecision": "APPROVED",
  "mergeable": "MERGEABLE",
  "mergeStateStatus": "CLEAN",
  "updatedAt": "2026-09-16T10:00:00Z",
  "statusCheckRollup": [
    { "__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS",
      "detailsUrl": "https://github.com/acme/raum/actions/runs/1", "workflowName": "CI",
      "startedAt": "2026-09-16T09:50:00Z", "completedAt": "2026-09-16T09:55:00Z" },
    { "__typename": "StatusContext", "context": "license/cla", "state": "SUCCESS",
      "targetUrl": "https://cla.example/1", "description": "CLA signed" }
  ]
}"#;

/// One job failed; a second is still running behind it.
const PR_VIEW_FAILING: &str = r#"{
  "number": 43,
  "title": "Flaky merge",
  "url": "https://github.com/acme/raum/pull/43",
  "state": "OPEN",
  "isDraft": false,
  "author": { "login": "andre" },
  "baseRefName": "main",
  "headRefName": "fix/flake",
  "headRefOid": "2222222222222222222222222222222222222222",
  "reviewDecision": "",
  "mergeable": "MERGEABLE",
  "mergeStateStatus": "UNSTABLE",
  "updatedAt": "2026-09-16T11:00:00Z",
  "statusCheckRollup": [
    { "__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "SUCCESS",
      "workflowName": "CI" },
    { "__typename": "CheckRun", "name": "build", "status": "IN_PROGRESS", "conclusion": "",
      "workflowName": "CI" },
    { "__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "FAILURE",
      "detailsUrl": "https://github.com/acme/raum/actions/runs/9", "workflowName": "CI" },
    { "__typename": "CheckRun", "name": "docs", "status": "COMPLETED", "conclusion": "SKIPPED",
      "workflowName": "CI" }
  ]
}"#;

/// Nothing has finished yet.
const PR_VIEW_PENDING: &str = r#"{
  "number": 44, "title": "WIP", "url": "https://github.com/acme/raum/pull/44",
  "state": "OPEN", "isDraft": false, "author": { "login": "andre" },
  "baseRefName": "main", "headRefName": "wip", "headRefOid": "3333333333333333333333333333333333333333",
  "reviewDecision": "REVIEW_REQUIRED", "mergeable": "UNKNOWN", "mergeStateStatus": "BLOCKED",
  "updatedAt": "2026-09-16T12:00:00Z",
  "statusCheckRollup": [
    { "__typename": "CheckRun", "name": "test", "status": "QUEUED", "conclusion": "" }
  ]
}"#;

/// A draft with no CI configured at all.
const PR_VIEW_DRAFT_NO_CHECKS: &str = r#"{
  "number": 45, "title": "Draft idea", "url": "https://github.com/acme/raum/pull/45",
  "state": "OPEN", "isDraft": true, "author": null,
  "baseRefName": "main", "headRefName": "idea", "headRefOid": "4444444444444444444444444444444444444444",
  "reviewDecision": "", "mergeable": "MERGEABLE", "mergeStateStatus": "DRAFT",
  "updatedAt": "2026-09-16T13:00:00Z",
  "statusCheckRollup": []
}"#;

/// `gh pr list --json …` — the search shape, fewer fields.
const PR_LIST: &str = r#"[
  { "number": 42, "title": "Coalesce PTY output", "url": "https://github.com/acme/raum/pull/42",
    "headRefName": "feat/coalesce", "author": { "login": "andre" }, "isDraft": false,
    "reviewDecision": "APPROVED", "updatedAt": "2026-09-16T10:00:00Z",
    "statusCheckRollup": [
      { "__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS" }
    ] },
  { "number": 45, "title": "Draft idea", "url": "https://github.com/acme/raum/pull/45",
    "headRefName": "idea", "author": null, "isDraft": true,
    "reviewDecision": "", "updatedAt": "2026-09-16T13:00:00Z", "statusCheckRollup": [] }
]"#;

const REPO_VIEW: &str = r#"{
  "allow_squash_merge": false,
  "allow_rebase_merge": true,
  "allow_merge_commit": true,
  "delete_branch_on_merge": true,
  "allow_auto_merge": false,
  "full_name": "andremonaco/raum"
}"#;

const RELEASE_LIST: &str = r#"[
  { "tagName": "v0.1.12", "name": "0.1.12", "publishedAt": "2026-09-10T08:00:00Z",
    "isLatest": true, "isDraft": false, "isPrerelease": false },
  { "tagName": "v0.1.11-rc.1", "name": "", "publishedAt": "2026-09-01T08:00:00Z",
    "isLatest": false, "isDraft": false, "isPrerelease": true }
]"#;

/// Two deployments for `prod` (the newer one is listed second on purpose, so
/// the grouping can't pass by accident) plus one per other environment.
const DEPLOYMENTS: &str = r#"{
  "data": { "repository": { "deployments": { "nodes": [
    { "environment": "prod", "state": "INACTIVE", "createdAt": "2026-09-14T08:00:00Z",
      "updatedAt": "2026-09-14T08:05:00Z", "ref": { "name": "main" },
      "commit": { "abbreviatedOid": "aaa1111", "messageHeadline": "old release" },
      "latestStatus": { "state": "INACTIVE", "description": "superseded",
                        "logUrl": "https://logs/1", "environmentUrl": "https://prod.example" } },
    { "environment": "prod", "state": "ACTIVE", "createdAt": "2026-09-16T08:00:00Z",
      "updatedAt": "2026-09-16T08:05:00Z", "ref": { "name": "main" },
      "commit": { "abbreviatedOid": "bbb2222", "messageHeadline": "ship it" },
      "latestStatus": { "state": "SUCCESS", "description": null,
                        "logUrl": "https://logs/2", "environmentUrl": null } },
    { "environment": "dev", "state": "IN_PROGRESS", "createdAt": "2026-09-16T09:00:00Z",
      "updatedAt": "2026-09-16T09:01:00Z", "ref": { "name": "feat/coalesce" },
      "commit": { "abbreviatedOid": "ccc3333", "messageHeadline": "wip" },
      "latestStatus": null },
    { "environment": "staging", "state": "FAILURE", "createdAt": "2026-09-15T09:00:00Z",
      "updatedAt": "2026-09-15T09:10:00Z", "ref": null, "commit": null, "latestStatus": null }
  ] } } }
}"#;

fn parse_pr(json: &str) -> PullRequest {
    serde_json::from_str::<RawPr>(json)
        .expect("fixture must parse")
        .into_pull_request()
}

/* ---------- check normalisation, rollup, ordering ---------- */

#[test]
fn passing_pr_mixes_check_runs_and_status_contexts() {
    let pr = parse_pr(PR_VIEW_PASSING);
    assert_eq!(pr.number, 42);
    assert_eq!(pr.author.as_deref(), Some("andre"));
    assert_eq!(pr.review_decision.as_deref(), Some("APPROVED"));
    assert_eq!(pr.rollup, CheckBucket::Pass);
    assert_eq!(pr.checks.len(), 2);

    let run = &pr.checks[0];
    assert_eq!(run.name, "test");
    assert_eq!(run.workflow.as_deref(), Some("CI"));
    assert_eq!(
        run.url.as_deref(),
        Some("https://github.com/acme/raum/actions/runs/1")
    );
    assert_eq!(run.completed_at.as_deref(), Some("2026-09-16T09:55:00Z"));

    // A StatusContext has no workflow and no timestamps, but it does have a
    // name (its context) and a description.
    let context = &pr.checks[1];
    assert_eq!(context.name, "license/cla");
    assert_eq!(context.bucket, CheckBucket::Pass);
    assert!(context.workflow.is_none());
    assert!(context.started_at.is_none());
    assert_eq!(context.description.as_deref(), Some("CLA signed"));

    assert_eq!(pr.checks_summary.total, 2);
    assert_eq!(pr.checks_summary.pass, 2);
    assert_eq!(pr.checks_summary.fail, 0);
}

#[test]
fn failing_pr_sorts_broken_first_and_rolls_up_to_fail() {
    let pr = parse_pr(PR_VIEW_FAILING);
    assert_eq!(pr.rollup, CheckBucket::Fail, "a failure outranks a pending");
    let order: Vec<(&str, CheckBucket)> = pr
        .checks
        .iter()
        .map(|c| (c.name.as_str(), c.bucket))
        .collect();
    assert_eq!(
        order,
        vec![
            ("test", CheckBucket::Fail),
            ("build", CheckBucket::Pending),
            ("lint", CheckBucket::Pass),
            ("docs", CheckBucket::Skipped),
        ],
    );
    assert_eq!(pr.checks_summary.fail, 1);
    assert_eq!(pr.checks_summary.pending, 1);
    assert_eq!(pr.checks_summary.pass, 1);
    assert_eq!(pr.checks_summary.skipped, 1);
    // gh reports "no review yet" as an empty string, not null.
    assert!(pr.review_decision.is_none());
}

#[test]
fn queued_check_is_pending() {
    let pr = parse_pr(PR_VIEW_PENDING);
    assert_eq!(pr.rollup, CheckBucket::Pending);
    assert_eq!(pr.merge_state_status, "BLOCKED");
}

#[test]
fn draft_without_checks_rolls_up_to_skipped() {
    let pr = parse_pr(PR_VIEW_DRAFT_NO_CHECKS);
    assert!(pr.is_draft);
    assert!(pr.author.is_none(), "a deleted author must not panic");
    assert!(pr.checks.is_empty());
    assert_eq!(pr.rollup, CheckBucket::Skipped);
    assert_eq!(pr.checks_summary.total, 0);
}

#[test]
fn cancelled_run_counts_against_the_pull_request() {
    let json = r#"{ "number": 1, "statusCheckRollup": [
        { "__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "CANCELLED" }
    ] }"#;
    let pr = parse_pr(json);
    assert_eq!(pr.checks[0].bucket, CheckBucket::Cancelled);
    assert_eq!(pr.rollup, CheckBucket::Fail);
    assert_eq!(pr.checks_summary.fail, 1);
    // Absent fields fall back to the neutral wire values, never to empty
    // strings the frontend would have to special-case.
    assert_eq!(pr.state, "OPEN");
    assert_eq!(pr.mergeable, "UNKNOWN");
    assert_eq!(pr.merge_state_status, "UNKNOWN");
}

/* ---------- search + policy + releases ---------- */

#[test]
fn pr_list_decodes_into_summaries() {
    let raw: Vec<RawPr> = serde_json::from_str(PR_LIST).unwrap();
    let rows: Vec<_> = raw
        .into_iter()
        .map(|pr| {
            let path = (pr.head_ref_name == "feat/coalesce").then(|| "/w/coalesce".to_string());
            pr.into_summary(path)
        })
        .collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].rollup, CheckBucket::Pass);
    assert_eq!(rows[0].worktree_path.as_deref(), Some("/w/coalesce"));
    assert_eq!(rows[1].rollup, CheckBucket::Skipped);
    assert!(rows[1].is_draft);
    assert!(rows[1].worktree_path.is_none());

    // Spotlight renders a "1/1" style count per row, so a summary rides along
    // with every search result and comes from the same normalisation the full
    // PR view uses.
    assert_eq!(rows[0].checks_summary.total, 1);
    assert_eq!(rows[0].checks_summary.pass, 1);
    assert_eq!(
        rows[1].checks_summary,
        super::types::ChecksSummary::default()
    );
}

#[test]
fn search_rows_carry_the_same_counts_as_the_full_view() {
    let full = parse_pr(PR_VIEW_FAILING);
    let row = serde_json::from_str::<RawPr>(PR_VIEW_FAILING)
        .unwrap()
        .into_summary(None);
    assert_eq!(row.checks_summary, full.checks_summary);
    assert_eq!(row.checks_summary.fail, 1);
    assert_eq!(row.checks_summary.total, 4);
    assert_eq!(row.rollup, full.rollup);
}

#[test]
fn pr_number_matches_bare_and_hashed_numbers_only() {
    assert_eq!(pr_number("123").as_deref(), Some("123"));
    assert_eq!(pr_number(" #123 ").as_deref(), Some("123"));
    assert!(pr_number("pr:123").is_none());
    assert!(pr_number("coalesce").is_none());
    assert!(pr_number("#").is_none());
}

#[test]
fn merge_policy_defaults_to_the_first_allowed_method() {
    let policy = serde_json::from_str::<RawRepo>(REPO_VIEW)
        .unwrap()
        .into_policy();
    assert!(!policy.squash);
    assert!(policy.rebase);
    assert!(policy.delete_branch_on_merge);
    assert!(!policy.auto_merge_allowed);
    assert_eq!(policy.default_method, super::types::MergeMethod::Rebase);
}

#[test]
fn releases_get_a_tag_url_on_the_remote_host() {
    let raw: Vec<RawRelease> = serde_json::from_str(RELEASE_LIST).unwrap();
    let releases: Vec<_> = raw
        .into_iter()
        .map(|r| r.into_release("github.example.com", "acme", "raum"))
        .collect();
    assert_eq!(
        releases[0].url,
        "https://github.example.com/acme/raum/releases/tag/v0.1.12"
    );
    assert!(releases[0].is_latest);
    // An empty name is "no name", not a release called "".
    assert!(releases[1].name.is_none());
    assert!(releases[1].is_prerelease);
}

/* ---------- deployments ---------- */

#[test]
fn deployments_keep_the_newest_per_environment_and_map_buckets() {
    let response: DeploymentsResponse = serde_json::from_str(DEPLOYMENTS).unwrap();
    let envs = newest_per_environment(response.data.repository.deployments.nodes);
    let names: Vec<&str> = envs.iter().map(|e| e.environment.as_str()).collect();
    // Newest first: dev (09:00 today), prod (08:00 today), staging (yesterday).
    assert_eq!(names, vec!["dev", "prod", "staging"]);

    let prod = &envs[1];
    assert_eq!(prod.state, "ACTIVE", "the older INACTIVE row must lose");
    assert_eq!(prod.bucket, CheckBucket::Pass);
    assert_eq!(prod.sha.as_deref(), Some("bbb2222"));
    // `gh api graphql` emits real `null`s; they must read as "no URL", not
    // sink the whole response.
    assert_eq!(prod.environment_url, None);
    assert_eq!(prod.log_url.as_deref(), Some("https://logs/2"));

    assert_eq!(envs[0].bucket, CheckBucket::Pending);
    assert_eq!(envs[0].git_ref.as_deref(), Some("feat/coalesce"));
    assert_eq!(envs[2].bucket, CheckBucket::Fail);
    // A deployment with no ref/commit/status still renders.
    assert!(envs[2].git_ref.is_none());
    assert!(envs[2].sha.is_none());
}

#[test]
fn deployment_states_map_onto_the_check_buckets() {
    use super::types::deployment_bucket;
    for state in ["ACTIVE", "SUCCESS"] {
        assert_eq!(deployment_bucket(state), CheckBucket::Pass);
    }
    for state in ["FAILURE", "ERROR"] {
        assert_eq!(deployment_bucket(state), CheckBucket::Fail);
    }
    for state in ["PENDING", "QUEUED", "IN_PROGRESS", "WAITING"] {
        assert_eq!(deployment_bucket(state), CheckBucket::Pending);
    }
    for state in ["INACTIVE", "DESTROYED", "ABANDONED", "WHAT_IS_THIS"] {
        assert_eq!(deployment_bucket(state), CheckBucket::Skipped);
    }
}

#[test]
fn environment_cap_keeps_the_newest_plus_checked_out_branches() {
    let response: DeploymentsResponse = serde_json::from_str(DEPLOYMENTS).unwrap();
    let base = newest_per_environment(response.data.repository.deployments.nodes);
    // Rebuild a long list: eight preview environments newer than everything in
    // the fixture, then the fixture's three.
    let mut many: Vec<_> = (0..8)
        .map(|i| {
            let mut env = base[0].clone();
            env.environment = format!("preview-{i}");
            env.created_at = format!("2026-09-17T0{i}:00:00Z");
            env.git_ref = Some(format!("pr-{i}"));
            env
        })
        .collect();
    many.extend(base.iter().cloned());

    let branches = ["feat/coalesce".to_string()].into_iter().collect();
    let capped = cap_environments(many, &branches);
    let names: Vec<&str> = capped.iter().map(|e| e.environment.as_str()).collect();
    assert_eq!(capped.len(), 9, "eight newest plus the branch match");
    assert!(names.contains(&"dev"), "dev is on a checked-out branch");
    assert!(!names.contains(&"prod"), "prod falls off the cap");
}

#[test]
fn deployment_transition_fires_only_when_an_environment_leaves_pending() {
    let response: DeploymentsResponse = serde_json::from_str(DEPLOYMENTS).unwrap();
    let prev = newest_per_environment(response.data.repository.deployments.nodes);
    assert_eq!(prev[0].bucket, CheckBucket::Pending);

    // Nothing moved.
    assert!(settled_environments(&prev, &prev).is_empty());

    // dev finished.
    let mut next = prev.clone();
    next[0].state = "ACTIVE".to_string();
    next[0].bucket = CheckBucket::Pass;
    let settled = settled_environments(&prev, &next);
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0].environment, "dev");
    assert_eq!(settled[0].bucket, CheckBucket::Pass);

    // An environment that was already settled does not re-announce itself.
    assert!(settled_environments(&next, &next).is_empty());
}

/* ---------- adaptive tick ---------- */

#[test]
fn tick_follows_the_pull_request_state() {
    let pending = parse_pr(PR_VIEW_PENDING);
    let passing = parse_pr(PR_VIEW_PASSING);
    assert_eq!(tick_for(true, Some(&pending)), TICK_HOT);
    assert_eq!(tick_for(true, Some(&passing)), TICK_SETTLED);
    assert_eq!(tick_for(true, None), TICK_IDLE, "no PR for the branch");
    assert_eq!(
        tick_for(false, Some(&pending)),
        TICK_IDLE,
        "an unavailable path never polls hot",
    );
}

/* ---------- transitions ---------- */

#[test]
fn checks_turning_green_and_breaking_are_both_reported() {
    let pending = parse_pr(PR_VIEW_PENDING);
    let passing = parse_pr(PR_VIEW_PASSING);
    let failing = parse_pr(PR_VIEW_FAILING);

    assert_eq!(
        transitions(&pending, &passing),
        vec![
            PrTransitionKind::ChecksPassed,
            PrTransitionKind::ReviewApproved
        ],
    );
    assert_eq!(
        transitions(&pending, &failing),
        vec![PrTransitionKind::ChecksFailed],
    );
    // Still red on the next tick: reported once, not every 10 seconds.
    assert!(transitions(&failing, &failing).is_empty());
    assert!(transitions(&passing, &passing).is_empty());
}

#[test]
fn review_and_merge_edges_are_reported() {
    let base = parse_pr(PR_VIEW_PENDING);

    let mut changes_requested = base.clone();
    changes_requested.review_decision = Some("CHANGES_REQUESTED".to_string());
    assert_eq!(
        transitions(&base, &changes_requested),
        vec![PrTransitionKind::ChangesRequested],
    );

    let mut approved = base.clone();
    approved.review_decision = Some("APPROVED".to_string());
    assert_eq!(
        transitions(&changes_requested, &approved),
        vec![PrTransitionKind::ReviewApproved],
    );

    let mut merged = approved.clone();
    merged.state = "MERGED".to_string();
    assert_eq!(
        transitions(&approved, &merged),
        vec![PrTransitionKind::Merged],
    );
    // A PR that was already merged doesn't announce itself again.
    assert!(transitions(&merged, &merged).is_empty());
}

/* ---------- gh plumbing ---------- */

#[test]
fn branchless_pull_request_is_not_an_error() {
    let no_pr = GhOut {
        stdout: String::new(),
        stderr: "no pull requests found for branch \"feat/x\"".to_string(),
        ok: false,
    };
    assert!(gh::is_no_pr(&no_pr));

    let real_failure = GhOut {
        stdout: String::new(),
        stderr: "gh: Not Found (HTTP 404)".to_string(),
        ok: false,
    };
    assert!(!gh::is_no_pr(&real_failure));
}

#[test]
fn remote_urls_parse_into_host_owner_repo() {
    let cases = [
        ("git@github.com:acme/raum.git", "github.com", "acme", "raum"),
        ("git@github.com:acme/raum", "github.com", "acme", "raum"),
        (
            "ssh://git@github.example.com/acme/raum.git",
            "github.example.com",
            "acme",
            "raum",
        ),
        (
            "ssh://git@github.com:22/acme/raum.git",
            "github.com",
            "acme",
            "raum",
        ),
        (
            "https://github.com/acme/raum.git",
            "github.com",
            "acme",
            "raum",
        ),
        (
            "https://user:token@github.example.com/acme/raum",
            "github.example.com",
            "acme",
            "raum",
        ),
        (
            "  https://GitHub.com/acme/raum/  ",
            "github.com",
            "acme",
            "raum",
        ),
        (
            "git://github.com/acme/raum.git",
            "github.com",
            "acme",
            "raum",
        ),
    ];
    for (url, host, owner, repo) in cases {
        let parsed = gh::parse_remote_url(url).unwrap_or_else(|| panic!("failed to parse {url}"));
        assert_eq!(parsed.host, host, "host of {url}");
        assert_eq!(parsed.owner, owner, "owner of {url}");
        assert_eq!(parsed.repo, repo, "repo of {url}");
    }

    // Not remotes raum can route to GitHub.
    assert!(gh::parse_remote_url("").is_none());
    assert!(gh::parse_remote_url("/srv/git/raum.git").is_none());
    assert!(gh::parse_remote_url("https://github.com/acme").is_none());
}

#[test]
fn only_authenticated_hosts_count_as_available() {
    let hosts = vec!["github.com".to_string(), "github.example.com".to_string()];
    assert!(gh::host_is_authenticated("github.com", &hosts));
    // gh prints hosts lowercase; remotes may not be.
    assert!(gh::host_is_authenticated("GitHub.com", &hosts));
    assert!(!gh::host_is_authenticated("gitlab.com", &hosts));
    assert!(!gh::host_is_authenticated("github.com", &[]));
}

#[test]
fn auth_status_hosts_parse_from_either_stream() {
    // gh ≥ 2.40 shape, written to stderr in some versions and stdout in others.
    let raw = "github.com\n  ✓ Logged in to github.com account andre (keyring)\n\
               github.example.com\n  ✓ Logged in to github.example.com as andre (oauth_token)\n";
    assert_eq!(
        gh::parse_auth_hosts(raw),
        vec!["github.com".to_string(), "github.example.com".to_string()],
    );
    assert!(gh::parse_auth_hosts("You are not logged into any GitHub hosts.").is_empty());
}

#[test]
fn version_is_read_from_the_first_line() {
    let raw = "gh version 2.62.0 (2024-11-14)\nhttps://github.com/cli/cli/releases/tag/v2.62.0\n";
    assert_eq!(gh::parse_version(raw).as_deref(), Some("2.62.0"));
    assert!(gh::parse_version("").is_none());
}
