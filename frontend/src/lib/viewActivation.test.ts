import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import {
  __resetRuntimeLayoutForTests,
  LAYOUT_UNIT,
  focusedPaneId,
  runtimeLayoutStore,
  setFocusedPaneId,
  setRuntimeLayout,
} from "../stores/runtimeLayoutStore";
import {
  __resetProjectStoreForTests,
  activeProjectSlug,
  setProjects,
} from "../stores/projectStore";
import { __resetTerminalStoreForTests, setTerminals } from "../stores/terminalStore";
import {
  __resetActiveWorktreeScopesForTests,
  ALL_WORKTREES_SCOPE,
  activeWorktreeStore,
  setActiveWorktree,
} from "../stores/worktreeStore";
import { __clearRegistryForTests, registerTerminal } from "./terminalRegistry";
import { __resetProjectionCacheForTests } from "./scopedProjection";
import {
  __resetNavigationDiagnosticsForTests,
  setNavigationDiagnosticsEnabled,
  snapshotNavigationDiagnostics,
} from "./navigationDiagnostics";
import {
  __resetViewActivationForTests,
  activateView,
  crossProjectViewMode,
  currentNavigationGeneration,
} from "./viewActivation";

// ---- fixtures --------------------------------------------------------------

const ALPHA_MAIN = "/tmp/alpha";
const ALPHA_FEAT = "/tmp/alpha-feature";
const BETA_MAIN = "/tmp/beta";

function seedProjects(): void {
  setProjects(
    [
      { slug: "alpha", rootPath: ALPHA_MAIN },
      { slug: "beta", rootPath: BETA_MAIN },
    ].map((p) => ({
      slug: p.slug,
      name: p.slug,
      color: "#fff",
      sigil: "α",
      rootPath: p.rootPath,
      inRepoSettings: false,
      hasRaumToml: false,
      hidden: false,
    })),
  );
}

/**
 * alpha/main → cell-a, alpha/feature → cell-f, beta/main → cell-b.
 * Three disjoint scopes so scope pruning and per-scope focus memory are
 * actually exercised.
 */
function seedLayout(): void {
  setRuntimeLayout([
    {
      id: "cell-a",
      x: 0,
      y: 0,
      w: LAYOUT_UNIT / 3,
      h: LAYOUT_UNIT,
      kind: "codex",
      projectSlug: "alpha",
      worktreeId: ALPHA_MAIN,
      activeTabId: "tab-a",
      tabs: [{ id: "tab-a", sessionId: "session-a" }],
    },
    {
      id: "cell-f",
      x: LAYOUT_UNIT / 3,
      y: 0,
      w: LAYOUT_UNIT / 3,
      h: LAYOUT_UNIT,
      kind: "codex",
      projectSlug: "alpha",
      worktreeId: ALPHA_FEAT,
      activeTabId: "tab-f",
      tabs: [{ id: "tab-f", sessionId: "session-f" }],
    },
    {
      id: "cell-b",
      x: (LAYOUT_UNIT / 3) * 2,
      y: 0,
      w: LAYOUT_UNIT / 3,
      h: LAYOUT_UNIT,
      kind: "codex",
      projectSlug: "beta",
      worktreeId: BETA_MAIN,
      activeTabId: "tab-b",
      tabs: [{ id: "tab-b", sessionId: "session-b" }],
    },
  ]);
}

function seedTerminals(ids = ["session-a", "session-f", "session-b"]): void {
  setTerminals(
    ids.map((id, i) => ({
      session_id: id,
      project_slug: id === "session-b" ? "beta" : "alpha",
      worktree_id: null,
      kind: "codex" as const,
      created_unix: i + 1,
    })),
  );
}

/** Fire the `onRender` subscribers of one registered surface. */
const renderTriggers = new Map<string, () => void>();

function renderSurface(tabId: string): void {
  renderTriggers.get(tabId)?.();
}

/** Register a fake xterm for each tab so `activateView`'s scheduled DOM focus
 *  has something to call, plus a `data-pane-id` host so the focus actually
 *  lands where `paneOwnsFocus` looks for it. Returns the ordered list of
 *  focused tab ids. */
