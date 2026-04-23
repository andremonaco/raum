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
  harnessIds,
  idleCount,
  idsByProjectSlug,
  idsByWorktreeId,
  lastOutputBySession,
  listCrossProjectHarnessSessions,
  markOutput,
  removeTerminal,
  setTerminals,
  subscribeTerminalEvents,
  terminalStore,
  upsertTerminal,
  waitingCount,
  waitingIds,
  workingIds,
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

  it("lists working and awaiting cross-project sessions from the live state buckets", () => {
    setTerminals([
      terminal({ session_id: "waiting-alpha", created_unix: 1 }),
      terminal({
        session_id: "working-beta",
        project_slug: "beta",
        kind: "codex",
        created_unix: 2,
      }),
      terminal({
        session_id: "idle-gamma",
        project_slug: "gamma",
        kind: "opencode",
        created_unix: 3,
      }),
    ]);

    applyAgentStateToTerminal("waiting-alpha", "waiting");
    applyAgentStateToTerminal("working-beta", "working");

    expect(listCrossProjectHarnessSessions("awaiting").map((t) => t.session_id)).toEqual([
      "waiting-alpha",
    ]);
    expect(listCrossProjectHarnessSessions("working").map((t) => t.session_id)).toEqual([
      "working-beta",
    ]);
  });

  it("lists recent cross-project sessions uncapped and sorted by last output", () => {
    vi.useFakeTimers();
    try {
      setTerminals([
        terminal({ session_id: "older", created_unix: 1 }),
        terminal({ session_id: "middle", project_slug: "beta", kind: "codex", created_unix: 2 }),
        terminal({ session_id: "newer", project_slug: "gamma", kind: "opencode", created_unix: 3 }),
      ]);

      vi.setSystemTime(new Date("2026-04-23T10:00:00Z"));
      markOutput("older");
      vi.setSystemTime(new Date("2026-04-23T10:00:01Z"));
      markOutput("middle");
      vi.setSystemTime(new Date("2026-04-23T10:00:02Z"));
      markOutput("newer");

      expect(listCrossProjectHarnessSessions("recent").map((t) => t.session_id)).toEqual([
        "newer",
        "middle",
        "older",
      ]);
    } finally {
      vi.useRealTimers();
    }
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

  it("keeps membership and counts stable across PTY-output storms", () => {
    setTerminals([terminal({ session_id: "streamer", worktree_id: "/tmp/alpha-stream" })]);
    applyAgentStateToTerminal("streamer", "working");

    const workingBefore = workingIds();
    const harnessBefore = harnessIds();
    const projectBucketBefore = idsByProjectSlug();
    const worktreeBucketBefore = idsByWorktreeId();
    const globalBefore = globalHarnessCounts();

    for (let i = 0; i < 1000; i++) markOutput("streamer");

    expect(workingIds()).toBe(workingBefore);
    expect(harnessIds()).toBe(harnessBefore);
    expect(idsByProjectSlug()).toBe(projectBucketBefore);
    expect(idsByWorktreeId()).toBe(worktreeBucketBefore);
    expect(globalHarnessCounts()).toEqual(globalBefore);
    expect(lastOutputBySession().get("streamer")).toBeGreaterThan(0);
  });

  it("relocates a session between worktree and project buckets on upsert", () => {
    setTerminals([terminal({ session_id: "mover", worktree_id: "/tmp/alpha-a" })]);
    applyAgentStateToTerminal("mover", "working");
    expect(idsByProjectSlug().get("alpha")?.has("mover")).toBe(true);
    expect(idsByWorktreeId().get("/tmp/alpha-a")?.has("mover")).toBe(true);

    upsertTerminal({
      session_id: "mover",
      project_slug: "beta",
      worktree_id: "/tmp/beta-x",
      kind: "claude-code",
      created_unix: 1,
    });

    expect(idsByProjectSlug().get("alpha")).toBeUndefined();
    expect(idsByProjectSlug().get("beta")?.has("mover")).toBe(true);
    expect(idsByWorktreeId().get("/tmp/alpha-a")).toBeUndefined();
    expect(idsByWorktreeId().get("/tmp/beta-x")?.has("mover")).toBe(true);
    // workingState rehydrates from existing, so working bucket stays.
    expect(workingIds().has("mover")).toBe(true);
  });

  it("drops removed sessions from every index signal and the recency map", () => {
    setTerminals([
      terminal({ session_id: "a", worktree_id: "/tmp/alpha-a" }),
      terminal({ session_id: "b", worktree_id: "/tmp/alpha-b", created_unix: 2 }),
    ]);
    applyAgentStateToTerminal("a", "working");
    applyAgentStateToTerminal("b", "waiting");
    markOutput("a");
    markOutput("b");

    removeTerminal("a");

    expect(harnessIds().has("a")).toBe(false);
    expect(workingIds().has("a")).toBe(false);
    expect(idsByProjectSlug().get("alpha")?.has("a")).toBe(false);
    expect(idsByWorktreeId().get("/tmp/alpha-a")).toBeUndefined();
    expect(lastOutputBySession().has("a")).toBe(false);
    // Sibling b untouched.
    expect(waitingIds().has("b")).toBe(true);
    expect(lastOutputBySession().has("b")).toBe(true);
  });

  it("satisfies the index-vs-byId invariant across a random patch sequence", () => {
    const sessionPool = Array.from({ length: 8 }, (_, i) => `pool-${i}`);
    const projects = ["alpha", "beta", "gamma"];
    const worktrees = ["/tmp/wt-a", "/tmp/wt-b", "/tmp/wt-c"];
    const states = ["idle", "working", "waiting", "completed", "errored"] as const;
    const kinds = ["claude-code", "codex", "opencode", "shell"] as const;

    let seed = 1337;
    function rand(n: number): number {
      seed = (seed * 9301 + 49297) % 233280;
      return Math.abs(seed) % n;
    }

    for (let step = 0; step < 400; step++) {
      const id = sessionPool[rand(sessionPool.length)];
      const op = rand(3);
      if (op === 0) {
        upsertTerminal({
          session_id: id,
          project_slug: rand(4) === 0 ? null : projects[rand(projects.length)],
          worktree_id: rand(4) === 0 ? null : worktrees[rand(worktrees.length)],
          kind: kinds[rand(kinds.length)],
          created_unix: step,
        });
      } else if (op === 1) {
        applyAgentStateToTerminal(id, states[rand(states.length)]);
      } else if (op === 2 && terminalStore.byId[id]) {
        removeTerminal(id);
      }

      // Invariants: harnessIds == ids whose record is a project-scoped harness.
      const ground = new Set<string>();
      const perProject = new Map<string, Set<string>>();
      const perWorktree = new Map<string, Set<string>>();
      const perState = {
        idle: new Set<string>(),
        working: new Set<string>(),
        waiting: new Set<string>(),
      };
      for (const [key, record] of Object.entries(terminalStore.byId)) {
        perState[record.workingState].add(key);
        if (record.kind === "shell" || record.project_slug === null) continue;
        ground.add(key);
        const slug = record.project_slug;
        if (!perProject.has(slug)) perProject.set(slug, new Set());
        perProject.get(slug)!.add(key);
        if (record.worktree_id) {
          if (!perWorktree.has(record.worktree_id)) perWorktree.set(record.worktree_id, new Set());
          perWorktree.get(record.worktree_id)!.add(key);
        }
      }
      expect(new Set(harnessIds())).toEqual(ground);
      expect(new Set(workingIds())).toEqual(perState.working);
      expect(new Set(waitingIds())).toEqual(perState.waiting);
      for (const [slug, ids] of perProject) {
        expect(new Set(idsByProjectSlug().get(slug) ?? [])).toEqual(ids);
      }
      for (const [wt, ids] of perWorktree) {
        expect(new Set(idsByWorktreeId().get(wt) ?? [])).toEqual(ids);
      }
    }
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
