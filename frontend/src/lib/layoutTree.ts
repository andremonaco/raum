/**
 * Pure layout-tree primitives.
 *
 * The grid is modeled as an n-ary BSP tree: every `Leaf` is a pane; every
 * `Split` contains >= 2 children arranged along one axis, with `ratios` that
 * sum to 1.0 and index-align with `children`. This shape guarantees perfect
 * viewport fill and supports arbitrary asymmetric layouts (tmux / iTerm /
 * Warp / Zellij / i3). All functions here are pure — they clone the tree on
 * mutation and have no Solid or DOM dependencies, so they're trivially
 * unit-testable.
 *
 * Axis convention:
 *   "row" — children laid out left-to-right (vertical dividers between).
 *   "col" — children stacked top-to-bottom (horizontal dividers between).
 *
 * Invariants maintained by every public mutator:
 *   - Every split has >= 2 children. Splits with 1 child are collapsed into
 *     their parent (or become the root). Splits with 0 children cannot exist.
 *   - Ratios always sum to 1.0 (±float epsilon) and are all >= MIN_RATIO.
 *   - Leaf ids are unique across the tree.
 *   - Adjacent same-axis splits are flattened: `row(row(a,b), c)` collapses
 *     to `row(a,b,c)` with ratios combined proportionally.
 */

export type Axis = "row" | "col";
export type Direction = "top" | "right" | "bottom" | "left";

export type LayoutNode = Leaf | Split;

export interface Leaf {
  kind: "leaf";
  id: string;
}

export interface Split {
  kind: "split";
  axis: Axis;
  ratios: number[];
  children: LayoutNode[];
}

/** Minimum ratio any child can shrink to during divider drag. Keeps a pane
 *  from vanishing mid-drag; the user can still close it with the X button. */
export const MIN_RATIO = 0.05;

// ---- constructors ----------------------------------------------------------

export function leaf(id: string): Leaf {
  return { kind: "leaf", id };
}

export function split(axis: Axis, children: LayoutNode[], ratios?: number[]): Split {
  if (children.length < 2) {
    throw new Error("split() requires >= 2 children");
  }
  const r = ratios ?? evenRatios(children.length);
  if (r.length !== children.length) {
    throw new Error("ratios length must match children length");
  }
  return { kind: "split", axis, ratios: normalizeRatios(r), children };
}

// ---- helpers ---------------------------------------------------------------

export function evenRatios(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n);
}

/** Normalize so the sum is 1.0 AND every entry is >= MIN_RATIO.
 *  Solved iteratively: entries at the floor are pinned, and the surplus is
 *  redistributed proportionally across the remaining entries until either
 *  all entries clear the floor or all are pinned. */
export function normalizeRatios(r: number[]): number[] {
  const n = r.length;
  if (n === 0) return [];
  if (n * MIN_RATIO >= 1) return evenRatios(n);
  // Start from positives scaled to sum 1.
  const positive = r.map((v) => (v > 0 ? v : 0));
  let sum = positive.reduce((a, b) => a + b, 0);
  const out = sum > 0 ? positive.map((v) => v / sum) : evenRatios(n);
  const pinned: boolean[] = Array.from({ length: n }, () => false);
  for (let pass = 0; pass < n; pass++) {
    let pinnedSum = 0;
    let freeSum = 0;
    let anyNew = false;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) {
        pinnedSum += out[i];
      } else if (out[i] < MIN_RATIO) {
        out[i] = MIN_RATIO;
        pinned[i] = true;
        pinnedSum += MIN_RATIO;
        anyNew = true;
      } else {
        freeSum += out[i];
      }
    }
    if (!anyNew) break;
    const remaining = 1 - pinnedSum;
    if (remaining <= 0 || freeSum <= 0) {
      // No room left for free entries — distribute evenly among free slots.
      const freeCount = n - pinned.filter(Boolean).length;
      const share = freeCount > 0 ? Math.max(0, remaining / freeCount) : 0;
      for (let i = 0; i < n; i++) if (!pinned[i]) out[i] = share;
      break;
    }
    const scale = remaining / freeSum;
    for (let i = 0; i < n; i++) if (!pinned[i]) out[i] *= scale;
  }
  // Final re-normalize against float drift.
  sum = out.reduce((a, b) => a + b, 0);
  return sum > 0 ? out.map((v) => v / sum) : evenRatios(n);
}

