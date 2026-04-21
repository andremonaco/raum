import { describe, it, expect, beforeEach, vi } from "vitest";

// Stub out the Tauri runtime surface the notification center touches.
// These modules aren't resolvable under vitest/jsdom, and we want every
// IPC to be a spy so we can assert on the payloads.
const mockInvoke = vi.fn();
const mockSendNotification = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: async () => false }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  onAction: vi.fn().mockResolvedValue({ unregister: () => undefined }),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}));

// Sonner is mounted via `<Toaster />` in production; tests never render it,
// so we only need `toast()` to be a spy. The factory is hoisted by vitest,
// so declare the spies inside it and expose them via `vi.hoisted` so the
// test bodies can still assert on them.
const toastMocks = vi.hoisted(() => {
  const toastFn = vi.fn() as unknown as {
    (msg: string, data?: unknown): void;
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    warning: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
  toastFn.success = vi.fn();
  toastFn.error = vi.fn();
  toastFn.warning = vi.fn();
  toastFn.info = vi.fn();
  return {
    toast: toastFn,
    mockToastFn: toastFn as unknown as ReturnType<typeof vi.fn>,
    mockToastSuccess: toastFn.success,
    mockToastError: toastFn.error,
    mockToastWarning: toastFn.warning,
  };
});
const { mockToastFn, mockToastSuccess, mockToastError, mockToastWarning } = toastMocks;
vi.mock("solid-sonner", () => ({
  toast: toastMocks.toast,
  Toaster: () => null,
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
  syncDockBadge,
} from "./notificationCenter";

function lastDockBadgeCall(): number | undefined {
  const calls = mockInvoke.mock.calls.filter((c) => c[0] === "set_dock_badge");
  if (calls.length === 0) return undefined;
  const last = calls[calls.length - 1];
  const args = last[1] as { count: number } | undefined;
  return args?.count;
}

describe("notification center badge modes", () => {
  beforeEach(async () => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockSendNotification.mockReset();
    mockToastFn.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockToastWarning.mockReset();
    __resetNotificationCenterForTests();
    await ensureNotificationPermission();
  });

  it("defaults to all_unread", () => {
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
    expect(mockSendNotification).toHaveBeenCalledTimes(2);
  });

  it("accepts permission events without request ids and sends focus-only notifications", async () => {
    await __handleNotificationEventForTests({
      harness: "codex",
      event: "PermissionRequest",
      session_id: "codex-1",
      permission_key: "codex-1",
      payload: { tool_name: "shell" },
    });
    expect(pendingPermissionCount()).toBe(1);
    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    expect(mockSendNotification.mock.calls[0]?.[0]).toMatchObject({
      title: "raum: codex needs permission",
      body: "shell requires permission — open the terminal to answer.",
      extra: { sessionId: "codex-1" },
    });
    expect(mockSendNotification.mock.calls[0]?.[0]).not.toHaveProperty("actions");
    // Permission toasts route through toast.warning with an infinite duration.
    expect(mockToastWarning).toHaveBeenCalledTimes(1);
    const [title, opts] = mockToastWarning.mock.calls[0] as [
      string,
      { description: string; duration: number; onDismiss: () => void } | undefined,
    ];
    expect(title).toBe("raum: codex needs permission");
    expect(opts?.duration).toBe(Number.POSITIVE_INFINITY);
  });

  it("manual dismiss on a permission toast aborts the owning session", async () => {
    await __handleNotificationEventForTests({
      harness: "claude-code",
      event: "PermissionRequest",
      session_id: "sess-abort",
      request_id: "req-abort",
      permission_key: "req-abort",
      payload: null,
    });
    const opts = mockToastWarning.mock.calls[0]?.[1] as { onDismiss?: () => void } | undefined;
    expect(opts?.onDismiss).toBeTypeOf("function");
    opts!.onDismiss!();
    const abortCalls = mockInvoke.mock.calls.filter((c) => c[0] === "abort_session");
    expect(abortCalls).toHaveLength(1);
    expect(abortCalls[0]?.[1]).toEqual({ sessionId: "sess-abort" });
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

    // Exactly one OS notification for the pair.
    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    // And exactly one in-app toast (permission took the slot; waiting is
    // dropped by the dedup gate so we don't show two cards for one event).
    expect(mockToastWarning).toHaveBeenCalledTimes(1);
    expect(mockToastFn).not.toHaveBeenCalled();
  });
});
