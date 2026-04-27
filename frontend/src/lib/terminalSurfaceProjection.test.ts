import { describe, expect, it } from "vitest";

import { LAYOUT_UNIT, type RuntimeCell } from "../stores/runtimeLayoutStore";
import type { TerminalRecord } from "../stores/terminalStore";
import type { Rect } from "./layoutTree";
import { projectTerminalSurfaces } from "./terminalSurfaceProjection";

function rect(id: string, x = 0, y = 0): Rect {
  return { id, x, y, w: LAYOUT_UNIT / 2, h: LAYOUT_UNIT / 2 };
}

function cell(id: string, projectSlug: string, overrides: Partial<RuntimeCell> = {}): RuntimeCell {
  const tabId = `tab-${id}`;
  return {
    id,
    x: 0,
    y: 0,
    w: LAYOUT_UNIT,
    h: LAYOUT_UNIT,
    kind: "codex",
    tabs: [{ id: tabId, sessionId: `session-${id}` }],
    activeTabId: tabId,
    projectSlug,
    ...overrides,
  };
}

function terminal(sessionId: string, projectSlug = "alpha"): TerminalRecord {
  return {
    session_id: sessionId,
    project_slug: projectSlug,
    worktree_id: null,
    kind: "codex",
    created_unix: 1,
    workingState: "idle",
  };
}

