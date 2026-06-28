import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

import { invoke } from "@tauri-apps/api/core";

import { __resetSessionActivityForTests } from "../lib/sessionActivity";
import {
  __resetTerminalsPrefsForTests,
  setAutoDockInactiveDays,
  setAutoDockInactiveEnabled,
} from "../lib/terminalsPrefs";
import { __resetAgentStoreForTests } from "./agentStore";
import { __resetProjectStoreForTests } from "./projectStore";
import {
  __resetRuntimeLayoutForTests,
  LAYOUT_UNIT,
  minimizedPaneIds,
  setFocusedPaneId,
  setRuntimeLayout,
  type RuntimeCell,
} from "./runtimeLayoutStore";
import {
  __resetTerminalStoreForTests,
  applyAgentStateToTerminal,
  setTerminals,
  type TerminalListItem,
} from "./terminalStore";
import { __setNowForTests, selectAutoDockTargets } from "./terminalAutoDock";
import type { PaneContent } from "./runtimeLayoutStore";
import type { TerminalRecord, TerminalWorkingState } from "./terminalStore";

const invokeMock = vi.mocked(invoke);
const NOW = 10 * 86_400_000; // day 10
const THRESHOLD = 86_400_000; // 1 day

// ── Pure selector tests ─────────────────────────────────────────────────────

function rec(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    session_id: "s",
    project_slug: null,
    worktree_id: null,
    kind: "claude-code",
    created_unix: 0,
    workingState: "idle" as TerminalWorkingState,
    ...overrides,
  };
}

function paneWith(
  id: string,
  tabs: PaneContent["tabs"],
  extra: Partial<PaneContent> = {},
): PaneContent {
  return { id, kind: "claude-code", tabs, activeTabId: tabs[0]?.id ?? "", ...extra };
}

interface Args {
  panes: Record<string, PaneContent>;
  byId: Record<string, TerminalRecord>;
  minimized?: ReadonlySet<string>;
  focused?: string | null;
  maximized?: string | null;
  lastActive?: (sid: string) => number;
  lastOutput?: (sid: string) => number;
  inScope?: (pane: PaneContent) => boolean;
  now?: number;
}

function run(a: Args) {
  return selectAutoDockTargets({
    now: a.now ?? NOW,
    thresholdMs: THRESHOLD,
    panes: a.panes,
    minimized: a.minimized ?? new Set(),
    focusedPaneId: a.focused ?? null,
    maximizedPaneId: a.maximized ?? null,
    byId: a.byId,
    lastActiveMs: a.lastActive ?? (() => 0),
    lastOutputMs: a.lastOutput ?? (() => 0),
    inScope: a.inScope ?? (() => true),
  });
}

describe("selectAutoDockTargets", () => {
  it("targets a stale idle tab", () => {
    const targets = run({
      panes: { a: paneWith("a", [{ id: "t1", sessionId: "s1" }]) },
      byId: { s1: rec({ session_id: "s1", created_unix: 0 }) }, // created at epoch → ancient
    });
    expect(targets).toEqual([{ paneId: "a", tabId: "t1", sessionId: "s1", lastUseMs: 0 }]);
  });

  it("skips a tab used within the threshold (recent prompt)", () => {
    const targets = run({
      panes: { a: paneWith("a", [{ id: "t1", sessionId: "s1" }]) },
      byId: {
        s1: rec({ session_id: "s1", lastPrompt: { text: "hi", submittedAtMs: NOW - 1000 } }),
      },
    });
    expect(targets).toEqual([]);
  });

  it("uses created_unix (seconds) as a recency floor", () => {
    const targets = run({
      panes: { a: paneWith("a", [{ id: "t1", sessionId: "s1" }]) },
      byId: { s1: rec({ session_id: "s1", created_unix: (NOW - 600_000) / 1000 }) },
    });
    expect(targets).toEqual([]);
  });

  it("honors the focus-stamp recency channel", () => {
    const targets = run({
      panes: { a: paneWith("a", [{ id: "t1", sessionId: "s1" }]) },
      byId: { s1: rec({ session_id: "s1", created_unix: 0 }) },
      lastActive: (sid) => (sid === "s1" ? NOW - 5000 : 0),
    });
    expect(targets).toEqual([]);
  });

  it("honors the PTY-output recency channel (a still-producing shell counts as used)", () => {
    const targets = run({
      panes: { a: paneWith("a", [{ id: "t1", sessionId: "s1" }]) },
      byId: { s1: rec({ session_id: "s1", created_unix: 0, kind: "shell" }) },
      lastOutput: (sid) => (sid === "s1" ? NOW - 5000 : 0),
    });
    expect(targets).toEqual([]);
  });

  it("skips out-of-scope panes (different project / worktree)", () => {
    const targets = run({
      panes: {
        a: paneWith("a", [{ id: "t1", sessionId: "s1" }], { projectSlug: "other" }),
      },
      byId: { s1: rec({ session_id: "s1", created_unix: 0 }) },
      inScope: () => false,
    });
    expect(targets).toEqual([]);
  });

  it("never docks a working or waiting harness", () => {
    const targets = run({
      panes: {
        a: paneWith("a", [{ id: "t1", sessionId: "s1" }]),
        b: paneWith("b", [{ id: "t2", sessionId: "s2" }]),
      },
      byId: {
        s1: rec({ session_id: "s1", created_unix: 0, workingState: "working" }),
        s2: rec({ session_id: "s2", created_unix: 0, workingState: "waiting" }),
      },
    });
    expect(targets).toEqual([]);
  });

  it("never docks the focused or maximized pane", () => {
    const panes = {
      a: paneWith("a", [{ id: "t1", sessionId: "s1" }]),
      b: paneWith("b", [{ id: "t2", sessionId: "s2" }]),
    };
    const byId = {
      s1: rec({ session_id: "s1", created_unix: 0 }),
      s2: rec({ session_id: "s2", created_unix: 0 }),
    };
    expect(run({ panes, byId, focused: "a" }).map((t) => t.paneId)).toEqual(["b"]);
    expect(run({ panes, byId, maximized: "b" }).map((t) => t.paneId)).toEqual(["a"]);
  });

  it("skips already-minimized panes", () => {
    const targets = run({
      panes: { a: paneWith("a", [{ id: "t1", sessionId: "s1" }]) },
      byId: { s1: rec({ session_id: "s1", created_unix: 0 }) },
      minimized: new Set(["a"]),
    });
    expect(targets).toEqual([]);
  });

  it("skips dead, unknown, and session-less tabs", () => {
    const targets = run({
      panes: {
        a: paneWith("a", [{ id: "t1", sessionId: "s1" }]), // dead
        b: paneWith("b", [{ id: "t2", sessionId: "s2" }]), // unknown (not in byId)
        c: paneWith("c", [{ id: "t3" }]), // no session id
      },
      byId: { s1: rec({ session_id: "s1", created_unix: 0, dead: true }) },
    });
    expect(targets).toEqual([]);
  });

  it("extracts only the idle tab from a multi-tab pane (active sibling working)", () => {
    const targets = run({
      panes: {
        a: paneWith("a", [
          { id: "t1", sessionId: "s1" }, // idle, stale → target
          { id: "t2", sessionId: "s2" }, // working → kept
        ]),
      },
      byId: {
        s1: rec({ session_id: "s1", created_unix: 0, workingState: "idle" }),
        s2: rec({ session_id: "s2", created_unix: 0, workingState: "working" }),
      },
    });
    expect(targets).toEqual([{ paneId: "a", tabId: "t1", sessionId: "s1", lastUseMs: 0 }]);
  });
});