export function isLeaf(n: LayoutNode): n is Leaf {
  return n.kind === "leaf";
}

export function isSplit(n: LayoutNode): n is Split {
  return n.kind === "split";
}

/** Direction → axis on which the target should be split. top/bottom split
 *  along the column axis; left/right split along the row axis. */
export function directionAxis(d: Direction): Axis {
  return d === "top" || d === "bottom" ? "col" : "row";
}

/** Direction → does the new pane appear BEFORE the target (top/left)
 *  or AFTER (bottom/right) along the split axis? */
export function directionBefore(d: Direction): boolean {
  return d === "top" || d === "left";
}

// ---- traversal -------------------------------------------------------------

/** Yield every leaf id in in-order traversal (stable, deterministic). */
export function leafIds(n: LayoutNode | null): string[] {
  if (!n) return [];
  const out: string[] = [];
  const visit = (node: LayoutNode): void => {
    if (isLeaf(node)) out.push(node.id);
    else node.children.forEach(visit);
  };
  visit(n);
  return out;
}

/** True iff the tree contains a leaf with the given id. */
export function hasLeaf(n: LayoutNode | null, id: string): boolean {
  if (!n) return false;
  if (isLeaf(n)) return n.id === id;
  return n.children.some((c) => hasLeaf(c, id));
}

// ---- mutators --------------------------------------------------------------

/**
 * Insert `newLeaf` adjacent to the leaf with id `targetId`, along the given
 * direction. Returns a new tree; never mutates the input.
 *
 *   - top/bottom  → splits the target vertically (col axis)
 *   - left/right  → splits the target horizontally (row axis)
 *
 * If the target's parent already splits on the matching axis, the new leaf
 * extends that split in place (no extra nesting). Otherwise the target is
 * wrapped in a new 2-child split with 50/50 ratio.
 *
 * If the root is null or targetId is not found, returns a tree containing
 * only `newLeaf` as a fallback.
 */
export function splitAtLeaf(
  root: LayoutNode | null,
  targetId: string,
  direction: Direction,
  newLeaf: Leaf,
): LayoutNode {
  if (!root || !hasLeaf(root, targetId)) return newLeaf;
  const axis = directionAxis(direction);
  const before = directionBefore(direction);

  // Fast path: target is the root and it's a leaf — wrap in a new 2-split.
  if (isLeaf(root)) {
    return before ? split(axis, [newLeaf, root]) : split(axis, [root, newLeaf]);
  }

  // Walk the tree; when we find the parent that directly owns the target
  // leaf, decide whether to extend (same axis) or nest (different axis).
  const visit = (node: LayoutNode): LayoutNode => {
    if (isLeaf(node)) return node;
    const idx = node.children.findIndex((c) => isLeaf(c) && c.id === targetId);
    if (idx !== -1) {
      const target = node.children[idx] as Leaf;
      if (node.axis === axis) {
        // Extend: split the target's slot between target and newLeaf, preserving
        // the original slot's total ratio share.
        const slotRatio = node.ratios[idx];
        const insertAt = before ? idx : idx + 1;
        const nextChildren = [...node.children];
        const nextRatios = [...node.ratios];
        nextChildren.splice(insertAt, 0, newLeaf);
        // Replace the single slotRatio entry with two halves around it.
        nextRatios.splice(idx, 1, slotRatio / 2, slotRatio / 2);
        // But the above creates two entries for the original slot only; we still
        // need to account for newLeaf's insertion. splice above inserts one value
        // at (idx, 1 removed, 2 added) — that's the pair for target-half. Now
        // newLeaf was inserted at `insertAt` in nextChildren but nextRatios needs
        // a corresponding entry. The splice above gave us two ratios for target's
        // old slot (covering target + newLeaf). Map them by order:
        //   before=true  → [newLeafRatio, targetRatio] both = slotRatio/2
        //   before=false → [targetRatio, newLeafRatio] both = slotRatio/2
        // Already correct — nextRatios length now equals nextChildren length.
        return {
          kind: "split",
          axis: node.axis,
          ratios: normalizeRatios(nextRatios),
          children: nextChildren,
        };
      }
      // Nest: wrap the target in a new 2-child split on the other axis.
      const wrapped = before ? split(axis, [newLeaf, target]) : split(axis, [target, newLeaf]);
      const nextChildren = [...node.children];
      nextChildren[idx] = wrapped;
      return { ...node, children: nextChildren };
    }
    // Recurse into children.
    const nextChildren = node.children.map(visit);
    return { ...node, children: nextChildren };
  };
  return compact(visit(root));
}

