import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  __resetAgentStoreForTests,
  type AgentListItem,
  agentStore,
  attentionQueue,
  flushPendingAcks,
  isAcknowledged,
  markAcknowledged,
  removeSession,
  setAdapters,
  unmarkAcknowledged,
  unreadAgentCount,
  updateSessionState,
  waitingByBlockedLongest,
} from "./agentStore";

describe("agentStore session removal", () => {
  beforeEach(() => {
    __resetAgentStoreForTests();
  });

  it("removes closed sessions from the registry", () => {
    updateSessionState("session-1", "codex", "working");

    expect(agentStore.sessions["session-1"]?.state).toBe("working");

    removeSession("session-1");

    expect(agentStore.sessions["session-1"]).toBeUndefined();
  });

  it("updates unreadAgentCount when a waiting session is removed", () => {
    updateSessionState("waiting-1", "claude-code", "waiting");
    updateSessionState("done-1", "opencode", "completed");
    updateSessionState("working-1", "codex", "working");

    expect(unreadAgentCount()).toBe(2);

    removeSession("waiting-1");
    expect(unreadAgentCount()).toBe(1);

    removeSession("done-1");
    expect(unreadAgentCount()).toBe(0);
  });
});

describe("agentStore acknowledgement", () => {
  beforeEach(() => {
    __resetAgentStoreForTests();
  });

  it("excludes acknowledged completed sessions from the unread count", () => {
    updateSessionState("done-1", "claude-code", "completed");
    updateSessionState("done-2", "codex", "errored");
    expect(unreadAgentCount()).toBe(2);

    markAcknowledged("done-1");
    expect(unreadAgentCount()).toBe(1);
    expect(isAcknowledged("done-1")).toBe(true);

    markAcknowledged("done-2");
    expect(unreadAgentCount()).toBe(0);
  });

  it("keeps waiting sessions sticky regardless of acknowledgement", () => {
    // Per the user rule, "needs input" notifications only clear when the
    // harness leaves the waiting state. Acknowledging a still-waiting
    // session via tab activation must not silently drop it from the
    // unread count.
    updateSessionState("wait-1", "claude-code", "waiting");
    expect(unreadAgentCount()).toBe(1);

    markAcknowledged("wait-1");
    expect(unreadAgentCount()).toBe(1);
  });

  it("auto-unmarks when a session transitions back to working", () => {
    updateSessionState("done-1", "claude-code", "completed");
    markAcknowledged("done-1");
    expect(unreadAgentCount()).toBe(0);

    // New turn starts: state goes completed → working. The store should
    // drop the acknowledgement so the next completion is visible again.
    updateSessionState("done-1", "claude-code", "working");
    expect(isAcknowledged("done-1")).toBe(false);

    updateSessionState("done-1", "claude-code", "completed");
    expect(unreadAgentCount()).toBe(1);
  });

  it("auto-unmarks when a session transitions to idle", () => {
    updateSessionState("done-1", "opencode", "errored");
    markAcknowledged("done-1");
    expect(unreadAgentCount()).toBe(0);

    updateSessionState("done-1", "opencode", "idle");
    expect(isAcknowledged("done-1")).toBe(false);
  });

  it("clears acknowledgement on session removal", () => {
    updateSessionState("done-1", "codex", "completed");
    markAcknowledged("done-1");
    expect(isAcknowledged("done-1")).toBe(true);

    removeSession("done-1");
    expect(isAcknowledged("done-1")).toBe(false);
  });

  it("unmarkAcknowledged restores the session to the unread count", () => {
    updateSessionState("done-1", "claude-code", "completed");
    markAcknowledged("done-1");
    expect(unreadAgentCount()).toBe(0);

    unmarkAcknowledged("done-1");
    expect(unreadAgentCount()).toBe(1);
  });
});

