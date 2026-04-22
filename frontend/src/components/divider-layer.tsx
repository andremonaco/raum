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
 *   we add to `ratios[i]` and subtract from `ratios[i+1]`.
 */

import { Component, For, Show, createMemo } from "solid-js";

import { MIN_RATIO, type LayoutNode } from "../lib/layoutTree";
import { runtimeLayoutStore, setSplitRatios } from "../stores/runtimeLayoutStore";

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
  /** Path from root to the split node this divider belongs to. */
  path: number[];
  /** Index of the sibling BEFORE this divider. */
  index: number;
  /** Along-axis extent of the parent split, in root-% (used to convert
   *  pointer pixel deltas into ratio deltas during drag). */
  parentAlongPct: number;
}

export const DividerLayer: Component<{ tree: LayoutNode | null }> = (props) => {
  const specs = createMemo<DividerSpec[]>(() => {
    const tree = props.tree;
    if (!tree) return [];
    const out: DividerSpec[] = [];
    walk(tree, [], { left: 0, top: 0, width: 100, height: 100 }, out);
    return out;
  });

  return (
    <Show when={specs().length > 0}>
      <div class="pointer-events-none absolute inset-0 z-10">
        <For each={specs()}>{(spec) => <Divider spec={spec} />}</For>
      </div>
    </Show>
  );
};

function walk(node: LayoutNode, path: number[], rect: PctRect, out: DividerSpec[]): void {
  if (node.kind === "leaf") return;

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
      id: `${path.join(".")}:${i}`,
      axis: node.axis,
      path,
      index: i,
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
    walk(node.children[i], [...path, i], childRects[i], out);
  }
}

// ---- Divider --------------------------------------------------------------

const Divider: Component<{ spec: DividerSpec }> = (props) => {
  const isRow = () => props.spec.axis === "row";

  // Drag state lives entirely inside the onPointerDown closure, and the
  // move/up listeners attach to `document` — NOT to the divider element.
  //
  // Why: every call to setSplitRatios creates a new tree, which replaces
  // the `specs()` memo's array with fresh DividerSpec objects. <For>
  // keys by reference, so every ratio update unmounts this component
  // and mounts a new one at the same position. Element-bound pointer
  // listeners (and setPointerCapture) die with the old DOM. Document
  // listeners survive any number of remounts, and path/index are
  // snapshotted at pointerdown so the drag math remains correct even
  // if `props.spec` is attached to a remounted instance. This mirrors
  // the pane-header drag pattern in terminal-grid.tsx.
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
    const startRatios = splitRatiosAtPath(props.spec.path);
    if (startRatios.length === 0) return;

    // Snapshot path + index so a mid-drag remount (new DividerSpec at
    // the same array position) can't change which split we're editing.
    const pathSnapshot = [...props.spec.path];
    const idxSnapshot = props.spec.index;

    grid.classList.add("is-resizing");
    document.body.style.cursor = rowAxis ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    let rafId: number | null = null;
    let pendingRatios: number[] | null = null;

    const scheduleApply = (): void => {
      if (rafId !== null || pendingRatios === null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (pendingRatios !== null) {
          setSplitRatios(pathSnapshot, pendingRatios);
          pendingRatios = null;
        }
      });
    };

    const onMove = (ev: PointerEvent): void => {
      const now = rowAxis ? ev.clientX : ev.clientY;
      const deltaFrac = (now - startClient) / parentAlongPx;
      const nextRatios = [...startRatios];
      nextRatios[idxSnapshot] += deltaFrac;
      nextRatios[idxSnapshot + 1] -= deltaFrac;
      // Clamp to MIN_RATIO on each side; store's normalize() re-enforces
      // but early clamp keeps the live render stable.
      if (nextRatios[idxSnapshot] < MIN_RATIO) {
        const adj = MIN_RATIO - nextRatios[idxSnapshot];
        nextRatios[idxSnapshot] = MIN_RATIO;
        nextRatios[idxSnapshot + 1] -= adj;
      }
      if (nextRatios[idxSnapshot + 1] < MIN_RATIO) {
        const adj = MIN_RATIO - nextRatios[idxSnapshot + 1];
        nextRatios[idxSnapshot + 1] = MIN_RATIO;
        nextRatios[idxSnapshot] -= adj;
      }
      pendingRatios = nextRatios;
      scheduleApply();
    };

    const onUp = (): void => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      grid.classList.remove("is-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (pendingRatios) {
        setSplitRatios(pathSnapshot, pendingRatios);
        pendingRatios = null;
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
    const curr = splitRatiosAtPath(props.spec.path);
    if (curr.length === 0) return;
    const next = [...curr];
    const i = props.spec.index;
    const avg = (next[i] + next[i + 1]) / 2;
    next[i] = avg;
    next[i + 1] = avg;
    setSplitRatios(props.spec.path, next);
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

function splitRatiosAtPath(path: number[]): number[] {
  let node: LayoutNode | null = runtimeLayoutStore.tree;
  for (const idx of path) {
    if (!node || node.kind !== "split") return [];
    node = node.children[idx];
  }
  if (!node || node.kind !== "split") return [];
  return [...node.ratios];
}
