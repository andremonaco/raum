import { describe, it, expect, beforeEach, vi } from "vitest";

// Stub out the Tauri runtime surface the notification center touches.
// These modules aren't resolvable under vitest/jsdom, and we want every
// IPC to be a spy so we can assert on the payloads. Note that
// `tauri-plugin-notification` is GONE — all OS notification dispatch
// flows through the Rust `notifications_send` command via `invoke()`,
// so its calls land in `mockInvoke` like every other backend command.
const mockInvoke = vi.fn();
const listenHandlers = new Map<string, (ev: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi
    .fn()
    .mockImplementation(async (event: string, cb: (ev: { payload: unknown }) => void) => {
      listenHandlers.set(event, cb);
      return () => {
        listenHandlers.delete(event);
      };
    }),
}));

import {
  __clearPendingPermissionForTests,
  __handleAgentStateChangedForTests,
  __handleNotificationEventForTests,
  __handleSessionRemovedForTests,
  __resetNotificationCenterForTests,
  badgeMode,
  ensureNotificationPermission,
  pendingPermissionCount,
  startNotificationCenter,
  syncDockBadge,
} from "./notificationCenter";

function lastDockBadgeCall(): number | undefined {
  const calls = mockInvoke.mock.calls.filter((c) => c[0] === "set_dock_badge");
  if (calls.length === 0) return undefined;
  const last = calls[calls.length - 1];
  const args = last[1] as { count: number } | undefined;
  return args?.count;
}

interface SendArgs {
  title: string;
  body: string;
  sessionId?: string | null;
}

function sendCalls(): SendArgs[] {
  return mockInvoke.mock.calls
    .filter((c) => c[0] === "notifications_send")
    .map((c) => (c[1] as { args: SendArgs }).args);
}

