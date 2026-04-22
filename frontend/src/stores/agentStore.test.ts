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
  removeSession,
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
