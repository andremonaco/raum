import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onCleanup, onMount } from "solid-js";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({ harnesses: [] }),
}));

vi.mock("../lib/keymapContext", () => ({
  useKeymap: () => ({
    register: () => () => undefined,
    accelerator: () => undefined,
  }),
}));

let surfaceMounts = 0;
let surfaceCleanups = 0;
// Counts every call to the whole-session surface projector. Focus changes must
// not move this number — that is the point of task 5.2.
let projectorCalls = 0;

vi.mock("../lib/terminalSurfaceProjection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/terminalSurfaceProjection")>();
  return {
    ...actual,
    projectTerminalSurfaces: (args: Parameters<typeof actual.projectTerminalSurfaces>[0]) => {
      projectorCalls += 1;
      return actual.projectTerminalSurfaces(args);
    },
  };
});

vi.mock("./terminal-pane", () => ({
  TerminalPane: (props: { surfaceKey?: string; visible?: boolean; active?: boolean }) => {
    onMount(() => {
      surfaceMounts += 1;
    });
    onCleanup(() => {
      surfaceCleanups += 1;
    });
    return (
      <div
        data-testid={`terminal-surface-${props.surfaceKey ?? "unknown"}`}
        data-visible={props.visible ? "true" : "false"}
        data-active={props.active ? "true" : "false"}
      />
    );
  },
}));

import { TerminalGrid } from "./terminal-grid";
import {
  __resetRuntimeLayoutForTests,
  focusedPaneId,
  LAYOUT_UNIT,
  setActiveTabId,
  setFocusedPaneId,
  setRuntimeLayout,
  toggleMaximize,
} from "../stores/runtimeLayoutStore";
import {
  __resetProjectStoreForTests,
  setActiveProjectSlug,
  setProjects,
} from "../stores/projectStore";
import { __resetTerminalStoreForTests, setTerminals } from "../stores/terminalStore";
import { setCrossProjectViewMode } from "./top-row";
import { __setDragStateForTests } from "../lib/paneDnD";
import { setPresentationPolicy } from "../lib/rendererScheduler";
import { __resetProjectionCacheForTests } from "../lib/scopedProjection";
import { activeWorktreeStore, setActiveWorktree } from "../stores/worktreeStore";

function seedProjects(): void {
  setProjects([
    {
      slug: "alpha",
      name: "Alpha",
      color: "#ff0000",
      sigil: "α",
      rootPath: "/tmp/alpha",
      inRepoSettings: false,
      hasRaumToml: false,
      hidden: false,
    },
    {
      slug: "beta",
      name: "Beta",
      color: "#00ff00",
      sigil: "β",
      rootPath: "/tmp/beta",
      inRepoSettings: false,
      hasRaumToml: false,
      hidden: false,
    },
  ]);
  setActiveProjectSlug("alpha");
}

function seedLayout(): void {
  setRuntimeLayout([
    {
      id: "cell-alpha",
      x: 0,
      y: 0,
      w: LAYOUT_UNIT / 2,
      h: LAYOUT_UNIT,
      kind: "codex",
      projectSlug: "alpha",
      activeTabId: "tab-alpha",
      tabs: [{ id: "tab-alpha", sessionId: "session-alpha" }],
    },
    {
      id: "cell-beta",
      x: LAYOUT_UNIT / 2,
      y: 0,
      w: LAYOUT_UNIT / 2,
      h: LAYOUT_UNIT,
      kind: "codex",
      projectSlug: "beta",
      activeTabId: "tab-beta",
      tabs: [{ id: "tab-beta", sessionId: "session-beta" }],
    },
  ]);
}

function seedTerminals(): void {
  setTerminals([
    {
      session_id: "session-alpha",
      project_slug: "alpha",
      worktree_id: null,
      kind: "codex",
      created_unix: 1,
    },
    {
      session_id: "session-beta",
      project_slug: "beta",
      worktree_id: null,
      kind: "codex",
      created_unix: 2,
    },
  ]);
}