describe("terminalSurfaceProjection", () => {
  it("keeps surface keys stable across project switches", () => {
    const alpha = cell("alpha", "alpha");
    const beta = cell("beta", "beta");

    const first = projectTerminalSurfaces({
      cells: [alpha, beta],
      activeRectMap: new Map([["alpha", rect("alpha")]]),
      minimizedPaneIds: new Set(),
      crossProjectMode: null,
      projectedSessionIds: [],
      projectedRectMap: new Map(),
      terminalById: {},
      focusedPaneId: "alpha",
      maximizedPaneId: null,
    });
    const second = projectTerminalSurfaces({
      cells: [alpha, beta],
      activeRectMap: new Map([["beta", rect("beta")]]),
      minimizedPaneIds: new Set(),
      crossProjectMode: null,
      projectedSessionIds: [],
      projectedRectMap: new Map(),
      terminalById: {},
      focusedPaneId: "beta",
      maximizedPaneId: null,
    });

    expect(first.map((surface) => surface.key).sort()).toEqual(
      second.map((surface) => surface.key).sort(),
    );
    expect(first.find((surface) => surface.key === "tab-alpha")?.visible).toBe(true);
    expect(second.find((surface) => surface.key === "tab-alpha")?.visible).toBe(false);
    expect(second.find((surface) => surface.key === "tab-alpha")?.rect).toBeNull();
    expect(second.find((surface) => surface.key === "tab-beta")?.visible).toBe(true);
  });

  it("reuses layout-owned surfaces in cross-project views", () => {
    const alpha = cell("alpha", "alpha");
    const surfaces = projectTerminalSurfaces({
      cells: [alpha],
      activeRectMap: new Map([["alpha", rect("alpha")]]),
      minimizedPaneIds: new Set(),
      crossProjectMode: "recent",
      projectedSessionIds: ["session-alpha"],
      projectedRectMap: new Map([["session-alpha", rect("session-alpha", 5000, 0)]]),
      terminalById: { "session-alpha": terminal("session-alpha") },
      focusedPaneId: null,
      maximizedPaneId: null,
    });

    expect(surfaces).toHaveLength(1);
    expect(surfaces[0].key).toBe("tab-alpha");
    expect(surfaces[0].visible).toBe(true);
    expect(surfaces[0].rect?.x).toBe(5000);
  });

  it("deduplicates duplicate session ids", () => {
    const primary = cell("primary", "alpha", {
      tabs: [{ id: "tab-primary", sessionId: "shared" }],
      activeTabId: "tab-primary",
    });
    const duplicate = cell("duplicate", "alpha", {
      tabs: [{ id: "tab-duplicate", sessionId: "shared" }],
      activeTabId: "tab-duplicate",
    });

    const surfaces = projectTerminalSurfaces({
      cells: [primary, duplicate],
      activeRectMap: new Map([["duplicate", rect("duplicate")]]),
      minimizedPaneIds: new Set(),
      crossProjectMode: null,
      projectedSessionIds: [],
      projectedRectMap: new Map(),
      terminalById: {},
      focusedPaneId: "duplicate",
      maximizedPaneId: null,
    });

    expect(surfaces.filter((surface) => surface.sessionId === "shared")).toHaveLength(1);
    expect(surfaces[0].key).toBe("tab-duplicate");
    expect(surfaces[0].visible).toBe(true);
  });

  it("hides layout surfaces behind another maximized pane", () => {
    const alpha = cell("alpha", "alpha");
    const beta = cell("beta", "alpha");

    const surfaces = projectTerminalSurfaces({
      cells: [alpha, beta],
      activeRectMap: new Map([
        ["alpha", rect("alpha")],
        ["beta", rect("beta", 5000, 0)],
      ]),
      minimizedPaneIds: new Set(),
      crossProjectMode: null,
      projectedSessionIds: [],
      projectedRectMap: new Map(),
      terminalById: {},
      focusedPaneId: "beta",
      maximizedPaneId: "beta",
    });

    expect(surfaces.find((surface) => surface.cellId === "alpha")).toMatchObject({
      visible: false,
      maximized: false,
      rect: null,
    });
    expect(surfaces.find((surface) => surface.cellId === "beta")).toMatchObject({
      visible: true,
      maximized: true,
    });
  });

  it("routes preview rects to siblings during a drag but pins the source", () => {
    const source = cell("source", "alpha");
    const sibling = cell("sibling", "alpha");
    const committedSourceRect = rect("source");
    const committedSiblingRect = rect("sibling");
    // Preview tree projects sibling into a different slot (e.g. it grew to
    // absorb space the dragged source vacated) and projects the source into
    // its hover-target slot. Source preview must be ignored — the surface
    // stays at the committed rect so the CSS ghost transform tracks the
    // cursor from the original location.
    const previewSiblingRect: Rect = { id: "sibling", x: 0, y: 0, w: 9000, h: 9000 };
    const previewSourceRect: Rect = { id: "source", x: 9000, y: 0, w: 1000, h: 1000 };

    const surfaces = projectTerminalSurfaces({
      cells: [source, sibling],
      activeRectMap: new Map([
        ["source", committedSourceRect],
        ["sibling", committedSiblingRect],
      ]),
      minimizedPaneIds: new Set(),
      crossProjectMode: null,
      projectedSessionIds: [],
      projectedRectMap: new Map(),
      terminalById: {},
      focusedPaneId: "source",
      maximizedPaneId: null,
      previewRectMap: new Map([
        ["sibling", previewSiblingRect],
        ["source", previewSourceRect],
      ]),
      dragSourceId: "source",
    });

    const sourceSurface = surfaces.find((s) => s.cellId === "source");
    const siblingSurface = surfaces.find((s) => s.cellId === "sibling");

    expect(sourceSurface?.rect).toEqual(committedSourceRect);
    expect(siblingSurface?.rect).toEqual(previewSiblingRect);
  });

  it("lets cross-project projected rects win over drag preview rects", () => {
    const owner = cell("owner", "alpha");
    const projected: Rect = { id: "session-owner", x: 5000, y: 0, w: 5000, h: 5000 };
    const preview: Rect = { id: "owner", x: 0, y: 5000, w: 5000, h: 5000 };

    const surfaces = projectTerminalSurfaces({
      cells: [owner],
      activeRectMap: new Map([["owner", rect("owner")]]),
      minimizedPaneIds: new Set(),
      crossProjectMode: "recent",
      projectedSessionIds: ["session-owner"],
      projectedRectMap: new Map([["session-owner", projected]]),
      terminalById: { "session-owner": terminal("session-owner") },
      focusedPaneId: null,
      maximizedPaneId: null,
      previewRectMap: new Map([["owner", preview]]),
      dragSourceId: null,
    });

    expect(surfaces[0].rect).toEqual(projected);
  });

  it("pre-owns orphan harness sessions and only shows projected ones", () => {
    const surfaces = projectTerminalSurfaces({
      cells: [],
      activeRectMap: new Map(),
      minimizedPaneIds: new Set(),
      crossProjectMode: "working",
      projectedSessionIds: ["orphan-session", "missing-record"],
      projectedRectMap: new Map([["orphan-session", rect("orphan-session")]]),
      terminalById: {
        "orphan-session": terminal("orphan-session"),
        "hidden-orphan": terminal("hidden-orphan"),
      },
      focusedPaneId: null,
      maximizedPaneId: null,
    });

    expect(surfaces).toHaveLength(2);
    expect(surfaces.find((surface) => surface.key === "orphan:orphan-session")).toMatchObject({
      key: "orphan:orphan-session",
      source: "orphan",
      visible: true,
    });
    expect(surfaces.find((surface) => surface.key === "orphan:hidden-orphan")).toMatchObject({
      key: "orphan:hidden-orphan",
      source: "orphan",
      visible: false,
    });
  });
});
