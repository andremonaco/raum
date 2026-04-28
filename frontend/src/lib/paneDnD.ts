/**
 * Pointer-driven drag & drop for panes.
 *
 * We intentionally avoid the HTML5 DnD API: it fights xterm.js focus, doesn't
 * give us pixel-accurate ghost previews, and its drop targets can't be
 * dynamically sliced into 5 zones without hacks. Plain pointer events are
 * simpler and more precise — the same pattern VSCode uses for editor groups.
 *
 * Lifecycle:
 *   1. `beginDrag(sourceId, pointerEvent)` is called when the user
 *      pointerdowns on a pane header (`.pane-drag-handle`). We install a
 *      singleton document-level pointermove/pointerup handler and show the
 *      ghost preview.
 *   2. On pointermove, we hit-test `[data-dnd-target-pane-id]` elements to
 *      identify the hovered target, then compute the 5-zone (top/right/
 *      bottom/left/center) from the pointer position relative to the
 *      target's bounding rect. The current drop-target is written to
 *      `dragStateSignal` so the overlay component re-renders.
 *   3. On pointerup, we call the `onDrop` callback (provided at begin-time)
 *      with the final { sourceId, targetId, zone } and reset state.
 *
 * Root-edge drops: if the pointer is close to the outer edge of the grid
 * container (`[data-dnd-root="true"]`), we return `targetId: ROOT_TARGET`
 * with a directional zone; the caller maps that to `movePaneToRootEdge`.
 */

import { createSignal } from "solid-js";

export const ROOT_TARGET = "__root__" as const;
export type RootTargetSentinel = typeof ROOT_TARGET;

export type DropZone = "top" | "right" | "bottom" | "left" | "center";

export interface DragState {
  sourceId: string;
  /** Harness kind of the source pane — used to pick the ghost icon. */
  sourceKind: string;
  /** Label shown inside the snap/swap chip ("Claude Code", "Shell", …). */
  sourceLabel: string;
  /** Pointer position in viewport coords at pointerdown. Used by LeafFrame
   *  to compute its drag-follows-cursor transform `translate(dx, dy)`. */
  startPointerX: number;
  startPointerY: number;
  /** Current pointer position in viewport coords. */
  pointerX: number;
  pointerY: number;
  /** Current hover target; either a pane id, the root sentinel, or null
   *  when the pointer is outside every drop-capable region. */
  targetId: string | RootTargetSentinel | null;
  zone: DropZone | null;
  /** Pixel rect of the hovered target so the overlay can position itself
   *  without re-querying the DOM. Null when no target. */
  targetRect: DOMRect | null;
}

const [dragState, setDragState] = createSignal<DragState | null>(null);
export { dragState };

/**
 * Test-only hook for driving `dragState` directly. Production code MUST go
 * through `beginDrag` / `cancelDrag`; this is purely for unit tests that
 * need to assert downstream consumers (e.g. `terminalSurfaces` projection)
 * react correctly to drag-state transitions without simulating a full
 * pointer-event sequence in jsdom.
 */
export function __setDragStateForTests(next: DragState | null): void {
  setDragState(next);
}

// Zone-boundary hysteresis. The pointer has to cross the *enter* threshold
// to step into a zone, then must travel back past the wider *exit* threshold
// before the classifier will let go of it. Without this band, sub-pixel
// jitter at exactly the boundary flips the zone on every pointermove —
// pointermove fires 120 Hz on trackpads, so the preview tree ping-pongs
// faster than the 160ms CSS transition can settle → visible flicker.
//
// Values tuned so the enter band is slightly narrower than the outer 20%
// (so reaching an edge feels deliberate) and the exit band is 2× wider
// (so sitting near the boundary feels stable, not flickery).
const EDGE_ENTER_FRACTION = 0.15;
const EDGE_EXIT_FRACTION = 0.3;

// Same pattern for root-edge magnets, in pixels. Approach within 72px to
// trigger the snap; must move 120px away before the classifier hands control
// back to pane-level hit-testing. Prevents root↔pane flipping at the seam.
const ROOT_ENTER_MARGIN = 72;
const ROOT_EXIT_MARGIN = 120;

