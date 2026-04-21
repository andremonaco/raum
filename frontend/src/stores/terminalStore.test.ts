import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  __resetTerminalStoreForTests,
  activeCount,
  applyAgentStateToTerminal,
  globalHarnessCounts,
  harnessCountsForProject,
  harnessCountsForWorktree,
  idleCount,
  removeTerminal,
  setTerminals,
  subscribeTerminalEvents,
  terminalStore,
  upsertTerminal,
  waitingCount,
  type TerminalListItem,
} from "./terminalStore";
import { __resetAgentStoreForTests, updateSessionState } from "./agentStore";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

function terminal(overrides: Partial<TerminalListItem> = {}): TerminalListItem {
  return {
    session_id: "session-1",
    project_slug: "alpha",
    worktree_id: "/tmp/alpha",
    kind: "claude-code",
    created_unix: 1,
    ...overrides,
  };
}

describe("terminalStore harness counts", () => {
  beforeEach(() => {
    __resetTerminalStoreForTests();
    __resetAgentStoreForTests();
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
  });

  it("excludes shell terminals from harness totals", () => {
    setTerminals([
      terminal({ session_id: "harness-1" }),
      terminal({
        session_id: "shell-1",
        kind: "shell",
      }),
    ]);

    applyAgentStateToTerminal("harness-1", "working");

    expect(activeCount()).toBe(1);
    expect(waitingCount()).toBe(0);
    expect(idleCount()).toBe(0);
  });

  it("tracks per-project and global totals from project-scoped harnesses", () => {
    setTerminals([
      terminal({ session_id: "alpha-working", worktree_id: "/tmp/alpha-a" }),
      terminal({ session_id: "alpha-waiting", worktree_id: "/tmp/alpha-b", created_unix: 2 }),
      terminal({
        session_id: "beta-idle",
        project_slug: "beta",
        worktree_id: "/tmp/beta-a",
        kind: "codex",
        created_unix: 3,
      }),
    ]);

    applyAgentStateToTerminal("alpha-working", "working");
    applyAgentStateToTerminal("alpha-waiting", "waiting");

    expect(harnessCountsForProject("alpha")).toEqual({ active: 1, waiting: 1, idle: 0 });
    expect(harnessCountsForProject("beta")).toEqual({ active: 0, waiting: 0, idle: 1 });
    expect(globalHarnessCounts()).toEqual({ active: 1, waiting: 1, idle: 1 });
  });

  it("tracks per-worktree totals", () => {
    setTerminals([
      terminal({ session_id: "alpha-a", worktree_id: "/tmp/alpha-a" }),
      terminal({ session_id: "alpha-b", worktree_id: "/tmp/alpha-b", kind: "opencode" }),
    ]);

    applyAgentStateToTerminal("alpha-a", "working");
    applyAgentStateToTerminal("alpha-b", "waiting");

    expect(harnessCountsForWorktree("/tmp/alpha-a")).toEqual({
      active: 1,
      waiting: 0,
      idle: 0,
    });
    expect(harnessCountsForWorktree("/tmp/alpha-b")).toEqual({
      active: 0,
      waiting: 1,
      idle: 0,
    });
  });

  it("drops sessions from every aggregate as soon as they are removed", () => {
    setTerminals([terminal({ session_id: "remove-me" })]);

    expect(idleCount()).toBe(1);

    removeTerminal("remove-me");

    expect(globalHarnessCounts()).toEqual({ active: 0, waiting: 0, idle: 0 });
    expect(harnessCountsForProject("alpha")).toEqual({ active: 0, waiting: 0, idle: 0 });
  });

  it("preserves live working state when a session is upserted again", () => {
    setTerminals([terminal({ session_id: "rehydrated", created_unix: 1 })]);

    applyAgentStateToTerminal("rehydrated", "waiting");
    upsertTerminal(
      terminal({
        session_id: "rehydrated",
        created_unix: 99,
        worktree_id: "/tmp/alpha-updated",
      }),
    );

    expect(waitingCount()).toBe(1);
    expect(harnessCountsForWorktree("/tmp/alpha-updated")).toEqual({
      active: 0,
      waiting: 1,
      idle: 0,
    });
  });

  it("hydrates startup counters from the current agent snapshot", () => {
    updateSessionState("startup-waiting", "claude-code", "waiting");
    updateSessionState("startup-working", "codex", "working");

    setTerminals([
      terminal({ session_id: "startup-waiting", worktree_id: "/tmp/alpha-waiting" }),
      terminal({
        session_id: "startup-working",
        kind: "codex",
        worktree_id: "/tmp/alpha-working",
      }),
    ]);

    expect(activeCount()).toBe(1);
    expect(waitingCount()).toBe(1);
    expect(idleCount()).toBe(0);
  });

  it("buffers agent states that arrive before the terminal exists", () => {
    applyAgentStateToTerminal("pending-waiting", "waiting");
    applyAgentStateToTerminal("pending-working", "working");

    upsertTerminal(terminal({ session_id: "pending-waiting", worktree_id: "/tmp/alpha-waiting" }));
    upsertTerminal(
      terminal({
        session_id: "pending-working",
        kind: "opencode",
        worktree_id: "/tmp/alpha-working",
      }),
    );

    expect(waitingCount()).toBe(1);
    expect(activeCount()).toBe(1);
    expect(idleCount()).toBe(0);
  });

  it("clears buffered state when the terminal is removed before hydration", () => {
    applyAgentStateToTerminal("stale-pending", "waiting");
    removeTerminal("stale-pending");

    upsertTerminal(terminal({ session_id: "stale-pending" }));

    expect(waitingCount()).toBe(0);
    expect(idleCount()).toBe(1);
  });

  it("applies pane-context events to the matching session only", async () => {
    setTerminals([
      terminal({ session_id: "ctx-a" }),
      terminal({ session_id: "ctx-b", kind: "codex", created_unix: 2 }),
    ]);
    const listeners: Record<string, (ev: { payload: unknown }) => void> = {};
    listenMock.mockImplementation(async (event, handler) => {
      listeners[event] = handler as (ev: { payload: unknown }) => void;
      return () => undefined;
    });

    const unlisten = await subscribeTerminalEvents();
    listeners["terminal-pane-context-changed"]({
      payload: {
        sessionId: "ctx-b",
        currentCommand: "node",
        currentPath: "/tmp/beta",
        paneTitle: "Investigating flake",
        windowName: "node",
      },
    });

    expect(terminalStore.byId["ctx-a"].paneContext).toBeUndefined();
    expect(terminalStore.byId["ctx-b"].paneContext).toEqual({
      currentCommand: "node",
      currentPath: "/tmp/beta",
      paneTitle: "Investigating flake",
      windowName: "node",
    });
    unlisten();
  });

  it("ignores a late harness-context seed after the session was removed", async () => {
    const listeners: Record<string, (ev: { payload: unknown }) => void> = {};
    listenMock.mockImplementation(async (event, handler) => {
      listeners[event] = handler as (ev: { payload: unknown }) => void;
      return () => undefined;
    });

    let resolvePaneContext!: (value: {
      currentCommand: string;
      currentPath: string;
      paneTitle: string;
      windowName: string;
    }) => void;
    invokeMock.mockReturnValueOnce(
      new Promise<{
        currentCommand: string;
        currentPath: string;
        paneTitle: string;
        windowName: string;
      }>((resolve) => {
        resolvePaneContext = resolve;
      }),
    );

    const unlisten = await subscribeTerminalEvents();
    listeners["terminal-session-upserted"]({
      payload: terminal({ session_id: "seeded", kind: "codex", created_unix: 7 }),
    });
    listeners["terminal-session-removed"]({
      payload: { session_id: "seeded" },
    });
    resolvePaneContext({
      currentCommand: "node",
      currentPath: "/tmp/alpha",
      paneTitle: "Reviewing fixes",
      windowName: "node",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(terminalStore.byId["seeded"]).toBeUndefined();
    unlisten();
  });

  it("clears stored pane context when the terminal is removed", async () => {
    setTerminals([terminal({ session_id: "remove-context", kind: "codex" })]);
    const listeners: Record<string, (ev: { payload: unknown }) => void> = {};
    listenMock.mockImplementation(async (event, handler) => {
      listeners[event] = handler as (ev: { payload: unknown }) => void;
      return () => undefined;
    });

    const unlisten = await subscribeTerminalEvents();
    listeners["terminal-pane-context-changed"]({
      payload: {
        sessionId: "remove-context",
        currentCommand: "node",
        currentPath: "/tmp/alpha",
        paneTitle: "Investigating flake",
        windowName: "node",
      },
    });
    expect(terminalStore.byId["remove-context"].paneContext?.paneTitle).toBe("Investigating flake");

    listeners["terminal-session-removed"]({
      payload: { session_id: "remove-context" },
    });

    expect(terminalStore.byId["remove-context"]).toBeUndefined();
    unlisten();
  });
});
