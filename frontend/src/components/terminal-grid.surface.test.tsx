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

vi.mock("./terminal-pane", () => ({
  TerminalPane: (props: { surfaceKey?: string; visible?: boolean }) => {
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
      />
    );
  },
}));

import { TerminalGrid } from "./terminal-grid";
import {
  __resetRuntimeLayoutForTests,
  LAYOUT_UNIT,
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
    },
    {
      slug: "beta",
      name: "Beta",
      color: "#00ff00",
      sigil: "β",
      rootPath: "/tmp/beta",
      inRepoSettings: false,
      hasRaumToml: false,
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
    surfaceMounts = 0;
    surfaceCleanups = 0;
    setCrossProjectViewMode(null);
    __setDragStateForTests(null);
    __resetRuntimeLayoutForTests();
    __resetProjectStoreForTests();
    __resetTerminalStoreForTests();
    seedProjects();
    seedLayout();
    seedTerminals();
  });

  afterEach(() => {
    __setDragStateForTests(null);
    cleanup();
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

    setCrossProjectViewMode("recent");
    expect(surfaceMounts).toBe(2);
    expect(surfaceCleanups).toBe(0);
    expect(screen.getByTestId("terminal-surface-tab-alpha")).toHaveAttribute(
      "data-visible",
      "true",
    );
    expect(screen.getByTestId("terminal-surface-tab-beta")).toHaveAttribute("data-visible", "true");
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
    // sibling x goes 50% → 0%, occupying the left half.
    __setDragStateForTests({
      sourceId: "cell-source",
      sourceKind: "codex",
      sourceLabel: "Codex",
      startPointerX: 0,
      startPointerY: 0,
      pointerX: 0,
      pointerY: 0,
      targetId: "cell-sibling",
      zone: "right",
      targetRect: null,
    });

    // Source surface marks itself as the ghost (CSS ride-along key).
    expect(sourceFrame.dataset.dragging).toBe("true");
    expect(sourceFrame.classList.contains("surface-dragging-source")).toBe(true);
    expect(siblingFrame.classList.contains("surface-dragging-source")).toBe(false);

    // Sibling has reflowed to its preview rect, in lockstep with the chrome.
    expect(siblingFrame.style.getPropertyValue("--x-pct")).toBe("0%");

    // Source surface stays anchored to its committed rect (the CSS transform
    // moves it visually). Without this pin, the surface would snap to the
    // hover-target slot mid-drag and the ghost would teleport.
    expect(sourceFrame.style.getPropertyValue("--x-pct")).toBe("0%");
    expect(sourceFrame.style.getPropertyValue("--w-pct")).toBe("50%");

    __setDragStateForTests(null);
    expect(sourceFrame.dataset.dragging).toBe("false");
    expect(sourceFrame.classList.contains("surface-dragging-source")).toBe(false);
    expect(siblingFrame.style.getPropertyValue("--x-pct")).toBe("50%");
  });
});
