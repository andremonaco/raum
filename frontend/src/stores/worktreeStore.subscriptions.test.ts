/**
 * Task 6.3 — the worktree-status subscription push is deduplicated.
 *
 * The push is declarative (the whole path set every time), so the cost of a
 * redundant one is a backend round-trip plus a task diff. Window focus can
 * fire several signals for one return, and sidebar remounts churn refcounts
 * that net out to the same set.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import {
  releaseWorktreeStatusStream,
  resyncStatusSubscriptions,
  retainWorktreeStatusStream,
} from "./worktreeStore";

/** The push is armed in a microtask; drain it plus the invoke settlement. */
const settle = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

const subscribeCalls = () =>
  invokeMock.mock.calls.filter(([cmd]) => cmd === "worktree_status_subscribe");

describe("worktree status subscriptions", () => {
  beforeEach(async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    // Leave the module's refcounts and last-pushed key in a known state.
    retainWorktreeStatusStream("/reset");
    await settle();
    releaseWorktreeStatusStream("/reset");
    await settle();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("pushes the full set once for a burst of retains", async () => {
    retainWorktreeStatusStream("/a");
    retainWorktreeStatusStream("/b");
    await settle();
    expect(subscribeCalls()).toEqual([["worktree_status_subscribe", { paths: ["/a", "/b"] }]]);

    releaseWorktreeStatusStream("/a");
    releaseWorktreeStatusStream("/b");
    await settle();
  });

  it("skips a refcount churn that lands on the same set", async () => {
    retainWorktreeStatusStream("/a");
    await settle();
    expect(subscribeCalls()).toHaveLength(1);

    // Second consumer of the same path, then one releases: same set, no push.
    retainWorktreeStatusStream("/a");
    releaseWorktreeStatusStream("/a");
    await settle();
    expect(subscribeCalls()).toHaveLength(1);

    releaseWorktreeStatusStream("/a");
    await settle();
    expect(subscribeCalls()).toHaveLength(2);
    expect(subscribeCalls()[1]).toEqual(["worktree_status_subscribe", { paths: [] }]);
  });

  it("collapses repeated focus resyncs into one in-flight request", async () => {
    retainWorktreeStatusStream("/a");
    await settle();
    expect(subscribeCalls()).toHaveLength(1);

    let release: (() => void) | undefined;
    invokeMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    resyncStatusSubscriptions();
    await settle();
    expect(subscribeCalls()).toHaveLength(2);

    // Native focus + document-visible for the same return.
    resyncStatusSubscriptions();
    resyncStatusSubscriptions();
    await settle();
    expect(subscribeCalls()).toHaveLength(2);

    release?.();
    await settle();
    // Exactly one catch-up push for the signals that arrived mid-flight.
    expect(subscribeCalls()).toHaveLength(3);

    releaseWorktreeStatusStream("/a");
    await settle();
  });

  it("re-pushes an unchanged set on resync so a dead watch task revives", async () => {
    retainWorktreeStatusStream("/a");
    await settle();
    expect(subscribeCalls()).toHaveLength(1);

    resyncStatusSubscriptions();
    await settle();
    expect(subscribeCalls()).toEqual([
      ["worktree_status_subscribe", { paths: ["/a"] }],
      ["worktree_status_subscribe", { paths: ["/a"] }],
    ]);

    releaseWorktreeStatusStream("/a");
    await settle();
  });
});
