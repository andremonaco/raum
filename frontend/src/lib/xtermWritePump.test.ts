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

  // The snapshot replay-under-viewport ordering used by `reattachSession`
  // (terminal-pane.tsx): the disk snapshot, the cursor-home + erase-below
  // boundary (ESC[H ESC[J), and the live bridge frame must all land on the SAME
  // pinned generation, in that order, so older scrollback restores beneath a
  // clean viewport and the live capture cannot render below the snapshot's
  // last screen (and leaves no ghost trailing characters).
  it("preserves snapshot -> ESC[H ESC[J -> live-frame ordering on one generation", () => {
    const terminal = new FakeTerminal();
    const pump = createXtermWritePump({ getTerminal: () => terminal });
    const generation = pump.generation();
    const CURSOR_HOME_CLEAR_BELOW = new Uint8Array([0x1b, 0x5b, 0x48, 0x1b, 0x5b, 0x4a]);

    // Replay order as terminal-pane enqueues it.
    pump.enqueue(generation, new TextEncoder().encode("SNAPSHOT-SCROLLBACK"));
    pump.enqueue(generation, CURSOR_HOME_CLEAR_BELOW);
    pump.enqueue(generation, new TextEncoder().encode("LIVE-FRAME"));

    // First frame writes immediately; the rest coalesce behind it.
    terminal.flushOne();
    terminal.flushOne();
    const joined = terminal.parsed.join("");
    // The boundary must sit between the snapshot and the live frame.
    const home = "\x1b[H\x1b[J";
    expect(joined.indexOf("SNAPSHOT-SCROLLBACK")).toBeLessThan(joined.indexOf(home));
    expect(joined.indexOf(home)).toBeLessThan(joined.indexOf("LIVE-FRAME"));
  });

  // The not-recoverable reboot fallback (terminal-pane.tsx) awaits the disk
  // snapshot and enqueues it on the current generation BEFORE releasing the
  // spawn gate, so the fresh harness output lands AFTER it on the same
  // generation. This pins the invariant that a snapshot enqueued first is
  // written before later same-generation output (no scrollback below new
  // output).
  it("orders an awaited snapshot before later same-generation spawn output", () => {
    const terminal = new FakeTerminal();
    const pump = createXtermWritePump({ getTerminal: () => terminal });
    const generation = pump.generation();

    pump.enqueue(generation, new TextEncoder().encode("PRIOR-SCROLLBACK"));
    // Fresh harness output arrives later on the same generation.
    pump.enqueue(generation, new TextEncoder().encode("NEW-HARNESS-PROMPT"));

    terminal.flushOne();
    const joined = terminal.parsed.join("");
    expect(joined.indexOf("PRIOR-SCROLLBACK")).toBeLessThan(joined.indexOf("NEW-HARNESS-PROMPT"));
  });

  // A snapshot fallback pinned to a generation that has since rotated must be
  // dropped, never appended after the new generation's output — the guarantee
  // that protects the recoverable reboot path from misordering a stale replay.
  it("drops a snapshot enqueued at a stale generation after rotation", () => {
    const terminal = new FakeTerminal();
    const pump = createXtermWritePump({ getTerminal: () => terminal });
    const staleGeneration = pump.generation();

    const freshGeneration = pump.rotate(true);
    pump.enqueue(freshGeneration, new TextEncoder().encode("FRESH"));
    // Late-resolving snapshot read pinned to the now-stale generation.
    pump.enqueue(staleGeneration, new TextEncoder().encode("STALE-SNAPSHOT"));

    terminal.flushOne();
    const joined = terminal.parsed.join("");
    expect(joined).toContain("FRESH");
    expect(joined).not.toContain("STALE-SNAPSHOT");
  });
});
