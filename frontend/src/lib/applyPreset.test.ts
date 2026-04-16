import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const invokeMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => {
  class FakeChannel<T> {
    onmessage: ((v: T) => void) | null = null;
  }
  return {
    invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
    Channel: FakeChannel,
  };
});

import { applyPreset } from "./applyPreset";
import { __resetRuntimeLayoutForTests, runtimeLayoutStore } from "../stores/runtimeLayoutStore";
import { __resetLayoutStoreForTests, flushScheduled } from "../stores/layoutPresetStore";
import type { LayoutPreset } from "../stores/layoutPresetStore";

const demo: LayoutPreset = {
  name: "demo",
  cells: [
    { x: 0, y: 0, w: 6, h: 6, kind: "shell" },
    { x: 6, y: 0, w: 6, h: 6, kind: "claude-code" },
    { x: 0, y: 6, w: 12, h: 6, kind: "empty" },
  ],
};

describe("applyPreset", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    __resetRuntimeLayoutForTests();
    __resetLayoutStoreForTests();
  });

  afterEach(async () => {
    await flushScheduled();
  });

  it("spawns terminal sessions for non-empty cells only", async () => {
    invokeMock.mockImplementation(async (cmd: unknown) => {
      if (cmd === "terminal_spawn") return "sess-" + Math.random().toString(36).slice(2);
      if (cmd === "worktree_preset_set") return null;
      if (cmd === "terminal_kill") return null;
      return null;
    });
    const result = await applyPreset(demo, { worktreeId: "wt-1" });
    expect(result.resolution).toBe("replace");
    expect(result.spawned).toBe(2);
    expect(result.skipped).toBe(1);
    expect(runtimeLayoutStore.cells).toHaveLength(3);
    expect(runtimeLayoutStore.sourcePreset).toBe("demo");
    // empty cell has no session id on its tab.
    const emptyCell = runtimeLayoutStore.cells.find((c) => c.kind === "empty");
    expect(emptyCell?.tabs[0]?.sessionId).toBeUndefined();
  });

  it("kills running agents on replace", async () => {
    invokeMock.mockImplementation(async () => "sess-xyz");
    await applyPreset(demo, {
      worktreeId: "wt-1",
      runningAgents: [
        { sessionId: "old-1", kind: "shell" },
        { sessionId: "old-2", kind: "codex" },
      ],
      onConflict: async () => "replace",
    });
    const kills = invokeMock.mock.calls.filter((c) => c[0] === "terminal_kill");
    expect(kills).toHaveLength(2);
  });

  it("reuses existing sessions on keep", async () => {
    invokeMock.mockImplementation(async () => "sess-new");
    const res = await applyPreset(demo, {
      worktreeId: "wt-1",
      runningAgents: [
        { sessionId: "reuse-1", kind: "shell" },
        { sessionId: "reuse-2", kind: "claude-code" },
      ],
      onConflict: async () => "keep",
    });
    expect(res.resolution).toBe("keep");
    // No new spawns should have happened for reusable slots.
    const spawns = invokeMock.mock.calls.filter((c) => c[0] === "terminal_spawn");
    expect(spawns).toHaveLength(0);
    const sessionIds = runtimeLayoutStore.cells
      .filter((c) => c.kind !== "empty")
      .map((c) => c.tabs.find((t) => t.id === c.activeTabId)?.sessionId);
    expect(sessionIds).toEqual(["reuse-1", "reuse-2"]);
  });

  it("cancel resolution short-circuits", async () => {
    const res = await applyPreset(demo, {
      worktreeId: "wt-1",
      runningAgents: [{ sessionId: "x", kind: "shell" }],
      onConflict: async () => "cancel",
    });
    expect(res.resolution).toBe("cancel");
    expect(res.spawned).toBe(0);
    expect(runtimeLayoutStore.cells).toHaveLength(0);
  });

  it("updates the worktree preset pointer via debounced invoke", async () => {
    invokeMock.mockImplementation(async () => "sess-1");
    await applyPreset(demo, { worktreeId: "wt-1" });
    await flushScheduled();
    const pointerCalls = invokeMock.mock.calls.filter((c) => c[0] === "worktree_preset_set");
    expect(pointerCalls).toHaveLength(1);
    expect(pointerCalls[0][1]).toEqual({
      worktreeId: "wt-1",
      presetName: "demo",
    });
  });
});
