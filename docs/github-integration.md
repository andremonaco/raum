# GitHub integration

Every worktree in raum maps to a branch, and most branches end up as a pull
request. This integration brings that pull request into raum: its checks,
reviewers, deployments and releases, plus one-click merge — so "did CI go
green?" stops being a trip to github.com.

It is **opt-in and off by default**. raum has no GitHub client of its own. It
shells out to GitHub's `gh` CLI, which you install and authenticate yourself,
exactly the way raum already shells out to `git`. No token is stored by raum.
See [Privacy](./privacy.md#github-integration-opt-in-via-gh) for what is sent.

## Prerequisites

1. Install `gh` version **2.42 or newer** from <https://cli.github.com>
   (`brew install gh`, `apt install gh`).
2. Authenticate once: `gh auth login`. Any pane inside raum works.
3. Open **Settings → Harnesses → Prerequisites**. The GitHub CLI row shows
   `✓ active` with the hosts you are logged in to. If it shows `○ sign in`,
   run `gh auth login` and press **Re-check**.

The features stay hidden for any worktree whose `origin` remote is not a host
`gh` is logged into, so non-GitHub repos are unaffected.

## What appears where

**PR chip on the worktree row.** In the sidebar, each worktree gets the PR
number for its branch, a rollup glyph for the checks, the review state and a
draft marker. It is deliberately quiet — only the glyph carries colour.
Clicking it opens the pull-request view.

**Environment dots on the base row.** The base worktree row carries one small
dot per deployment environment in its bucket colour, with a tooltip like
`prod · yesterday`. It mirrors the environment list in GitHub's own repo
sidebar.

**GitHub tab in the worktree detail.** A fourth tab next to Changes, History
and Files:

- the branch's pull request — title, state, base and head, reviewers, and
  every check with its result and a link to the run;
- **Deployments** — one row per environment with the latest deployment's
  state, age, ref and commit. Rows whose ref matches the worktree's branch
  are lifted to the top;
- **Releases** — the latest release plus the last ten, with tag, age and the
  `Latest` / pre-release / draft markers.

The tab is hidden when `gh` is unavailable or the remote is not GitHub.

**Search in Spotlight.** `⌘F`, then type `#123`, a `pr:` prefix, or a
fragment of a title. Open pull requests of the active project appear as their
own result group. Activating one focuses the worktree that has the branch
checked out, or opens the PR on github.com when no worktree matches.

**One-click merge.** The merge button in the GitHub tab opens a confirmation
sheet: merge method (limited to what the repo allows, defaulting to the repo
default), delete-the-remote-branch toggle, and **Merge when green** when
checks are still running. Merge when green uses `gh pr merge --auto`, so
GitHub completes the merge once the checks pass; the toggle is hidden when
the repo has auto-merge disabled. Blockers such as conflicts or a failing
required check are listed verbatim and disable the button. After a merge raum
offers its normal delete-worktree flow — it never removes a worktree on its
own.

**Notifications.** Checks turning green, checks failing, a review landing, and
a PR merged elsewhere all route through the notification centre, together with
deployments leaving the pending state. The usual focus gate applies: an OS
banner only when raum is in the background, otherwise the in-app toast and the
attention rail.

## Refresh rate and API budget

There is no push channel for GitHub clients, so raum polls, at a rate that
follows the state.

| Stream      | State                            | Tick       |
| ----------- | -------------------------------- | ---------- |
| Pull request | any check running               | 10 s       |
| Pull request | all checks settled, PR open     | 90 s       |
| Pull request | branch has no PR                | 5 min      |
| Deployments | any deployment in flight         | 10 s       |
| Deployments | every environment settled        | 2 min      |
| Releases    | always                           | 5 min      |
| all         | window unfocused, project inactive | paused   |

A push from a pane is picked up immediately: raum watches the remote ref and
jumps the affected worktree into the fast tick, so a fresh PR shows up without
waiting for the slow poll.

Five actively building pull requests cost roughly 1 800 requests per hour
against GitHub's authenticated limit of 5 000. Settled pull requests cost
about 40 per hour each. If you hit the limit, `gh` reports it and raum shows
the message in the GitHub tab; polling backs off until the window resets.

## Troubleshooting

**"Not logged in" in Settings.** `gh auth status` found no host. Run
`gh auth login` in any pane, then press Re-check in Settings.

**Enterprise host.** Log in per host: `gh auth login --hostname
github.your-company.com`. raum matches the host of your `origin` remote
against the list `gh auth status` reports, so both github.com and an
Enterprise host can be active at once.

**Deployments section shows a permissions error.** The deployments query
needs the `repo_deployment` scope. A token from `gh auth login` has it; a
fine-grained personal access token often does not. Re-run `gh auth login`, or
add the scope with `gh auth refresh -s repo_deployment`.

**"gh version too old".** Releases need `gh` 2.42 and the checks rollup needs
2.20. Upgrade with `brew upgrade gh` or your package manager, then Re-check.

**No PR chip on a branch that has a PR.** raum resolves the PR through `gh`
from the worktree directory, using the `origin` remote only. A branch pushed
to a different remote is not picked up in this version.

**Everything is hidden.** Confirm the prerequisite row says `✓ active`, then
confirm the project is the active one — polling runs only for the project you
are working in.