describe("agentStore enteredStateAt", () => {
  beforeEach(() => {
    __resetAgentStoreForTests();
    vi.useRealTimers();
  });

  it("stamps enteredStateAt on the first transition", () => {
    const before = Date.now();
    updateSessionState("s-1", "claude-code", "waiting");
    const after = Date.now();
    const ts = agentStore.sessions["s-1"]?.enteredStateAt;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("re-stamps when the state actually changes but preserves it on a no-op", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    updateSessionState("s-1", "claude-code", "working");
    const first = agentStore.sessions["s-1"]?.enteredStateAt;
    expect(first).toBe(1_000);

    // Same state again later: timestamp must NOT advance (blocked-since, not
    // last-touched).
    vi.setSystemTime(5_000);
    updateSessionState("s-1", "claude-code", "working");
    expect(agentStore.sessions["s-1"]?.enteredStateAt).toBe(1_000);

    // Real transition: timestamp jumps to the new wall-clock.
    vi.setSystemTime(9_000);
    updateSessionState("s-1", "claude-code", "waiting");
    expect(agentStore.sessions["s-1"]?.enteredStateAt).toBe(9_000);
    vi.useRealTimers();
  });
});

describe("agentStore hydration seeding", () => {
  beforeEach(() => {
    __resetAgentStoreForTests();
  });

  function sessionItem(overrides: Partial<AgentListItem> & { session_id: string }): AgentListItem {
    return {
      harness: "claude-code",
      state: "idle",
      supports_native_events: false,
      ...overrides,
    };
  }

  it("maps state_entered_at_ms to enteredStateAt without fabricating Date.now()", () => {
    setAdapters([sessionItem({ session_id: "s-1", state: "waiting", state_entered_at_ms: 1_234 })]);
    expect(agentStore.sessions["s-1"]?.enteredStateAt).toBe(1_234);
  });

  it("leaves enteredStateAt undefined when state_entered_at_ms is absent", () => {
    setAdapters([sessionItem({ session_id: "s-1", state: "completed" })]);
    expect(agentStore.sessions["s-1"]?.enteredStateAt).toBeUndefined();
  });

  it("seeds acks for acked done/errored sessions, excluding them from attentionQueue", () => {
    setAdapters([
      sessionItem({
        session_id: "done-acked",
        state: "completed",
        state_entered_at_ms: 5_000,
        state_acked: true,
      }),
      sessionItem({
        session_id: "done-unacked",
        state: "completed",
        state_entered_at_ms: 6_000,
      }),
    ]);
    // The acked completion stays quiet across the reload; the unacked one
    // still demands attention.
    expect(isAcknowledged("done-acked")).toBe(true);
    expect(isAcknowledged("done-unacked")).toBe(false);
    expect(attentionQueue().map((i) => i.session.session_id)).toEqual(["done-unacked"]);
    expect(unreadAgentCount()).toBe(1);
  });

  it("never seeds an ack for a waiting session even when state_acked is set", () => {
    // `waiting` is sticky by design and must re-surface after a reload
    // regardless of the persisted ack flag.
    setAdapters([
      sessionItem({
        session_id: "wait",
        state: "waiting",
        state_entered_at_ms: 7_000,
        state_acked: true,
      }),
    ]);
    expect(isAcknowledged("wait")).toBe(false);
    expect(attentionQueue().map((i) => i.session.session_id)).toEqual(["wait"]);
  });
});

describe("agentStore seeded updateSessionState", () => {
  beforeEach(() => {
    __resetAgentStoreForTests();
    vi.useRealTimers();
  });

  it("leaves enteredStateAt undefined for a seeded update with no timestamp", () => {
    updateSessionState("s-1", "claude-code", "completed", null, { seeded: true });
    expect(agentStore.sessions["s-1"]).toBeDefined();
    expect(agentStore.sessions["s-1"]?.enteredStateAt).toBeUndefined();
  });

  it("honours an explicit enteredStateAtMs over Date.now() on a real change", () => {
    vi.useFakeTimers();
    vi.setSystemTime(9_999);
    updateSessionState("s-1", "claude-code", "waiting", null, { enteredStateAtMs: 4_000 });
    expect(agentStore.sessions["s-1"]?.enteredStateAt).toBe(4_000);
    vi.useRealTimers();
  });

  it("preserves the existing timestamp on a same-state seeded update", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    updateSessionState("s-1", "claude-code", "waiting");
    expect(agentStore.sessions["s-1"]?.enteredStateAt).toBe(1_000);

    // Re-applying the same state via a seed must not clobber the original
    // blocked-since stamp, even with a different explicit ms.
    updateSessionState("s-1", "claude-code", "waiting", null, {
      enteredStateAtMs: 8_000,
      seeded: true,
    });
    expect(agentStore.sessions["s-1"]?.enteredStateAt).toBe(1_000);
    vi.useRealTimers();
  });
});