/**
 * Insert `newLeaf` at the outer edge of the whole grid (top/right/bottom/left
 * of the root). Produces a new 2-split at the root level, or extends an
 * existing root split whose axis matches. This is the gesture for
 * "drop on root edge" — the way the user expresses layouts like `o/u | i`
 * without disturbing the internal arrangement of the other column.
 */
export function splitAtRoot(
  root: LayoutNode | null,
  direction: Direction,
  newLeaf: Leaf,
): LayoutNode {
  if (!root) return newLeaf;
  const axis = directionAxis(direction);
  const before = directionBefore(direction);
  if (isSplit(root) && root.axis === axis) {
    // Extend: add newLeaf at end/start with a 1/(n+1) share.
    const n = root.children.length;
    const newShare = 1 / (n + 1);
    const scale = 1 - newShare;
    const scaled = root.ratios.map((v) => v * scale);
    const nextChildren = before ? [newLeaf, ...root.children] : [...root.children, newLeaf];
    const nextRatios = before ? [newShare, ...scaled] : [...scaled, newShare];
    return {
      kind: "split",
      axis: root.axis,
      ratios: normalizeRatios(nextRatios),
      children: nextChildren,
    };
  }
  return before ? split(axis, [newLeaf, root]) : split(axis, [root, newLeaf]);
}

/**
 * Remove the leaf with id `targetId`. Collapses any split that ends up with
 * a single child into that child, recursively. Returns null if the tree
 * becomes empty.
 */
export function removeLeaf(root: LayoutNode | null, targetId: string): LayoutNode | null {
  if (!root) return null;
  if (isLeaf(root)) return root.id === targetId ? null : root;
  const visit = (node: LayoutNode): LayoutNode | null => {
    if (isLeaf(node)) return node.id === targetId ? null : node;
    const results: { child: LayoutNode | null; originalRatio: number }[] = node.children.map(
      (c, i) => ({ child: visit(c), originalRatio: node.ratios[i] }),
    );
    const kept = results.filter((r) => r.child !== null);
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0].child;
    return {
      kind: "split",
      axis: node.axis,
      ratios: normalizeRatios(kept.map((r) => r.originalRatio)),
      children: kept.map((r) => r.child as LayoutNode),
    };
  };
  const out = visit(root);
  return out ? compact(out) : null;
}

/**
 * Swap the ids of two leaves in-place (keeps layout unchanged, just exchanges
 * which pane content lives in which slot). Used for DnD center-drop swaps.
 */
export function swapLeaves(root: LayoutNode | null, a: string, b: string): LayoutNode | null {
  if (!root || a === b) return root;
  const visit = (node: LayoutNode): LayoutNode => {
    if (isLeaf(node)) {
      if (node.id === a) return { kind: "leaf", id: b };
      if (node.id === b) return { kind: "leaf", id: a };
      return node;
    }
    return { ...node, children: node.children.map(visit) };
  };
  return visit(root);
}

/**
 * Set the ratios on the split that is the ancestor of `childLeafId` along
 * the given axis. Called by divider drag: `childLeafId` is the leaf on one
 * side of the divider; `axis` disambiguates in case the leaf sits inside
 * nested splits on both axes.
 *
 * This form is rarely needed — divider drag passes a path instead. Kept for
 * completeness.
 */
export function setSplitRatios(root: LayoutNode, nodePath: number[], ratios: number[]): LayoutNode {
  if (nodePath.length === 0) {
    if (!isSplit(root)) return root;
    return { ...root, ratios: normalizeRatios(ratios) };
  }
  if (!isSplit(root)) return root;
  const [head, ...rest] = nodePath;
  const nextChildren = [...root.children];
  nextChildren[head] = setSplitRatios(root.children[head], rest, ratios);
  return { ...root, children: nextChildren };
}

/**
 * Find the path (sequence of child indices) from root to the leaf with id
 * `targetId`. Returns null if the leaf is not present. Path is empty when
 * the root itself is the target leaf.
 */
export function pathToLeaf(root: LayoutNode | null, targetId: string): number[] | null {
  if (!root) return null;
  if (isLeaf(root)) return root.id === targetId ? [] : null;
  for (let i = 0; i < root.children.length; i++) {
    const sub = pathToLeaf(root.children[i], targetId);
    if (sub) return [i, ...sub];
  }
  return null;
}