describe("TerminalGrid persistent surfaces", () => {
  beforeEach(() => {
    setPresentationPolicy("warm-residency");
    surfaceMounts = 0;
    surfaceCleanups = 0;
    projectorCalls = 0;
    setCrossProjectViewMode(null);
    __setDragStateForTests(null);
    __resetRuntimeLayoutForTests();
    // `__resetRuntimeLayoutForTests` rewinds `layoutRev` to 0, so a cached
    // projection from the previous test would otherwise be reused for a
    // completely different tree at the same key.
    __resetProjectionCacheForTests();
    __resetProjectStoreForTests();
    __resetTerminalStoreForTests();
    seedProjects();
    seedLayout();
    seedTerminals();
  });

  afterEach(() => {
    __setDragStateForTests(null);
    setPresentationPolicy("legacy");
    cleanup();
  });

  /** The positioned surface frame that owns a mocked pane. */
  function frameOf(key: string): HTMLElement {
    const el = screen.getByTestId(`terminal-surface-${key}`).closest(".terminal-surface-frame");
    if (!el) throw new Error(`no surface frame for ${key}`);
    return el as HTMLElement;
  }

  function dragFrom(sourceId: string): void {
    __setDragStateForTests({
      sourceId,
      sourceKind: "codex",
      sourceLabel: "Codex",
      startPointerX: 0,
      startPointerY: 0,
      targetId: null,
      zone: null,
      targetRect: null,
      snapped: false,
      snapHystRect: null,
      armed: false,
      armStartedAtMs: null,
      armDelayMs: 0,
      escapedTargetId: null,
    });
  }

  it("legacy policy leaves hidden hosts in layout", () => {
    setPresentationPolicy("legacy");
    render(() => <TerminalGrid />);
    const beta = frameOf("tab-beta");
    expect(beta.style.display).toBe("");
    expect(beta.style.visibility).toBe("hidden");
  });

  it("warm-residency takes hidden hosts out of layout, except mid-gesture", () => {
    setPresentationPolicy("warm-residency");
    render(() => <TerminalGrid />);

    const alpha = frameOf("tab-alpha");
    const beta = frameOf("tab-beta");
    expect(alpha.style.display).toBe("");
    expect(beta.style.display).toBe("none");
    // The cached rect survives hiding: show must not wait for geometry.
    expect(beta.style.getPropertyValue("--w-pct")).toBe("100%");

    // Drag source: the surface rides the cursor transform, so it has to stay
    // laid out for the whole gesture.
    dragFrom("cell-beta");
    expect(beta.style.display).toBe("");
    __setDragStateForTests(null);
    expect(beta.style.display).toBe("none");

    // Maximize animation target: same reason, until the transition ends.
    toggleMaximize("cell-beta");
    expect(beta.style.display).toBe("");
  });

  it("keeps terminal surfaces mounted across project switches and cross-project filters", () => {
    render(() => <TerminalGrid />);

    expect(surfaceMounts).toBe(2);
    expect(surfaceCleanups).toBe(0);
    expect(screen.getByTestId("terminal-surface-tab-alpha")).toHaveAttribute(
      "data-visible",
      "true",
    );
    expect(screen.getByTestId("terminal-surface-tab-beta")).toHaveAttribute(
      "data-visible",
      "false",
    );

    setActiveProjectSlug("beta");
    expect(surfaceMounts).toBe(2);
    expect(surfaceCleanups).toBe(0);
    expect(screen.getByTestId("terminal-surface-tab-alpha")).toHaveAttribute(
      "data-visible",
      "false",
    );
    expect(screen.getByTestId("terminal-surface-tab-beta")).toHaveAttribute("data-visible", "true");

    setCrossProjectViewMode("completed");
    expect(surfaceMounts).toBe(2);
    expect(surfaceCleanups).toBe(0);
    expect(screen.getByTestId("terminal-surface-tab-alpha")).toHaveAttribute(
      "data-visible",
      "true",
    );
    expect(screen.getByTestId("terminal-surface-tab-beta")).toHaveAttribute("data-visible", "true");
  });

  it("does not mount dock-only orphan sessions in normal project view", () => {
    setTerminals([
      {
        session_id: "session-alpha",
        project_slug: "alpha",
        worktree_id: null,
        kind: "codex",
        created_unix: 1,
      },
      {
        session_id: "orphan-alpha",
        project_slug: "alpha",
        worktree_id: null,
        kind: "codex",
        created_unix: 3,
      },
    ]);

    render(() => <TerminalGrid />);

    expect(screen.getByTestId("terminal-surface-tab-alpha")).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-surface-orphan:orphan-alpha")).toBeNull();
    expect(surfaceMounts).toBe(2);
  });

  it("hides the divider layer while a pane is maximized", () => {
    setRuntimeLayout([
      {
        id: "cell-source",
        x: 0,
        y: 0,
        w: LAYOUT_UNIT / 2,
        h: LAYOUT_UNIT,
        kind: "codex",
        projectSlug: "alpha",
        activeTabId: "tab-source",
        tabs: [{ id: "tab-source", sessionId: "session-source" }],
      },
      {
        id: "cell-sibling",
        x: LAYOUT_UNIT / 2,
        y: 0,
        w: LAYOUT_UNIT / 2,
        h: LAYOUT_UNIT,
        kind: "codex",
        projectSlug: "alpha",
        activeTabId: "tab-sibling",
        tabs: [{ id: "tab-sibling", sessionId: "session-sibling" }],
      },
    ]);

    const { container } = render(() => <TerminalGrid />);

    // At rest a row split with two siblings produces one divider.
    expect(container.querySelectorAll(".pane-divider")).toHaveLength(1);

    toggleMaximize("cell-source");
    expect(container.querySelectorAll(".pane-divider")).toHaveLength(0);

    // Restoring brings the divider back.
    toggleMaximize("cell-source");
    expect(container.querySelectorAll(".pane-divider")).toHaveLength(1);
  });

  it("ghosts the dragged surface and reflows siblings to preview rects", () => {
    // Two siblings in the same project so both stay in the active tree under
    // a same-project drag (the default seed splits siblings across projects,
    // which would prune cell-beta out of the active scope).
    setRuntimeLayout([
      {
        id: "cell-source",
        x: 0,
        y: 0,
        w: LAYOUT_UNIT / 2,
        h: LAYOUT_UNIT,
        kind: "codex",
        projectSlug: "alpha",
        activeTabId: "tab-source",
        tabs: [{ id: "tab-source", sessionId: "session-source" }],
      },
      {
        id: "cell-sibling",
        x: LAYOUT_UNIT / 2,
        y: 0,
        w: LAYOUT_UNIT / 2,
        h: LAYOUT_UNIT,
        kind: "codex",
        projectSlug: "alpha",
        activeTabId: "tab-sibling",
        tabs: [{ id: "tab-sibling", sessionId: "session-sibling" }],
      },
    ]);
    setTerminals([
      {
        session_id: "session-source",
        project_slug: "alpha",
        worktree_id: null,
        kind: "codex",
        created_unix: 1,
      },
      {
        session_id: "session-sibling",
        project_slug: "alpha",
        worktree_id: null,
        kind: "codex",
        created_unix: 2,
      },
    ]);

    render(() => <TerminalGrid />);

    const sourceFrame = screen
      .getByTestId("terminal-surface-tab-source")
      .closest(".terminal-surface-frame") as HTMLElement;
    const siblingFrame = screen
      .getByTestId("terminal-surface-tab-sibling")
      .closest(".terminal-surface-frame") as HTMLElement;
    expect(sourceFrame).toBeTruthy();
    expect(siblingFrame).toBeTruthy();

    // Pre-drag: sibling at the right half (committed rect).
    expect(siblingFrame.style.getPropertyValue("--x-pct")).toBe("50%");
    expect(sourceFrame.dataset.dragging).toBe("false");

    // Drive a drag from `cell-source` toward the sibling's `right` edge.
    // Pure preview-tree replay: source removed → sibling collapses to full
    // width → source re-inserted to the right of sibling. Net effect:
    // sibling x goes 50% → 0%, occupying the left half. `armed: true` because
    // the edge-split preview reflow only engages after the dwell elapses (the
    // dwell gate itself is covered in paneDnD.test.ts).
    __setDragStateForTests({
      sourceId: "cell-source",
      sourceKind: "codex",
      sourceLabel: "Codex",
      startPointerX: 0,
      startPointerY: 0,
      targetId: "cell-sibling",
      zone: "right",
      targetRect: null,
      snapped: false,
      snapHystRect: null,
      armed: true,
      armStartedAtMs: null,
      armDelayMs: 0,
      escapedTargetId: null,
    });

    // Source surface marks itself as the ghost (CSS ride-along key).
    expect(sourceFrame.dataset.dragging).toBe("true");
    expect(sourceFrame.classList.contains("surface-dragging-source")).toBe(true);
    expect(siblingFrame.classList.contains("surface-dragging-source")).toBe(false);

    // Sibling has reflowed to its preview rect, in lockstep with the chrome.
    expect(siblingFrame.style.getPropertyValue("--x-pct")).toBe("0%");

    // Once latched, the dragged source ALSO settles into its slot (the dragged
    // pane is its own landing preview) — it takes the right half, marked
    // `is-edge-snapped` so its chrome drops the cursor transform.
    expect(sourceFrame.classList.contains("is-edge-snapped")).toBe(true);
    expect(sourceFrame.style.getPropertyValue("--x-pct")).toBe("50%");
    expect(sourceFrame.style.getPropertyValue("--w-pct")).toBe("50%");

    __setDragStateForTests(null);
    expect(sourceFrame.dataset.dragging).toBe("false");
    expect(sourceFrame.classList.contains("surface-dragging-source")).toBe(false);
    expect(siblingFrame.style.getPropertyValue("--x-pct")).toBe("50%");
  });

  it("toggles snap-target and is-snapped chrome classes when the magnetic snap engages", () => {
    setRuntimeLayout([
      {
        id: "cell-source",
        x: 0,
        y: 0,
        w: LAYOUT_UNIT / 2,
        h: LAYOUT_UNIT,
        kind: "codex",
        projectSlug: "alpha",
        activeTabId: "tab-source",
        tabs: [{ id: "tab-source", sessionId: "session-source" }],
      },
      {
        id: "cell-sibling",
        x: LAYOUT_UNIT / 2,
        y: 0,
        w: LAYOUT_UNIT / 2,
        h: LAYOUT_UNIT,
        kind: "codex",
        projectSlug: "alpha",
        activeTabId: "tab-sibling",
        tabs: [{ id: "tab-sibling", sessionId: "session-sibling" }],
      },
    ]);
    setTerminals([
      {
        session_id: "session-source",
        project_slug: "alpha",
        worktree_id: null,
        kind: "codex",
        created_unix: 1,
      },
      {
        session_id: "session-sibling",
        project_slug: "alpha",
        worktree_id: null,
        kind: "codex",
        created_unix: 2,
      },
    ]);

    const { container } = render(() => <TerminalGrid />);

    // The chrome layer's frame is a `.terminal-chrome-frame` (LeafFrame).
    // Both chrome and surface frames carry `data-cell-id`, so the selector
    // must scope to the chrome class to disambiguate.
    function chromeFrameFor(cellId: string): HTMLElement {
      const el = container.querySelector(`.terminal-chrome-frame[data-cell-id="${cellId}"]`);
      if (!el) throw new Error(`no chrome frame for ${cellId}`);
      return el as HTMLElement;
    }
    const sourceChrome = chromeFrameFor("cell-source");
    const siblingChrome = chromeFrameFor("cell-sibling");
    const sourceSurface = screen
      .getByTestId("terminal-surface-tab-source")
      .closest(".terminal-surface-frame") as HTMLElement;

    // Pre-snap baseline.
    expect(sourceChrome.classList.contains("is-snapped")).toBe(false);
    expect(sourceSurface.classList.contains("is-snapped")).toBe(false);
    expect(siblingChrome.classList.contains("pane-review-snap-target")).toBe(false);
    expect(screen.queryByTestId("review-snap-overlay")).toBeNull();

    // Drive the snap state: the user has dragged source onto sibling and
    // the magnetic snap is engaged. The chrome should now mark sibling as
    // the snap target, source as snapped, and render the overlay.
    __setDragStateForTests({
      sourceId: "cell-source",
      sourceKind: "codex",
      sourceLabel: "Codex",
      startPointerX: 0,
      startPointerY: 0,
      targetId: "cell-sibling",
      zone: "center",
      targetRect: new DOMRect(500, 0, 500, 1000),
      snapped: true,
      snapHystRect: new DOMRect(452, -48, 596, 1096),
      armed: true,
      armStartedAtMs: null,
      armDelayMs: 0,
      escapedTargetId: null,
    });

    expect(sourceChrome.classList.contains("is-snapped")).toBe(true);
    expect(sourceSurface.classList.contains("is-snapped")).toBe(true);
    expect(siblingChrome.classList.contains("pane-review-snap-target")).toBe(true);
    expect(screen.getByTestId("review-snap-overlay")).toBeInTheDocument();

    // Releasing the snap (still mid-drag, just unsnapped) clears all three.
    __setDragStateForTests({
      sourceId: "cell-source",
      sourceKind: "codex",
      sourceLabel: "Codex",
      startPointerX: 0,
      startPointerY: 0,
      targetId: null,
      zone: null,
      targetRect: null,
      snapped: false,
      snapHystRect: null,
      armed: false,
      armStartedAtMs: null,
      armDelayMs: 0,
      escapedTargetId: null,
    });

    expect(sourceChrome.classList.contains("is-snapped")).toBe(false);
    expect(sourceSurface.classList.contains("is-snapped")).toBe(false);
    expect(siblingChrome.classList.contains("pane-review-snap-target")).toBe(false);
    expect(screen.queryByTestId("review-snap-overlay")).toBeNull();
  });

  it("derives pane-active state from focus without re-running the projector", () => {
    render(() => <TerminalGrid />);

    const alpha = screen.getByTestId("terminal-surface-tab-alpha");
    const beta = screen.getByTestId("terminal-surface-tab-beta");
    expect(alpha).toHaveAttribute("data-active", "false");

    const projectionsAfterMount = projectorCalls;
    const mountsAfterMount = surfaceMounts;

    setFocusedPaneId("cell-alpha");
    expect(alpha).toHaveAttribute("data-active", "true");
    // Hidden surface in another project: never active, even when its cell id
    // happens to be the focused one.
    expect(beta).toHaveAttribute("data-active", "false");

    setFocusedPaneId("cell-beta");
    expect(alpha).toHaveAttribute("data-active", "false");
    expect(beta).toHaveAttribute("data-active", "false");

    // The whole point: focus touched only the two focus consumers. No global
    // re-projection, no remount, no teardown.
    expect(projectorCalls).toBe(projectionsAfterMount);
    expect(surfaceMounts).toBe(mountsAfterMount);
    expect(surfaceCleanups).toBe(0);
  });

  it("flips only the affected hosts' visibility on an A→B project switch", () => {
    render(() => <TerminalGrid />);

    const alpha = screen.getByTestId("terminal-surface-tab-alpha");
    const beta = screen.getByTestId("terminal-surface-tab-beta");
    expect(alpha).toHaveAttribute("data-visible", "true");
    expect(beta).toHaveAttribute("data-visible", "false");

    const mountsBefore = surfaceMounts;
    setActiveProjectSlug("beta");

    expect(alpha).toHaveAttribute("data-visible", "false");
    expect(beta).toHaveAttribute("data-visible", "true");
    expect(surfaceMounts).toBe(mountsBefore);
    expect(surfaceCleanups).toBe(0);
    // Same DOM nodes — the hosts were updated in place, not recreated.
    expect(screen.getByTestId("terminal-surface-tab-alpha")).toBe(alpha);
    expect(screen.getByTestId("terminal-surface-tab-beta")).toBe(beta);
  });

  it("keeps active tab selection off the geometry projection path", () => {
    setRuntimeLayout([
      {
        id: "cell-alpha",
        x: 0,
        y: 0,
        w: LAYOUT_UNIT,
        h: LAYOUT_UNIT,
        kind: "codex",
        projectSlug: "alpha",
        activeTabId: "tab-alpha",
        tabs: [
          { id: "tab-alpha", sessionId: "session-alpha" },
          { id: "tab-alpha-2", sessionId: "session-alpha-2" },
        ],
      },
    ]);

    render(() => <TerminalGrid />);
    const first = screen.getByTestId("terminal-surface-tab-alpha");
    const second = screen.getByTestId("terminal-surface-tab-alpha-2");
    expect(first).toHaveAttribute("data-visible", "true");
    expect(second).toHaveAttribute("data-visible", "false");

    const mountsBefore = surfaceMounts;
    setActiveTabId("cell-alpha", "tab-alpha-2");

    expect(first).toHaveAttribute("data-visible", "false");
    expect(second).toHaveAttribute("data-visible", "true");
    expect(surfaceMounts).toBe(mountsBefore);
    expect(surfaceCleanups).toBe(0);
  });
  it("a notification for a main-worktree pane widens a pinned feature-worktree scope", () => {
    render(() => <TerminalGrid />);
    // cell-alpha has no worktreeId: it lives in the main worktree, which the
    // scope prune keys by the project root path.
    setActiveWorktree("alpha", "/tmp/alpha/.raum/feature");
    window.dispatchEvent(
      new CustomEvent("terminal-focus-requested", { detail: { sessionId: "session-alpha" } }),
    );
    expect(activeWorktreeStore.byProject["alpha"]).toEqual({
      mode: "worktree",
      path: "/tmp/alpha",
    });
    expect(focusedPaneId()).toBe("cell-alpha");
  });
});
