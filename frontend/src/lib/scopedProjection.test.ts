import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import {
  __resetRuntimeLayoutForTests,
  LAYOUT_UNIT,
  layoutRev,
  runtimeLayoutStore,
  splitPane,
  type PaneContent,
  type RuntimeCell,
} from "../stores/runtimeLayoutStore";
import {
  __projectionCacheSizeForTests,
  __resetProjectionCacheForTests,
  getScopedProjection,
  setProjectionCacheMaxSize,
} from "./scopedProjection";
import { ALL_WORKTREES_SCOPE, type WorktreeScope } from "../stores/worktreeStore";

function pane(id: string, overrides: Partial<PaneContent> = {}): PaneContent {
  const tabId = `tab-${id}`;
  return {
    id,
    kind: "claude-code",
    tabs: [{ id: tabId }],
    activeTabId: tabId,
    projectSlug: "alpha",
    worktreeId: "/tmp/alpha",
    ...overrides,
  };
}

function cellFrom(p: PaneContent, x = 0, y = 0): RuntimeCell {
  return { ...p, x, y, w: LAYOUT_UNIT, h: LAYOUT_UNIT };
}

function call(slug: string, scope: WorktreeScope, mainPath: string | undefined) {
  return getScopedProjection({
    layoutRev: layoutRev(),
    tree: runtimeLayoutStore.tree,
    panes: runtimeLayoutStore.panes,
    slug,
    scope,
    mainPath,
  });
}

describe("scopedProjection cache", () => {
  beforeEach(() => {
    __resetRuntimeLayoutForTests();
    __resetProjectionCacheForTests();
  });

  it("returns identical objects for repeated calls on an unchanged layout", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b", { projectSlug: "beta", worktreeId: "/tmp/beta" }), "a", "right");

    const first = call("alpha", ALL_WORKTREES_SCOPE, "/tmp/alpha");
    const second = call("beta", ALL_WORKTREES_SCOPE, "/tmp/beta");
    const third = call("alpha", ALL_WORKTREES_SCOPE, "/tmp/alpha");

    expect(third).toBe(first);
    expect(second).not.toBe(first);
  });

  it("misses the cache after a layout mutation", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b", { projectSlug: "beta", worktreeId: "/tmp/beta" }), "a", "right");

    const first = call("alpha", ALL_WORKTREES_SCOPE, "/tmp/alpha");
    splitPane(pane("c", { projectSlug: "alpha", worktreeId: "/tmp/alpha" }), "a", "bottom");
    const second = call("alpha", ALL_WORKTREES_SCOPE, "/tmp/alpha");

    expect(second).not.toBe(first);
    expect(second.rects.size).toBe(2); // a + c now belong to alpha
  });

  it("enforces the configured max size via LRU eviction", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b", { projectSlug: "beta", worktreeId: "/tmp/beta" }), "a", "right");
    splitPane(pane("c", { projectSlug: "gamma", worktreeId: "/tmp/gamma" }), "b", "right");

    setProjectionCacheMaxSize(4);

    // Prime 4 distinct cache entries. Each call uses a different slug so
    // the key varies.
    call("alpha", ALL_WORKTREES_SCOPE, "/tmp/alpha");
    call("beta", ALL_WORKTREES_SCOPE, "/tmp/beta");
    call("gamma", ALL_WORKTREES_SCOPE, "/tmp/gamma");
    call("delta", ALL_WORKTREES_SCOPE, "/tmp/delta");
    expect(__projectionCacheSizeForTests()).toBeLessThanOrEqual(4);

    // Adding a fifth distinct entry must evict the oldest.
    call("epsilon", ALL_WORKTREES_SCOPE, "/tmp/epsilon");
    expect(__projectionCacheSizeForTests()).toBeLessThanOrEqual(4);
  });

  it("prunes panes that don't match the active project", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b", { projectSlug: "beta", worktreeId: "/tmp/beta" }), "a", "right");
    // Make a cell snapshot so we see the unpruned count first.
    expect(runtimeLayoutStore.cells.map((c: RuntimeCell) => c.id).sort()).toEqual(["a", "b"]);

    const alphaProjection = call("alpha", ALL_WORKTREES_SCOPE, "/tmp/alpha");
    expect([...alphaProjection.rects.keys()]).toEqual(["a"]);

    const betaProjection = call("beta", ALL_WORKTREES_SCOPE, "/tmp/beta");
    expect([...betaProjection.rects.keys()]).toEqual(["b"]);
  });

  // Unused helper keeps the type import alive for explicit signature clarity.
  void cellFrom;
});
