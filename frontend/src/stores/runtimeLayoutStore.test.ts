import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import {
  __resetRuntimeLayoutForTests,
  __setActiveLayoutBootStateForTests,
  flushActiveLayoutNow,
  markActiveLayoutHydrated,
  openActiveLayoutSaveGate,
  scheduleActiveSave,
  addCellTab,
  clearMaximize,
  compactTree,
  cycleFocus,
  equalizeAllRatios,
  focusedPaneId,
  focusPaneByIndex,
  LAYOUT_UNIT,
  layoutRev,
  maximizeAnim,
  maximizedPaneId,
  isTabAlive,
  isTabPendingReset,
  markTabPendingReset,
  removePane,
  removeCellTab,
  removeTabsBySessionId,
  runtimeLayoutStore,
  setActiveTabId,
  placedSessionIds,
  setRuntimeLayout,
  setFocusedPaneId,
  minimizedPaneIds,
  minimizePane,
  restorePane,
  setSessionId,
  setSplitRatios,
  setSplitRatiosByBoundary,
  setTabLabel,
  setTabAutoLabel,
  setTabSessionId,
  splitPane,
  swapPanes,
  tileAll,
  toggleMaximize,
  movePaneToEdge,
  type PaneContent,
  type RuntimeCell,
} from "./runtimeLayoutStore";

function cell(id: string, overrides: Partial<RuntimeCell> = {}): RuntimeCell {
  const tabId = `tab-${id}`;
  return {
    id,
    x: 0,
    y: 0,
    w: LAYOUT_UNIT,
    h: LAYOUT_UNIT,
    kind: "shell",
    tabs: [{ id: tabId }],
    activeTabId: tabId,
    ...overrides,
  };
}

function pane(id: string, overrides: Partial<PaneContent> = {}): PaneContent {
  const tabId = `tab-${id}`;
  return {
    id,
    kind: "shell",
    tabs: [{ id: tabId }],
    activeTabId: tabId,
    ...overrides,
  };
}

