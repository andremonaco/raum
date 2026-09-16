/**
 * Pure helpers behind Spotlight's "Pull requests" group. Kept out of
 * `spotlight-dock.tsx` so the trigger grammar and the row copy are testable
 * without mounting the dock (which drags in xterm, CodeMirror and the keymap
 * provider).
 */

import type { PullRequestSummary } from "./githubTypes";

export interface PrQuery {
  /** What to hand `github_pr_search`; may be empty for a bare `#`. */
  term: string;
  /** True when the user typed `#` / `pr:`, which lifts the group above Sessions. */
  prefixed: boolean;
}

/**
 * Decide whether a spotlight query should search pull requests, and with what
 * term. `#123` and `pr:flaky` search explicitly; anything else needs three
 * characters so every keystroke does not hit `gh`.
 */
export function parsePrQuery(raw: string): PrQuery | null {
  const q = raw.trim();
  if (q.startsWith("#")) return { term: q.slice(1).trim(), prefixed: true };
  if (q.toLowerCase().startsWith("pr:")) return { term: q.slice(3).trim(), prefixed: true };
  if (q.length >= 3) return { term: q, prefixed: false };
  return null;
}

/** `feature/x · in worktree x` or `feature/x · not checked out`. */
export function prBranchLabel(pr: PullRequestSummary): string {
  if (!pr.worktreePath) return `${pr.headRefName} · not checked out`;
  const name = pr.worktreePath.split("/").filter(Boolean).at(-1) ?? pr.worktreePath;
  return `${pr.headRefName} · in worktree ${name}`;
}

/**
 * The dim right-hand summary: draft marker, check counts, review state.
 *
 * A green rollup says nothing — the dot already carries it, and "3/3" next to
 * a green dot is noise. Only a failure count or a still-running tally earns
 * words.
 */
export function prMetaLabel(pr: PullRequestSummary): string {
  const parts: string[] = [];
  const checks = pr.checksSummary;
  if (pr.isDraft) parts.push("draft");
  if (pr.rollup === "fail") parts.push(`${checks.fail} failing`);
  else if (pr.rollup === "pending") parts.push(`${checks.pass}/${checks.total}`);
  if (pr.reviewDecision === "APPROVED") parts.push("approved");
  else if (pr.reviewDecision === "CHANGES_REQUESTED") parts.push("changes requested");
  else if (pr.reviewDecision === "REVIEW_REQUIRED") parts.push("review required");
  return parts.join(" · ");
}

/**
 * Split `text` around the first case-insensitive occurrence of `term`, so the
 * row can mark the match the way the scrollback group does. `match` is empty
 * when the term does not occur (e.g. a `#123` number search).
 */
export function highlightParts(
  text: string,
  term: string,
): { before: string; match: string; after: string } {
  const t = term.trim();
  if (!t) return { before: text, match: "", after: "" };
  const at = text.toLowerCase().indexOf(t.toLowerCase());
  if (at < 0) return { before: text, match: "", after: "" };
  return {
    before: text.slice(0, at),
    match: text.slice(at, at + t.length),
    after: text.slice(at + t.length),
  };
}