/**
 * Reset every split in the tree to even ratios. Leaves are unchanged; the
 * split topology (axes, child order) is preserved. Use this to "unskew" a
 * layout after drag sessions without losing the pane arrangement.
 */
export function equalizeRatios(root: LayoutNode): LayoutNode {
  if (isLeaf(root)) return root;
  return {
    kind: "split",
    axis: root.axis,
    ratios: evenRatios(root.children.length),
    children: root.children.map(equalizeRatios),
  };
}

/**
 * Build a balanced grid from a flat list of leaf ids.
 *
 * `priority` controls the column/row trade-off:
 *   - `"cols"` (default, legacy): `cols = ceil(sqrt(N))`, favours wider grids.
 *     N=5 → 3+2, N=7 → 3+3+1.
 *   - `"rows"`: `cols = floor(sqrt(N))`, favours taller grids with a single
 *     full-width tail row when N is not a perfect square. N=5 → 2+2+1,
 *     N=10 → 3+3+3+1.
 *
 * Produces:
 *   - null for N=0, a single leaf for N=1, a single row split for N=2.
 *   - `col` of `row` splits for N >= 3. A single-leaf final row is inserted
 *     as a leaf child of the outer col split (full-width bottom band).
 * Leaf ids stay in the order given — callers can pass `treeLeafIds(current)`
 * to preserve the left-to-right, top-to-bottom reading order.
 */
export function tileLeaves(
  ids: string[],
  opts: { priority?: "rows" | "cols" } = {},
): LayoutNode | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) return leaf(ids[0]);
  if (ids.length === 2) return split("row", [leaf(ids[0]), leaf(ids[1])]);
  const priority = opts.priority ?? "cols";
  const cols =
    priority === "rows"
      ? Math.max(1, Math.floor(Math.sqrt(ids.length)))
      : Math.ceil(Math.sqrt(ids.length));
  const rows = Math.ceil(ids.length / cols);
  const rowNodes: LayoutNode[] = [];
  for (let r = 0; r < rows; r++) {
    const rowIds = ids.slice(r * cols, (r + 1) * cols);
    if (rowIds.length === 0) continue;
    if (rowIds.length === 1) {
      rowNodes.push(leaf(rowIds[0]));
    } else {
      rowNodes.push(split("row", rowIds.map(leaf)));
    }
  }
  if (rowNodes.length === 1) return rowNodes[0];
  return split("col", rowNodes);
}

/**
 * Collapse degenerate structure produced by the mutators:
 *   - Splits with 1 child → replaced by that child.
 *   - Splits nested under a parent of the same axis → merged into the parent
 *     with proportionally combined ratios.
 */
export function compact(root: LayoutNode): LayoutNode {
  if (isLeaf(root)) return root;
  // Recurse first so inner collapses happen before the outer sees them.
  const compactedChildren = root.children.map(compact);
  // Collapse same-axis child splits into this node.
  const mergedChildren: LayoutNode[] = [];
  const mergedRatios: number[] = [];
  for (let i = 0; i < compactedChildren.length; i++) {
    const child = compactedChildren[i];
    const parentShare = root.ratios[i];
    if (isSplit(child) && child.axis === root.axis) {
      for (let j = 0; j < child.children.length; j++) {
        mergedChildren.push(child.children[j]);
        mergedRatios.push(parentShare * child.ratios[j]);
      }
    } else {
      mergedChildren.push(child);
      mergedRatios.push(parentShare);
    }
  }
  if (mergedChildren.length === 1) return mergedChildren[0];
  return {
    kind: "split",
    axis: root.axis,
    ratios: normalizeRatios(mergedRatios),
    children: mergedChildren,
  };
}

// ---- projection to/from flat rectangles -----------------------------------

export interface Rect {
  id: string;
  x: number; // 0..UNIT
  y: number; // 0..UNIT
  w: number;
  h: number;
}

/**
 * Project a tree into a flat list of pane rectangles, each covering a unit
 * square scaled by `unit` (e.g. 10000 for TOML persistence). Rectangles tile
 * perfectly with no gaps. Used for serialization into the existing flat-cell
 * schema.
 */
