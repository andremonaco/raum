import { describe, expect, it } from "vitest";

import { createXtermWritePump, type TerminalOutputWriter } from "./xtermWritePump";

class FakeTerminal implements TerminalOutputWriter {
  parsed: string[] = [];
  resets = 0;
  callbacks: Array<() => void> = [];

  reset(): void {
    this.resets += 1;
  }

  write(data: Uint8Array, callback: () => void): void {
    this.parsed.push(new TextDecoder().decode(data));
    this.callbacks.push(callback);
  }

  flushOne(): void {
    const next = this.callbacks.shift();
    next?.();
  }
}

describe("createXtermWritePump", () => {
  it("feeds xterm in callback order and coalesces queued frames", () => {
    const terminal = new FakeTerminal();
    let parsedCount = 0;
    const pump = createXtermWritePump({
      getTerminal: () => terminal,
      onWriteParsed: () => {
        parsedCount += 1;
      },
    });

    pump.enqueue(pump.generation(), new TextEncoder().encode("a"));
    pump.enqueue(pump.generation(), new TextEncoder().encode("b"));
    pump.enqueue(pump.generation(), new TextEncoder().encode("c"));

    expect(terminal.parsed).toEqual(["a"]);
    expect(pump.queuedFrames()).toBe(2);
    terminal.flushOne();
    expect(terminal.parsed).toEqual(["a", "bc"]);
    terminal.flushOne();
    expect(parsedCount).toBe(2);
  });

  it("drops stale queued frames after generation rotation", () => {
    const terminal = new FakeTerminal();
    const pump = createXtermWritePump({ getTerminal: () => terminal });

    pump.enqueue(pump.generation(), new TextEncoder().encode("old-1"));
    pump.enqueue(pump.generation(), new TextEncoder().encode("old-2"));
    const nextGeneration = pump.rotate(true);
    pump.enqueue(nextGeneration, new TextEncoder().encode("new"));

    expect(terminal.parsed).toEqual(["old-1"]);
    terminal.flushOne();
    expect(terminal.resets).toBe(1);
    expect(terminal.parsed).toEqual(["old-1", "new"]);
  });

  it("rotates without resetting for ordinary reconnects", () => {
    const terminal = new FakeTerminal();
    const pump = createXtermWritePump({ getTerminal: () => terminal });

    const nextGeneration = pump.rotate(false);
    pump.enqueue(nextGeneration, new TextEncoder().encode("reattach-history"));

    expect(terminal.resets).toBe(0);
    expect(terminal.parsed).toEqual(["reattach-history"]);
  });
});
