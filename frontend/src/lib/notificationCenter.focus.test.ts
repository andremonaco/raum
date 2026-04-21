import { describe, it, expect, beforeEach, vi } from "vitest";

// Focused-window variant of the notification center tests. The default
// test file mocks `isFocused` as `false` (unfocused); this file flips the
// mock to `true` to prove that:
//
//   - OS notifications are suppressed while the window is focused
//     (behavior preserved), AND
//   - the in-app Sonner toast still fires while the window is focused
//     (previously we only pushed a banner on OS-unavailable paths, which
//     meant dev-mode users on `tauri dev` never saw anything).
const mockInvoke = vi.fn();
const mockSendNotification = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: async () => true }),
}));
// `isPermissionGranted` returns `false` and `requestPermission` throws so
// the center ends up in the "OS notifications unavailable" state, which
// is exactly the dev-mode scenario we are protecting.
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

describe("notification center — focus gate split", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
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

  it("shows an in-app toast on waiting even when the window is focused", async () => {
    __handleAgentStateChangedForTests({
      session_id: "s-1",
      harness: "claude-code",
      from: "working",
      to: "waiting",
    });

    // Waiting dispatch is now synchronous; just flush microtasks so the
    // async body runs.
    await Promise.resolve();
    await Promise.resolve();

    expect(mockToastFn).toHaveBeenCalledTimes(1);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("shows an in-app toast on completed even when the window is focused", async () => {
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
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});