describe("notification center", () => {
  beforeEach(async () => {
    listenHandlers.clear();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    __resetNotificationCenterForTests();
    await ensureNotificationPermission();
  });

  it("defaults to all_unread badge mode", () => {
    expect(badgeMode()).toBe("all_unread");
  });

  it("adds to pendingPermissionCount on notification events", async () => {
    expect(pendingPermissionCount()).toBe(0);
    await __handleNotificationEventForTests({
      harness: "claude-code",
      event: "PermissionRequest",
      session_id: "s-1",
      request_id: "req-1",
      permission_key: "req-1",
      payload: null,
    });
    expect(pendingPermissionCount()).toBe(1);

    // A second distinct request increments again.
    await __handleNotificationEventForTests({
      harness: "claude-code",
      event: "PermissionRequest",
      session_id: "s-2",
      request_id: "req-2",
      permission_key: "req-2",
      payload: null,
    });
    expect(pendingPermissionCount()).toBe(2);

    // Duplicate request id is a no-op.
    await __handleNotificationEventForTests({
      harness: "claude-code",
      event: "PermissionRequest",
      session_id: "s-1",
      request_id: "req-1",
      permission_key: "req-1",
      payload: null,
    });
    expect(pendingPermissionCount()).toBe(2);
    expect(sendCalls()).toHaveLength(2);
  });

  it("fires an OS notification for permission requests", async () => {
    await __handleNotificationEventForTests({
      harness: "codex",
      event: "PermissionRequest",
      session_id: "codex-1",
      permission_key: "codex-1",
      payload: { tool_name: "shell" },
    });
    expect(pendingPermissionCount()).toBe(1);
    const calls = sendCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      title: "Permission requested",
      body: "Codex needs permission for shell.",
      sessionId: "codex-1",
    });
  });

  it("fires OS notifications when an agent transitions to waiting", async () => {
    __handleAgentStateChangedForTests({
      session_id: "s-1",
      harness: "claude-code",
      from: "working",
      to: "waiting",
    });
    await Promise.resolve();
    await Promise.resolve();
    const calls = sendCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      title: "Interactive Question",
      body: "Claude is asking for feedback.",
      sessionId: "s-1",
    });
  });

  it("fires OS notifications when an agent completes", async () => {
    __handleAgentStateChangedForTests({
      session_id: "s-2",
      harness: "codex",
      from: "working",
      to: "completed",
    });
    await Promise.resolve();
    await Promise.resolve();
    const calls = sendCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      title: "Finished",
      body: "Codex finished successfully.",
      sessionId: "s-2",
    });
  });

  it("decrements pendingPermissionCount when a request is cleared", async () => {
    await __handleNotificationEventForTests({
      harness: "claude-code",
      event: "PermissionRequest",
      session_id: "s-1",
      request_id: "req-1",
      permission_key: "req-1",
      payload: null,
    });
    expect(pendingPermissionCount()).toBe(1);

    __clearPendingPermissionForTests("req-1");
    expect(pendingPermissionCount()).toBe(0);

    // Clearing an unknown id is a no-op.
    __clearPendingPermissionForTests("req-does-not-exist");
    expect(pendingPermissionCount()).toBe(0);
  });

  it("clears pending permissions when the session leaves waiting", async () => {
    await __handleNotificationEventForTests({
      harness: "claude-code",
      event: "PermissionRequest",
      session_id: "s-1",
      request_id: "req-1",
      permission_key: "req-1",
      payload: null,
    });
    expect(pendingPermissionCount()).toBe(1);

    __handleAgentStateChangedForTests({
      session_id: "s-1",
      harness: "claude-code",
      from: "waiting",
      to: "working",
    });
    expect(pendingPermissionCount()).toBe(0);
  });

  it("clears pending permissions when the session is removed", async () => {
    await __handleNotificationEventForTests({
      harness: "codex",
      event: "PermissionRequest",
      session_id: "codex-1",
      permission_key: "codex-1",
      payload: null,
    });
    expect(pendingPermissionCount()).toBe(1);

    __handleSessionRemovedForTests("codex-1");
    expect(pendingPermissionCount()).toBe(0);
  });

  it("syncDockBadge dedupes against the previous value", () => {
    syncDockBadge(3);
    syncDockBadge(3);
    syncDockBadge(3);
    const calls = mockInvoke.mock.calls.filter((c) => c[0] === "set_dock_badge");
    expect(calls).toHaveLength(1);
    expect(lastDockBadgeCall()).toBe(3);
  });

  it("syncDockBadge floors negative / fractional counts to integers >= 0", () => {
    syncDockBadge(-5);
    expect(lastDockBadgeCall()).toBe(0);
    syncDockBadge(2.9);
    expect(lastDockBadgeCall()).toBe(2);
  });

  it("dedupes permission + waiting back-to-back into a single OS notification", async () => {
    await __handleNotificationEventForTests({
      harness: "claude-code",
      event: "PermissionRequest",
      session_id: "s-dedup",
      request_id: "req-d",
      permission_key: "req-d",
      payload: { tool_name: "bash" },
    });

    // Backend emits the follow-up `agent-state-changed` in the same loop
    // iteration — in tests we call it synchronously.
    __handleAgentStateChangedForTests({
      session_id: "s-dedup",
      harness: "claude-code",
      from: "working",
      to: "waiting",
    });

    // Let the async waiting dispatcher run.
    await Promise.resolve();
    await Promise.resolve();

    // Exactly one OS notification for the pair — the waiting dispatcher
    // was suppressed by the dedup gate so the user doesn't see two
    // banners for the same logical event.
    expect(sendCalls()).toHaveLength(1);
  });

  it("forwards notifications:clicked events as terminal-focus-requested", async () => {
    // Pre-populate `notifications_check_authorization` so `startNotificationCenter` resolves.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "notifications_check_authorization") {
        return {
          status: "granted",
          bundle_id: "de.raum.desktop",
          is_dev_mode: false,
          note: null,
        };
      }
      if (cmd === "config_get") {
        return { notifications: {} };
      }
      return undefined;
    });

    const dispose = await startNotificationCenter();
    const handler = listenHandlers.get("notifications:clicked");
    expect(handler).toBeDefined();

    const seen: string[] = [];
    const dom = (ev: Event) => {
      const detail = (ev as CustomEvent<{ sessionId: string }>).detail;
      seen.push(detail.sessionId);
    };
    window.addEventListener("terminal-focus-requested", dom);

    handler!({ payload: { sessionId: "click-target" } });
    expect(seen).toEqual(["click-target"]);

    window.removeEventListener("terminal-focus-requested", dom);
    dispose();
  });
});
