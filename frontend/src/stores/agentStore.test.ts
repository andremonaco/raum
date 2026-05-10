import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

import {
  __resetAgentStoreForTests,
  agentStore,
  isAcknowledged,
  markAcknowledged,
  removeSession,
  unmarkAcknowledged,
  unreadAgentCount,
  updateSessionState,
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
