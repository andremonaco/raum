/**
 * Merge sheet enable/disable matrix — the button must never offer a merge
 * GitHub would reject.
 */
import { render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { MergePrSheet } from "./merge-pr-sheet";
import type { MergePolicy, MergeStateStatus, PullRequest } from "../lib/githubTypes";

const POLICY: MergePolicy = {
  squash: true,
  rebase: false,
  mergeCommit: true,
  deleteBranchOnMerge: true,
  autoMergeAllowed: true,
  defaultMethod: "squash",
};

function makePr(state: MergeStateStatus, pending: number): PullRequest {
  return {
    number: 412,
    title: "Add the thing",
    url: "https://github.com/o/r/pull/412",
    state: "OPEN",
    isDraft: false,
    author: "andre",
    baseRefName: "main",
    headRefName: "feat/x",
    headRefOid: "abc123",
    reviewDecision: "APPROVED",
    mergeable: state === "DIRTY" ? "CONFLICTING" : "MERGEABLE",
    mergeStateStatus: state,
    checks: Array.from({ length: pending }, (_, i) => ({
      name: `check-${i}`,
      bucket: "pending" as const,
      url: null,
      workflow: null,
      startedAt: null,
      completedAt: null,
      description: null,
    })),
    checksSummary: { total: pending, pass: 0, fail: 0, pending, skipped: 0 },
    rollup: pending > 0 ? "pending" : "pass",
    commitCount: 3,
    updatedAt: "2026-09-16T12:00:00Z",
  };
}

const openSheet = (pr: PullRequest, policy: MergePolicy = POLICY) => {
  mockInvoke.mockImplementation((cmd: string) =>
    cmd === "github_merge_policy" ? Promise.resolve(policy) : Promise.resolve(null),
  );
  render(() => (
    <MergePrSheet
      open={true}
      path="/wt/a"
      pr={pr}
      onMerged={() => undefined}
      onClose={() => undefined}
    />
  ));
};

const mergeButton = () =>
  screen.queryAllByRole("button").find((b) => (b.textContent ?? "").startsWith("Merge"));

describe("<MergePrSheet>", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("enables the merge for a CLEAN pull request", async () => {
    openSheet(makePr("CLEAN", 0));
    await waitFor(() => expect(mergeButton()).toBeTruthy());
    expect(mergeButton()).not.toBeDisabled();
    expect(mergeButton()?.textContent).toBe("Merge");
  });

  it("offers auto-merge while checks are pending", async () => {
    openSheet(makePr("UNSTABLE", 3));
    await waitFor(() => expect(mergeButton()?.textContent).toBe("Merge when green"));
    expect(mergeButton()).not.toBeDisabled();
    expect(screen.getByText(/Waiting on check-0, check-1 and 1 more/)).toBeTruthy();
    expect(screen.getByText(/--auto/)).toBeTruthy();
  });

  it("drops the primary action on conflicts and says what to do", async () => {
    openSheet(makePr("DIRTY", 0));
    await waitFor(() => expect(screen.getByText(/Conflicts with the base branch/)).toBeTruthy());
    expect(mergeButton()).toBeUndefined();
  });

  it("disables a method the repository does not allow", async () => {
    openSheet(makePr("CLEAN", 0));
    await waitFor(() => expect(mergeButton()).toBeTruthy());
    const rebase = screen.getByLabelText("Rebase and merge", { exact: false });
    expect(rebase).toBeDisabled();
    expect(screen.getByText("Not allowed by repository settings")).toBeTruthy();
  });
});