describe("runtimeLayoutStore (BSP)", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    __resetRuntimeLayoutForTests();
  });

  it("setRuntimeLayout builds a tree from flat cells", () => {
    setRuntimeLayout([
      cell("a", { x: 0, y: 0, w: LAYOUT_UNIT / 2, h: LAYOUT_UNIT }),
      cell("b", { x: LAYOUT_UNIT / 2, y: 0, w: LAYOUT_UNIT / 2, h: LAYOUT_UNIT }),
    ]);
    expect(runtimeLayoutStore.cells.map((c) => c.id).sort()).toEqual(["a", "b"]);
    expect(runtimeLayoutStore.tree).not.toBeNull();
  });

  it("setRuntimeLayout auto-initializes tabs when missing", () => {
    setRuntimeLayout([
      { id: "x", x: 0, y: 0, w: LAYOUT_UNIT, h: LAYOUT_UNIT, kind: "shell" } as RuntimeCell,
    ]);
    const c = runtimeLayoutStore.cells[0];
    expect(c.tabs).toHaveLength(1);
    expect(c.activeTabId).toBe(c.tabs[0].id);
  });

  it("splitPane on empty tree installs root leaf", () => {
    splitPane(pane("a"), null, "right");
    expect(runtimeLayoutStore.cells.map((c) => c.id)).toEqual(["a"]);
    expect(runtimeLayoutStore.cells[0].w).toBe(LAYOUT_UNIT);
  });

  it("splitPane adjacent grows the tree without disturbing other leaves", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b"), "a", "right");
    const ids = runtimeLayoutStore.cells.map((c) => c.id).sort();
    expect(ids).toEqual(["a", "b"]);
    // Both cells share the viewport — widths sum to LAYOUT_UNIT.
    const sumW = runtimeLayoutStore.cells.reduce((s, c) => s + c.w, 0);
    expect(sumW).toBe(LAYOUT_UNIT);
  });

  it("removePane collapses the tree and clears maximize/focus", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b"), "a", "right");
    toggleMaximize("a");
    focusPaneByIndex(1);
    expect(maximizedPaneId()).toBe("a");
    expect(focusedPaneId()).toBe("a");
    removePane("a");
    expect(runtimeLayoutStore.cells.map((c) => c.id)).toEqual(["b"]);
    expect(maximizedPaneId()).toBeNull();
    expect(focusedPaneId()).toBeNull();
    // Surviving pane gets the full viewport back.
    expect(runtimeLayoutStore.cells[0].w).toBe(LAYOUT_UNIT);
  });

  it("swapPanes exchanges content without changing layout", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b"), "a", "right");
    const before = runtimeLayoutStore.cells.map((c) => ({ id: c.id, x: c.x, w: c.w }));
    swapPanes("a", "b");
    const after = runtimeLayoutStore.cells.map((c) => ({ id: c.id, x: c.x, w: c.w }));
    // Same x/w for each slot, just with swapped ids.
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(after[i].x).toBe(before[i].x);
      expect(after[i].w).toBe(before[i].w);
    }
  });

  it("movePaneToEdge moves a pane beside another without losing panes", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b"), "a", "right");
    splitPane(pane("c"), "b", "right");
    movePaneToEdge("a", "c", "bottom");
    const ids = runtimeLayoutStore.cells.map((c) => c.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("setSessionId updates the active tab of the targeted cell only", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b"), "a", "right");
    setSessionId("b", "sess-123");
    const bCell = runtimeLayoutStore.cells.find((c) => c.id === "b")!;
    const activeTab = bCell.tabs.find((t) => t.id === bCell.activeTabId);
    expect(activeTab?.sessionId).toBe("sess-123");
    const aCell = runtimeLayoutStore.cells.find((c) => c.id === "a")!;
    expect(aCell.tabs[0].sessionId).toBeUndefined();
  });

  it("setTabSessionId updates a specific tab's sessionId", () => {
    splitPane(pane("a"), null, "right");
    const tabId = runtimeLayoutStore.cells[0].tabs[0].id;
    setTabSessionId("a", tabId, "my-session");
    expect(runtimeLayoutStore.cells[0].tabs[0].sessionId).toBe("my-session");
  });

  it("setRuntimeLayout persists pane-scoped project context in active layout saves", async () => {
    vi.useFakeTimers();
    setRuntimeLayout([
      cell("a", {
        kind: "claude-code",
        projectSlug: "acme",
        worktreeId: "/tmp/acme-main",
        tabs: [{ id: "tab-a", sessionId: "raum-a" }],
        activeTabId: "tab-a",
      }),
    ]);

    await vi.advanceTimersByTimeAsync(500);

    expect(invoke).toHaveBeenCalledWith(
      "active_layout_save",
      expect.objectContaining({
        layout: expect.objectContaining({
          cells: [
            expect.objectContaining({
              project_slug: "acme",
              worktree_id: "/tmp/acme-main",
              tabs: [expect.objectContaining({ session_id: "raum-a" })],
            }),
          ],
        }),
      }),
    );
  });

  it("addCellTab appends a new tab and makes it active", () => {
    splitPane(pane("a"), null, "right");
    const newTabId = addCellTab("a");
    const c = runtimeLayoutStore.cells[0];
    expect(c.tabs).toHaveLength(2);
    expect(c.activeTabId).toBe(newTabId);
  });

  it("addCellTab stores per-tab projectSlug/worktreeId init values", async () => {
    vi.useFakeTimers();
    splitPane(
      pane("a", { kind: "claude-code", projectSlug: "stale", worktreeId: "/tmp/stale" }),
      null,
      "right",
    );
    const newTabId = addCellTab("a", {
      projectSlug: "current",
      worktreeId: "/tmp/current",
    });
    const c = runtimeLayoutStore.cells[0];
    const newTab = c.tabs.find((t) => t.id === newTabId);
    expect(newTab?.projectSlug).toBe("current");
    expect(newTab?.worktreeId).toBe("/tmp/current");

    // First tab untouched: still inherits from the pane (so its running
    // session doesn't claim to be in a different worktree).
    expect(c.tabs[0].projectSlug).toBeUndefined();
    expect(c.tabs[0].worktreeId).toBeUndefined();

    // Per-tab binding round-trips through active_layout_save.
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).toHaveBeenCalledWith(
      "active_layout_save",
      expect.objectContaining({
        layout: expect.objectContaining({
          cells: [
            expect.objectContaining({
              tabs: expect.arrayContaining([
                expect.objectContaining({
                  id: newTabId,
                  project_slug: "current",
                  worktree_id: "/tmp/current",
                }),
              ]),
            }),
          ],
        }),
      }),
    );
  });

  it("removeCellTab keeps active when removing a non-active tab", () => {
    splitPane(pane("a"), null, "right");
    const firstTabId = runtimeLayoutStore.cells[0].tabs[0].id;
    addCellTab("a");
    const c = runtimeLayoutStore.cells[0];
    const secondTabId = c.tabs[1].id;
    setActiveTabId("a", firstTabId);
    removeCellTab("a", secondTabId);
    expect(runtimeLayoutStore.cells[0].tabs).toHaveLength(1);
    expect(runtimeLayoutStore.cells[0].activeTabId).toBe(firstTabId);
  });

  it("removeCellTab activates a neighbor when removing the active tab", () => {
    splitPane(pane("a"), null, "right");
    const firstTabId = runtimeLayoutStore.cells[0].tabs[0].id;
    addCellTab("a");
    const secondTabId = runtimeLayoutStore.cells[0].tabs[1].id;
    removeCellTab("a", secondTabId);
    expect(runtimeLayoutStore.cells[0].activeTabId).toBe(firstTabId);
  });

  it("removeCellTab removes the pane entirely when it was the last tab", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b"), "a", "right");
    const tabId = runtimeLayoutStore.cells.find((c) => c.id === "a")!.tabs[0].id;
    removeCellTab("a", tabId);
    expect(runtimeLayoutStore.cells.map((c) => c.id)).toEqual(["b"]);
  });

  it("isTabAlive reflects tab presence; false for missing pane or tab", () => {
    splitPane(pane("a"), null, "right");
    const firstTabId = runtimeLayoutStore.cells[0].tabs[0].id;
    expect(isTabAlive("a", firstTabId)).toBe(true);
    expect(isTabAlive("a", "nonexistent")).toBe(false);
    expect(isTabAlive("missing-pane", firstTabId)).toBe(false);
  });

  it("markTabPendingReset flags the tab; flag survives until tab/pane removal", () => {
    splitPane(pane("a"), null, "right");
    const firstTabId = runtimeLayoutStore.cells[0].tabs[0].id;
    expect(isTabPendingReset("a", firstTabId)).toBe(false);
    markTabPendingReset("a", firstTabId);
    expect(isTabPendingReset("a", firstTabId)).toBe(true);
    // Independent tabs don't share the flag.
    const secondTabId = addCellTab("a");
    expect(isTabPendingReset("a", secondTabId)).toBe(false);
    expect(isTabPendingReset("a", firstTabId)).toBe(true);
  });

  it("removeCellTab clears the pending-reset flag for the removed tab", () => {
    splitPane(pane("a"), null, "right");
    const firstTabId = runtimeLayoutStore.cells[0].tabs[0].id;
    addCellTab("a");
    markTabPendingReset("a", firstTabId);
    removeCellTab("a", firstTabId);
    // The tab is gone, but the pending-reset registry must not retain stale
    // entries — otherwise a future tab reusing the same id would inherit a
    // bogus "pending" status.
    expect(isTabPendingReset("a", firstTabId)).toBe(false);
  });

  it("removePane clears pending-reset flags for all tabs in the pane", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b"), "a", "right");
    const aTab = runtimeLayoutStore.cells.find((c) => c.id === "a")!.tabs[0].id;
    addCellTab("a");
    const aTab2 = runtimeLayoutStore.cells.find((c) => c.id === "a")!.tabs[1].id;
    markTabPendingReset("a", aTab);
    markTabPendingReset("a", aTab2);
    removePane("a");
    expect(isTabPendingReset("a", aTab)).toBe(false);
    expect(isTabPendingReset("a", aTab2)).toBe(false);
  });

  it("removeTabsBySessionId removes stale session tabs from the persisted layout", () => {
    setRuntimeLayout([
      cell("a", {
        tabs: [
          { id: "tab-a-1", sessionId: "stale" },
          { id: "tab-a-2", sessionId: "live" },
        ],
        activeTabId: "tab-a-1",
      }),
      cell("b", {
        x: LAYOUT_UNIT / 2,
        w: LAYOUT_UNIT / 2,
        tabs: [{ id: "tab-b-1", sessionId: "stale" }],
        activeTabId: "tab-b-1",
      }),
    ]);

    removeTabsBySessionId("stale");

    expect(runtimeLayoutStore.cells.map((c) => c.id)).toEqual(["a"]);
    expect(runtimeLayoutStore.cells[0].tabs).toEqual([{ id: "tab-a-2", sessionId: "live" }]);
    expect(runtimeLayoutStore.cells[0].activeTabId).toBe("tab-a-2");
  });

  it("persists an empty active layout when the last pane is removed", async () => {
    vi.useFakeTimers();
    splitPane(pane("a"), null, "right");
    vi.mocked(invoke).mockClear();

    removePane("a");
    await vi.advanceTimersByTimeAsync(500);

    expect(runtimeLayoutStore.cells).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("active_layout_save", {
      layout: expect.objectContaining({ cells: [] }),
    });
  });

  it("setActiveTabId switches the visible tab", () => {
    splitPane(pane("a"), null, "right");
    const firstTabId = runtimeLayoutStore.cells[0].tabs[0].id;
    const secondTabId = addCellTab("a");
    expect(runtimeLayoutStore.cells[0].activeTabId).toBe(secondTabId);
    setActiveTabId("a", firstTabId);
    expect(runtimeLayoutStore.cells[0].activeTabId).toBe(firstTabId);
  });

  it("toggleMaximize flips and clearMaximize resets", () => {
    splitPane(pane("a"), null, "right");
    toggleMaximize("a");
    expect(maximizedPaneId()).toBe("a");
    toggleMaximize("a");
    expect(maximizedPaneId()).toBeNull();
    toggleMaximize("a");
    clearMaximize();
    expect(maximizedPaneId()).toBeNull();
  });

  it("opens a maximize-anim window so chrome and surface position transitions stay in lockstep", () => {
    vi.useFakeTimers();
    splitPane(pane("a"), null, "right");
    expect(maximizeAnim()).toBe(false);

    toggleMaximize("a");
    expect(maximizeAnim()).toBe(true);

    // Outlasts the 180 ms spring transition so the surface stays glued to the
    // chrome through the overshoot tail.
    vi.advanceTimersByTime(180);
    expect(maximizeAnim()).toBe(true);

    vi.advanceTimersByTime(60);
    expect(maximizeAnim()).toBe(false);
  });

  it("focusPaneByIndex is 1-based over in-order traversal", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b"), "a", "right");
    splitPane(pane("c"), "b", "right");
    focusPaneByIndex(2);
    expect(focusedPaneId()).toBe("b");
  });

  it("cycleFocus wraps around in both directions", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b"), "a", "right");
    splitPane(pane("c"), "b", "right");
    focusPaneByIndex(3);
    cycleFocus("forward");
    expect(focusedPaneId()).toBe("a");
    cycleFocus("back");
    expect(focusedPaneId()).toBe("c");
  });

  it("setTabLabel stores a trimmed label and clears on whitespace-only", () => {
    splitPane(pane("a"), null, "right");
    const tabId = runtimeLayoutStore.cells[0].tabs[0].id;

    setTabLabel("a", tabId, "  Main agent  ");
    expect(runtimeLayoutStore.cells[0].tabs[0].label).toBe("Main agent");

    setTabLabel("a", tabId, "   ");
    expect(runtimeLayoutStore.cells[0].tabs[0].label).toBeUndefined();

    setTabLabel("a", tabId, "Planner");
    expect(runtimeLayoutStore.cells[0].tabs[0].label).toBe("Planner");

    setTabLabel("a", tabId, undefined);
    expect(runtimeLayoutStore.cells[0].tabs[0].label).toBeUndefined();
  });

  it("setTabAutoLabel stores a trimmed auto label and clears on whitespace-only", () => {
    splitPane(pane("a"), null, "right");
    const tabId = runtimeLayoutStore.cells[0].tabs[0].id;

    setTabAutoLabel("a", tabId, "  Investigating flake  ");
    expect(runtimeLayoutStore.cells[0].tabs[0].autoLabel).toBe("Investigating flake");

    setTabAutoLabel("a", tabId, "   ");
    expect(runtimeLayoutStore.cells[0].tabs[0].autoLabel).toBeUndefined();
  });

  it("equalizeAllRatios snaps skewed dividers back to even positions", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b"), "a", "right");
    // Skew the divider heavily toward the left pane.
    setSplitRatios([], [0.9, 0.1]);
    const skewed = runtimeLayoutStore.cells.find((c) => c.id === "a")!;
    expect(skewed.w).toBeGreaterThan(LAYOUT_UNIT * 0.8);
    equalizeAllRatios();
    const a = runtimeLayoutStore.cells.find((c) => c.id === "a")!;
    const b = runtimeLayoutStore.cells.find((c) => c.id === "b")!;
    expect(a.w).toBeCloseTo(LAYOUT_UNIT / 2, -1);
    expect(b.w).toBeCloseTo(LAYOUT_UNIT / 2, -1);
  });

  it("setSplitRatiosByBoundary resizes the right runtime split when adjacent visible siblings are not adjacent in runtime", () => {
    // Runtime tree: row split [a, b, c]. The pruned tree (visible only)
    // hides `b`, so to the user it looks like row split [a, c]. Dragging
    // the divider between a and c must end up changing the runtime split's
    // ratios for a and c, leaving b's runtime ratio untouched.
    splitPane(pane("a"), null, "right");
    splitPane(pane("b"), "a", "right");
    splitPane(pane("c"), "b", "right");
    // Sequential splitPane rolls slots in halves, so the tree starts at
    // a=0.5, b=0.25, c=0.25. Sanity-check that before the drag.
    expect(runtimeLayoutStore.cells.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
    const a0 = runtimeLayoutStore.cells.find((c) => c.id === "a")!;
    const b0 = runtimeLayoutStore.cells.find((c) => c.id === "b")!;
    const c0 = runtimeLayoutStore.cells.find((c) => c.id === "c")!;
    expect(a0.w).toBeCloseTo(LAYOUT_UNIT * 0.5, -1);
    expect(b0.w).toBeCloseTo(LAYOUT_UNIT * 0.25, -1);
    expect(c0.w).toBeCloseTo(LAYOUT_UNIT * 0.25, -1);

    // Pretend `b` is hidden (the way the pruned tree would present it):
    // visibleLeafIds = [a, c], leftIds = [a], rightIds = [c]. The
    // visible siblings' combined runtime share is 0.5 + 0.25 = 0.75,
    // and the user drags so that pruned [a:c] becomes [0.7, 0.3].
    setSplitRatiosByBoundary({
      axis: "row",
      leftLeafIds: ["a"],
      rightLeafIds: ["c"],
      visibleLeafIds: ["a", "c"],
      prunedLeftRatio: 0.7,
      prunedRightRatio: 0.3,
    });

    const a = runtimeLayoutStore.cells.find((c) => c.id === "a")!;
    const b = runtimeLayoutStore.cells.find((c) => c.id === "b")!;
    const c = runtimeLayoutStore.cells.find((c) => c.id === "c")!;
    // b's runtime share is preserved — the user can't see it, so it
    // shouldn't move under their drag.
    expect(b.w).toBeCloseTo(LAYOUT_UNIT * 0.25, -1);
    // a and c divide the remaining 0.75 share in 0.7 : 0.3 proportions.
    expect(a.w).toBeCloseTo(LAYOUT_UNIT * 0.75 * 0.7, -1);
    expect(c.w).toBeCloseTo(LAYOUT_UNIT * 0.75 * 0.3, -1);
  });

  it("setSplitRatiosByBoundary is a no-op when the leaves are missing or the axis disagrees", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b"), "a", "right");
    const before = runtimeLayoutStore.cells.map((c) => c.w);

    // Wrong axis — the only split here is "row", asking for "col" must
    // not corrupt the tree.
    setSplitRatiosByBoundary({
      axis: "col",
      leftLeafIds: ["a"],
      rightLeafIds: ["b"],
      visibleLeafIds: ["a", "b"],
      prunedLeftRatio: 0.9,
      prunedRightRatio: 0.1,
    });
    expect(runtimeLayoutStore.cells.map((c) => c.w)).toEqual(before);

    // Unknown leaves — same: don't touch the tree.
    setSplitRatiosByBoundary({
      axis: "row",
      leftLeafIds: ["ghost"],
      rightLeafIds: ["b"],
      visibleLeafIds: ["a", "b"],
      prunedLeftRatio: 0.9,
      prunedRightRatio: 0.1,
    });
    expect(runtimeLayoutStore.cells.map((c) => c.w)).toEqual(before);
  });

  it("equalizeAllRatios is a safe no-op on a single-leaf tree", () => {
    splitPane(pane("a"), null, "right");
    expect(() => equalizeAllRatios()).not.toThrow();
    expect(runtimeLayoutStore.cells.map((c) => c.id)).toEqual(["a"]);
  });

  it("tileAll rebuilds any topology into a near-square grid", () => {
    // Build a long horizontal strip of 4 panes; tileAll should reshape into 2x2.
    splitPane(pane("a"), null, "right");
    splitPane(pane("b"), "a", "right");
    splitPane(pane("c"), "b", "right");
    splitPane(pane("d"), "c", "right");
    tileAll();
    // After tileAll, 4 panes arrange into a 2x2 grid: 2 rows × 2 cols.
    const cells = runtimeLayoutStore.cells;
    expect(cells).toHaveLength(4);
    const rowHeights = new Set(cells.map((c) => c.h));
    const colWidths = new Set(cells.map((c) => c.w));
    expect(rowHeights.size).toBe(1);
    expect(colWidths.size).toBe(1);
    expect([...rowHeights][0]).toBeCloseTo(LAYOUT_UNIT / 2, -1);
    expect([...colWidths][0]).toBeCloseTo(LAYOUT_UNIT / 2, -1);
  });

  it("tileAll is a no-op on a single-leaf tree", () => {
    splitPane(pane("a"), null, "right");
    tileAll();
    expect(runtimeLayoutStore.cells.map((c) => c.id)).toEqual(["a"]);
    expect(runtimeLayoutStore.cells[0].w).toBe(LAYOUT_UNIT);
  });

  it("compactTree is idempotent on a healthy tree", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b"), "a", "right");
    const snapshot = runtimeLayoutStore.cells.map((c) => ({ id: c.id, x: c.x, w: c.w }));
    compactTree();
    const after = runtimeLayoutStore.cells.map((c) => ({ id: c.id, x: c.x, w: c.w }));
    expect(after).toEqual(snapshot);
  });

  it("setTabLabel is a no-op for unknown cell or tab ids", () => {
    splitPane(pane("a"), null, "right");
    const tabId = runtimeLayoutStore.cells[0].tabs[0].id;
    setTabLabel("ghost-cell", tabId, "nope");
    setTabLabel("a", "ghost-tab", "nope");
    expect(runtimeLayoutStore.cells[0].tabs[0].label).toBeUndefined();
  });

  it("layoutRev monotonically bumps on every real mutation", () => {
    expect(layoutRev()).toBe(0);

    splitPane(pane("a"), null, "right");
    const afterSplit = layoutRev();
    expect(afterSplit).toBeGreaterThan(0);

    splitPane(pane("b"), "a", "right");
    expect(layoutRev()).toBeGreaterThan(afterSplit);

    const beforeSetTab = layoutRev();
    const tabId = runtimeLayoutStore.cells[0].tabs[0].id;
    setTabLabel("a", tabId, "labeled");
    expect(layoutRev()).toBeGreaterThan(beforeSetTab);

    const beforeRemove = layoutRev();
    removePane("a");
    expect(layoutRev()).toBeGreaterThan(beforeRemove);
  });

  it("setTabAutoLabel does not bump layoutRev when the value is unchanged", () => {
    splitPane(pane("a"), null, "right");
    const tabId = runtimeLayoutStore.cells[0].tabs[0].id;
    setTabAutoLabel("a", tabId, "label");
    const stable = layoutRev();
    setTabAutoLabel("a", tabId, "label");
    expect(layoutRev()).toBe(stable);
  });

  // ── minimize / restore ──────────────────────────────────────────────────
  it("minimizePane removes the leaf from the tree but keeps PaneContent", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b"), "a", "right");
    minimizePane("a");
    expect(runtimeLayoutStore.cells.map((c) => c.id)).toEqual(["b"]);
    expect(runtimeLayoutStore.panes["a"]).toBeDefined();
    expect(minimizedPaneIds().has("a")).toBe(true);
    // Surviving pane absorbs the freed space (no ghost slot left behind).
    expect(runtimeLayoutStore.cells[0].w).toBe(LAYOUT_UNIT);
  });

  it("minimizePane clears focus / maximize when the minimized pane held them", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b"), "a", "right");
    setFocusedPaneId("a");
    toggleMaximize("a");
    expect(focusedPaneId()).toBe("a");
    expect(maximizedPaneId()).toBe("a");
    minimizePane("a");
    expect(focusedPaneId()).toBeNull();
    expect(maximizedPaneId()).toBeNull();
  });

  it("restorePane re-inserts the existing pane next to the focused one", () => {
    splitPane(pane("a"), null, "right");
    splitPane(pane("b"), "a", "right");
    minimizePane("a");
    setFocusedPaneId("b");
    restorePane("a");
    expect(minimizedPaneIds().has("a")).toBe(false);
    const ids = runtimeLayoutStore.cells.map((c) => c.id).sort();
    expect(ids).toEqual(["a", "b"]);
    // Tabs and pane content survive the round-trip.
    expect(runtimeLayoutStore.cells.find((c) => c.id === "a")?.tabs).toHaveLength(1);
  });

  it("restorePane installs the pane as root when the tree is empty", () => {
    splitPane(pane("a"), null, "right");
    minimizePane("a");
    expect(runtimeLayoutStore.cells).toEqual([]);
    expect(runtimeLayoutStore.tree).toBeNull();
    restorePane("a");
    expect(runtimeLayoutStore.cells.map((c) => c.id)).toEqual(["a"]);
    expect(minimizedPaneIds().has("a")).toBe(false);
  });

  it("active_layout_save round-trips minimized panes off-tree", async () => {
    vi.useFakeTimers();
    splitPane(pane("a"), null, "right");
    splitPane(
      pane("b", {
        kind: "claude-code",
        tabs: [{ id: "tab-b", sessionId: "raum-b" }],
        activeTabId: "tab-b",
      }),
      "a",
      "right",
    );
    minimizePane("b");
    vi.mocked(invoke).mockClear();
    await vi.advanceTimersByTimeAsync(500);

    expect(invoke).toHaveBeenCalledWith(
      "active_layout_save",
      expect.objectContaining({
        layout: expect.objectContaining({
          cells: expect.arrayContaining([
            expect.objectContaining({ id: "a" }),
            expect.objectContaining({
              id: "b",
              minimized: true,
              x: 0,
              y: 0,
              w: 0,
              h: 0,
              tabs: [expect.objectContaining({ session_id: "raum-b" })],
            }),
          ]),
        }),
      }),
    );
  });

  it("setRuntimeLayout rehydrates minimized cells off-tree", () => {
    setRuntimeLayout([
      cell("a", { x: 0, y: 0, w: LAYOUT_UNIT, h: LAYOUT_UNIT }),
      {
        id: "b",
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        kind: "claude-code",
        tabs: [{ id: "tab-b", sessionId: "raum-b" }],
        activeTabId: "tab-b",
        minimized: true,
      } as RuntimeCell & { minimized: boolean },
    ]);
    expect(runtimeLayoutStore.cells.map((c) => c.id)).toEqual(["a"]);
    expect(runtimeLayoutStore.panes["b"]).toBeDefined();
    expect(minimizedPaneIds().has("b")).toBe(true);
  });

  it("placedSessionIds returns every session bound to a pane tab", () => {
    setRuntimeLayout([
      cell("a", { x: 0, y: 0, w: LAYOUT_UNIT / 2, h: LAYOUT_UNIT }),
      cell("b", { x: LAYOUT_UNIT / 2, y: 0, w: LAYOUT_UNIT / 2, h: LAYOUT_UNIT }),
    ]);
    setTabSessionId("a", "tab-a", "raum-claude-1-1");
    setTabSessionId("b", "tab-b", "raum-sh-2-2");
    const placed = placedSessionIds();
    expect(placed.size).toBe(2);
    expect(placed.has("raum-claude-1-1")).toBe(true);
    expect(placed.has("raum-sh-2-2")).toBe(true);
    // A session with no tab is an orphan — not placed.
    expect(placed.has("raum-codex-9-9")).toBe(false);
  });

  it("placedSessionIds counts minimized panes as placed (restorable, not orphans)", () => {
    setRuntimeLayout([cell("a", { x: 0, y: 0, w: LAYOUT_UNIT, h: LAYOUT_UNIT })]);
    setTabSessionId("a", "tab-a", "raum-claude-1-1");
    minimizePane("a");
    // The pane left the tree but stays in `panes`, so its session is still
    // something the user can restore — it must not be treated as an orphan.
    expect(placedSessionIds().has("raum-claude-1-1")).toBe(true);
  });
});

