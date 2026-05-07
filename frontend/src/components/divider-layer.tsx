/**
 * Divider overlay for the BSP split-tree.
 *
 * Panes are rendered in a flat `<For each={cells}>` at `position: absolute`
 * (see `<TerminalGrid>`). That layer is agnostic to tree shape — only
 * `top/left/width/height` change on layout mutations, so xterm instances
 * stay mounted. This overlay is the *only* place that reacts to tree-shape
 * changes: it walks the tree and emits one draggable divider between every
 * pair of adjacent siblings at every split.
 *
 * All coordinates are percentages of the grid root. The browser keeps
 * everything aligned with the pane layer on window resize — no JS required.
 *
 * Divider resize math:
 *   Each divider knows its parent split's along-axis extent in root-%
 *   (`parentAlongPct`). At pointerdown we capture the grid's pixel size,
 *   so `parentAlongPx = gridPx * parentAlongPct / 100`. A pointer delta of
 *   `dx` pixels then maps to a ratio delta of `dx / parentAlongPx`, which
 *   the store applies to whichever runtime split actually owns the
 *   visible boundary.
 *
 * Boundary identity:
 *   Dividers are computed against the *pruned* tree (active project +
 *   active worktree scope only). The runtime tree may have *hidden*
 *   siblings between two visible neighbours — pruning + `compact()` can
 *   reshape it freely. So instead of mailing a tree-path back to the
 *   store (which would land on the wrong split or a leaf), each divider
 *   carries the visible leaf ids on each side of the boundary. The
 *   store walks the runtime tree to find the lowest split that owns
 *   those two groups in different children, and adjusts THAT split's
 *   ratios. This is what makes nested-pruning grids resize reliably
 *   instead of leaving some handles silently dead.
 */

import { Component, For, Show, createMemo } from "solid-js";

import { MIN_RATIO, leafIds as treeLeafIds, type LayoutNode } from "../lib/layoutTree";
import { setSplitRatiosByBoundary } from "../stores/runtimeLayoutStore";

interface PctRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DividerSpec {
  id: string;
  rect: PctRect;
  axis: "row" | "col";
  /** Index of the sibling BEFORE this divider, within the *pruned* split.
   *  Combined with the snapshot of pruned ratios at pointerdown, this is
   *  what the drag math feeds back through `setSplitRatiosByBoundary`. */
  index: number;
  /** Pruned-tree ratios for the siblings this divider sits between. The
   *  drag turns these into the new pair `(left, right)` while keeping
   *  every other pruned sibling untouched. */
  prunedRatios: readonly number[];
  /** Visible leaf ids on each side of the boundary. The store walks the
   *  *runtime* tree to find the LCA that owns these two groups, which
   *  keeps drags correct even when pruning / `compact` reshape the
   *  visible tree away from the runtime one. */
  leftLeafIds: readonly string[];
  rightLeafIds: readonly string[];
  /** Along-axis extent of the parent split, in root-% (used to convert
   *  pointer pixel deltas into ratio deltas during drag). */
  parentAlongPct: number;
}

export const DividerLayer: Component<{ tree: LayoutNode | null }> = (props) => {
  const specs = createMemo<DividerSpec[]>(() => {
    const tree = props.tree;
    if (!tree) return [];
    const out: DividerSpec[] = [];
    walk(tree, { left: 0, top: 0, width: 100, height: 100 }, out);
    return out;
  });

  // All currently-visible leaves (the pruned tree's leaves). Each Divider
  // hands this to the store so the LCA-based ratio rewrite can decide
  // which of the LCA's runtime children are visible (vs. hidden by the
  // active project / worktree scope).
  const visibleLeafIds = createMemo<readonly string[]>(() =>
    props.tree ? treeLeafIds(props.tree) : [],
  );

  return (
    <Show when={specs().length > 0}>
      <div class="pointer-events-none absolute inset-0 z-10">
        <For each={specs()}>
          {(spec) => <Divider spec={spec} visibleLeafIds={visibleLeafIds()} />}
        </For>
      </div>
    </Show>
  );
};

function walk(node: LayoutNode, rect: PctRect, out: DividerSpec[]): void {
  if (node.kind === "leaf") return;

  // Cache leaf ids per child once — used both to ferry the boundary's
  // "left side" / "right side" leaves to the store and to render a
  // stable id so `<For>` can preserve divider DOM across ratio drags.
  const childLeafIds: string[][] = node.children.map((c) => treeLeafIds(c));

  // Compute each child's rect so we can position dividers at the boundary
  // between adjacent siblings and recurse into children.
  const childRects: PctRect[] = [];
  let offset = 0;
  for (let i = 0; i < node.children.length; i++) {
    const r = node.ratios[i];
    if (node.axis === "row") {
      const cw = rect.width * r;
      childRects.push({ left: rect.left + offset, top: rect.top, width: cw, height: rect.height });
      offset += cw;
    } else {
      const ch = rect.height * r;
      childRects.push({ left: rect.left, top: rect.top + offset, width: rect.width, height: ch });
      offset += ch;
    }
  }

  const parentAlongPct = node.axis === "row" ? rect.width : rect.height;

  for (let i = 0; i < node.children.length - 1; i++) {
    const left = childRects[i];
    const spec: DividerSpec = {
      // Identity follows the leaves on each side, not the path — the
      // pruned tree's path can shift between renders but the
      // boundary-by-leaves stays semantically the same divider.
      id: `${node.axis}:${childLeafIds[i].join(",")}|${childLeafIds[i + 1].join(",")}`,
      axis: node.axis,
      index: i,
      prunedRatios: node.ratios,
      leftLeafIds: childLeafIds[i],
      rightLeafIds: childLeafIds[i + 1],
      parentAlongPct,
      rect:
        node.axis === "row"
          ? {
              left: left.left + left.width,
              top: rect.top,
              width: 0,
              height: rect.height,
            }
          : {
              left: rect.left,
              top: left.top + left.height,
              width: rect.width,
              height: 0,
            },
    };
    out.push(spec);
  }

  for (let i = 0; i < node.children.length; i++) {
    walk(node.children[i], childRects[i], out);
  }
}