describe("agentStore attention ranking", () => {
  beforeEach(() => {
    __resetAgentStoreForTests();
    vi.useFakeTimers();
  });

  function blockAt(id: string, state: Parameters<typeof updateSessionState>[2], at: number): void {
    vi.setSystemTime(at);
    updateSessionState(id, "claude-code", state);
  }

  it("waitingByBlockedLongest sorts oldest-blocked first", () => {
    blockAt("new", "waiting", 3_000);
    blockAt("old", "waiting", 1_000);
    blockAt("mid", "waiting", 2_000);

    const order = waitingByBlockedLongest().map((s) => s.session_id);
    expect(order).toEqual(["old", "mid", "new"]);
    vi.useRealTimers();
  });

  it("attentionQueue tiers waiting → errored → completed and excludes non-attention states", () => {
    blockAt("work", "working", 500); // not in queue
    blockAt("idle", "idle", 600); // not in queue
    blockAt("done", "completed", 1_000);
    blockAt("err", "errored", 2_000);
    blockAt("wait-new", "waiting", 4_000);
    blockAt("wait-old", "waiting", 3_000);

    const order = attentionQueue().map((i) => i.session.session_id);
    // Both waiting first (oldest-blocked leading), then errored, then completed.
    expect(order).toEqual(["wait-old", "wait-new", "err", "done"]);
    vi.useRealTimers();
  });

  it("attentionQueue drops acknowledged completed/errored but keeps waiting sticky", () => {
    blockAt("done", "completed", 1_000);
    blockAt("wait", "waiting", 2_000);

    markAcknowledged("done");
    markAcknowledged("wait"); // sticky: must remain

    const order = attentionQueue().map((i) => i.session.session_id);
    expect(order).toEqual(["wait"]);
    vi.useRealTimers();
  });
});

describe("agentStore ack durability", () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    __resetAgentStoreForTests();
    invokeMock.mockReset();
  });

  function sessionItem(overrides: Partial<AgentListItem> & { session_id: string }): AgentListItem {
    return {
      harness: "claude-code",
      state: "idle",
      supports_native_events: false,
      ...overrides,
    };
  }

  /** Let the fire-and-forget sendAck promise chain settle. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("flushPendingAcks retries an ack whose persist rejected", async () => {
    invokeMock.mockRejectedValueOnce(new Error("webview dying"));
    invokeMock.mockResolvedValue(undefined as never);

    markAcknowledged("done-1");
    await settle();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // The rejected ack stayed queued: the flush must retry exactly it.
    await flushPendingAcks();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith("agent_ack_state", { sessionId: "done-1" });

    // Confirmed now — a second flush has nothing to do.
    await flushPendingAcks();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("a revoked ack is never replayed by a later flush", async () => {
    invokeMock.mockRejectedValueOnce(new Error("webview dying"));
    invokeMock.mockResolvedValue(undefined as never);

    markAcknowledged("done-1");
    await settle();
    expect(invokeMock).toHaveBeenCalledTimes(1); // failed, so still queued

    // The agent resumes: the ack is revoked and must leave the retry queue
    // with it — otherwise a later flush would mark the agent's NEXT
    // completion as already-seen.
    unmarkAcknowledged("done-1");
    await flushPendingAcks();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("flushPendingAcks is a no-op once every ack is confirmed", async () => {
    invokeMock.mockResolvedValue(undefined as never);
    markAcknowledged("done-1");
    await settle();
    await flushPendingAcks();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("a webview reload never grows the attention set", async () => {
    invokeMock.mockResolvedValue(undefined as never);
    setAdapters([
      sessionItem({ session_id: "done-a", state: "completed" }),
      sessionItem({ session_id: "done-b", state: "completed" }),
      sessionItem({ session_id: "wait-1", state: "waiting" }),
    ]);
    markAcknowledged("done-a");
    await settle();
    const before = attentionQueue().map((i) => i.session.session_id);

    // Simulate the post-lock reload: fresh page, store rebuilt from the
    // backend truth in which the ack reached disk.
    __resetAgentStoreForTests();
    setAdapters([
      sessionItem({ session_id: "done-a", state: "completed", state_acked: true }),
      sessionItem({ session_id: "done-b", state: "completed" }),
      sessionItem({ session_id: "wait-1", state: "waiting" }),
    ]);

    expect(attentionQueue().map((i) => i.session.session_id)).toEqual(before);
  });
});
