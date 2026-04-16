/**
 * §10.1 — thin Solid adapter around `gridstack`.
 *
 * Gridstack is framework-agnostic imperative DOM code; this adapter keeps the
 * imperative surface in one file so the Solid components stay declarative:
 *
 *   - `initGrid(host, opts)` — construct the `GridStack` instance on the host
 *     `<div class="grid-stack">` and return a handle.
 *   - `reconcile(grid, cells)` — diff the running grid against a target list
 *     of `{ id, x, y, w, h }` cells and `addWidget` / `update` / `removeWidget`
 *     accordingly. Cell content is rendered by Solid *outside* gridstack (we
 *     pass empty widgets whose HTML host is then handed to a Solid `<For>`
 *     portal target). This keeps xterm DOM ownership on the Solid side.
 *   - `onChange(grid, handler)` — subscribe to the coalesced `change` event.
 *     The handler receives the full snapshot of `{ id, x, y, w, h }` cells in
 *     grid order, suitable for feeding back into `runtimeLayoutStore`.
 *   - `destroyGrid(grid)` — tear down event listeners + release DOM.
 *
 * The adapter is deliberately tolerant of JSDOM: `initGrid` returns `null` if
 * `GridStack.init` throws (which it can in a test environment missing layout
 * primitives). Callers must null-check.
 */

import {
  GridStack,
  type GridItemHTMLElement,
  type GridStackNode,
  type GridStackOptions,
} from "gridstack";
import "gridstack/dist/gridstack.min.css";

/** Minimal geometry we care about — matches the Solid store shape. */
export interface AdapterCell {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GridHandle {
  grid: GridStack;
  /** Detach every subscribed handler + release references. */
  destroy: () => void;
}

/** Fixed row count — the grid is always a 12×12 tiling of the available viewport. */
const GRID_ROWS = 12;

/** Sensible defaults for raum's terminal grid. */
const DEFAULT_OPTS: GridStackOptions = {
  column: 12,
  // Lock the grid to exactly 12 rows. Without this, gridstack grows vertically
  // to fit any cell whose `y + h` exceeds the current row count — which is how
  // we ended up overflowing the viewport when a 12-row-tall cell was dropped
  // in at the default ~60 px cellHeight.
  row: GRID_ROWS,
  // cellHeight is computed dynamically from the container height in initGrid.
  // Margin doubles as the visible gutter between window-like panes, so it needs
  // enough breathing room for each cell's rounded corners + ambient shadow.
  margin: 6,
  animate: true,
  float: false,
  // Don't auto-grow cells to fit their content — we drive the size from the
  // layout math, not from inside xterm.
  sizeToContent: false,
  // Restrict drag to the pane header so xterm body receives mousedown freely.
  draggable: { handle: ".pane-drag-handle" },
  // Keep our own widget DOM; do not let gridstack inject `<div class="grid-stack-item-content">`.
  // (Solid renders the content container directly.)
  alwaysShowResizeHandle: false,
};

/**
 * Initialize a `GridStack` on the host element. Safe to call multiple times
 * on the same host — gridstack returns the existing instance on re-init.
 *
 * cellHeight is computed from the host's current clientHeight so the 12-row
 * grid exactly fills the viewport. A ResizeObserver keeps it in sync when the
 * window is resized (e.g. TopRow height changes or window resize).
 *
 * A rAF recompute covers the case where the host has `clientHeight === 0` at
 * init time (flex parent not yet laid out) — without it, gridstack would stay
 * at the minimum 20 px cellHeight until the ResizeObserver tick fired, which
 * on some browsers is late enough to flash a taller-than-viewport grid.
 */
export function initGrid(
  host: HTMLElement,
  overrides: Partial<GridStackOptions> = {},
): GridHandle | null {
  const measure = (): number => {
    const h = host.clientHeight;
    if (h <= 0) return 0; // signal "unknown" so the caller can skip the update
    return Math.max(20, Math.floor(h / GRID_ROWS));
  };

  try {
    const initial = measure();
    const grid = GridStack.init(
      {
        ...DEFAULT_OPTS,
        // Fall back to 20 px only until the first real measurement lands.
        cellHeight: initial > 0 ? initial : 20,
        ...overrides,
      },
      host,
    );

    const applyIfChanged = (): void => {
      const next = measure();
      if (next <= 0) return;
      try {
        grid.cellHeight(next);
      } catch {
        /* best-effort */
      }
    };

    // Catch the "host was 0×0 at init because flex parent hadn't laid out"
    // case. A single rAF is enough — the browser has reflowed by then.
    let raf: ReturnType<typeof requestAnimationFrame> | null = null;
    if (typeof requestAnimationFrame !== "undefined") {
      raf = requestAnimationFrame(() => {
        raf = null;
        applyIfChanged();
      });
    }

    // Keep cellHeight in sync with container height so the grid never
    // overflows the viewport vertically (window resize, TopRow height change,
    // sidebar collapse, etc.).
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => applyIfChanged());
      ro.observe(host);
    }

    return {
      grid,
      destroy: () => {
        if (raf !== null && typeof cancelAnimationFrame !== "undefined") {
          cancelAnimationFrame(raf);
          raf = null;
        }
        ro?.disconnect();
        try {
          grid.destroy(false);
        } catch {
          /* JSDOM may throw; swallow to keep tests green. */
        }
      },
    };
  } catch (err) {
    console.warn("[gridstackAdapter] init failed, falling back to static DOM", err);
    return null;
  }
}

/**
 * Subscribe to coalesced change events. `handler` receives the full set of
 * cells (id + geometry) present in the grid *after* the user interaction
 * settles. Returns an unsubscribe function.
 */
export function onChange(handle: GridHandle, handler: (cells: AdapterCell[]) => void): () => void {
  const listener = (_event: Event, nodes: GridStackNode[]): void => {
    const snapshot: AdapterCell[] = nodes.map((n) => ({
      id: (n.id ?? n.el?.getAttribute("gs-id") ?? "") as string,
      x: n.x ?? 0,
      y: n.y ?? 0,
      w: n.w ?? 1,
      h: n.h ?? 1,
    }));
    handler(snapshot);
  };
  handle.grid.on("change", listener);
  return () => {
    try {
      handle.grid.off("change");
    } catch {
      /* ignore */
    }
  };
}

/**
 * Subscribe to `resizestop` so callers can flush a final `terminal_resize` to
 * tmux after the user stops dragging the corner handle (§10.8). Handler fires
 * with the single node that finished resizing.
 */
export function onResizeStop(handle: GridHandle, handler: (cell: AdapterCell) => void): () => void {
  const listener = (_event: Event, el: GridItemHTMLElement): void => {
    const node = el.gridstackNode;
    if (!node) return;
    handler({
      id: (node.id ?? "") as string,
      x: node.x ?? 0,
      y: node.y ?? 0,
      w: node.w ?? 1,
      h: node.h ?? 1,
    });
  };
  handle.grid.on("resizestop", listener);
  return () => {
    try {
      handle.grid.off("resizestop");
    } catch {
      /* ignore */
    }
  };
}

/** Snapshot the grid into `AdapterCell[]`; used when persisting presets. */
export function snapshotGrid(handle: GridHandle): AdapterCell[] {
  const saved = handle.grid.save(false);
  if (!Array.isArray(saved)) return [];
  return saved.map((n) => ({
    id: (n.id ?? "") as string,
    x: n.x ?? 0,
    y: n.y ?? 0,
    w: n.w ?? 1,
    h: n.h ?? 1,
  }));
}