// ── Live reactive driver tests (mirror projectVisibility's effect-level tests) ─

const LIVE_NOW = 1_700_000_000_000;

function shellPane(paneId: string, sessionId: string): RuntimeCell {
  return {
    id: paneId,
    x: 0,
    y: 0,
    w: LAYOUT_UNIT,
    h: LAYOUT_UNIT,
    kind: "shell",
    tabs: [{ id: `tab-${paneId}`, sessionId }],
    activeTabId: `tab-${paneId}`,
  } as RuntimeCell;
}

function terminal(overrides: Partial<TerminalListItem> = {}): TerminalListItem {
  return {
    session_id: "s1",
    project_slug: null,
    worktree_id: null,
    kind: "shell",
    created_unix: 1, // epoch → ancient unless something else bumps it
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("terminalAutoDock — live effect", () => {
  beforeEach(() => {
    __resetRuntimeLayoutForTests();
    __resetTerminalStoreForTests();
    __resetProjectStoreForTests();
    __resetAgentStoreForTests();
    __resetSessionActivityForTests();
    __resetTerminalsPrefsForTests();
    __setNowForTests(LIVE_NOW);
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("docks a stale idle pane once enabled and the clock advances", async () => {
    setRuntimeLayout([shellPane("p1", "s1")]);
    setTerminals([terminal({ session_id: "s1" })]);
    setFocusedPaneId(null);
    setAutoDockInactiveEnabled(true);
    setAutoDockInactiveDays(1);
    __setNowForTests(LIVE_NOW);
    await flush();
    expect(minimizedPaneIds().has("p1")).toBe(true);
  });

  it("is a no-op while disabled (default)", async () => {
    setRuntimeLayout([shellPane("p1", "s1")]);
    setTerminals([terminal({ session_id: "s1" })]);
    setFocusedPaneId(null);
    __setNowForTests(LIVE_NOW);
    await flush();
    expect(minimizedPaneIds().has("p1")).toBe(false);
  });

  it("never docks the focused pane", async () => {
    setRuntimeLayout([shellPane("p1", "s1")]);
    setTerminals([terminal({ session_id: "s1" })]);
    setFocusedPaneId("p1");
    setAutoDockInactiveEnabled(true);
    setAutoDockInactiveDays(1);
    __setNowForTests(LIVE_NOW);
    await flush();
    expect(minimizedPaneIds().has("p1")).toBe(false);
  });

  it("never docks a working harness", async () => {
    setRuntimeLayout([{ ...shellPane("p1", "s1"), kind: "claude-code" } as RuntimeCell]);
    setTerminals([terminal({ session_id: "s1", kind: "claude-code" })]);
    applyAgentStateToTerminal("s1", "working");
    setFocusedPaneId(null);
    setAutoDockInactiveEnabled(true);
    setAutoDockInactiveDays(1);
    __setNowForTests(LIVE_NOW);
    await flush();
    expect(minimizedPaneIds().has("p1")).toBe(false);
  });
});