/**
 * Minimal cell shape used for hit-testing. Structurally compatible with
 * the store's `RuntimeCell` so callers can pass cells directly without
 * mapping. Coordinates are in a virtual grid (x/y/w/h 0..layoutUnit)
 * matching how raum persists layouts — conversion to pixels happens
 * inside `cellToRect`.
 */
export interface HitTestCell {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface BeginDragOptions {
  sourceId: string;
  /** Harness kind of the source pane — forwarded to the ghost icon. */
  sourceKind: string;
  /** Label shown inside the ghost preview. */
  sourceLabel: string;
  event: PointerEvent;
  /** The grid host element. Used to detect root-edge drops and to scope
   *  pointer capture. */
  rootEl: HTMLElement;
  /**
   * Pane cells (in layout-unit coords) used for hit-testing throughout
   * the drag. **Snapshot semantics**: the caller passes the current
   * `runtimeLayoutStore.cells` and we rely on the real tree staying
   * unchanged until pointerup (preview tree lives only inside
   * `<TerminalGrid>` — never commits mid-drag).
   *
   * Why pass cells instead of hit-testing the DOM?
   *   The preview reflow animates pane DOM elements toward their
   *   projected positions. `elementsFromPoint` + `getBoundingClientRect`
   *   would return *animating* bounds, creating a feedback loop:
   *     cursor-in-A → target=A → A animates → cursor-out-of-A → target=null
   *     → preview clears → A animates back → cursor-in-A → …
   *   Against the stable real layout, the classification is deterministic.
   */
  cells: readonly HitTestCell[];
  /** Scale of cell.x/y/w/h. `LAYOUT_UNIT` from the store (typically 10000). */
  layoutUnit: number;
  /** Called once on pointerup. `zone === null` or `targetId === null`
   *  means the drop was cancelled (outside any target). */
  onDrop: (result: {
    sourceId: string;
    targetId: string | RootTargetSentinel | null;
    zone: DropZone | null;
  }) => void;
}

let activeCleanup: (() => void) | null = null;

/** Begin a pane drag. Only one drag can be active at a time; subsequent
 *  calls abort the previous one. */
export function beginDrag(opts: BeginDragOptions): void {
  cancelDrag();
  const { sourceId, sourceKind, sourceLabel, event, rootEl, cells, layoutUnit, onDrop } = opts;

  const startPointerX = event.clientX;
  const startPointerY = event.clientY;

  setDragState({
    sourceId,
    sourceKind,
    sourceLabel,
    startPointerX,
    startPointerY,
    pointerX: event.clientX,
    pointerY: event.clientY,
    targetId: null,
    zone: null,
    targetRect: null,
  });

  // rAF throttle for pointermove. Trackpads fire pointermove at 120+ Hz;
  // updating dragState that often causes the preview reflow to retarget
  // mid-transition. Coalesce to one update per animation frame (≤60 fps).
  let rafId = 0;
  let latestMoveEvent: PointerEvent | null = null;

  function processMove(e: PointerEvent): void {
    const prev = dragState();
    const { targetId, zone, rect } = hitTest(e, rootEl, sourceId, cells, layoutUnit, {
      targetId: prev?.targetId ?? null,
      zone: prev?.zone ?? null,
    });
    setDragState({
      sourceId,
      sourceKind,
      sourceLabel,
      startPointerX,
      startPointerY,
      pointerX: e.clientX,
      pointerY: e.clientY,
      targetId,
      zone,
      targetRect: rect,
    });
  }

  function onMove(e: PointerEvent): void {
    latestMoveEvent = e;
    if (rafId !== 0) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      const ev = latestMoveEvent;
      latestMoveEvent = null;
      if (ev) processMove(ev);
    });
  }

  function onUp(e: PointerEvent): void {
    // Run the final hit-test synchronously (don't wait on rAF) so the drop
    // commits against the zone under the cursor at pointerup, not against
    // a potentially-stale frame's classification.
    const prev = dragState();
    const { targetId, zone } = hitTest(e, rootEl, sourceId, cells, layoutUnit, {
      targetId: prev?.targetId ?? null,
      zone: prev?.zone ?? null,
    });
    cleanup();
    onDrop({ sourceId, targetId, zone });
  }

  function onCancel(): void {
    cleanup();
    onDrop({ sourceId, targetId: null, zone: null });
  }

  // Escape mid-drag is a hard cancel — the live preview tree clears as
  // `dragState` becomes null, sibling panes ease back to their committed
  // rects, and `onDrop` is invoked with no target so no mutation commits.
  // Capture-phase + stopPropagation so the keystroke can't be swallowed
  // upstream (e.g. by the cross-project view's own Escape handler in
  // terminal-grid.tsx) before we get it.
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  }

  function cleanup(): void {
    if (rafId !== 0) {
      cancelAnimationFrame(rafId);
      rafId = 0;
      latestMoveEvent = null;
    }
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    document.removeEventListener("keydown", onKeyDown, true);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    // `is-resizing` removal triggers each TerminalPane's MutationObserver
    // (terminal-pane.tsx) to flush the throttled resize pump — sibling panes
    // that reflowed during the drag end at the exact committed cols/rows.
    rootEl.classList.remove("dnd-active", "is-resizing");
    setDragState(null);
    activeCleanup = null;
  }

  activeCleanup = cleanup;
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
  document.addEventListener("keydown", onKeyDown, true);
  document.body.style.cursor = "grabbing";
  document.body.style.userSelect = "none";
  // `dnd-active` drives the chrome's drag affordances (sibling rings,
  // ease-out reflow, etc.). `is-resizing` tells TerminalPane that the
  // speculative preview tree is active, so it can keep sending throttled live
  // resizes and force one final measurement when the drag commits/cancels.
  rootEl.classList.add("dnd-active", "is-resizing");

  // Clear any pre-existing native text selection — otherwise a stale
  // selection rectangle stays painted on xterm while the user drags, and
  // the macOS accent-blue selection fill obscures the terminal content.
  try {
    window.getSelection()?.removeAllRanges();
  } catch {
    /* best-effort */
  }
}

