import { describe, expect, it } from "vitest";

import { findSplicePoint, formatRecoveryMarker, renderRecoveryPayload } from "./tmuxBackfill";

describe("findSplicePoint", () => {
  it("returns no match for empty inputs", () => {
    expect(findSplicePoint([], []).matchIndex).toBe(-1);
    expect(findSplicePoint(["a"], []).matchIndex).toBe(-1);
    expect(findSplicePoint([], ["a"]).matchIndex).toBe(-1);
  });

  it("returns no missing lines when xterm is already caught up", () => {
    const lines = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const result = findSplicePoint(lines, lines);
    expect(result.missingCount).toBe(0);
    expect(result.missingLines).toEqual([]);
    expect(result.matchIndex).toBe(lines.length - 1);
  });

  it("recovers the tail tmux has beyond xterm", () => {
    const xterm = ["line 1", "line 2", "line 3", "line 4", "line 5"];
    const tmux = ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8"];
    const result = findSplicePoint(xterm, tmux);
    expect(result.missingLines).toEqual(["line 6", "line 7", "line 8"]);
    expect(result.missingCount).toBe(3);
    expect(result.matchIndex).toBe(4);
  });

  it("recovers ~5000 extra lines without choking", () => {
    const xterm = Array.from({ length: 80 }, (_, i) => `row-${i}`);
    const tmux = [...xterm, ...Array.from({ length: 5000 }, (_, i) => `extra-${i}`)];
    const result = findSplicePoint(xterm, tmux);
    expect(result.missingCount).toBe(5000);
    expect(result.missingLines[0]).toBe("extra-0");
    expect(result.missingLines.at(-1)).toBe("extra-4999");
  });

  it("returns no match when content has fully diverged", () => {
    const xterm = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    const tmux = ["completely", "different", "story", "line by line", "no overlap"];
    const result = findSplicePoint(xterm, tmux);
    expect(result.matchIndex).toBe(-1);
    expect(result.missingCount).toBe(0);
  });

  it("ignores trailing blank padding on both sides", () => {
    const xterm = ["alpha", "beta", "gamma", "", "", ""];
    const tmux = ["alpha", "beta", "gamma", "delta", "epsilon", "", ""];
    const result = findSplicePoint(xterm, tmux);
    expect(result.missingLines).toEqual(["delta", "epsilon"]);
  });

  it("ignores trailing whitespace on individual lines (tmux pads to pane width)", () => {
    const xterm = ["alpha", "beta   ", "gamma\t"];
    const tmux = ["alpha", "beta", "gamma", "delta"];
    const result = findSplicePoint(xterm, tmux);
    expect(result.missingLines).toEqual(["delta"]);
  });

  it("skips suspiciously thin matches (single-line) to avoid false positives", () => {
    // Only "$" matches between the two; that's not enough to be confident.
    const xterm = ["unique tail 1", "unique tail 2", "$"];
    const tmux = ["unrelated 1", "unrelated 2", "unrelated 3", "$"];
    const result = findSplicePoint(xterm, tmux);
    expect(result.matchIndex).toBe(-1);
  });

  it("prefers the most-recent match when content repeats", () => {
    // "block" appears twice in tmux; the LATER one is the right anchor.
    const xterm = ["block-a", "block-b", "block-c", "block-d"];
    const tmux = [
      "block-a",
      "block-b",
      "block-c",
      "block-d",
      "intermission",
      "block-a",
      "block-b",
      "block-c",
      "block-d",
      "tail-x",
      "tail-y",
    ];
    const result = findSplicePoint(xterm, tmux);
    expect(result.missingLines).toEqual(["tail-x", "tail-y"]);
  });

  it("handles xterm tail much shorter than tmux capture", () => {
    const xterm = ["only", "four", "anchor", "rows"];
    const tmux = [
      ...Array.from({ length: 100 }, (_, i) => `noise-${i}`),
      "only",
      "four",
      "anchor",
      "rows",
      "missing-1",
      "missing-2",
    ];
    const result = findSplicePoint(xterm, tmux);
    expect(result.missingLines).toEqual(["missing-1", "missing-2"]);
  });
});

describe("formatRecoveryMarker", () => {
  it("singular vs plural and thousands separators", () => {
    expect(formatRecoveryMarker(1)).toContain("1 line recovered");
    expect(formatRecoveryMarker(3)).toContain("3 lines recovered");
    expect(formatRecoveryMarker(1243)).toContain("1,243 lines recovered");
  });

  it("wraps with SGR dim + reset and surrounding CRLFs", () => {
    const marker = formatRecoveryMarker(7);
    expect(marker.startsWith("\r\n\x1b[2m")).toBe(true);
    expect(marker.endsWith("\x1b[0m\r\n")).toBe(true);
  });
});

describe("renderRecoveryPayload", () => {
  it("returns empty string for no missing lines", () => {
    expect(renderRecoveryPayload([])).toBe("");
  });

  it("joins missing lines with CRLF and trailing newline", () => {
    const payload = renderRecoveryPayload(["x", "y", "z"]);
    expect(payload.endsWith("x\r\ny\r\nz\r\n")).toBe(true);
    expect(payload).toContain("3 lines recovered");
  });
});