export function projectToRects(root: LayoutNode | null, unit = 10000): Rect[] {
  if (!root) return [];
  const out: Rect[] = [];
  const visit = (node: LayoutNode, x: number, y: number, w: number, h: number): void => {
    if (isLeaf(node)) {
      out.push({
        id: node.id,
        x: Math.round(x),
        y: Math.round(y),
        w: Math.max(1, Math.round(w)),
        h: Math.max(1, Math.round(h)),
      });
      return;
    }
    let offset = 0;
    for (let i = 0; i < node.children.length; i++) {
      const r = node.ratios[i];
      if (node.axis === "row") {
        const cw = w * r;
        visit(node.children[i], x + offset, y, cw, h);
        offset += cw;
      } else {
        const ch = h * r;
        visit(node.children[i], x, y + offset, w, ch);
        offset += ch;
      }
    }
  };
  visit(root, 0, 0, unit, unit);
  return out;
}

/**
 * Build a tree from a flat list of pane rectangles by recursively finding a
 * guillotine cut (horizontal or vertical line that partitions the rectangles
 * into two non-empty groups). Works whenever the rectangles came from a BSP
 * tree (which our editor guarantees). Falls back to a row-banding heuristic
 * if no cut exists — that handles edge cases but shouldn't trigger for
 * layouts this editor produced.
 */
export function buildFromRects(rects: Rect[], unit = 10000): LayoutNode | null {
  if (rects.length === 0) return null;
  if (rects.length === 1) return leaf(rects[0].id);
  const built = partition(rects, 0, 0, unit, unit);
  return built;
}

function partition(rects: Rect[], x: number, y: number, w: number, h: number): LayoutNode {
  if (rects.length === 1) return leaf(rects[0].id);
  // Try vertical cuts (split axis = "row"): find an x between rectangles.
  const xs = [...new Set(rects.map((r) => r.x))].filter((v) => v > x).sort((a, b) => a - b);
  for (const cut of xs) {
    const left = rects.filter((r) => r.x + r.w <= cut);
    const right = rects.filter((r) => r.x >= cut);
    if (left.length > 0 && right.length > 0 && left.length + right.length === rects.length) {
      const lw = cut - x;
      const rw = x + w - cut;
      const child1 = partition(left, x, y, lw, h);
      const child2 = partition(right, cut, y, rw, h);
      return {
        kind: "split",
        axis: "row",
        ratios: normalizeRatios([lw / w, rw / w]),
        children: [child1, child2],
      };
    }
  }
  // Try horizontal cuts (split axis = "col"): find a y between rectangles.
  const ys = [...new Set(rects.map((r) => r.y))].filter((v) => v > y).sort((a, b) => a - b);
  for (const cut of ys) {
    const top = rects.filter((r) => r.y + r.h <= cut);
    const bottom = rects.filter((r) => r.y >= cut);
    if (top.length > 0 && bottom.length > 0 && top.length + bottom.length === rects.length) {
      const th = cut - y;
      const bh = y + h - cut;
      const child1 = partition(top, x, y, w, th);
      const child2 = partition(bottom, x, cut, w, bh);
      return {
        kind: "split",
        axis: "col",
        ratios: normalizeRatios([th / h, bh / h]),
        children: [child1, child2],
      };
    }
  }
  // No clean guillotine cut — fall back to row-banding: group rects with
  // the same top edge, row-split each band, then col-split the bands.
  const byY = new Map<number, Rect[]>();
  for (const r of rects) {
    const arr = byY.get(r.y) ?? [];
    arr.push(r);
    byY.set(r.y, arr);
  }
  const bands = [...byY.entries()].sort(([a], [b]) => a - b);
  const bandNodes: LayoutNode[] = [];
  const bandRatios: number[] = [];
  for (const [bandY, bandRects] of bands) {
    const bandH = Math.max(...bandRects.map((r) => r.h));
    bandRects.sort((a, b) => a.x - b.x);
    if (bandRects.length === 1) {
      bandNodes.push(leaf(bandRects[0].id));
    } else {
      bandNodes.push({
        kind: "split",
        axis: "row",
        ratios: normalizeRatios(bandRects.map((r) => r.w / w)),
        children: bandRects.map((r) => leaf(r.id)),
      });
    }
    bandRatios.push(bandH / h);
    // reference bandY to quiet unused-var lint in some configs
    void bandY;
  }
  if (bandNodes.length === 1) return bandNodes[0];
  return {
    kind: "split",
    axis: "col",
    ratios: normalizeRatios(bandRatios),
    children: bandNodes,
  };
}
