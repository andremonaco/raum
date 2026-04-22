/**
 * Dock — filter mode persistence.
 *
 * Exercises the localStorage-backed `dockFilterMode` signal: toggling a
 * filter writes to localStorage, toggling the same filter again clears it,
 * and a fresh module load picks up the persisted value. Chip-ordering
 * behaviour is exercised end-to-end in the release smoke test
 * (see `docs/release.md`) — asserting it here would require mocking
 * runtimeLayoutStore + agentStore fixtures that diverge from production state.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const KEY = "raum:dock-filter";

describe("dock filter mode persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    // Force a fresh module instance so `loadInitialFilter` re-reads localStorage.
    (
      globalThis as Record<string, unknown> & { __vitest_resetModules__?: () => void }
    ).__vitest_resetModules__?.();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to null when nothing is persisted", async () => {
    const mod = await import("./dock");
    expect(mod.dockFilterMode()).toBeNull();
  });

  it("toggleFilterMode writes the selection to localStorage", async () => {
    const mod = await import("./dock");
    mod.toggleFilterMode("awaiting");
    expect(localStorage.getItem(KEY)).toBe("awaiting");
    mod.toggleFilterMode("working");
    expect(localStorage.getItem(KEY)).toBe("working");
  });

  it("toggling the active filter clears it", async () => {
    const mod = await import("./dock");
    mod.toggleFilterMode("recent");
    expect(mod.dockFilterMode()).toBe("recent");
    mod.toggleFilterMode("recent");
    expect(mod.dockFilterMode()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
