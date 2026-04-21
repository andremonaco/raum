import { describe, it, expect } from "vitest";
import {
  buildFromRects,
  compact,
  equalizeRatios,
  hasLeaf,
  leaf,
  leafIds,
  MIN_RATIO,
  normalizeRatios,
  pathToLeaf,
  projectToRects,
  removeLeaf,
  split,
  splitAtLeaf,
  splitAtRoot,
  swapLeaves,
  tileLeaves,
  type LayoutNode,
} from "./layoutTree";

describe("layoutTree: basics", () => {
  it("normalizeRatios enforces min and sums to 1", () => {
    const r = normalizeRatios([0.01, 0.99]);
    expect(r[0]).toBeGreaterThanOrEqual(MIN_RATIO - 1e-9);
    expect(r[0] + r[1]).toBeCloseTo(1, 9);
  });

  it("leafIds yields in-order traversal", () => {
    const tree = split("row", [leaf("a"), split("col", [leaf("b"), leaf("c")]), leaf("d")]);
    expect(leafIds(tree)).toEqual(["a", "b", "c", "d"]);
  });

  it("hasLeaf + pathToLeaf find nested leaves", () => {
    const tree = split("row", [leaf("a"), split("col", [leaf("b"), leaf("c")])]);
    expect(hasLeaf(tree, "c")).toBe(true);
    expect(hasLeaf(tree, "zz")).toBe(false);
    expect(pathToLeaf(tree, "c")).toEqual([1, 1]);
    expect(pathToLeaf(tree, "a")).toEqual([0]);
  });
});

describe("splitAtLeaf", () => {
  it("wraps a root leaf into a 2-split", () => {
    const out = splitAtLeaf(leaf("a"), "a", "right", leaf("b")) as ReturnType<typeof split>;
    expect(out.kind).toBe("split");
    expect(out.axis).toBe("row");
    expect(leafIds(out)).toEqual(["a", "b"]);
  });

  it("inserts before target for left/top", () => {
    const out = splitAtLeaf(leaf("a"), "a", "left", leaf("b"));
    expect(leafIds(out)).toEqual(["b", "a"]);
  });

  it("extends same-axis parent without nesting", () => {
    const tree = split("row", [leaf("a"), leaf("b")]);
    const out = splitAtLeaf(tree, "b", "right", leaf("c")) as ReturnType<typeof split>;
    expect(out.kind).toBe("split");
    expect(out.axis).toBe("row");
    expect(out.children.length).toBe(3);
    expect(leafIds(out)).toEqual(["a", "b", "c"]);
    expect(out.ratios.reduce((s, v) => s + v, 0)).toBeCloseTo(1);
  });

  it("nests when parent axis differs", () => {
    const tree = split("row", [leaf("a"), leaf("b")]);
    const out = splitAtLeaf(tree, "b", "bottom", leaf("c"));
    // root is still row; b is replaced by col(b,c)
    expect(leafIds(out)).toEqual(["a", "b", "c"]);
    if (out.kind !== "split") throw new Error("expected split");
    const right = out.children[1];
    if (right.kind !== "split") throw new Error("expected nested split");
    expect(right.axis).toBe("col");
  });

  it("supports the o/u | i layout via root-edge drop", () => {
    // Build: row( col(o,u), i ) — the user's sketch.
    let tree: LayoutNode = leaf("o");
    tree = splitAtLeaf(tree, "o", "bottom", leaf("u"));
    tree = splitAtRoot(tree, "right", leaf("i"));
    if (tree.kind !== "split") throw new Error("expected split");
    expect(tree.axis).toBe("row");
    expect(tree.children.length).toBe(2);
    // Left: col(o,u); Right: leaf(i)
    const left = tree.children[0];
    if (left.kind !== "split") throw new Error("expected nested col");
    expect(left.axis).toBe("col");
    expect(leafIds(left)).toEqual(["o", "u"]);
    expect(tree.children[1]).toEqual(leaf("i"));
  });
});

describe("removeLeaf", () => {
  it("collapses unary parent", () => {
    const tree = split("row", [leaf("a"), leaf("b")]);
    const out = removeLeaf(tree, "b");
    expect(out).toEqual(leaf("a"));
  });

  it("normalizes remaining ratios", () => {
    const tree = split("row", [leaf("a"), leaf("b"), leaf("c")], [0.5, 0.25, 0.25]);
    const out = removeLeaf(tree, "a");
    if (!out || out.kind !== "split") throw new Error("expected split");
    expect(out.children.length).toBe(2);
    expect(out.ratios.reduce((s, v) => s + v, 0)).toBeCloseTo(1);
  });

  it("returns null when emptying tree", () => {
    expect(removeLeaf(leaf("a"), "a")).toBeNull();
  });
});

