# GitHub pull-request status, search and one-click merge

**Status:** proposal — not yet implemented
**Author:** discussion notes, 2026-09-16
**Companion:** UI mockups published as the "raum PR Radar" artifact (see PR description / chat).

## Problem

Every worktree in raum maps to a branch, and most branches end up as a pull
request. Today the loop "did CI go green? is it approved? can I merge?" means
leaving raum for github.com, finding the PR, waiting on the checks page, and
coming back. With five worktrees running five agents in parallel this is the
single most frequent context switch left in the workflow.

Goal: inside raum, per worktree, see the PR that belongs to the branch, its
check status and review state live, get notified when checks settle, search
PRs of the project, and merge with one click. Per project, see the latest
release and the state of every deployment environment (dev / prod / …) the
way the GitHub repo sidebar shows them.

## Decision: opt-in via the `gh` CLI, no native GitHub client

`docs/privacy.md` promises exactly one outbound network call from raum (the
updater). `crates/raum-core/tests/no_outbound_network.rs` enforces it by
rejecting `reqwest` / `hyper` / `octocrab` etc. as direct dependencies outside
`tauri-plugin-updater` and the loopback-only `raum-core` OpenCode path.

Shelling out to `gh` keeps that promise the same way harness binaries do: the
network call is originated by a third-party binary the user installed and
authenticated (`gh auth login`), raum stores no token, and no new crate is
pulled in. It mirrors how every git operation already works
(`src-tauri/src/git.rs` subprocess wrappers).

Consequences:

- The feature is **off** until `gh` is found on `PATH` and `gh auth status`
  succeeds. Settings → Prerequisites shows the probe result like it does for
  harness binaries today (`crates/raum-core/src/prereqs.rs`).
- `docs/privacy.md` gets a section: "GitHub integration (opt-in, via gh)".
- GitHub Enterprise works through `GH_HOST` / gh's own host config; raum
  only checks that the `origin` remote host matches a host gh is logged into.

## Live updates: adaptive polling, not webhooks

GitHub offers no client-side push channel. Webhooks need a public HTTPS
endpoint; `gh webhook forward` needs repo admin and is beta; a relay server
would mean raum operates infrastructure, which privacy.md rules out. GitHub's
own `gh pr checks --watch` and `gh run watch` poll. So does this feature, but
the poll rate follows the PR state:

| Stream        | State                                              | Tick     |
| ------------- | -------------------------------------------------- | -------- |
| PR (per path) | any check `queued` / `in_progress`                 | 10 s     |
| PR (per path) | all checks settled, PR open                        | 90 s     |
| PR (per path) | no open PR for the branch                          | 5 min    |
| Deployments   | any deployment `PENDING` / `QUEUED` / `IN_PROGRESS` / `WAITING` | 10 s |
| Deployments   | every environment settled                          | 2 min    |
| Releases      | always                                             | 5 min + focus |
| all           | window unfocused, or project not active            | paused   |
| all           | remote host is not a gh-authenticated GitHub host  | never    |

PR polling is per worktree path. Deployments and releases are per
**project** (repo), one task each, since they are not branch-scoped.

Triggers that force an immediate recompute: window focus, a local push (see
"remote-ref pulse" below), a merge or search action from the UI, a manual
refresh. Recompute results are diffed against the cached value and emitted
only on change, exactly like `status_service.rs`.

Budget: the hot loop is one `gh pr view --json …` (one GraphQL point) per
worktree per 10 s. Five hot PRs = 1 800 requests/h against a 5 000/h
authenticated limit. Settled PRs cost 40/h each. Batching all open PRs of a
project into a single aliased GraphQL query via `gh api graphql` is the
fallback if a project has many worktrees; it is not needed for v1.

## Scope

### v1 (this proposal)

1. **PR chip** on the worktree row in the sidebar: number, checks rollup
   glyph, review state, draft marker. Click opens the PR view.
2. **Pull request view** as a fourth tab in the worktree detail
   (Changes / History / Files / PR): title, state, base→head, reviewers,
   every check with its bucket and a link to the run, merge readiness,
   and the merge button.
3. **One-click merge** via `gh pr merge` with a confirmation sheet: merge
   method (repo-allowed methods, default = repo default), delete remote
   branch, "auto-merge when checks pass" (`--auto`) when checks are still
   pending. After a successful merge raum offers the existing
   delete-worktree flow; it never removes the worktree by itself.