function seedRegistry(tabIds: string[]): string[] {
  const focused: string[] = [];
  for (const tabId of tabIds) {
    const host = document.createElement("div");
    host.setAttribute("data-pane-id", tabId);
    host.tabIndex = -1;
    document.body.append(host);
    const subscribers = new Set<() => void>();
    renderTriggers.set(tabId, () => {
      for (const subscriber of subscribers) subscriber();
    });
    registerTerminal({
      paneId: tabId,
      sessionId: null,
      kind: "codex",
      projectSlug: null,
      worktreeId: null,
      terminal: {
        onRender: (callback: () => void) => {
          subscribers.add(callback);
          return { dispose: () => subscribers.delete(callback) };
        },
      } as never,
      search: {} as never,
      revealBufferLine: () => undefined,
      focus: () => {
        focused.push(tabId);
        host.focus();
      },
    });
  }
  return focused;
}

/** Drain the scheduled focus callbacks (one animation frame). */
function flushFocus(): void {
  vi.advanceTimersByTime(50);
}

describe("viewActivation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "setTimeout", "clearTimeout"] });
    __resetRuntimeLayoutForTests();
    __resetProjectStoreForTests();
    __resetTerminalStoreForTests();
    __resetProjectionCacheForTests();
    __resetActiveWorktreeScopesForTests();
    __resetViewActivationForTests();
    __clearRegistryForTests();
    __resetNavigationDiagnosticsForTests();
    setNavigationDiagnosticsEnabled(true);
    renderTriggers.clear();
    document.body.innerHTML = "";
    seedProjects();
    seedLayout();
    seedTerminals();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits project, scope and focus, then focuses the target terminal", () => {
    const focused = seedRegistry(["tab-a", "tab-f", "tab-b"]);

    activateView({ projectSlug: "beta", source: "mouse" });

    expect(activeProjectSlug()).toBe("beta");
    expect(focusedPaneId()).toBe("cell-b");
    expect(focused).toEqual([]);
    flushFocus();
    expect(focused).toEqual(["tab-b"]);
  });

  it("focuses only the newest target across a rapid A→B→C burst", () => {
    const focused = seedRegistry(["tab-a", "tab-f", "tab-b"]);

    activateView({
      projectSlug: "alpha",
      scope: { mode: "worktree", path: ALPHA_MAIN },
      source: "keyboard",
    });
    const second = activateView({
      projectSlug: "alpha",
      scope: { mode: "worktree", path: ALPHA_FEAT },
      source: "keyboard",
    });
    const third = activateView({ projectSlug: "beta", source: "keyboard" });

    expect(third).toBeGreaterThan(second);
    expect(currentNavigationGeneration()).toBe(third);

    flushFocus();
    // The first two activations' scheduled callbacks ran too, but each saw a
    // newer generation and bowed out — only C's focus lands.
    expect(focused).toEqual(["tab-b"]);
    expect(focusedPaneId()).toBe("cell-b");
  });

  it("restores the last focused pane per (project, scope)", () => {
    setRuntimeLayout([
      {
        id: "cell-a1",
        x: 0,
        y: 0,
        w: LAYOUT_UNIT / 2,
        h: LAYOUT_UNIT,
        kind: "codex",
        projectSlug: "alpha",
        worktreeId: ALPHA_MAIN,
        activeTabId: "tab-a1",
        tabs: [{ id: "tab-a1", sessionId: "session-a1" }],
      },
      {
        id: "cell-a2",
        x: LAYOUT_UNIT / 2,
        y: 0,
        w: LAYOUT_UNIT / 2,
        h: LAYOUT_UNIT,
        kind: "codex",
        projectSlug: "alpha",
        worktreeId: ALPHA_MAIN,
        activeTabId: "tab-a2",
        tabs: [{ id: "tab-a2", sessionId: "session-a2" }],
      },
    ]);
    setTerminals([
      {
        session_id: "session-a1",
        project_slug: "alpha",
        worktree_id: null,
        kind: "codex",
        created_unix: 1,
      },
      {
        session_id: "session-a2",
        project_slug: "alpha",
        worktree_id: null,
        kind: "codex",
        created_unix: 2,
      },
    ]);

    activateView({ projectSlug: "alpha", cellId: "cell-a2", source: "mouse" });
    expect(focusedPaneId()).toBe("cell-a2");

    // Leave and come back with no explicit cell: the second pane wins, not the
    // first one in projected order.
    activateView({ projectSlug: "beta", source: "mouse" });
    activateView({ projectSlug: "alpha", source: "mouse" });
    expect(focusedPaneId()).toBe("cell-a2");
  });

  it("falls back to a live pane when the remembered target's session is gone", () => {
    activateView({
      projectSlug: "alpha",
      scope: { mode: "worktree", path: ALPHA_FEAT },
      source: "mouse",
    });
    expect(focusedPaneId()).toBe("cell-f");

    // The feature worktree's pane is removed entirely (worktree deleted).
    setRuntimeLayout([
      {
        id: "cell-a",
        x: 0,
        y: 0,
        w: LAYOUT_UNIT,
        h: LAYOUT_UNIT,
        kind: "codex",
        projectSlug: "alpha",
        worktreeId: ALPHA_MAIN,
        activeTabId: "tab-a",
        tabs: [{ id: "tab-a", sessionId: "session-a" }],
      },
    ]);

    activateView({ projectSlug: "alpha", scope: ALL_WORKTREES_SCOPE, source: "mouse" });
    expect(focusedPaneId()).toBe("cell-a");
  });

  it("makes no focus attempt for an empty scope", () => {
    const focused = seedRegistry(["tab-a", "tab-f", "tab-b"]);
    setFocusedPaneId("cell-a");

    activateView({
      projectSlug: "alpha",
      scope: { mode: "worktree", path: "/tmp/alpha-empty" },
      source: "mouse",
    });

    expect(activeProjectSlug()).toBe("alpha");
    expect(activeWorktreeStore.byProject["alpha"]).toMatchObject({
      mode: "worktree",
      path: "/tmp/alpha-empty",
    });
    // Focus is left exactly where it was; nothing is focused in the DOM.
    expect(focusedPaneId()).toBe("cell-a");
    flushFocus();
    expect(focused).toEqual([]);
  });

  it("distinguishes an explicit All Worktrees scope from an omitted one", () => {
    setActiveWorktree("alpha", ALPHA_FEAT);

    // Omitted → the project keeps its pinned worktree.
    activateView({ projectSlug: "alpha", source: "mouse" });
    expect(activeWorktreeStore.byProject["alpha"]).toMatchObject({
      mode: "worktree",
      path: ALPHA_FEAT,
    });
    expect(focusedPaneId()).toBe("cell-f");

    // Explicit All Worktrees → the pin is dropped.
    activateView({ projectSlug: "alpha", scope: ALL_WORKTREES_SCOPE, source: "mouse" });
    expect(activeWorktreeStore.byProject["alpha"]?.mode).toBe("all");
  });

  it("sets the cross-project attention mode inside the same activation", () => {
    activateView({ projectSlug: "alpha", crossProjectMode: "awaiting", source: "mouse" });
    expect(crossProjectViewMode()).toBe("awaiting");

    activateView({ projectSlug: "alpha", crossProjectMode: null, source: "mouse" });
    expect(crossProjectViewMode()).toBeNull();

    // Omitting the field leaves the spotlight untouched.
    activateView({ projectSlug: "alpha", crossProjectMode: "working", source: "mouse" });
    activateView({ projectSlug: "beta", source: "mouse" });
    expect(crossProjectViewMode()).toBe("working");
  });

  it("resolves a notification-style session target in another project and scope", () => {
    const focused = seedRegistry(["tab-a", "tab-f", "tab-b"]);
    activateView({
      projectSlug: "alpha",
      scope: { mode: "worktree", path: ALPHA_MAIN },
      source: "mouse",
    });
    expect(focusedPaneId()).toBe("cell-a");

    activateView({
      projectSlug: "alpha",
      scope: { mode: "worktree", path: ALPHA_FEAT },
      sessionId: "session-f",
      source: "notification",
    });

    expect(activeProjectSlug()).toBe("alpha");
    expect(focusedPaneId()).toBe("cell-f");
    expect(runtimeLayoutStore.panes["cell-f"].activeTabId).toBe("tab-f");
    // Only the newest activation's scheduled focus survives the generation
    // check — the first one was superseded before the frame ran.
    flushFocus();
    expect(focused).toEqual(["tab-f"]);
  });

  it("activates the tab named by a session target", () => {
    setRuntimeLayout([
      {
        id: "cell-a",
        x: 0,
        y: 0,
        w: LAYOUT_UNIT,
        h: LAYOUT_UNIT,
        kind: "codex",
        projectSlug: "alpha",
        worktreeId: ALPHA_MAIN,
        activeTabId: "tab-a1",
        tabs: [
          { id: "tab-a1", sessionId: "session-a1" },
          { id: "tab-a2", sessionId: "session-a2" },
        ],
      },
    ]);

    activateView({ projectSlug: "alpha", sessionId: "session-a2", source: "dock" });

    expect(focusedPaneId()).toBe("cell-a");
    expect(runtimeLayoutStore.panes["cell-a"].activeTabId).toBe("tab-a2");
  });

  it("records one diagnostics record per intent, superseding the ones it replaced", () => {
    seedRegistry(["tab-a", "tab-f", "tab-b"]);

    activateView({
      projectSlug: "alpha",
      scope: { mode: "worktree", path: ALPHA_MAIN },
      source: "keyboard",
    });
    activateView({
      projectSlug: "alpha",
      scope: { mode: "worktree", path: ALPHA_FEAT },
      source: "keyboard",
    });
    activateView({ projectSlug: "beta", source: "keyboard" });

    flushFocus();
    renderSurface("tab-b");

    const { completed } = snapshotNavigationDiagnostics();
    expect(completed.map((record) => record.result)).toEqual([
      "superseded",
      "superseded",
      "complete",
    ]);
    const current = completed[2];
    expect(current.kind).toBe("project");
    expect(current.source).toBe("keyboard");
    expect(current.target).toMatchObject({ projectSlug: "beta", cellId: "cell-b" });
    expect(Object.keys(current.milestones).sort()).toEqual([
      "all-visible-rendered",
      "focus-ready",
      "handler",
      "selection-committed",
      "target-rendered",
    ]);
  });

  it("marks focus-ready only for the activation that still owns the generation", () => {
    seedRegistry(["tab-a", "tab-f", "tab-b"]);

    activateView({
      projectSlug: "alpha",
      scope: { mode: "worktree", path: ALPHA_MAIN },
      source: "mouse",
    });
    activateView({ projectSlug: "beta", source: "mouse" });
    flushFocus();

    const { completed, inFlight } = snapshotNavigationDiagnostics();
    expect(completed[0].result).toBe("superseded");
    expect(completed[0].milestones["focus-ready"]).toBeUndefined();
    // The winner is still in flight (its surface hasn't painted yet) but has
    // already taken focus.
    expect(inFlight[0].milestones["focus-ready"]).toEqual(expect.any(Number));
  });

  it("leaves an explicitly focused search input or modal alone", () => {
    const focused = seedRegistry(["tab-a", "tab-f", "tab-b"]);
    const input = document.createElement("input");
    input.type = "search";
    document.body.append(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    activateView({ projectSlug: "beta", source: "keyboard" });
    flushFocus();

    // Selection still commits — only the caret is left where the user put it.
    expect(focusedPaneId()).toBe("cell-b");
    expect(focused).toEqual([]);
    expect(document.activeElement).toBe(input);

    // Same for a button inside a modal dialog.
    input.remove();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.append(button);
    document.body.append(dialog);
    button.focus();

    activateView({ projectSlug: "alpha", source: "keyboard" });
    flushFocus();
    expect(focused).toEqual([]);
  });
});
