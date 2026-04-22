import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import {
  __resetRuntimeLayoutForTests,
  addCellTab,
  clearMaximize,
  compactTree,
  cycleFocus,
  equalizeAllRatios,
  focusedPaneId,
  focusPaneByIndex,
  LAYOUT_UNIT,
  layoutRev,
  maximizedPaneId,
  removePane,
  removeCellTab,
  runtimeLayoutStore,
  setActiveTabId,
  setRuntimeLayout,
  setSessionId,
  setSplitRatios,
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
});
