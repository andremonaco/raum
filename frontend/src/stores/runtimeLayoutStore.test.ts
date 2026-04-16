import { describe, it, expect, beforeEach } from "vitest";

import {
  __resetRuntimeLayoutForTests,
  addCellTab,
  clearMaximize,
  cycleFocus,
  focusedPaneId,
  focusPaneByIndex,
  maximizedPaneId,
  patchGeometry,
  removeCell,
  removeCellTab,
  runtimeLayoutStore,
  setActiveTabId,
  setRuntimeLayout,
  setSessionId,
  setTabSessionId,
  snapshotPreset,
  toggleMaximize,
  upsertCell,
  type RuntimeCell,
} from "./runtimeLayoutStore";

function cell(id: string, overrides: Partial<RuntimeCell> = {}): RuntimeCell {
  const tabId = `tab-${id}`;
  return {
    id,
    x: 0,
    y: 0,
    w: 4,
    h: 4,
    kind: "shell",
    tabs: [{ id: tabId }],
    activeTabId: tabId,
    ...overrides,
  };
}

describe("runtimeLayoutStore", () => {
  beforeEach(() => {
    __resetRuntimeLayoutForTests();
  });

  it("setRuntimeLayout replaces all cells and records the source preset", () => {
    setRuntimeLayout([cell("a"), cell("b", { x: 4 })], "two-agents");
    expect(runtimeLayoutStore.cells.map((c) => c.id)).toEqual(["a", "b"]);
    expect(runtimeLayoutStore.sourcePreset).toBe("two-agents");
  });

  it("setRuntimeLayout auto-initializes tabs for cells that lack them", () => {
    // Simulate preset-derived cells (no tabs field)
    const rawCell = { id: "x", x: 0, y: 0, w: 4, h: 4, kind: "shell" as const };
    setRuntimeLayout([rawCell as RuntimeCell], null);
    const c = runtimeLayoutStore.cells[0];
    expect(c.tabs).toHaveLength(1);
    expect(c.activeTabId).toBe(c.tabs[0].id);
  });

  it("patchGeometry merges only x/y/w/h", () => {
    setRuntimeLayout([cell("a", { kind: "claude-code" })], null);
    patchGeometry([{ id: "a", x: 6, y: 3, w: 2, h: 2 }]);
    expect(runtimeLayoutStore.cells[0]).toMatchObject({
      x: 6,
      y: 3,
      w: 2,
      h: 2,
      kind: "claude-code",
    });
  });

  it("upsertCell inserts new and replaces existing by id", () => {
    upsertCell(cell("a"));
    upsertCell(cell("b"));
    upsertCell(cell("a", { x: 9 }));
    expect(runtimeLayoutStore.cells).toHaveLength(2);
    expect(runtimeLayoutStore.cells.find((c) => c.id === "a")?.x).toBe(9);
  });

  it("removeCell clears maximize/focus when it matches", () => {
    setRuntimeLayout([cell("a"), cell("b")], null);
    toggleMaximize("a");
    focusPaneByIndex(1);
    expect(maximizedPaneId()).toBe("a");
    expect(focusedPaneId()).toBe("a");
    removeCell("a");
    expect(maximizedPaneId()).toBeNull();
    expect(focusedPaneId()).toBeNull();
  });

  it("setSessionId updates the active tab of the targeted cell only", () => {
    setRuntimeLayout([cell("a"), cell("b")], null);
    setSessionId("b", "sess-123");
    const bCell = runtimeLayoutStore.cells.find((c) => c.id === "b")!;
    const activeTab = bCell.tabs.find((t) => t.id === bCell.activeTabId);
    expect(activeTab?.sessionId).toBe("sess-123");
    const aCell = runtimeLayoutStore.cells.find((c) => c.id === "a")!;
    expect(aCell.tabs[0].sessionId).toBeUndefined();
  });

  it("setTabSessionId updates a specific tab's sessionId", () => {
    setRuntimeLayout([cell("a")], null);
    const tabId = runtimeLayoutStore.cells[0].tabs[0].id;
    setTabSessionId("a", tabId, "my-session");
    expect(runtimeLayoutStore.cells[0].tabs[0].sessionId).toBe("my-session");
  });

  it("addCellTab appends a new tab and makes it active", () => {
    setRuntimeLayout([cell("a")], null);
    const newTabId = addCellTab("a");
    const c = runtimeLayoutStore.cells[0];
    expect(c.tabs).toHaveLength(2);
    expect(c.activeTabId).toBe(newTabId);
  });

  it("removeCellTab removes a non-active tab without changing active", () => {
    setRuntimeLayout([cell("a")], null);
    const firstTabId = runtimeLayoutStore.cells[0].tabs[0].id;
    addCellTab("a");
    const c = runtimeLayoutStore.cells[0];
    const secondTabId = c.tabs[1].id;
    // Make first tab active, then remove second
    setActiveTabId("a", firstTabId);
    removeCellTab("a", secondTabId);
    expect(runtimeLayoutStore.cells[0].tabs).toHaveLength(1);
    expect(runtimeLayoutStore.cells[0].activeTabId).toBe(firstTabId);
  });

  it("removeCellTab activates a neighbor when removing the active tab", () => {
    setRuntimeLayout([cell("a")], null);
    const firstTabId = runtimeLayoutStore.cells[0].tabs[0].id;
    addCellTab("a");
    // Second tab is now active; remove it → should revert to first
    const c = runtimeLayoutStore.cells[0];
    const secondTabId = c.tabs[1].id;
    removeCellTab("a", secondTabId);
    expect(runtimeLayoutStore.cells[0].activeTabId).toBe(firstTabId);
  });

  it("removeCellTab removes the entire cell when it was the last tab", () => {
    setRuntimeLayout([cell("a"), cell("b")], null);
    const tabId = runtimeLayoutStore.cells[0].tabs[0].id;
    removeCellTab("a", tabId);
    expect(runtimeLayoutStore.cells.map((c) => c.id)).toEqual(["b"]);
  });

  it("setActiveTabId switches the visible tab", () => {
    setRuntimeLayout([cell("a")], null);
    const firstTabId = runtimeLayoutStore.cells[0].tabs[0].id;
    const secondTabId = addCellTab("a");
    expect(runtimeLayoutStore.cells[0].activeTabId).toBe(secondTabId);
    setActiveTabId("a", firstTabId);
    expect(runtimeLayoutStore.cells[0].activeTabId).toBe(firstTabId);
  });

  it("toggleMaximize flips and clearMaximize resets", () => {
    setRuntimeLayout([cell("a")], null);
    toggleMaximize("a");
    expect(maximizedPaneId()).toBe("a");
    toggleMaximize("a");
    expect(maximizedPaneId()).toBeNull();
    toggleMaximize("a");
    clearMaximize();
    expect(maximizedPaneId()).toBeNull();
  });

  it("focusPaneByIndex is 1-based", () => {
    setRuntimeLayout([cell("a"), cell("b"), cell("c")], null);
    focusPaneByIndex(2);
    expect(focusedPaneId()).toBe("b");
  });

  it("cycleFocus wraps around in both directions", () => {
    setRuntimeLayout([cell("a"), cell("b"), cell("c")], null);
    focusPaneByIndex(3);
    cycleFocus("forward");
    expect(focusedPaneId()).toBe("a");
    cycleFocus("back");
    expect(focusedPaneId()).toBe("c");
  });

  it("snapshotPreset strips tabs/sessionIds and includes titles only when set", () => {
    setRuntimeLayout([cell("a", { title: "main" }), cell("b", { x: 4, kind: "empty" })], null);
    const snap = snapshotPreset("demo");
    expect(snap.name).toBe("demo");
    expect(snap.cells).toHaveLength(2);
    expect(snap.cells[0]).toEqual({
      x: 0,
      y: 0,
      w: 4,
      h: 4,
      kind: "shell",
      title: "main",
    });
    expect(snap.cells[1]).toEqual({
      x: 4,
      y: 0,
      w: 4,
      h: 4,
      kind: "empty",
    });
  });
});
