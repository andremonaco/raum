import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
const mockWindowListen = vi.fn();
const focusListeners = new Map<string, () => void>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFocused: vi.fn().mockResolvedValue(false),
    listen: (...args: unknown[]) => mockWindowListen(...args),
  }),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  onAction: vi.fn().mockResolvedValue({ unregister: () => undefined }),
  sendNotification: vi.fn(),
}));

vi.mock("solid-sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
  Toaster: () => null,
}));

import { __resetNotificationCenterForTests, startNotificationCenter } from "./notificationCenter";

describe("notification center authorization refresh", () => {
  beforeEach(() => {
    __resetNotificationCenterForTests();
    focusListeners.clear();
    mockInvoke.mockReset();
    mockWindowListen.mockReset();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "notifications_check_authorization") {
        return {
          status: "unknown",
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
    mockWindowListen.mockImplementation(async (event: string, cb: () => void) => {
      focusListeners.set(event, cb);
      return () => {
        focusListeners.delete(event);
      };
    });
  });

  it("re-probes notification authorization on window focus", async () => {
    const dispose = await startNotificationCenter();
    const authCalls = () =>
      mockInvoke.mock.calls.filter(([cmd]) => cmd === "notifications_check_authorization").length;

    expect(authCalls()).toBe(1);

    focusListeners.get("focus")?.();
    await Promise.resolve();

    expect(authCalls()).toBe(2);
    dispose();
  });
});
