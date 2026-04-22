import { describe, it, expect, beforeEach, vi } from "vitest";

// OS-denied variant of the notification center tests. The default test
// file exercises the happy path (probe → granted, OS notification fires);
// this file flips the probe to `"denied"` to prove the toast fallback
// covers every dispatcher. Window focus is intentionally NOT consulted by
// the dispatchers (raum fires notifications whenever the user has enabled
// them, foreground or not), so these tests don't mock focus state either.
const mockInvoke = vi.fn();
const mockSendNotification = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(false),
  onAction: vi.fn().mockResolvedValue({ unregister: () => undefined }),
  requestPermission: vi.fn().mockRejectedValue(new Error("dev build: plugin unavailable")),
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}));

// Stub Sonner so `toast()` is a spy. The dispatchers call `toast(...)`,
// `toast.success(...)`, and `toast.error(...)` depending on the kind.
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
  __handleAgentStateChangedForTests,
  __resetNotificationCenterForTests,
  ensureNotificationPermission,
} from "./notificationCenter";

describe("notification center — OS-denied fallback", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    // Simulate a user who has explicitly denied notifications for the raum
    // bundle. That is the only state that forces the toast fallback —
    // `"unknown"` is treated as "try the OS path" so the first real send
    // can trigger macOS's authorization prompt.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "notifications_check_authorization") {
        return {
          status: "denied",
          bundle_id: "de.raum.desktop",
          is_dev_mode: false,
          note: null,
        };
      }
      return undefined;
    });
    mockSendNotification.mockReset();
    mockToastFn.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockToastWarning.mockReset();
    __resetNotificationCenterForTests();
    await ensureNotificationPermission();
  });

  it("shows an in-app toast on waiting when OS is denied", async () => {
    __handleAgentStateChangedForTests({
      session_id: "s-1",
      harness: "claude-code",
      from: "working",
      to: "waiting",
    });

    // Waiting dispatch is synchronous; just flush microtasks so the async
    // body runs.
    await Promise.resolve();
    await Promise.resolve();

    expect(mockToastFn).toHaveBeenCalledTimes(1);
    expect(mockToastFn.mock.calls[0]?.[0]).toBe("Interactive Question");
    expect(mockToastFn.mock.calls[0]?.[1]).toMatchObject({
      description: "Claude is asking for feedback.",
    });
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("shows an in-app toast on completed when OS is denied", async () => {
    __handleAgentStateChangedForTests({
      session_id: "s-2",
      harness: "codex",
      from: "working",
      to: "completed",
    });

    // Done transitions bypass the waiting debounce but still await sound
    // setup, so give microtasks a turn.
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess.mock.calls[0]?.[0]).toBe("Finished");
    expect(mockToastSuccess.mock.calls[0]?.[1]).toMatchObject({
      description: "Codex finished successfully.",
    });
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});
