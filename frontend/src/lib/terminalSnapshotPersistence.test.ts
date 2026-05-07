import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  loadTerminalSnapshotBytes,
  moveTerminalSnapshot,
  persistTerminalSnapshot,
  serializeTerminalSnapshot,
  type SnapshotSource,
} from "./terminalSnapshotPersistence";

import type { Terminal } from "@xterm/xterm";

class FakeSerializeAddon {
  constructor(private readonly responses: { [scrollback: number]: string }) {}
  // SerializeAddon's real signature: serialize({ scrollback }).
  serialize(opts?: { scrollback?: number }) {
    const sb = opts?.scrollback ?? 100_000;
    if (sb in this.responses) return this.responses[sb];
    // Find the largest configured scrollback ≤ requested.
    const keys = Object.keys(this.responses)
      .map(Number)
      .sort((a, b) => a - b);
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      if (keys[i] <= sb) return this.responses[keys[i]];
    }
    return "";
  }
}

function makeSource(addonResponses: { [scrollback: number]: string }): SnapshotSource {
  return {
    term: {} as unknown as Terminal,
    addon: new FakeSerializeAddon(addonResponses) as unknown as SnapshotSource["addon"],
  };
}

describe("terminalSnapshotPersistence", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  afterEach(() => {
    invokeMock.mockReset();
  });

  it("serializes the active buffer via SerializeAddon", () => {
    const source = makeSource({ 100_000: "\x1b[2Jhi" });
    const bytes = serializeTerminalSnapshot(source);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe("\x1b[2Jhi");
  });

  it("returns null for an empty buffer", () => {
    const source = makeSource({ 100_000: "" });
    expect(serializeTerminalSnapshot(source)).toBeNull();
  });

  it("persists bytes via the Tauri invoke command", async () => {
    invokeMock.mockResolvedValueOnce(true);
    const source = makeSource({ 100_000: "hello" });
    await persistTerminalSnapshot("sess-1", source);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("terminal_snapshot_persist", {
      sessionId: "sess-1",
      bytes: Array.from(new TextEncoder().encode("hello")),
    });
  });

  it("retries with smaller scrollback when backend rejects on size", async () => {
    // First two calls return false (over cap), third accepts.
    invokeMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    // Each successive serialize produces shorter content so a real overflow
    // path would actually shrink — the test asserts the retry loop calls
    // `invoke` until acceptance, never byte-truncates the blob.
    const source = makeSource({
      100_000: "BIG".repeat(1000),
      50_000: "MED".repeat(500),
      25_000: "OK",
    });
    await persistTerminalSnapshot("sess-overflow", source);
    expect(invokeMock).toHaveBeenCalledTimes(3);
    const sentSizes = invokeMock.mock.calls.map((call) => {
      const args = call[1] as { bytes: number[] };
      return args.bytes.length;
    });
    // Each retry must send a smaller payload; we never byte-trim a single
    // blob — the loop re-serializes from xterm with a smaller scrollback.
    for (let i = 1; i < sentSizes.length; i += 1) {
      expect(sentSizes[i]).toBeLessThan(sentSizes[i - 1]);
    }
  });

  it("swallows persist errors so streaming is never blocked", async () => {
    invokeMock.mockRejectedValueOnce(new Error("disk full"));
    const source = makeSource({ 100_000: "hi" });
    await expect(persistTerminalSnapshot("sess-err", source)).resolves.toBeUndefined();
  });

  it("loads bytes from the backend and returns a Uint8Array", async () => {
    const stored = Array.from(new TextEncoder().encode("\x1b[Hhello"));
    invokeMock.mockResolvedValueOnce(stored);
    const result = await loadTerminalSnapshotBytes("sess-load");
    expect(invokeMock).toHaveBeenCalledWith("terminal_snapshot_load", {
      sessionId: "sess-load",
    });
    expect(result).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(result!)).toBe("\x1b[Hhello");
  });

  it("returns null when the backend has nothing", async () => {
    invokeMock.mockResolvedValueOnce(null);
    expect(await loadTerminalSnapshotBytes("missing")).toBeNull();
  });

  it("returns null when the backend errors", async () => {
    invokeMock.mockRejectedValueOnce(new Error("io"));
    expect(await loadTerminalSnapshotBytes("err")).toBeNull();
  });

  it("moves a snapshot from the old session to the new one", async () => {
    const stored = Array.from(new TextEncoder().encode("payload"));
    invokeMock
      // load(old) returns bytes
      .mockResolvedValueOnce(stored)
      // persist(new) accepts
      .mockResolvedValueOnce(true)
      // delete(old) succeeds
      .mockResolvedValueOnce(undefined);
    await moveTerminalSnapshot("old-id", "new-id");
    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).toEqual([
      "terminal_snapshot_load",
      "terminal_snapshot_persist",
      "terminal_snapshot_delete",
    ]);
  });

  it("move is a no-op when the old snapshot does not exist", async () => {
    invokeMock.mockResolvedValueOnce(null);
    await moveTerminalSnapshot("old-empty", "new-id");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("move is a no-op when ids are equal", async () => {
    await moveTerminalSnapshot("same", "same");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