4. **PR search** in Spotlight (`⌘F`): typing `#123`, `pr:` or a title
   fragment lists open PRs of the active project. Activating one focuses
   the matching worktree (if the branch is checked out) or opens the PR
   on github.com via the opener plugin.
5. **Notifications** on state transitions: checks turned green, checks
   failed, review approved / changes requested, PR merged elsewhere.
   Routed through `notificationCenter`; OS banner only when raum is
   backgrounded, in-app toast + attention rail otherwise.
6. **Deployments** per project: one row per environment with the latest
   deployment's state, age, ref and commit, matching the GitHub repo
   sidebar (`dev · 3 minutes ago ✓`). Rows whose ref is the worktree's
   branch are highlighted in that worktree's view. Environment URL and log
   URL open via the opener plugin.
7. **Releases** per project: latest release (tag, name, age, `Latest` /
   pre-release / draft marker) plus the last ten, with the release page
   link. Release assets and notes stay on github.com in v1.
8. **Prerequisite probe** for `gh` with auth status.

### v2 (explicitly deferred)

- Create a PR from a worktree (`gh pr create`), review-comment inbox, re-run
  failed jobs (`gh run rerun`), `gh webhook forward` as an opt-in
  accelerator for repo admins.
- Cross-project "all PRs" board.

## Data source

Everything comes from `gh` with `--json`. Environment for every call:
`GH_NO_UPDATE_NOTIFIER=1`, `GH_PROMPT_DISABLED=1`, `NO_COLOR=1`,
`current_dir` = worktree path (gh derives owner/repo and branch from cwd).
A 20 s timeout kills hung calls.

| Purpose                     | Command                                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preflight                   | `gh auth status --hostname <host>`; `gh --version`                                                                                                        |
| PR for the current branch   | `gh pr view --json number,title,url,state,isDraft,author,baseRefName,headRefName,headRefOid,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,reviews,updatedAt` |
| Checks detail               | `gh pr checks <n> --json name,state,bucket,link,workflow,startedAt,completedAt,description`                                                              |
| Search                      | `gh pr list --state open --limit 30 --search "<q>" --json number,title,headRefName,author,isDraft,reviewDecision,statusCheckRollup,updatedAt,url`         |
| Repo merge policy           | `gh api repos/{owner}/{repo}` (REST: `allow_squash_merge`, `allow_rebase_merge`, `allow_merge_commit`, `delete_branch_on_merge`, `allow_auto_merge`; `gh repo view --json` has no auto-merge field) |
| Merge                       | `gh pr merge <n> --squash\|--merge\|--rebase [--auto]`; remote branch deleted via `gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/<head>` (never `--delete-branch`: it checks out the base branch and pulls in the cwd) |
| Releases                    | `gh release list --limit 10 --json tagName,name,publishedAt,isLatest,isDraft,isPrerelease` (gh ≥ 2.42)                                                  |
| Deployments                 | one `gh api graphql` query, see below                                                                                                                     |

Deployments have no `gh` subcommand, and the REST shape
(`/deployments` then `/deployments/{id}/statuses` per row) costs one call per
environment. One GraphQL query returns everything the sidebar needs:

```graphql
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    deployments(last: 30, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        environment state createdAt updatedAt
        ref { name }
        commit { abbreviatedOid messageHeadline }
        latestStatus { state description logUrl environmentUrl }
      }
    }
  }
}
```

raum groups nodes by `environment` and keeps the newest per environment.
`state ∈ {ACTIVE, SUCCESS, FAILURE, ERROR, INACTIVE, PENDING, QUEUED,
IN_PROGRESS, WAITING, DESTROYED, ABANDONED}` maps onto the same
`pass / fail / pending / skipped` buckets as checks so one glyph set serves
PR checks and deployments.

Notes on fields:

- `statusCheckRollup` items are either `CheckRun`
  (`name`, `status`, `conclusion`, `detailsUrl`, `workflowName`) or
  `StatusContext` (`context`, `state`, `targetUrl`). Normalise both into
  one `Check { name, bucket, url, workflow }` where
  `bucket ∈ {pass, fail, pending, skipped, cancelled}` — the same buckets
  `gh pr checks` uses.
- `mergeStateStatus ∈ {CLEAN, BEHIND, BLOCKED, DIRTY, DRAFT, HAS_HOOKS,
  UNSTABLE, UNKNOWN}` drives the merge button: only `CLEAN` and
  `HAS_HOOKS` enable "Merge now"; `UNSTABLE`/`BLOCKED` with pending checks
  enable "Merge when green" (`--auto`); `DIRTY` shows "conflicts, rebase
  first"; `BEHIND` offers `gh pr update-branch` (v1 nice-to-have).