// ---- Divider --------------------------------------------------------------

const Divider: Component<{ spec: DividerSpec; visibleLeafIds: readonly string[] }> = (props) => {
  const isRow = () => props.spec.axis === "row";

  // Drag state lives entirely inside the onPointerDown closure, and the
  // move/up listeners attach to `document` — NOT to the divider element.
  //
  // Why: every commit to the runtime tree rebuilds the cells projection
  // and the pruned divider list, so `<For>` may unmount and remount this
  // component mid-drag. Element-bound listeners (and setPointerCapture)
  // would die with the old DOM. Document listeners survive any number of
  // remounts, and the boundary identity (left/right leaf ids) is
  // snapshotted at pointerdown so the drag math remains correct even
  // if `props.spec` is attached to a remounted instance.
  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const grid = el.closest<HTMLElement>('[data-dnd-root="true"]');
    if (!grid) return;
    const gridRect = grid.getBoundingClientRect();
    const rowAxis = isRow();
    const parentAlongPx =
      ((rowAxis ? gridRect.width : gridRect.height) * props.spec.parentAlongPct) / 100;
    if (parentAlongPx <= 0) return;
    const startClient = rowAxis ? e.clientX : e.clientY;

    // Snapshot every input the boundary mutator needs so a mid-drag
    // remount (fresh DividerSpec at the same array position) can't
    // shift which boundary we're editing.
    const axis = props.spec.axis;
    const idx = props.spec.index;
    const startRatios = [...props.spec.prunedRatios];
    const leftLeafIds = [...props.spec.leftLeafIds];
    const rightLeafIds = [...props.spec.rightLeafIds];
    const visibleLeafIds = [...props.visibleLeafIds];

    grid.classList.add("is-resizing");
    document.body.style.cursor = rowAxis ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    let rafId: number | null = null;
    let pendingPair: { left: number; right: number } | null = null;

    const scheduleApply = (): void => {
      if (rafId !== null || pendingPair === null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (pendingPair !== null) {
          setSplitRatiosByBoundary({
            axis,
            leftLeafIds,
            rightLeafIds,
            visibleLeafIds,
            prunedLeftRatio: pendingPair.left,
            prunedRightRatio: pendingPair.right,
          });
          pendingPair = null;
        }
      });
    };

    const onMove = (ev: PointerEvent): void => {
      const now = rowAxis ? ev.clientX : ev.clientY;
      const deltaFrac = (now - startClient) / parentAlongPx;
      let l = startRatios[idx] + deltaFrac;
      let r = startRatios[idx + 1] - deltaFrac;
      // Clamp to MIN_RATIO on each side; store's normalize re-enforces
      // but early clamp keeps the live render stable.
      if (l < MIN_RATIO) {
        const adj = MIN_RATIO - l;
        l = MIN_RATIO;
        r -= adj;
      }
      if (r < MIN_RATIO) {
        const adj = MIN_RATIO - r;
        r = MIN_RATIO;
        l -= adj;
      }
      pendingPair = { left: l, right: r };
      scheduleApply();
    };

    const onUp = (): void => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      grid.classList.remove("is-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (pendingPair) {
        setSplitRatiosByBoundary({
          axis,
          leftLeafIds,
          rightLeafIds,
          visibleLeafIds,
          prunedLeftRatio: pendingPair.left,
          prunedRightRatio: pendingPair.right,
        });
        pendingPair = null;
      }
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }

  function onDoubleClick(e: MouseEvent): void {
    e.stopPropagation();
    const ratios = props.spec.prunedRatios;
    const i = props.spec.index;
    const avg = (ratios[i] + ratios[i + 1]) / 2;
    setSplitRatiosByBoundary({
      axis: props.spec.axis,
      leftLeafIds: [...props.spec.leftLeafIds],
      rightLeafIds: [...props.spec.rightLeafIds],
      visibleLeafIds: [...props.visibleLeafIds],
      prunedLeftRatio: avg,
      prunedRightRatio: avg,
    });
  }

  return (
    <div
      class="pane-divider pointer-events-auto absolute group"
      classList={{
        "cursor-col-resize": isRow(),
        "cursor-row-resize": !isRow(),
      }}
      style={
        // The hit target is wider/taller than the visible line (6 px total)
        // so the user can grab it easily at any DPI.
        isRow()
          ? {
              left: `calc(${props.spec.rect.left}% - 3px)`,
              top: `${props.spec.rect.top}%`,
              width: "6px",
              height: `${props.spec.rect.height}%`,
              "touch-action": "none",
            }
          : {
              left: `${props.spec.rect.left}%`,
              top: `calc(${props.spec.rect.top}% - 3px)`,
              width: `${props.spec.rect.width}%`,
              height: "6px",
              "touch-action": "none",
            }
      }
      onPointerDown={onPointerDown}
      onDblClick={onDoubleClick}
    />
  );
};