describe("swapLeaves", () => {
  it("swaps ids without changing structure", () => {
    const tree = split("row", [leaf("a"), split("col", [leaf("b"), leaf("c")])]);
    const out = swapLeaves(tree, "a", "c");
    expect(leafIds(out!)).toEqual(["c", "b", "a"]);
    // structure preserved
    if (out!.kind !== "split") throw new Error("expected split");
    expect(out!.axis).toBe("row");
  });
});

describe("compact", () => {
  it("merges same-axis nested splits", () => {
    const nested = {
      kind: "split" as const,
      axis: "row" as const,
      ratios: [0.5, 0.5],
      children: [
        {
          kind: "split" as const,
          axis: "row" as const,
          ratios: [0.5, 0.5],
          children: [leaf("a"), leaf("b")],
        },
        leaf("c"),
      ],
    };
    const out = compact(nested);
    if (out.kind !== "split") throw new Error("expected split");
    expect(out.children.length).toBe(3);
    expect(leafIds(out)).toEqual(["a", "b", "c"]);
    // Combined ratios: a = 0.5*0.5, b = 0.5*0.5, c = 0.5
    expect(out.ratios[0]).toBeCloseTo(0.25);
    expect(out.ratios[1]).toBeCloseTo(0.25);
    expect(out.ratios[2]).toBeCloseTo(0.5);
  });

  it("collapses unary split", () => {
    const out = compact({
      kind: "split",
      axis: "row",
      ratios: [1],
      children: [leaf("a")],
    });
    expect(out).toEqual(leaf("a"));
  });
});

describe("equalizeRatios", () => {
  it("leaves a bare leaf untouched", () => {
    expect(equalizeRatios(leaf("a"))).toEqual(leaf("a"));
  });

  it("resets a skewed binary split to 50/50", () => {
    const tree = split("row", [leaf("a"), leaf("b")], [0.9, 0.1]);
    const out = equalizeRatios(tree);
    if (out.kind !== "split") throw new Error("expected split");
    expect(out.ratios[0]).toBeCloseTo(0.5);
    expect(out.ratios[1]).toBeCloseTo(0.5);
    expect(leafIds(out)).toEqual(["a", "b"]);
  });

  it("equalizes nested splits recursively", () => {
    const tree = split(
      "row",
      [split("col", [leaf("a"), leaf("b")], [0.8, 0.2]), leaf("c")],
      [0.3, 0.7],
    );
    const out = equalizeRatios(tree);
    if (out.kind !== "split") throw new Error("expected split");
    expect(out.ratios.every((r) => Math.abs(r - 0.5) < 1e-9)).toBe(true);
    const left = out.children[0];
    if (left.kind !== "split") throw new Error("expected nested split");
    expect(left.ratios.every((r) => Math.abs(r - 0.5) < 1e-9)).toBe(true);
  });

  it("equalizes n-ary splits", () => {
    const tree = split("row", [leaf("a"), leaf("b"), leaf("c"), leaf("d")], [0.1, 0.2, 0.3, 0.4]);
    const out = equalizeRatios(tree);
    if (out.kind !== "split") throw new Error("expected split");
    expect(out.ratios.every((r) => Math.abs(r - 0.25) < 1e-9)).toBe(true);
  });

  it("preserves split axes and child order (topology-only touch)", () => {
    const tree = split(
      "row",
      [split("col", [leaf("a"), leaf("b")]), split("col", [leaf("c"), leaf("d"), leaf("e")])],
      [0.3, 0.7],
    );
    const out = equalizeRatios(tree);
    expect(leafIds(out)).toEqual(["a", "b", "c", "d", "e"]);
    if (out.kind !== "split") throw new Error("expected split");
    expect(out.axis).toBe("row");
    expect((out.children[0] as { axis: string }).axis).toBe("col");
    expect((out.children[1] as { axis: string }).axis).toBe("col");
  });
});

