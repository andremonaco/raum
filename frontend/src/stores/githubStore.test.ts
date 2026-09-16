/**
 * githubStore — event fan-in, declarative PR subscription set, and the
 * compact age formatter.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
/** Event name → the handler `subscribeGithubEvents` registered for it. */
const handlers = new Map<string, (ev: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (ev: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }),
}));

import {
  __resetGithubStoreForTests,
  deploymentsForProject,
  envDotsForProject,
  formatAge,
  prForPath,
  releasePrStream,
  releasesForProject,
  retainPrStream,
  subscribeGithubEvents,
} from "./githubStore";
import type { PullRequest } from "../lib/githubTypes";

/** The subscription push is armed in a microtask. */
const settle = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

const subscribeCalls = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "github_pr_subscribe");

const pr = (number: number): PullRequest => ({
  number,
  title: "Add the thing",
  url: `https://github.com/o/r/pull/${number}`,
  state: "OPEN",
  isDraft: false,
  author: "andre",
  baseRefName: "main",
  headRefName: "feat/x",
  headRefOid: "abc123",
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  checks: [],
  checksSummary: { total: 0, pass: 0, fail: 0, pending: 0, skipped: 0 },
  rollup: "pass",
  updatedAt: "2026-09-16T12:00:00Z",
});

describe("githubStore", () => {
  beforeEach(async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    handlers.clear();
    __resetGithubStoreForTests();
    await settle();
  });

  it("applies pr, deployment and release events", async () => {
    await subscribeGithubEvents();

    handlers.get("github-pr-changed")?.({
      payload: { path: "/wt/a", pr: pr(412), available: true },
    });
    handlers.get("github-deployments-changed")?.({
      payload: {
        slug: "demo",
        environments: [
          {
            environment: "prod",
            state: "ACTIVE",
            bucket: "pass",
            ref: "main",
            sha: "abc123",
            message: null,
            createdAt: "2026-09-16T11:00:00Z",
            updatedAt: "2026-09-16T11:00:00Z",
            environmentUrl: null,
            logUrl: null,
          },
        ],
      },
    });
    handlers.get("github-releases-changed")?.({
      payload: {
        slug: "demo",
        releases: [
          {
            tagName: "v1.2.0",
            name: null,
            publishedAt: "2026-09-15T11:00:00Z",
            isLatest: true,
            isDraft: false,
            isPrerelease: false,
            url: "https://github.com/o/r/releases/tag/v1.2.0",
          },
        ],
      },
    });

    expect(prForPath("/wt/a")?.pr?.number).toBe(412);
    expect(deploymentsForProject("demo")).toHaveLength(1);
    expect(releasesForProject("demo")[0]?.tagName).toBe("v1.2.0");
    expect(envDotsForProject("demo", Date.parse("2026-09-16T11:03:00Z"))).toEqual([
      { environment: "prod", bucket: "pass", ageLabel: "3m" },
    ]);
  });

  it("marks a non-GitHub worktree unavailable so chrome hides", async () => {
    await subscribeGithubEvents();
    const apply = handlers.get("github-pr-changed");

    apply?.({ payload: { path: "/wt/a", pr: pr(412), available: true } });
    apply?.({ payload: { path: "/wt/a", pr: null, available: false } });

    expect(prForPath("/wt/a")).toEqual({ pr: null, available: false });
    // No event at all stays distinct from "no PR" — that is the loading state.
    expect(prForPath("/wt/unknown")).toBeUndefined();
  });

  it("pushes the full path set once per burst and skips no-op churn", async () => {
    retainPrStream("/wt/a");
    retainPrStream("/wt/b");
    await settle();
    expect(subscribeCalls()).toEqual([["github_pr_subscribe", { paths: ["/wt/a", "/wt/b"] }]]);

    // Remount churn: release + retain the same path lands on the same set.
    releasePrStream("/wt/a");
    retainPrStream("/wt/a");
    await settle();
    expect(subscribeCalls()).toHaveLength(1);

    releasePrStream("/wt/a");
    releasePrStream("/wt/b");
    await settle();
    expect(subscribeCalls()[1]).toEqual(["github_pr_subscribe", { paths: [] }]);
  });

  it("formats ages compactly", () => {
    const now = Date.parse("2026-09-16T12:00:00Z");
    expect(formatAge("2026-09-16T11:59:20Z", now)).toBe("40s");
    expect(formatAge("2026-09-16T11:57:00Z", now)).toBe("3m");
    expect(formatAge("2026-09-15T11:00:00Z", now)).toBe("yesterday");
    expect(formatAge("2026-09-13T12:00:00Z", now)).toBe("3d");
    expect(formatAge(null, now)).toBe("");
  });
});
