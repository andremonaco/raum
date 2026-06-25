import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
vi.mock("../stores/runtimeLayoutStore", () => ({
  flushActiveLayoutNow: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./terminalSnapshotPersistence", () => ({
  flushAllTerminalSnapshotsNow: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { flushActiveLayoutNow } from "../stores/runtimeLayoutStore";
import { flushAllTerminalSnapshotsNow } from "./terminalSnapshotPersistence";
import { flushAllForQuit, installQuitFlush } from "./quitFlush";

const listenMock = vi.mocked(listen);
const invokeMock = vi.mocked(invoke);
const flushLayoutMock = vi.mocked(flushActiveLayoutNow);
const flushSnapshotsMock = vi.mocked(flushAllTerminalSnapshotsNow);

describe("quitFlush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flushLayoutMock.mockResolvedValue(undefined);
    flushSnapshotsMock.mockResolvedValue(undefined);
    invokeMock.mockResolvedValue(undefined);
  });

  it("flushAllForQuit runs both flushers", async () => {
    await flushAllForQuit();
    expect(flushLayoutMock).toHaveBeenCalledOnce();
    expect(flushSnapshotsMock).toHaveBeenCalledOnce();
  });

  it("flushAllForQuit runs the snapshot flush even if the layout flush throws", async () => {
    flushLayoutMock.mockRejectedValue(new Error("boom"));
    await flushAllForQuit();
    expect(flushSnapshotsMock).toHaveBeenCalledOnce();
  });

  it("installQuitFlush flushes and acks on app-will-quit", async () => {
    let handler: (() => void) | undefined;
    listenMock.mockImplementation(async (_name, cb) => {
      handler = cb as () => void;
      return () => undefined;
    });

    await installQuitFlush();
    expect(listenMock).toHaveBeenCalledWith("app-will-quit", expect.any(Function));
    expect(handler).toBeDefined();

    handler?.();
    // The handler kicks off an async flush+ack chain; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(flushLayoutMock).toHaveBeenCalledOnce();
    expect(flushSnapshotsMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("app_quit_flush_done");
  });

  it("still acks when a flush throws", async () => {
    flushSnapshotsMock.mockRejectedValue(new Error("snapshot fail"));
    let handler: (() => void) | undefined;
    listenMock.mockImplementation(async (_name, cb) => {
      handler = cb as () => void;
      return () => undefined;
    });

    await installQuitFlush();
    handler?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith("app_quit_flush_done");
  });
});
