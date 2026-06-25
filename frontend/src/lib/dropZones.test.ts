import { describe, expect, it } from "vitest";

import { leaf, split } from "./layoutTree";
import { clusterRect, computeAnchors, landingLabel } from "./dropZones";
import { ROOT_TARGET } from "./paneDnD";

describe("computeAnchors — ambient nodes on seams + outer edges", () => {
  it("returns nothing for an empty tree or a single pane", () => {
    expect(computeAnchors(null)).toEqual([]);
    expect(computeAnchors(leaf("A"))).toEqual([]);
  });

  it("marks the four outer edges plus a seam for a two-column split", () => {
    const anchors = computeAnchors(split("row", [leaf("A"), leaf("B")]));
    // 4 edges + 1 seam.
    expect(anchors).toHaveLength(5);
    expect(anchors.filter((a) => a.id.startsWith("edge:"))).toHaveLength(4);
    const seam = anchors.find((a) => a.id.startsWith("seam:"))!;
    expect(seam.orient).toBe("v");
    expect(seam.cx).toBeCloseTo(50);
    expect(seam.cy).toBeCloseTo(50);
  });

  it("recurses into nested splits — one seam node per boundary at every level", () => {
    const anchors = computeAnchors(split("row", [leaf("A"), split("col", [leaf("B"), leaf("C")])]));
    const seams = anchors.filter((a) => a.id.startsWith("seam:"));
    expect(seams).toHaveLength(2);
    expect(seams.map((s) => s.orient).sort()).toEqual(["h", "v"]);
  });
});

describe("clusterRect — the rect the drop cluster overlays", () => {
  it("returns null when there is no tree or no target", () => {
    expect(clusterRect(null, "A")).toBeNull();
    expect(clusterRect(leaf("A"), null)).toBeNull();
  });

  it("returns null for an id not in the tree", () => {
    expect(clusterRect(split("row", [leaf("A"), leaf("B")]), "ghost")).toBeNull();
  });

  it("returns the whole grid for an outer-edge (root) wrap", () => {
    expect(clusterRect(split("row", [leaf("A"), leaf("B")]), ROOT_TARGET)).toEqual({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    });
  });

  it("returns a pane's rect for a two-column split", () => {
    const tree = split("row", [leaf("A"), leaf("B")]);
    expect(clusterRect(tree, "A")).toEqual({ left: 0, top: 0, width: 50, height: 100 });
    expect(clusterRect(tree, "B")).toEqual({ left: 50, top: 0, width: 50, height: 100 });
  });

  it("resolves a leaf nested inside a sub-split", () => {
    // row( A | col(B / C) ): C is the lower half of the right column.
    const tree = split("row", [leaf("A"), split("col", [leaf("B"), leaf("C")])]);
    const c = clusterRect(tree, "C");
    expect(c).not.toBeNull();
    expect(c!.left).toBeCloseTo(50);
    expect(c!.top).toBeCloseTo(50);
    expect(c!.width).toBeCloseTo(50);
    expect(c!.height).toBeCloseTo(50);
  });
});

describe("landingLabel", () => {
  it("names pane-edge splits directionally", () => {
    expect(landingLabel("left", false)).toBe("Split left");
    expect(landingLabel("bottom", false)).toBe("Split down");
  });

  it("names root-edge wraps as a new track", () => {
    expect(landingLabel("left", true)).toBe("New column");
    expect(landingLabel("bottom", true)).toBe("New row");
  });

  it("returns empty for the center (review) zone", () => {
    expect(landingLabel("center", false)).toBe("");
  });
});
