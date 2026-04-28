/**
 * Dock — filter mode persistence + orphan selection.
 *
 * Filter persistence: exercises the localStorage-backed `dockFilterMode`
 * signal — toggling writes to localStorage, toggling the same filter
 * clears it, and a fresh module load picks up the persisted value.
 *
 * Orphan selection: the pure `selectOrphanRecords` helper is exercised
 * directly so we don't have to render Solid or mock the
 * runtimeLayoutStore. Chip rendering itself is covered by the release
 * smoke test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeCell } from "../stores/runtimeLayoutStore";
import type { TerminalRecord } from "../stores/terminalStore";

const KEY = "raum:dock-filter";

function makeCell(overrides: Partial<RuntimeCell> & { id: string }): RuntimeCell {
  return {
    kind: "claude-code",
    tabs: [],
    activeTabId: "",
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<TerminalRecord> & { session_id: string }): TerminalRecord {
  return {
    project_slug: "alpha",
    worktree_id: null,
    kind: "claude-code",
    created_unix: 0,
    workingState: "idle",
    ...overrides,
  };
}

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

describe("selectOrphanRecords", () => {
  it("returns empty when no project is active", async () => {
    const { selectOrphanRecords } = await import("./dock");
    const byId = {
      "s-1": makeRecord({ session_id: "s-1" }),
    };
    expect(selectOrphanRecords(undefined, [], byId)).toEqual([]);
  });

  it("excludes sessions that are already mounted in a cell", async () => {
    const { selectOrphanRecords } = await import("./dock");
    const cells = [
      makeCell({
        id: "c-1",
        projectSlug: "alpha",
        tabs: [{ id: "t-1", sessionId: "mounted" }],
        activeTabId: "t-1",
      }),
    ];
    const byId = {
      mounted: makeRecord({ session_id: "mounted" }),
      orphan: makeRecord({ session_id: "orphan" }),
    };
    const got = selectOrphanRecords("alpha", cells, byId);
    expect(got.map((r) => r.session_id)).toEqual(["orphan"]);
  });

  it("excludes sessions mounted in live layout terminals even if the tab has not flushed sessionId yet", async () => {
    const { selectOrphanRecords } = await import("./dock");
    const cells = [
      makeCell({
        id: "c-1",
        projectSlug: "alpha",
        tabs: [{ id: "t-1" }],
        activeTabId: "t-1",
      }),
    ];
    const byId = {
      mounted: makeRecord({ session_id: "mounted" }),
      orphan: makeRecord({ session_id: "orphan" }),
    };
    const got = selectOrphanRecords("alpha", cells, byId, new Set(["mounted"]));
    expect(got.map((r) => r.session_id)).toEqual(["orphan"]);
  });

  it("scopes orphans to the active project", async () => {
    const { selectOrphanRecords } = await import("./dock");
    const byId = {
      a: makeRecord({ session_id: "a", project_slug: "alpha" }),
      b: makeRecord({ session_id: "b", project_slug: "beta" }),
      c: makeRecord({ session_id: "c", project_slug: null }),
    };
    expect(selectOrphanRecords("alpha", [], byId).map((r) => r.session_id)).toEqual(["a"]);
    expect(selectOrphanRecords("beta", [], byId).map((r) => r.session_id)).toEqual(["b"]);
  });

  it("filters out dead and closing sessions, then sorts alive project sessions by created_unix desc", async () => {
    const { selectOrphanRecords } = await import("./dock");
    const byId = {
      "live-old": makeRecord({ session_id: "live-old", created_unix: 100 }),
      "live-new": makeRecord({ session_id: "live-new", created_unix: 300 }),
      dead: makeRecord({ session_id: "dead", created_unix: 200, dead: true }),
      shell: makeRecord({ session_id: "shell", created_unix: 400, kind: "shell" }),
      closing: makeRecord({ session_id: "closing", created_unix: 500 }),
    };
    const got = selectOrphanRecords("alpha", [], byId, new Set(), new Set(["closing"]));
    expect(got.map((r) => r.session_id)).toEqual(["shell", "live-new", "live-old"]);
  });
});
