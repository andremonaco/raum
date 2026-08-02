import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";

import { matchIndexAt, searchStats, selectionIsMatch } from "./editorSearch";

const DOC = ["const foo = 1;", "function foo(bar) {", "  return bar + foo;", "}"].join("\n");

function stateWithSelection(anchor = 0, head = anchor): EditorState {
  return EditorState.create({ doc: DOC, selection: { anchor, head } });
}

describe("searchStats", () => {
  it("counts every match", () => {
    const stats = searchStats(stateWithSelection(), new SearchQuery({ search: "foo" }));
    expect(stats.count).toBe(3);
    expect(stats.capped).toBe(false);
  });

  it("reports no matches for an invalid (empty) query", () => {
    expect(searchStats(stateWithSelection(), new SearchQuery({ search: "" }))).toEqual({
      count: 0,
      index: -1,
      capped: false,
    });
  });

  it("locates the selected match", () => {
    const first = DOC.indexOf("foo");
    const second = DOC.indexOf("foo", first + 1);
    const stats = searchStats(
      stateWithSelection(second, second + 3),
      new SearchQuery({ search: "foo" }),
    );
    expect(stats.index).toBe(1);
  });

  it("returns index -1 when the selection isn't on a match", () => {
    const stats = searchStats(stateWithSelection(0), new SearchQuery({ search: "foo" }));
    expect(stats.index).toBe(-1);
  });

  it("honours case sensitivity", () => {
    const state = EditorState.create({ doc: "Foo foo" });
    expect(searchStats(state, new SearchQuery({ search: "foo" })).count).toBe(2);
    expect(searchStats(state, new SearchQuery({ search: "foo", caseSensitive: true })).count).toBe(
      1,
    );
  });

  it("supports regexp queries", () => {
    const stats = searchStats(
      stateWithSelection(),
      new SearchQuery({ search: "\\bfoo\\b", regexp: true }),
    );
    expect(stats.count).toBe(3);
  });

  it("stops at the cap and marks the count as a lower bound", () => {
    const state = EditorState.create({ doc: "xxxxx" });
    const stats = searchStats(state, new SearchQuery({ search: "x" }), 3);
    expect(stats).toEqual({ count: 3, index: -1, capped: true });
  });
});

describe("matchIndexAt", () => {
  const query = new SearchQuery({ search: "foo" });

  it("agrees with searchStats for each match", () => {
    let at = DOC.indexOf("foo");
    for (let expected = 0; at >= 0; expected++) {
      const state = stateWithSelection(at, at + 3);
      expect(matchIndexAt(state, query)).toBe(expected);
      expect(matchIndexAt(state, query)).toBe(searchStats(state, query).index);
      at = DOC.indexOf("foo", at + 3);
    }
  });

  it("is -1 when the selection isn't exactly on a match", () => {
    expect(matchIndexAt(stateWithSelection(0), query)).toBe(-1);
    const at = DOC.indexOf("foo");
    expect(matchIndexAt(stateWithSelection(at, at + 2), query)).toBe(-1);
  });
});

describe("selectionIsMatch", () => {
  const query = new SearchQuery({ search: "foo" });

  it("is true when the selection exactly covers a match", () => {
    const at = DOC.indexOf("foo");
    expect(selectionIsMatch(stateWithSelection(at, at + 3), query)).toBe(true);
  });

  it("is false for an empty selection", () => {
    expect(selectionIsMatch(stateWithSelection(DOC.indexOf("foo")), query)).toBe(false);
  });

  it("is false when the selection only overlaps a match", () => {
    const at = DOC.indexOf("foo");
    expect(selectionIsMatch(stateWithSelection(at, at + 2), query)).toBe(false);
  });
});
