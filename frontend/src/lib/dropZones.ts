/**
 * Pure geometry for the drag drop-zone cluster.
 *
 * Rather than papering the whole grid with indicators, the affordance follows
 * the cursor: only the pane (or the grid, for an outer-edge wrap) currently
 * under the pointer shows its four directional drop targets. `clusterRect`
 * returns the rect that cluster overlays; the renderer places one chevron tab
 * on each of its edges. Coordinates are percentages of the grid root.
 */

import { type LayoutNode } from "./layoutTree";
import { ROOT_TARGET, type DropZone, type RootTargetSentinel } from "./paneDnD";

export interface PctRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Human-readable chip label for a landing. Root-edge wraps read as "New
 * column"/"New row" (you're adding a top-level track); pane-edge splits read
 * directionally ("Split left", "Split up", …). Center (review) draws no rect
 * and has no label.
 *
 * Currently unused by the live UI (the dragged pane is its own landing
 * preview), but kept + tested as the canonical directional-label mapping.
 */
export function landingLabel(zone: DropZone, isRoot: boolean): string {
  if (zone === "center") return "";
  if (isRoot) {
    return zone === "left" || zone === "right" ? "New column" : "New row";
  }
  switch (zone) {
    case "left":
      return "Split left";
    case "right":
      return "Split right";
    case "top":
      return "Split up";
    case "bottom":
      return "Split down";
    default:
      return "";
  }
}

/** A small ambient anchor node marking a drop boundary (a seam between panes
 *  or an outer edge), shown across the whole grid during a drag for visual
 *  anchoring. `orient` follows the boundary it sits on. */
export interface DropAnchor {
  id: string;
  cx: number;
  cy: number;
  orient: "v" | "h";
}

/**
 * Anchor nodes for the whole grid: one on every seam between adjacent panes,
 * plus one on each of the four outer edges. These are the quiet, always-on
 * "here's where things can go" layer; the cluster (`clusterRect`) is the
 * detailed hover affordance on top. Returns [] for a single pane.
 */
export function computeAnchors(tree: LayoutNode | null): DropAnchor[] {
  const out: DropAnchor[] = [];
  if (tree && tree.kind !== "leaf") {
    walkSeamAnchors(tree, { left: 0, top: 0, width: 100, height: 100 }, out);
    out.push({ id: "edge:left", cx: 0, cy: 50, orient: "v" });
    out.push({ id: "edge:right", cx: 100, cy: 50, orient: "v" });
    out.push({ id: "edge:top", cx: 50, cy: 0, orient: "h" });
    out.push({ id: "edge:bottom", cx: 50, cy: 100, orient: "h" });
  }
  return out;
}

function walkSeamAnchors(node: LayoutNode, rect: PctRect, out: DropAnchor[]): void {
  if (node.kind === "leaf") return;
  const childRects: PctRect[] = [];
  let offset = 0;
  for (let i = 0; i < node.children.length; i++) {
    const ratio = node.ratios[i];
    if (node.axis === "row") {
      const cw = rect.width * ratio;
      childRects.push({ left: rect.left + offset, top: rect.top, width: cw, height: rect.height });
      offset += cw;
    } else {
      const ch = rect.height * ratio;
      childRects.push({ left: rect.left, top: rect.top + offset, width: rect.width, height: ch });
      offset += ch;
    }
  }
  for (let i = 0; i < node.children.length - 1; i++) {
    const before = childRects[i];
    if (node.axis === "row") {
      out.push({
        id: `seam:${node.axis}:${i}:${Math.round(before.left + before.width)}:${Math.round(rect.top)}`,
        cx: before.left + before.width,
        cy: rect.top + rect.height / 2,
        orient: "v",
      });
    } else {
      out.push({
        id: `seam:${node.axis}:${i}:${Math.round(rect.left)}:${Math.round(before.top + before.height)}`,
        cx: rect.left + rect.width / 2,
        cy: before.top + before.height,
        orient: "h",
      });
    }
  }
  for (let i = 0; i < node.children.length; i++) {
    walkSeamAnchors(node.children[i], childRects[i], out);
  }
}

/**
 * The rect the drop-zone cluster overlays for the current drag target:
 *   • a real pane id → that pane's rect (split it on one of four sides),
 *   • `ROOT_TARGET`  → the whole grid (wrap the layout in a new column/row).
 * Returns null when there's no target (cursor isn't over a drop-capable
 * region) or the id isn't in the tree.
 */
export function clusterRect(
  tree: LayoutNode | null,
  targetId: string | RootTargetSentinel | null,
): PctRect | null {
  if (!tree || targetId === null) return null;
  if (targetId === ROOT_TARGET) return { left: 0, top: 0, width: 100, height: 100 };
  return findLeafRect(tree, targetId);
}

/** Walk the tree to find a single leaf's rect in percent-of-root (float
 *  precision so the cluster lines up exactly with the pane edges). */
function findLeafRect(tree: LayoutNode, id: string): PctRect | null {
  let found: PctRect | null = null;
  const visit = (node: LayoutNode, r: PctRect): void => {
    if (found) return;
    if (node.kind === "leaf") {
      if (node.id === id) found = r;
      return;
    }
    let offset = 0;
    for (let i = 0; i < node.children.length; i++) {
      const ratio = node.ratios[i];
      if (node.axis === "row") {
        const cw = r.width * ratio;
        visit(node.children[i], { left: r.left + offset, top: r.top, width: cw, height: r.height });
        offset += cw;
      } else {
        const ch = r.height * ratio;
        visit(node.children[i], { left: r.left, top: r.top + offset, width: r.width, height: ch });
        offset += ch;
      }
    }
  };
  visit(tree, { left: 0, top: 0, width: 100, height: 100 });
  return found;
}