/** Force-cancel the current drag if any. */
export function cancelDrag(): void {
  if (activeCleanup) activeCleanup();
}

// ---- hit-testing ----------------------------------------------------------

function hitTest(
  e: PointerEvent,
  rootEl: HTMLElement,
  sourceId: string,
  cells: readonly HitTestCell[],
  layoutUnit: number,
  prev: {
    targetId: string | RootTargetSentinel | null;
    zone: DropZone | null;
  },
): { targetId: string | RootTargetSentinel | null; zone: DropZone | null; rect: DOMRect | null } {
  const rootRect = rootEl.getBoundingClientRect();

  // 1) Root-edge check first. If the pointer is within ROOT_ENTER_MARGIN of
  //    the rootEl's outer edge, prefer a root-level drop over a pane-level
  //    drop — matches VSCode's "drag to edit group edge" gesture.
  //    Hysteresis: if we were already on a root-edge zone, stay there until
  //    the pointer passes the EXIT margin. Prevents root↔pane flipping.
  const prevRootZone = prev.targetId === ROOT_TARGET && prev.zone !== "center" ? prev.zone : null;
  const rootZone = rootEdgeZone(e.clientX, e.clientY, rootRect, prevRootZone);
  if (rootZone) {
    return { targetId: ROOT_TARGET, zone: rootZone, rect: rootRect };
  }

  // 2) Pane-level hit test against the **snapshot** cell rects, not the
  //    live DOM. The DOM panes are animating under the preview reflow;
  //    hit-testing their getBoundingClientRect would classify the cursor
  //    against moving bounds and flip target on every frame. Snapshot
  //    cells come from `runtimeLayoutStore.cells` which stays stable
  //    until pointerup (preview tree never commits mid-drag).
  for (const cell of cells) {
    if (cell.id === sourceId) continue;
    const rect = cellToRect(cell, rootRect, layoutUnit);
    if (
      e.clientX >= rect.left &&
      e.clientX < rect.right &&
      e.clientY >= rect.top &&
      e.clientY < rect.bottom
    ) {
      // Hysteresis: carry the previous zone only if it was classified on
      // the *same* target pane. Crossing to a new pane starts fresh.
      const prevZone = prev.targetId === cell.id ? prev.zone : null;
      return {
        targetId: cell.id,
        zone: paneZone(e.clientX, e.clientY, rect, prevZone),
        rect,
      };
    }
  }

  return { targetId: null, zone: null, rect: null };
}

