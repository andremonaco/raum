import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock the Tauri invoke surface so the store can be exercised in jsdom.
const invokeMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import {
  __resetLayoutStoreForTests,
  createPreset,
  deletePreset,
  flushScheduled,
  getPreset,
  layoutPresetStore,
  loadLayoutPresets,
  savePreset,
  schedule,
  type LayoutPreset,
} from "./layoutPresetStore";

function preset(name: string, extra: Partial<LayoutPreset> = {}): LayoutPreset {
  return {
    name,
    cells: [{ x: 0, y: 0, w: 6, h: 6, kind: "shell" }],
    ...extra,
  };
}

describe("layoutPresetStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    __resetLayoutStoreForTests();
  });

  afterEach(async () => {
    await flushScheduled();
  });

  it("loads presets via layouts_list", async () => {
    invokeMock.mockResolvedValueOnce([preset("alpha"), preset("beta")]);
    const out = await loadLayoutPresets();
    expect(out).toHaveLength(2);
    expect(layoutPresetStore.presets.map((p) => p.name)).toEqual(["alpha", "beta"]);
    expect(layoutPresetStore.loaded).toBe(true);
  });

  it("savePreset updates the store optimistically and debounces the backend call", async () => {
    invokeMock.mockResolvedValue([]);
    savePreset(preset("alpha"));
    // Optimistic update landed.
    expect(getPreset("alpha")).toBeDefined();
    // Rapid re-save should coalesce.
    savePreset(preset("alpha"));
    savePreset(preset("alpha"));
    await flushScheduled();
    // Only one layouts_save invocation should have happened.
    const saveCalls = invokeMock.mock.calls.filter((c) => c[0] === "layouts_save");
    expect(saveCalls).toHaveLength(1);
  });

  it("createPreset errors on duplicate name", () => {
    savePreset(preset("alpha"));
    const res = createPreset(preset("alpha"));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already exists/);
  });

  it("createPreset succeeds with a fresh name", () => {
    const res = createPreset(preset("gamma"));
    expect(res.ok).toBe(true);
    expect(getPreset("gamma")).toBeDefined();
  });

  it("deletePreset removes from store and debounces the backend call", async () => {
    invokeMock.mockResolvedValue([{ name: "alpha", cells: [] }]);
    savePreset(preset("alpha"));
    await flushScheduled();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue([]);
    deletePreset("alpha");
    expect(getPreset("alpha")).toBeUndefined();
    await flushScheduled();
    const deleteCalls = invokeMock.mock.calls.filter((c) => c[0] === "layouts_delete");
    expect(deleteCalls).toHaveLength(1);
  });

  it("sanitizes cells with kind 'empty' before persisting", async () => {
    invokeMock.mockResolvedValue([]);
    savePreset({
      name: "mixed",
      cells: [
        { x: 0, y: 0, w: 4, h: 4, kind: "shell" },
        { x: 4, y: 0, w: 4, h: 4, kind: "empty" },
      ],
    });
    await flushScheduled();
    const saveCall = invokeMock.mock.calls.find((c) => c[0] === "layouts_save");
    expect(saveCall).toBeDefined();
    const payload = saveCall?.[1] as { preset: LayoutPreset };
    expect(payload.preset.cells).toHaveLength(1);
    expect(payload.preset.cells[0].kind).toBe("shell");
  });

  it("schedule() keyed debouncer coalesces by key", async () => {
    const hits: string[] = [];
    schedule("k", async () => {
      hits.push("a");
    });
    schedule("k", async () => {
      hits.push("b");
    });
    schedule("k", async () => {
      hits.push("c");
    });
    await flushScheduled();
    expect(hits).toEqual(["c"]);
  });
});
