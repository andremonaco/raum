import { describe, it, expect, beforeEach, vi } from "vitest";

// Stub the Tauri runtime surface: every invoke is a spy, and listen()
// captures handlers so tests can fire synthetic backend pings.
const mockInvoke = vi.fn();
const listenHandlers = new Map<string, (ev: { payload: unknown }) => void>();
const mockListen = vi
  .fn()
  .mockImplementation(async (event: string, cb: (ev: { payload: unknown }) => void) => {
    listenHandlers.set(event, cb);
    return () => {
      listenHandlers.delete(event);
    };
  });
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...(args as [string, () => void])),
}));

import { installWebviewHealth } from "./webviewHealth";

describe("webviewHealth", () => {
  beforeEach(() => {
    mockInvoke.mockReset().mockResolvedValue(undefined);
    mockListen.mockClear();
    listenHandlers.clear();
  });

  it("registers the ping listener before signalling ready", async () => {
    await installWebviewHealth();
    // The listener must already be live when webview_ready fires, so a ping
    // emitted right after the ready signal can never be missed.
    expect(listenHandlers.has("raum:ping")).toBe(true);
    expect(mockListen.mock.invocationCallOrder[0]).toBeLessThan(
      mockInvoke.mock.invocationCallOrder[0],
    );
    expect(mockInvoke).toHaveBeenCalledWith("webview_ready");
  });

  it("echoes a ping nonce via webview_pong", async () => {
    await installWebviewHealth();
    mockInvoke.mockClear();
    listenHandlers.get("raum:ping")?.({ payload: 7 });
    expect(mockInvoke).toHaveBeenCalledWith("webview_pong", { nonce: 7 });
  });

  it("returned unlisten removes the ping listener", async () => {
    const unlisten = await installWebviewHealth();
    unlisten();
    expect(listenHandlers.has("raum:ping")).toBe(false);
  });
});