/** Convert a cell's layout-unit coords into a pixel-space DOMRect against
 *  the current root container. Called on every pointermove rather than
 *  cached because the root can resize (window resize during drag). */
function cellToRect(cell: HitTestCell, rootRect: DOMRect, unit: number): DOMRect {
  const sx = rootRect.width / unit;
  const sy = rootRect.height / unit;
  return new DOMRect(
    rootRect.left + cell.x * sx,
    rootRect.top + cell.y * sy,
    cell.w * sx,
    cell.h * sy,
  );
}

/**
 * Classify which 5-zone the pointer is in, relative to a target rect.
 * Hysteresis: if `prevZone` is an edge zone on this same target, the
 * classifier sticks with it until the pointer has moved PAST the wider
 * EXIT fraction — no flipping at the enter threshold.
 */
export function paneZone(
  px: number,
  py: number,
  rect: DOMRect,
  prevZone: DropZone | null = null,
): DropZone {
  const rx = (px - rect.left) / rect.width;
  const ry = (py - rect.top) / rect.height;
  // Distance from each edge as a fraction of width/height.
  const d: Record<Exclude<DropZone, "center">, number> = {
    left: rx,
    right: 1 - rx,
    top: ry,
    bottom: 1 - ry,
  };
  // If we were in an edge zone, stick with it as long as the pointer is
  // still within EXIT distance of *that* edge. This creates the dead band
  // that absorbs jitter at the 15% boundary.
  if (prevZone && prevZone !== "center") {
    if (d[prevZone] <= EDGE_EXIT_FRACTION) return prevZone;
    // Moved clearly away from the prev edge — fall through to fresh
    // classification. We might land on center or another edge.
  }
  const minEdge = Math.min(d.left, d.right, d.top, d.bottom);
  // Fresh classification uses the ENTER fraction (narrower than EXIT).
  if (minEdge > EDGE_ENTER_FRACTION) return "center";
  if (d.left === minEdge) return "left";
  if (d.right === minEdge) return "right";
  if (d.top === minEdge) return "top";
  return "bottom";
}

/**
 * Root-edge zone if the pointer is within ROOT_ENTER_MARGIN of an outer
 * edge, null otherwise. Hysteresis: once classified on a root edge, the
 * pointer must travel ROOT_EXIT_MARGIN px inward before the classifier
 * releases the zone.
 */
function rootEdgeZone(
  px: number,
  py: number,
  rect: DOMRect,
  prevZone: DropZone | null,
): DropZone | null {
  const dLeft = px - rect.left;
  const dRight = rect.right - px;
  const dTop = py - rect.top;
  const dBottom = rect.bottom - py;
  // Pointer must be inside the root (all d* >= 0) to trigger a root edge.
  if (dLeft < 0 || dRight < 0 || dTop < 0 || dBottom < 0) return null;

  // Stay on the previous root-edge zone until the pointer is ROOT_EXIT_MARGIN
  // away from it. Absorbs jitter at the 72px seam with pane-level hit-testing.
  if (prevZone) {
    const prevDist =
      prevZone === "left"
        ? dLeft
        : prevZone === "right"
          ? dRight
          : prevZone === "top"
            ? dTop
            : dBottom;
    if (prevDist <= ROOT_EXIT_MARGIN) return prevZone;
  }

  const min = Math.min(dLeft, dRight, dTop, dBottom);
  if (min > ROOT_ENTER_MARGIN) return null;
  if (dLeft === min) return "left";
  if (dRight === min) return "right";
  if (dTop === min) return "top";
  return "bottom";
}
