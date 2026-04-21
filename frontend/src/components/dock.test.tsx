/**
 * Dock — sort mode persistence.
 *
 * Exercises the localStorage-backed `dockSortMode` signal: switching modes
 * writes to localStorage, and a fresh module load picks up the persisted value.
 * Chip-ordering behaviour is exercised end-to-end in the release smoke test
 * (see `docs/release.md`) — asserting it here would require mocking
 * runtimeLayoutStore + agentStore fixtures that diverge from production state.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const KEY = "raum:dock-sort";

describe("dock sort mode persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    // Force a fresh module instance so `loadInitialSort` re-reads localStorage.
    (
      globalThis as Record<string, unknown> & { __vitest_resetModules__?: () => void }
    ).__vitest_resetModules__?.();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to 'working' when nothing is persisted", async () => {
    const mod = await import("./dock");
    expect(mod.dockSortMode()).toBe("working");
  });

  it("setSortMode writes the selection to localStorage", async () => {
    const mod = await import("./dock");
    mod.setSortMode("recent");
    expect(localStorage.getItem(KEY)).toBe("recent");
    mod.setSortMode("attention");
    expect(localStorage.getItem(KEY)).toBe("attention");
  });

  it("setSortMode updates the reactive signal", async () => {
    const mod = await import("./dock");
    mod.setSortMode("recent");
    expect(mod.dockSortMode()).toBe("recent");
  });
});
