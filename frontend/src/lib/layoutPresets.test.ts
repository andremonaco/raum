import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import {
  __resetRuntimeLayoutForTests,
  LAYOUT_UNIT,
  minimizePane,
  minimizedPaneIds,
  runtimeLayoutStore,
  setTabSessionId,
  splitPane,
  type PaneContent,
} from "../stores/runtimeLayoutStore";
import { LAYOUT_PRESETS, applyLayoutPreset } from "./layoutPresets";

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

/** Build a horizontal strip of `ids` panes. */
function strip(ids: string[]): void {
  splitPane(pane(ids[0]), null, "right");
  for (let i = 1; i < ids.length; i++) {
    splitPane(pane(ids[i]), ids[i - 1], "right");
  }
}

describe("layoutPresets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRuntimeLayoutForTests();
  });

  it("exposes stable preset ids and labels", () => {
    expect(LAYOUT_PRESETS.map((p) => p.id)).toEqual([
      "grid-2x2",
      "main-right-sidebar",
      "three-columns",
    ]);
    for (const p of LAYOUT_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0);
    }
  });

  it("grid-2x2 reshapes four panes into a 2x2 grid preserving pane ids", () => {
    strip(["a", "b", "c", "d"]);
    applyLayoutPreset("grid-2x2");
    const cells = runtimeLayoutStore.cells;
    expect(cells).toHaveLength(4);
    expect(cells.map((c) => c.id).sort()).toEqual(["a", "b", "c", "d"]);
    // Two distinct column widths? No — a clean 2x2 has one width + one height.
    const widths = new Set(cells.map((c) => c.w));
    const heights = new Set(cells.map((c) => c.h));
    expect(widths.size).toBe(1);
    expect(heights.size).toBe(1);
    expect([...widths][0]).toBeCloseTo(LAYOUT_UNIT / 2, -1);
    expect([...heights][0]).toBeCloseTo(LAYOUT_UNIT / 2, -1);
  });

  it("three-columns reshapes three panes into equal full-height columns", () => {
    strip(["a", "b", "c"]);
    applyLayoutPreset("three-columns");
    const cells = runtimeLayoutStore.cells;
    expect(cells).toHaveLength(3);
    // Every column spans the full height.
    for (const c of cells) {
      expect(c.h).toBeCloseTo(LAYOUT_UNIT, -1);
    }
    // Widths are ~1/3 each and tile the viewport.
    const sumW = cells.reduce((s, c) => s + c.w, 0);
    expect(sumW).toBe(LAYOUT_UNIT);
    for (const c of cells) {
      expect(c.w).toBeCloseTo(LAYOUT_UNIT / 3, -1);
    }
  });

  it("main-right-sidebar gives the first pane a wide main column", () => {
    strip(["a", "b", "c"]);
    applyLayoutPreset("main-right-sidebar");
    const cells = runtimeLayoutStore.cells;
    expect(cells).toHaveLength(3);
    const main = cells.find((c) => c.id === "a")!;
    // Main spans full height and ~65% width.
    expect(main.h).toBeCloseTo(LAYOUT_UNIT, -1);
    expect(main.w).toBeGreaterThan(LAYOUT_UNIT * 0.5);
    // The two sidebar panes share the right column, stacked.
    const side = cells.filter((c) => c.id !== "a");
    for (const c of side) {
      expect(c.x).toBeGreaterThan(LAYOUT_UNIT * 0.5);
    }
    // Stacked: their heights sum to the full viewport.
    const sumH = side.reduce((s, c) => s + c.h, 0);
    expect(sumH).toBeCloseTo(LAYOUT_UNIT, -1);
  });

  it("degrades gracefully: presets are a no-op for a single pane", () => {
    splitPane(pane("solo"), null, "right");
    const before = runtimeLayoutStore.cells.map((c) => ({ ...c }));
    applyLayoutPreset("grid-2x2");
    applyLayoutPreset("three-columns");
    applyLayoutPreset("main-right-sidebar");
    expect(runtimeLayoutStore.cells.map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(runtimeLayoutStore.cells[0].w).toBe(LAYOUT_UNIT);
  });

  it("unknown preset id leaves the layout untouched", () => {
    strip(["a", "b"]);
    const before = runtimeLayoutStore.cells.map((c) => ({ id: c.id, x: c.x, w: c.w }));
    applyLayoutPreset("does-not-exist");
    const after = runtimeLayoutStore.cells.map((c) => ({ id: c.id, x: c.x, w: c.w }));
    expect(after).toEqual(before);
  });

  it("preserves minimized panes across a preset reshape", () => {
    strip(["a", "b", "c"]);
    minimizePane("c");
    expect(minimizedPaneIds().has("c")).toBe(true);
    applyLayoutPreset("three-columns");
    // The two in-tree panes reshaped; the minimized pane stays docked.
    expect(runtimeLayoutStore.cells.map((c) => c.id).sort()).toEqual(["a", "b"]);
    expect(minimizedPaneIds().has("c")).toBe(true);
    expect(runtimeLayoutStore.panes["c"]).toBeDefined();
  });

  it("preserves tab/session content through a reshape", () => {
    strip(["a", "b", "c", "d"]);
    // Tag pane b's tab with a session id; it must survive the reshape.
    const bTab = runtimeLayoutStore.cells.find((c) => c.id === "b")!.tabs[0].id;
    setTabSessionId("b", bTab, "sess-b");
    applyLayoutPreset("grid-2x2");
    const b = runtimeLayoutStore.cells.find((c) => c.id === "b")!;
    expect(b.tabs[0].sessionId).toBe("sess-b");
  });
});