- `reviewDecision ∈ {APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, ""}`.
- `gh pr view` exits 1 with "no pull requests found" when the branch has
  no PR. That is the normal "no PR" state, not an error.

Remote detection happens once per worktree without spawning `gh`:
`git remote get-url origin`, parse the host; skip the worktree unless the
host is one that `gh auth status` reported as logged in.

## Backend design

New module `src-tauri/src/commands/github/`:

```
github/
  mod.rs          # command registration, shared types
  gh.rs           # subprocess wrapper: env, timeout, JSON decode, error mapping
  types.rs        # PullRequest, Check, CheckBucket, MergeReadiness, GhStatus (serde, camelCase)
  pr_service.rs   # per-worktree poll tasks, adaptive tick, cache + diff, events
  repo_service.rs # per-project deployments + releases tasks (same reconciler shape)
  search.rs       # github_pr_search command
  merge.rs        # github_pr_merge command + repo merge-policy lookup
  tests.rs        # fixture-driven parsing + tick/transition tests
```

`pr_service.rs` is a sibling of `worktree/status_service.rs` with the same
shape: the frontend pushes the set of mounted worktree paths
(`github_pr_subscribe`), the service reconciles tasks against that set, each
task recomputes on trigger or tick, and emits `github-pr-changed
{ path, pr: PullRequest | null }` only when the value differs from the cache.
Differences from the status service:

- The tick length is a function of the cached state (table above) instead of
  a fixed 15 s.
- A second event, `github-pr-transition { path, kind, pr }`, fires when the
  diff crosses a notification-worthy edge: `checks: pending→pass`,
  `checks: *→fail`, `review: *→APPROVED`, `review: *→CHANGES_REQUESTED`,
  `state: OPEN→MERGED`. The notification centre owns what to do with it.
- Tasks run only for the active project (same rule as the git watcher and
  the working-tree FS watcher). Activating a project seeds its rows from
  cache immediately and refreshes in the background.

`repo_service.rs` runs two tasks for the active project: deployments (one
GraphQL query, grouped per environment, hot tick while any deployment is in
flight) and releases (`gh release list`, slow tick). They emit
`github-deployments-changed { slug, environments[] }` and
`github-releases-changed { slug, releases[] }` on diff, and
`github-deployment-transition { slug, environment, from, to }` when an
environment leaves `pending` (green: "prod deployed", red: "dev deploy
failed") for the notification centre.

**Remote-ref pulse.** A push from a pane updates
`.git/refs/remotes/origin/<branch>` (or `packed-refs`). `git_watcher.rs`
watches `.git/` non-recursively for `HEAD`/`index`; extend it to also watch
`.git/refs/remotes/origin/` and forward a `Remote` pulse to the PR service,
which jumps the affected worktree into the hot tick. This is the cheapest
way to make "I just pushed" feel live without any GitHub round trip.

Tauri commands:

| Command                | Args                                  | Returns                          |
| ---------------------- | ------------------------------------- | -------------------------------- |
| `github_status`        | —                                     | `GhStatus { installed, version, hosts[] }` |
| `github_pr_subscribe`  | `paths: string[]`                     | —                                |
| `github_pr_refresh`    | `path`                                | —                                |
| `github_pr_checks`     | `path, number`                        | `Check[]`                        |
| `github_pr_search`     | `projectSlug, query, limit`           | `PullRequestSummary[]`           |
| `github_merge_policy`  | `path`                                | `MergePolicy`                    |
| `github_pr_merge`      | `path, number, method, deleteBranch, auto` | `MergeOutcome`              |
| `github_repo_subscribe`| `slug \| null`                        | —  (active project only)          |
| `github_repo_refresh`  | `slug`                                | —                                |

`github_pr_merge` triggers `github_pr_refresh` and the worktree status
service for the path afterwards so both the chip and ahead/behind update
without waiting for the next tick.

## Frontend design

- `frontend/src/stores/githubStore.ts`: `prForPath(path)`,
  `subscribeGithubEvents()`, `retain/releasePrStream(path)` mirroring the
  worktree-status subscription helpers, plus `ghStatus()` for the
  prerequisite gate.
- `components/sidebar/worktree-tab.tsx`: PR chip on line 2 after the
  ahead/behind counters. Quiet by default (mono, `text-foreground-subtle`);
  only the rollup glyph carries semantic colour (`text-success`,
  `text-destructive`, `text-warning`, pulsing while pending). No stripes,
  no glow — consistent with the tab-styling restraint rule.
- `components/sidebar/worktree-detail.tsx`: fourth tab `github` with
  `github-view.tsx`: the branch's PR (header, reviewers, checks list, merge
  footer) on top, then the repo-wide **Deployments** and **Releases**
  sections. In non-base worktrees the two repo sections are collapsed by
  default and the deployment rows whose ref matches the branch are lifted
  to the top. Tab is hidden when `gh` is unavailable or the remote is not
  GitHub.