describe("tileLeaves", () => {
  it("returns null for an empty id list", () => {
    expect(tileLeaves([])).toBeNull();
  });

  it("returns a single leaf for N=1", () => {
    expect(tileLeaves(["a"])).toEqual(leaf("a"));
  });

  it("returns a 2-child row split for N=2", () => {
    const out = tileLeaves(["a", "b"])!;
    if (out.kind !== "split") throw new Error("expected split");
    expect(out.axis).toBe("row");
    expect(out.ratios[0]).toBeCloseTo(0.5);
    expect(leafIds(out)).toEqual(["a", "b"]);
  });

  it("tiles 4 leaves into a 2x2 grid", () => {
    const out = tileLeaves(["a", "b", "c", "d"])!;
    if (out.kind !== "split") throw new Error("expected split");
    expect(out.axis).toBe("col");
    expect(out.children.length).toBe(2);
    for (const c of out.children) {
      if (c.kind !== "split") throw new Error("expected row split");
      expect(c.axis).toBe("row");
      expect(c.children.length).toBe(2);
    }
    expect(leafIds(out)).toEqual(["a", "b", "c", "d"]);
  });

  it("tiles 5 leaves into a 3+2 layout (ceil(sqrt(5)) = 3 cols)", () => {
    const out = tileLeaves(["a", "b", "c", "d", "e"])!;
    if (out.kind !== "split") throw new Error("expected split");
    expect(out.axis).toBe("col");
    expect(out.children.length).toBe(2);
    expect(leafIds(out)).toEqual(["a", "b", "c", "d", "e"]);
    const row1 = out.children[0];
    const row2 = out.children[1];
    if (row1.kind !== "split" || row2.kind !== "split") throw new Error("expected row splits");
    expect(row1.children.length).toBe(3);
    expect(row2.children.length).toBe(2);
  });

  it("tiles 9 leaves into a 3x3 grid", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const out = tileLeaves(ids)!;
    if (out.kind !== "split") throw new Error("expected split");
    expect(out.axis).toBe("col");
    expect(out.children.length).toBe(3);
    for (const c of out.children) {
      if (c.kind !== "split") throw new Error("expected row split");
      expect(c.children.length).toBe(3);
    }
    expect(leafIds(out)).toEqual(ids);
  });

  it("handles a lone trailing leaf as a bottom band (N=7)", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    const out = tileLeaves(ids)!;
    if (out.kind !== "split") throw new Error("expected split");
    expect(out.axis).toBe("col");
    // cols = ceil(sqrt(7)) = 3, rows = ceil(7/3) = 3. Rows: 3, 3, 1.
    expect(out.children.length).toBe(3);
    expect(out.children[2]).toEqual(leaf("g"));
    expect(leafIds(out)).toEqual(ids);
  });
});

describe("tileLeaves with priority: rows", () => {
  it("N=4 → 2×2 (same as default)", () => {
    const out = tileLeaves(["a", "b", "c", "d"], { priority: "rows" })!;
    if (out.kind !== "split") throw new Error("expected split");
    expect(out.axis).toBe("col");
    expect(out.children.length).toBe(2);
    for (const c of out.children) {
      if (c.kind !== "split") throw new Error("expected row split");
      expect(c.children.length).toBe(2);
    }
  });

  it("N=5 → 2+2+1 (full-width tail row)", () => {
    const out = tileLeaves(["a", "b", "c", "d", "e"], { priority: "rows" })!;
    if (out.kind !== "split") throw new Error("expected split");
    expect(out.axis).toBe("col");
    expect(out.children.length).toBe(3);
    const row1 = out.children[0];
    const row2 = out.children[1];
    const tail = out.children[2];
    if (row1.kind !== "split" || row2.kind !== "split") throw new Error("expected row splits");
    expect(row1.children.length).toBe(2);
    expect(row2.children.length).toBe(2);
    expect(tail).toEqual(leaf("e"));
    expect(leafIds(out)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("N=9 → 3×3", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const out = tileLeaves(ids, { priority: "rows" })!;
    if (out.kind !== "split") throw new Error("expected split");
    expect(out.children.length).toBe(3);
    for (const c of out.children) {
      if (c.kind !== "split") throw new Error("expected row split");
      expect(c.children.length).toBe(3);
    }
  });

  it("N=10 → 3+3+3+1 (full-width tail row)", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const out = tileLeaves(ids, { priority: "rows" })!;
    if (out.kind !== "split") throw new Error("expected split");
    expect(out.children.length).toBe(4);
    expect(out.children[3]).toEqual(leaf("j"));
  });
});

describe("projection round-trip", () => {
  it("rects reconstruct to an equivalent tree", () => {
    const tree = split(
      "row",
      [split("col", [leaf("o"), leaf("u")], [0.4, 0.6]), leaf("i")],
      [0.35, 0.65],
    );
    const rects = projectToRects(tree, 10000);
    const rebuilt = buildFromRects(rects, 10000);
    expect(leafIds(rebuilt)).toEqual(leafIds(tree));
    const rects2 = projectToRects(rebuilt, 10000);
    // Same rectangles regardless of axis-labeling drift in rebuilt tree.
    const key = (r: { id: string; x: number; y: number; w: number; h: number }) =>
      `${r.id}:${r.x},${r.y},${r.w},${r.h}`;
    expect(rects2.map(key).sort()).toEqual(rects.map(key).sort());
  });
});
