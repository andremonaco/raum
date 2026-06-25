/**
 * Layout presets — content-agnostic BSP tree-shape templates.
 *
 * A preset rearranges the *existing* panes into a canonical shape (a 2×2 grid,
 * a main+sidebar, three columns) without spawning or killing any session: pane
 * content (tabs, session ids, project bindings) rides along untouched; only the
 * geometry changes. We do this by recomputing each in-tree pane's rect on the
 * LAYOUT_UNIT grid and handing the full cell list back to `setRuntimeLayout`,
 * which rebuilds the tree from those rects. Minimized (off-tree) panes are
 * passed through verbatim so a preset never resurrects or drops a docked pane.
 *
 * Presets degrade gracefully when there are fewer panes than the shape's
 * nominal slots: extra slots are simply not produced (e.g. "three columns" with
 * two panes yields two columns), and the empty / single-pane cases are no-ops
 * that still preserve the current layout.
 *
 * All geometry math is pure and deterministic; the only store touch-point is
 * `setRuntimeLayout`, so the same persistence + tree-rebuild path the launch
 * rehydration uses also covers presets.
 */

import {
  LAYOUT_UNIT,
  minimizedPaneIds,
  pushLayoutHistory,
  runtimeLayoutStore,
  setRuntimeLayout,
  type RuntimeCell,
} from "../stores/runtimeLayoutStore";

export interface LayoutPreset {
  id: string;
  label: string;
}

/** The presets surfaced in the UI (command palette / layout menu). Order is the
 *  display order. Keep ids stable — they're referenced by keymap/palette. */
export const LAYOUT_PRESETS: LayoutPreset[] = [
  { id: "grid-2x2", label: "2×2 grid" },
  { id: "main-right-sidebar", label: "Main + right sidebar" },
  { id: "three-columns", label: "Three columns" },
];

/** A pane's full content (everything `setRuntimeLayout` needs) plus the freshly
 *  assigned rect on the LAYOUT_UNIT grid. */
type PlacedCell = RuntimeCell;

/** Snapshot the current in-tree cells in their stable in-order traversal order.
 *  `runtimeLayoutStore.cells` is already projection-ordered, so this preserves
 *  the user's left-to-right / top-to-bottom reading order across the reshape. */
function inTreeCells(): RuntimeCell[] {
  return runtimeLayoutStore.cells.map((c) => ({ ...c }));
}

/** Collect minimized (off-tree) panes as cells flagged for off-tree rehydrate,
 *  so a preset preserves the dock exactly. */
function minimizedCells(): Array<RuntimeCell & { minimized: true }> {
  const out: Array<RuntimeCell & { minimized: true }> = [];
  for (const id of minimizedPaneIds()) {
    const pane = runtimeLayoutStore.panes[id];
    if (!pane) continue;
    out.push({ ...pane, x: 0, y: 0, w: 0, h: 0, minimized: true });
  }
  return out;
}

/** Commit a reshaped set of in-tree cells. Appends untouched minimized panes
 *  and routes through `setRuntimeLayout`, which rebuilds the tree from the
 *  supplied rects and persists. */
function commit(placed: PlacedCell[]): void {
  setRuntimeLayout([...placed, ...minimizedCells()]);
}

/** Lay `cells` out as evenly-sized columns spanning full height. */
function columns(cells: RuntimeCell[]): PlacedCell[] {
  const n = cells.length;
  const w = Math.round(LAYOUT_UNIT / n);
  return cells.map((c, i) => ({
    ...c,
    x: i * w,
    y: 0,
    // Last column absorbs rounding remainder so the row fills exactly.
    w: i === n - 1 ? LAYOUT_UNIT - i * w : w,
    h: LAYOUT_UNIT,
  }));
}

/** Lay `cells` out as a near-square grid (cols = ceil(sqrt(n))), row-major.
 *  Rows that come up short (the final row when n isn't a perfect rectangle)
 *  stretch their cells to fill the row width. */
function grid(cells: RuntimeCell[]): PlacedCell[] {
  const n = cells.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const rowH = Math.round(LAYOUT_UNIT / rows);
  const out: PlacedCell[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    // How many cells share this row (last row may be partial).
    const cellsInRow = Math.min(cols, n - row * cols);
    const colW = Math.round(LAYOUT_UNIT / cellsInRow);
    const isLastCol = col === cellsInRow - 1;
    const isLastRow = row === rows - 1;
    out.push({
      ...cells[i],
      x: col * colW,
      y: row * rowH,
      w: isLastCol ? LAYOUT_UNIT - col * colW : colW,
      h: isLastRow ? LAYOUT_UNIT - row * rowH : rowH,
    });
  }
  return out;
}

/** Main pane on the left (≈65% width), the remaining panes stacked as a right
 *  sidebar column. With a single pane this is just full-screen; the main pane
 *  is always the first in traversal order. */
function mainRightSidebar(cells: RuntimeCell[]): PlacedCell[] {
  const n = cells.length;
  if (n === 1) {
    return [{ ...cells[0], x: 0, y: 0, w: LAYOUT_UNIT, h: LAYOUT_UNIT }];
  }
  const mainW = Math.round(LAYOUT_UNIT * 0.65);
  const sideX = mainW;
  const sideW = LAYOUT_UNIT - mainW;
  const sideCount = n - 1;
  const sideH = Math.round(LAYOUT_UNIT / sideCount);
  const out: PlacedCell[] = [{ ...cells[0], x: 0, y: 0, w: mainW, h: LAYOUT_UNIT }];
  for (let i = 1; i < n; i++) {
    const sideIdx = i - 1;
    const isLast = sideIdx === sideCount - 1;
    out.push({
      ...cells[i],
      x: sideX,
      y: sideIdx * sideH,
      w: sideW,
      h: isLast ? LAYOUT_UNIT - sideIdx * sideH : sideH,
    });
  }
  return out;
}

/**
 * Apply a preset by id. No-op (preserves the current layout) for unknown ids
 * or when there are 0/1 in-tree panes — there's nothing meaningful to reshape.
 */
export function applyLayoutPreset(id: string): void {
  const cells = inTreeCells();
  // 0 or 1 panes: every preset collapses to "the current layout", so don't
  // churn the store (and never blow away an empty grid).
  if (cells.length <= 1) return;

  let placed: PlacedCell[];
  switch (id) {
    case "grid-2x2":
      placed = grid(cells);
      break;
    case "three-columns":
      // Cap at three columns; any extra panes wrap into the grid fallback so we
      // never produce slivers narrower than a third of the viewport.
      placed = cells.length <= 3 ? columns(cells) : grid(cells);
      break;
    case "main-right-sidebar":
      placed = mainRightSidebar(cells);
      break;
    default:
      return; // unknown preset id — leave the layout untouched
  }
  // Snapshot before the reshape so Cmd+Z restores the prior arrangement — a
  // mistaken preset is exactly when users reach for undo.
  pushLayoutHistory();
  commit(placed);
}
