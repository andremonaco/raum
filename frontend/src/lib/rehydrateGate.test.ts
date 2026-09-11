import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { __resetRehydrateGateForTests, awaitSessionReady } from "./rehydrateGate";
import { __resetBootTimingForTests } from "./bootTiming";
import { __resetTerminalStoreForTests, terminalStore } from "../stores/terminalStore";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

type Handler = (ev: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Observe settlement without racing microtask ordering: flag + flush. */
const track = (p: Promise<void>): (() => boolean) => {
  let done = false;
  void p.then(() => {
    done = true;
  });
  return () => done;
};

describe("rehydrateGate", () => {
  beforeEach(() => {
    __resetRehydrateGateForTests();
    __resetBootTimingForTests();
    __resetTerminalStoreForTests();
    handlers.clear();
    invokeMock.mockReset();
    listenMock.mockReset();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "terminal_list") return Promise.resolve([]);
      if (cmd === "terminal_rehydrate_ready") return Promise.resolve(false);
      return Promise.resolve(undefined);
    });
    listenMock.mockImplementation((name: string, handler: unknown) => {
      handlers.set(name, handler as Handler);
      return Promise.resolve(() => {});
    });
  });

  it("releases a pane when its own row lands, and every pane on the global latch", async () => {
    const a = track(awaitSessionReady("sess-a"));
    const b = track(awaitSessionReady("sess-b"));
    await flush();
    expect(a()).toBe(false);
    expect(b()).toBe(false);

    handlers.get("terminal-session-upserted")!({
      payload: { session_id: "sess-a", kind: "claude-code", recoverable_after_reboot: true },
    });
    await flush();
    expect(a()).toBe(true);
    expect(b()).toBe(false);
    // The row reached terminalStore before the pane could decide.
    expect(terminalStore.byId["sess-a"]?.recoverable_after_reboot).toBe(true);

    handlers.get("rehydrate:complete")!({ payload: true });
    await flush();
    expect(b()).toBe(true);
    // Post-latch callers never wait.
    const c = track(awaitSessionReady("sess-c"));
    await flush();
    expect(c()).toBe(true);
  });
});
