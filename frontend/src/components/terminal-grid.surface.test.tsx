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
} from "../stores/runtimeLayoutStore";
import {
  __resetProjectStoreForTests,
  setActiveProjectSlug,
  setProjects,
} from "../stores/projectStore";
import { __resetTerminalStoreForTests, setTerminals } from "../stores/terminalStore";
import { setCrossProjectViewMode } from "./top-row";

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
    __resetRuntimeLayoutForTests();
    __resetProjectStoreForTests();
    __resetTerminalStoreForTests();
    seedProjects();
    seedLayout();
    seedTerminals();
  });

  afterEach(() => {
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
});
