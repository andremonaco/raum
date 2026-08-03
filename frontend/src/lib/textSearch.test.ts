import { describe, expect, it } from "vitest";

import { findTextMatches, matchesByLine, segmentLine } from "./textSearch";

const LINES = ["const foo = 1;", "function foo(bar) {", "  return bar + foo;", "}"];

describe("findTextMatches", () => {
  it("returns nothing for an empty query", () => {
    expect(findTextMatches(LINES, "")).toEqual({ matches: [], capped: false, invalid: false });
  });

  it("finds every occurrence in document order", () => {
    const { matches } = findTextMatches(LINES, "foo");
    expect(matches).toEqual([
      { line: 0, start: 6, end: 9 },
      { line: 1, start: 9, end: 12 },
      { line: 2, start: 15, end: 18 },
    ]);
  });

  it("matches several times on one line", () => {
    const { matches } = findTextMatches(["ababab"], "ab");
    expect(matches.map((m) => m.start)).toEqual([0, 2, 4]);
  });

  it("is case-insensitive by default and exact when asked", () => {
    expect(findTextMatches(["Foo foo"], "foo").matches).toHaveLength(2);
    expect(findTextMatches(["Foo foo"], "foo", { caseSensitive: true }).matches).toEqual([
      { line: 0, start: 4, end: 7 },
    ]);
  });

  it("reports offsets into the ORIGINAL text when case-insensitive", () => {
    // U+0130 grows by one code unit under toLowerCase(); offsets taken from a
    // lowercased copy would slice the wrong characters out of the original.
    const line = "İabc def";
    const { matches } = findTextMatches([line], "abc");
    expect(matches).toEqual([{ line: 0, start: 1, end: 4 }]);
    expect(line.slice(matches[0].start, matches[0].end)).toBe("abc");
  });

  it("treats regex metacharacters literally in a plain query", () => {
    expect(findTextMatches(["a.c", "abc"], "a.c").matches).toEqual([{ line: 0, start: 0, end: 3 }]);
  });

  it("supports regular expressions", () => {
    const { matches } = findTextMatches(LINES, "\\bfoo\\b", { regexp: true });
    expect(matches).toHaveLength(3);
  });

  it("flags an uncompilable pattern instead of throwing", () => {
    const result = findTextMatches(LINES, "foo(", { regexp: true });
    expect(result).toEqual({ matches: [], capped: false, invalid: true });
  });

  it("does not spin on zero-length regex matches", () => {
    const result = findTextMatches(["aaa"], "b*", { regexp: true });
    expect(result.matches).toEqual([]);
    expect(result.capped).toBe(false);
  });

  it("stops at the cap and says so", () => {
    const result = findTextMatches(["xxxxx"], "x", {}, 3);
    expect(result.matches).toHaveLength(3);
    expect(result.capped).toBe(true);
  });

  it("bails out at the time budget with a document-order prefix", () => {
    // A zero budget forces the first between-lines deadline check (line 64)
    // to fire, so the scan reports capped with only the earlier lines'
    // matches — the shape a pathological regexp degrades to.
    const lines = Array.from({ length: 1000 }, () => "needle haystack");
    const result = findTextMatches(lines, "needle", { budgetMs: 0 });
    expect(result.capped).toBe(true);
    expect(result.matches.length).toBeLessThan(lines.length);
    expect(result.matches.length).toBeGreaterThan(0);
    // Prefix property: matches come from a contiguous leading line range.
    const lastLine = result.matches[result.matches.length - 1]!.line;
    expect(result.matches).toHaveLength(lastLine + 1);
  });
});

describe("matchesByLine", () => {
  it("groups matches by line, keeping their global index", () => {
    const { matches } = findTextMatches(LINES, "foo");
    const byLine = matchesByLine(matches);
    expect([...byLine.keys()]).toEqual([0, 1, 2]);
    expect(byLine.get(2)).toEqual([{ start: 15, end: 18, index: 2 }]);
  });
});

describe("segmentLine", () => {
  it("returns the whole line untouched when there are no spans", () => {
    expect(segmentLine("hello", [])).toEqual([{ text: "hello", matchIndex: null }]);
  });

  it("splits around a match", () => {
    expect(segmentLine("a foo b", [{ start: 2, end: 5, index: 7 }])).toEqual([
      { text: "a ", matchIndex: null },
      { text: "foo", matchIndex: 7 },
      { text: " b", matchIndex: null },
    ]);
  });

  it("handles adjacent matches and a match at the very start", () => {
    expect(
      segmentLine("abab", [
        { start: 0, end: 2, index: 0 },
        { start: 2, end: 4, index: 1 },
      ]),
    ).toEqual([
      { text: "ab", matchIndex: 0 },
      { text: "ab", matchIndex: 1 },
    ]);
  });
});
