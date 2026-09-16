import { describe, expect, it } from "vitest";

import { highlightParts, parsePrQuery, prBranchLabel, prMetaLabel } from "./githubSpotlight";
import type { PullRequestSummary } from "./githubTypes";

function summary(over: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 412,
    title: "Fix the flaky bridge test",
    url: "https://github.com/acme/raum/pull/412",
    headRefName: "fix/flaky-bridge",
    author: "andre",
    isDraft: false,
    reviewDecision: null,
    rollup: "pass",
    checksSummary: { total: 7, pass: 7, fail: 0, pending: 0, skipped: 0 },
    updatedAt: "2026-09-16T10:00:00Z",
    worktreePath: null,
    ...over,
  };
}

describe("parsePrQuery", () => {
  it("strips the # and pr: prefixes and marks them as explicit", () => {
    expect(parsePrQuery("#412")).toEqual({ term: "412", prefixed: true });
    expect(parsePrQuery("pr: flaky")).toEqual({ term: "flaky", prefixed: true });
    expect(parsePrQuery("PR:flaky")).toEqual({ term: "flaky", prefixed: true });
  });

  it("treats a bare # as 'list open PRs'", () => {
    expect(parsePrQuery("#")).toEqual({ term: "", prefixed: true });
  });

  it("searches unprefixed queries only from three characters on", () => {
    expect(parsePrQuery("fl")).toBeNull();
    expect(parsePrQuery("  ")).toBeNull();
    expect(parsePrQuery("flaky")).toEqual({ term: "flaky", prefixed: false });
  });
});

describe("prBranchLabel", () => {
  it("names the worktree when the branch is checked out", () => {
    expect(prBranchLabel(summary({ worktreePath: "/tmp/raum/.raum/fix-flaky" }))).toBe(
      "fix/flaky-bridge · in worktree fix-flaky",
    );
  });

  it("says so when it is not", () => {
    expect(prBranchLabel(summary())).toBe("fix/flaky-bridge · not checked out");
  });
});

describe("prMetaLabel", () => {
  it("counts passed checks while any are still running", () => {
    expect(
      prMetaLabel(
        summary({
          rollup: "pending",
          checksSummary: { total: 7, pass: 3, fail: 0, pending: 4, skipped: 0 },
          reviewDecision: "REVIEW_REQUIRED",
        }),
      ),
    ).toBe("3/7 · review required");
  });

  it("counts failures on a red rollup", () => {
    expect(
      prMetaLabel(
        summary({
          rollup: "fail",
          checksSummary: { total: 7, pass: 5, fail: 1, pending: 1, skipped: 0 },
        }),
      ),
    ).toBe("1 failing");
  });

  it("says nothing about checks that all passed — the dot carries that", () => {
    expect(prMetaLabel(summary({ rollup: "pass", reviewDecision: "APPROVED" }))).toBe("approved");
  });

  it("leads with the draft marker", () => {
    expect(
      prMetaLabel(
        summary({
          isDraft: true,
          rollup: "pending",
          checksSummary: { total: 2, pass: 0, fail: 0, pending: 2, skipped: 0 },
        }),
      ),
    ).toBe("draft · 0/2");
  });

  it("is empty when nothing is worth saying", () => {
    expect(prMetaLabel(summary({ rollup: "skipped" }))).toBe("");
  });
});

describe("highlightParts", () => {
  it("splits around the first case-insensitive hit", () => {
    expect(highlightParts("Fix the flaky bridge", "FLAKY")).toEqual({
      before: "Fix the ",
      match: "flaky",
      after: " bridge",
    });
  });

  it("returns the whole string unmarked when the term is absent or empty", () => {
    expect(highlightParts("Fix it", "412")).toEqual({ before: "Fix it", match: "", after: "" });
    expect(highlightParts("Fix it", "")).toEqual({ before: "Fix it", match: "", after: "" });
  });
});