describe("active-layout save gate & empty-save guard (recovery)", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    __resetRuntimeLayoutForTests();
  });

  it("does NOT overwrite with cells:[] when nothing was hydrated this session", async () => {
    vi.useFakeTimers();
    // Simulate the corrupt/timed-out-read boot path: gate eventually open, but
    // hydration never completed, so an empty save must be suppressed.
    __setActiveLayoutBootStateForTests({ gateOpen: true, didHydrate: false });
    // The store is empty (cells === []). An early save (e.g. from the boot
    // project-tab select) must not clobber a possibly-non-empty on-disk file.
    scheduleActiveSave();
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).not.toHaveBeenCalledWith("active_layout_save", expect.anything());
  });

  it("allows an empty save once a real layout has been hydrated", async () => {
    vi.useFakeTimers();
    __setActiveLayoutBootStateForTests({ gateOpen: true, didHydrate: false });
    // A real (even empty) layout loaded — the user genuinely has zero panes.
    markActiveLayoutHydrated();
    scheduleActiveSave();
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).toHaveBeenCalledWith(
      "active_layout_save",
      expect.objectContaining({ layout: expect.objectContaining({ cells: [] }) }),
    );
  });

  it("parks saves while the gate is closed, then flushes on open", async () => {
    vi.useFakeTimers();
    __setActiveLayoutBootStateForTests({ gateOpen: false, didHydrate: true });
    setRuntimeLayout([cell("a")]);
    // Gate closed: the mutation's scheduled save is parked, not issued.
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).not.toHaveBeenCalledWith("active_layout_save", expect.anything());
    // Opening the gate flushes the parked save.
    openActiveLayoutSaveGate();
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).toHaveBeenCalledWith("active_layout_save", expect.anything());
  });

  it("flushActiveLayoutNow persists immediately, cancelling the debounce", async () => {
    vi.useFakeTimers();
    __setActiveLayoutBootStateForTests({ gateOpen: true, didHydrate: true });
    setRuntimeLayout([cell("a", { tabs: [{ id: "tab-a", sessionId: "raum-a" }] })]);
    vi.mocked(invoke).mockClear();
    // No timer advance — flushActiveLayoutNow must write synchronously.
    await flushActiveLayoutNow();
    expect(invoke).toHaveBeenCalledWith(
      "active_layout_save",
      expect.objectContaining({
        layout: expect.objectContaining({
          cells: [expect.objectContaining({ id: "a" })],
        }),
      }),
    );
    // The debounce timer was cleared, so advancing time issues no second save.
    vi.mocked(invoke).mockClear();
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).not.toHaveBeenCalledWith("active_layout_save", expect.anything());
  });

  it("flushActiveLayoutNow is a no-op when the gate is closed", async () => {
    __setActiveLayoutBootStateForTests({ gateOpen: false, didHydrate: true });
    setRuntimeLayout([cell("a")]);
    vi.mocked(invoke).mockClear();
    await flushActiveLayoutNow();
    expect(invoke).not.toHaveBeenCalledWith("active_layout_save", expect.anything());
  });

  it("flushActiveLayoutNow does not clobber a never-hydrated empty layout", async () => {
    __setActiveLayoutBootStateForTests({ gateOpen: true, didHydrate: false });
    vi.mocked(invoke).mockClear();
    await flushActiveLayoutNow();
    expect(invoke).not.toHaveBeenCalledWith("active_layout_save", expect.anything());
  });

  it("allows a later empty save after the user persisted a real layout (corrupt-read leg)", async () => {
    vi.useFakeTimers();
    // Corrupt/timed-out read boot path: gate open, hydration never completed.
    __setActiveLayoutBootStateForTests({ gateOpen: true, didHydrate: false });
    // 1. The user builds a non-empty layout — this persists (bypasses the
    //    guard via cells.length > 0) and marks the on-disk file as raum-owned.
    setRuntimeLayout([cell("a", { tabs: [{ id: "tab-a", sessionId: "raum-a" }] })]);
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).toHaveBeenCalledWith(
      "active_layout_save",
      expect.objectContaining({
        layout: expect.objectContaining({ cells: [expect.objectContaining({ id: "a" })] }),
      }),
    );
    // 2. The user closes every pane — the resulting empty save must now persist
    //    cells:[] so the next launch reflects the genuinely-empty grid instead
    //    of reloading the stale single-pane layout from step 1.
    vi.mocked(invoke).mockClear();
    setRuntimeLayout([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).toHaveBeenCalledWith(
      "active_layout_save",
      expect.objectContaining({ layout: expect.objectContaining({ cells: [] }) }),
    );
  });

  it("still blocks a boot-time empty save before any non-empty write (corrupt-read leg)", async () => {
    vi.useFakeTimers();
    __setActiveLayoutBootStateForTests({ gateOpen: true, didHydrate: false });
    // No non-empty save has happened — an empty save fired by the boot
    // project-tab select must still be suppressed (anti-clobber invariant).
    setRuntimeLayout([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).not.toHaveBeenCalledWith("active_layout_save", expect.anything());
  });
});