- `components/sidebar/worktree-tab.tsx` (base worktree only): environment
  dots after the branch — one 6 px dot per environment in its bucket
  colour, tooltip `prod · yesterday`. Keeps the deployment picture visible
  without opening the tab.
- `components/merge-pr-sheet.tsx`: confirmation dialog, method radio
  filtered by repo policy, delete-branch toggle, `--auto` toggle when
  checks are pending, blockers listed verbatim from `mergeStateStatus`.
- `components/spotlight-dock.tsx`: new result group "Pull requests" when
  the query starts with `#`, `pr:` or when the active project has a
  GitHub remote and the query is ≥ 3 chars. Debounced 250 ms, one
  `github_pr_search` call in flight at a time.
- `lib/notificationCenter.ts`: handle `github-pr-transition` and
  `github-deployment-transition` next to agent state changes; reuse the
  focus gate and the attention rail row type (new kinds `pr`, `deploy`).
- Settings → Prerequisites: `gh` row with version, auth hosts, and the
  "Sign in with `gh auth login`" hint when missing.

## Privacy, tests, docs

- `docs/privacy.md`: new section describing the opt-in, that requests are
  originated by the `gh` binary, what is sent (repo + branch names in the
  API query, nothing from panes), and how to disable (uninstall gh or log
  out).
- No new crate dependencies; `no_outbound_network.rs` stays untouched.
- Rust tests: JSON fixtures for `gh pr view` (CheckRun + StatusContext mix,
  draft, no-PR exit), `gh pr list`, `gh api repos/{owner}/{repo}`, `gh release list`, the
  deployments GraphQL response (grouping per environment, newest wins,
  state→bucket mapping); adaptive-tick selection
  per state; transition detection edges; merge-readiness mapping from
  `mergeStateStatus`.
- Vitest: chip rendering per rollup state, spotlight PR result group,
  merge sheet enable/disable matrix.

## Phases

| Phase | Deliverable                                                                  | Size (rough)        |
| ----- | ---------------------------------------------------------------------------- | ------------------- |
| 0     | `gh` probe in prereqs, `github_status`, privacy.md section                   | ½ day               |
| 1     | `gh.rs` wrapper + types + `pr_service.rs` with adaptive tick + chip in sidebar | 1½ days           |
| 2     | GitHub tab with PR checks list; remote-ref pulse in git watcher               | 1 day               |
| 2b    | `repo_service.rs`: deployments (GraphQL) + releases sections, env dots        | 1 day               |
| 3     | Merge policy + `github_pr_merge` + merge sheet + post-merge worktree offer     | 1 day               |
| 4     | Spotlight PR search                                                          | ½ day               |
| 5     | Transition notifications (toast, rail, focus-gated banner)                    | ½ day               |

Each phase ships on its own; phase 1 alone already removes most of the
github.com round trips.

## Open questions

- Minimum `gh` version: `statusCheckRollup` and `gh pr checks --json` need
  gh ≥ 2.20 (2022). Probe and refuse older versions with a hint.
- Multiple remotes / fork workflows: v1 uses `origin` only. `gh` itself
  resolves fork PRs by head branch, so PRs opened from a fork still show.
- Should the PR chip also appear in the collapsed sidebar (icon-only
  rail)? Proposal: a 6 px dot in the rollup colour, nothing more.
- Auto-merge (`--auto`) needs the repo setting "Allow auto-merge". Detected
  via `allow_auto_merge` on the REST repository object; the toggle is hidden
  otherwise.
- Deployments GraphQL needs the `repo_deployment` scope, which the default
  `gh auth login` token has. Fine-grained PATs may lack it; surface the
  GraphQL error text in the section instead of hiding it.
- Repos with hundreds of environments (preview-per-PR patterns): cap the
  section at the 8 most recently deployed environments plus the ones whose
  ref matches an open worktree branch.
