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
  /** Magnetic-snap gate for cross-harness review. `true` whenever the
   *  cursor is over a review-eligible sibling pane's interior, OR when
   *  the snap was previously engaged on `targetId` and the cursor is
   *  still inside the inflated hysteresis bounds (`snapHystRect`).
   *  Visual feedback (target outline, source dock, overlay) keys off
   *  this flag. **Releasing while `snapped` does NOT by itself commit
   *  the review** — `armed` must also be true. */
  snapped: boolean;
  /** Inflated rect around the snapped target (target rect expanded by
   *  `SNAP_HYST_PX` on every side). The snap stays engaged as long as
   *  the cursor is inside this rect, so micro-jitter doesn't disengage.
   *  Null when not snapped. */
  snapHystRect: DOMRect | null;
  /** Commit gate for the cross-harness review. Independent of `snapped`
   *  so the visual snap can be felt immediately while the destructive
   *  commit (which kills the source pane's session) waits for a
   *  deliberate dwell. Goes true when:
   *    • `armDelayMs === 0` — snap engages and arms in the same frame.
   *      Used when the source pane is empty, so there's no work to lose.
   *    • A `setTimeout(armDelayMs)` scheduled at engage time fires
   *      while still snapped on the same target.
   *  Resets to false on every fresh engagement (initial entry OR
   *  re-target onto a different pane), on every release, and on
   *  Escape — so any hesitation that releases the snap forces the
   *  user to re-enter and re-hold before a commit can fire. */
  armed: boolean;
  /** Wall-clock ms (`Date.now()`) at which the active dwell started, or
   *  null when no dwell is in flight. Set to a fresh stamp on every
   *  engage / re-target so consumers can render a progress indicator
   *  whose elapsed time matches the timer that will flip `armed`. */
  armStartedAtMs: number | null;
  /** Configured dwell duration for THIS drag, copied from
   *  `BeginDragOptions.armDelayMs` so the overlay can size its progress
   *  animation without re-reading the original options. 0 = no dwell. */
  armDelayMs: number;
  /** Target id whose snap was just released by an Escape keypress. The
   *  snap state machine refuses to re-engage on this target until the
   *  cursor leaves it — without this, releasing snap inside the target
   *  pane would re-engage immediately on the next pointermove because
   *  the cursor is still in the same interior. Cleared the first frame
   *  the cursor is over a different (or no) pane. Null when no escape
   *  is pending. */
  escapedTargetId: string | null;
}

/** How far outside the target's bounds the cursor can drift before the
 *  snap releases. Bigger = more forgiving but feels "magnetic and
 *  sticky"; smaller = unsnaps quickly and feels responsive. Tuned down
 *  from 48 px (which the user reported held the snap too aggressively
 *  on intentional drag-away gestures) to 16 px — still larger than
 *  trackpad tremor (~2–4 px) but small enough that any deliberate
 *  drag-onwards motion releases immediately. */
export const SNAP_HYST_PX = 16;

/** Hard pixel cap for an edge band's width. Without this cap, the
 *  fractional 15 % rule shrinks the snap interior to a sliver on small
 *  panes (the user's specific complaint). With it, edges stay reachable
 *  for splits but never claim more than 32 px per side, so even on a
 *  120-px pane the interior dominates. */
const MAX_EDGE_BAND_PX = 32;
/** Same cap for the wider hysteresis exit band. 2× MAX_EDGE_BAND_PX
 *  matches the EDGE_EXIT_FRACTION : EDGE_ENTER_FRACTION ratio. */
const MAX_EDGE_EXIT_PX = 64;

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
  /** Optional kind/permission gate: returns `true` if the snap should
   *  engage when the cursor is over `targetId`'s interior. Default
   *  (when omitted) is `true` for every non-source pane. The harness
   *  shell wires this to "both source and target are review-eligible
   *  agent kinds", so dragging onto a Shell pane never visually snaps. */
  canSnapTo?: (targetId: string) => boolean;
  /** Dwell time (ms) the cursor must remain snapped on the same target
   *  before a release counts as a commit. Default `0` arms the snap
   *  immediately — used when the source pane has no work to lose
   *  (empty/fresh harness). Pass a positive value (e.g. `600`) when
   *  the source has history; the visual snap engages on entry but
   *  releasing before the dwell elapses cancels harmlessly. The dwell
   *  resets on every fresh engagement (initial entry OR re-target). */
  armDelayMs?: number;
  /** Called once on pointerup. `zone === null` or `targetId === null`
   *  means the drop was cancelled (outside any target). `snapped` is
   *  `true` when the magnetic snap was visually engaged at release;
   *  `armed` is `true` only after the dwell has elapsed. **The caller
   *  MUST gate any destructive review action on both `snapped && armed`**
   *  — `snapped` alone is the visual state, `armed` is the commit gate. */
  onDrop: (result: {
    sourceId: string;
    targetId: string | RootTargetSentinel | null;
    zone: DropZone | null;
    snapped: boolean;
    armed: boolean;
  }) => void;
}

let activeCleanup: (() => void) | null = null;

/** Begin a pane drag. Only one drag can be active at a time; subsequent
 *  calls abort the previous one. */
export function beginDrag(opts: BeginDragOptions): void {
  cancelDrag();
  const { sourceId, sourceKind, sourceLabel, event, rootEl, cells, layoutUnit, canSnapTo, onDrop } =
    opts;
  const armDelayMs = Math.max(0, opts.armDelayMs ?? 0);

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
    snapped: false,
    snapHystRect: null,
    armed: false,
    armStartedAtMs: null,
    armDelayMs,
    escapedTargetId: null,
  });

  // Pending dwell timer + the target it was scheduled against. Both must
  // line up at fire time — if the user has retargeted or unsnapped, the
  // late callback is a no-op. Tracked outside `dragState` so cancellations
  // are O(1) and don't churn the reactive signal.
  let armTimerId: ReturnType<typeof setTimeout> | null = null;
  let armTimerTargetId: string | null = null;

  function clearArmTimer(): void {
    if (armTimerId !== null) {
      clearTimeout(armTimerId);
      armTimerId = null;
      armTimerTargetId = null;
    }
  }

  function scheduleArmFor(targetId: string): void {
    clearArmTimer();
    if (armDelayMs === 0) return; // instant arm path skips the timer
    armTimerTargetId = targetId;
    armTimerId = setTimeout(() => {
      armTimerId = null;
      const cur = dragState();
      // Only flip armed=true if the snap is still engaged on the SAME
      // target the timer was scheduled against. Re-target / release
      // between scheduling and firing must cancel the arm — the late
      // callback would otherwise commit a destructive review against a
      // pane the user is no longer hovering.
      if (
        cur &&
        cur.snapped &&
        cur.targetId === armTimerTargetId &&
        cur.targetId !== ROOT_TARGET &&
        !cur.armed
      ) {
        setDragState({ ...cur, armed: true });
      }
      armTimerTargetId = null;
    }, armDelayMs);
  }

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

    // Snap state machine. Once engaged the snap is sticky against
    // tremor: cursor drift inside the inflated hysteresis ring keeps
    // the magnet engaged. It releases the moment the user signals
    // intent to do something else — either by (i) pressing Escape,
    // which sets `escapedTargetId` so we suppress re-engagement until
    // the cursor leaves the escaped target, (ii) dragging the cursor
    // into another candidate's interior (atomic re-target), or
    // (iii) entering an edge zone of any pane, which is reserved for
    // split drops and must remain reachable even from inside the
    // hysteresis ring.
    //
    // Three outcomes per frame:
    //  (a) ENGAGE/RE-TARGET: cursor is in a sibling pane's interior,
    //      consumer's kind check passes, AND the target isn't the one
    //      the user just escaped from → snap with a fresh hysteresis
    //      rect.
    //  (b) HOLD: snap was previously engaged and the cursor is still
    //      inside the inflated hysteresis rect — UNLESS the cursor has
    //      crossed into an edge zone of any non-source pane. Edge
    //      zones are reserved for split drops, so two adjacent
    //      harnesses can be separated by a "wiggle-room" band where
    //      the snap releases and the user can drop a normal split
    //      between them. Without this carve-out the 48 px hysteresis
    //      ring of pane A overlaps pane B's left-edge band entirely,
    //      jumping snap-A → snap-B with no neutral interval.
    //  (c) RELEASE: neither — natural classification flows through and
    //      downstream (edge-split preview, root-edge magnets) takes
    //      over.
    //
    // (a) beats (b) so re-snapping onto a different candidate is atomic
    // (no flicker through an intermediate "released" state).
    const isInteriorHit = zone === "center" && targetId !== null && targetId !== ROOT_TARGET;
    const escapedFromHere = prev?.escapedTargetId !== null && prev?.escapedTargetId === targetId;
    const eligible =
      isInteriorHit &&
      rect !== null &&
      !escapedFromHere &&
      (canSnapTo?.(targetId as string) ?? true);
    // Cursor is in an edge band of a real (non-source, non-root) pane.
    // When true, the HOLD branch must yield so the split-drop classifier
    // owns this region. Engage (a) still wins above when the cursor
    // reaches a sibling's interior.
    const cursorInEdgeOfNonSourcePane =
      targetId !== null &&
      targetId !== ROOT_TARGET &&
      targetId !== sourceId &&
      zone !== null &&
      zone !== "center";

    let snapped = false;
    let snapHystRect: DOMRect | null = null;
    let outTargetId = targetId;
    let outZone = zone;
    let outRect = rect;

    if (eligible && rect !== null) {
      snapped = true;
      snapHystRect = inflateRect(rect, SNAP_HYST_PX);
    } else if (
      prev?.snapped &&
      prev.snapHystRect &&
      prev.targetId !== null &&
      prev.targetRect !== null &&
      pointerInRect(e.clientX, e.clientY, prev.snapHystRect) &&
      !cursorInEdgeOfNonSourcePane
    ) {
      snapped = true;
      snapHystRect = prev.snapHystRect;
      outTargetId = prev.targetId;
      outZone = "center";
      outRect = prev.targetRect;
    }

    // Clear the escape suppression once the cursor has left the
    // escaped target — re-entering should snap again. Engaging on a
    // different target also clears it (we've moved on).
    let nextEscapedTargetId = prev?.escapedTargetId ?? null;
    if (nextEscapedTargetId !== null && targetId !== nextEscapedTargetId) {
      nextEscapedTargetId = null;
    }
    if (snapped && outTargetId !== nextEscapedTargetId) {
      nextEscapedTargetId = null;
    }

    // Dwell-to-arm state machine. Three transitions matter:
    //   • RELEASE      (snap was on, now off)               → cancel
    //                                                         timer,
    //                                                         armed=false.
    //   • FRESH ENGAGE (snap was off OR target changed)     → cancel
    //                                                         old timer,
    //                                                         schedule
    //                                                         new one
    //                                                         (or arm
    //                                                         instantly
    //                                                         when
    //                                                         delay=0).
    //   • HOLD         (snap on same target as last frame)  → keep
    //                                                         prev.armed
    //                                                         and the
    //                                                         already-
    //                                                         scheduled
    //                                                         timer.
    // Carrying `prev.armed` through the HOLD branch is critical: any
    // pointermove inside the snap interior would otherwise reset armed
    // to false, defeating the dwell entirely.
    const wasSnappedSameTarget =
      prev?.snapped === true && prev?.targetId === outTargetId && outTargetId !== null;

    let armed = false;
    let armStartedAtMs: number | null = null;
    if (snapped && outTargetId !== null && outTargetId !== ROOT_TARGET) {
      if (wasSnappedSameTarget) {
        armed = prev?.armed ?? false;
        armStartedAtMs = prev?.armStartedAtMs ?? null;
      } else {
        // FRESH ENGAGE: either initial entry, retarget to a different
        // pane, or re-entry after a release. Restart the dwell from 0.
        armed = armDelayMs === 0;
        armStartedAtMs = armDelayMs === 0 ? null : Date.now();
        scheduleArmFor(outTargetId as string);
      }
    } else {
      // RELEASE (or no snap to begin with). Make sure no timer can
      // resurrect the arm against a stale target after the user has
      // moved on.
      clearArmTimer();
    }

    setDragState({
      sourceId,
      sourceKind,
      sourceLabel,
      startPointerX,
      startPointerY,
      pointerX: e.clientX,
      pointerY: e.clientY,
      targetId: outTargetId,
      zone: outZone,
      targetRect: outRect,
      snapped,
      snapHystRect,
      armed,
      armStartedAtMs,
      armDelayMs,
      escapedTargetId: nextEscapedTargetId,
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
    // Run the snap state machine one last time synchronously (don't wait
    // on rAF) so the drop commits against the cursor's exact position at
    // pointerup, including the hysteresis hold for "released a few px
    // outside the pane but still inside the hysteresis ring".
    if (rafId !== 0) {
      cancelAnimationFrame(rafId);
      rafId = 0;
      latestMoveEvent = null;
    }
    processMove(e);
    const final = dragState();
    const result = {
      sourceId,
      targetId: final?.targetId ?? null,
      zone: final?.zone ?? null,
      snapped: final?.snapped ?? false,
      armed: final?.armed ?? false,
    };
    cleanup();
    onDrop(result);
  }

  function onCancel(): void {
    cleanup();
    onDrop({ sourceId, targetId: null, zone: null, snapped: false, armed: false });
  }

  // Escape mid-drag has two roles depending on whether the magnetic
  // snap is currently engaged:
  //
  //   • SNAPPED: release the snap and suppress re-engagement on the
  //     same target (`escapedTargetId`) until the cursor leaves it.
  //     The drag continues — the user is back in free-positioning mode
  //     where edge-split previews and other targets are reachable.
  //   • NOT SNAPPED: hard-cancel the entire drag (the original
  //     behavior) — the live preview tree clears as `dragState`
  //     becomes null, sibling panes ease back to their committed
  //     rects, and `onDrop` is invoked with no target so no mutation
  //     commits.
  //
  // Capture-phase + stopPropagation so the keystroke can't be swallowed
  // upstream (e.g. by the cross-project view's own Escape handler in
  // terminal-grid.tsx) before we get it.
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    const cur = dragState();
    if (cur?.snapped && cur.targetId !== null && cur.targetId !== ROOT_TARGET) {
      e.preventDefault();
      e.stopPropagation();
      // Cancel any in-flight dwell — Escape's whole job here is "I
      // don't want this snap to commit". Without this, the timer would
      // continue running and could fire `armed=true` while the user is
      // still in the snap interior re-evaluating. The snap itself
      // releases (snapped=false) so on re-entry the FRESH ENGAGE branch
      // reschedules a new dwell from 0.
      clearArmTimer();
      setDragState({
        ...cur,
        snapped: false,
        snapHystRect: null,
        armed: false,
        armStartedAtMs: null,
        escapedTargetId: cur.targetId as string,
      });
      return;
    }
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
    clearArmTimer();
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
 *
 * Edge bands are sized as `min(dim × FRACTION, MAX_PX)` per side. The
 * pixel cap is the magnetic-snap fix for dense layouts: the legacy
 * fraction-only rule shrank the snap interior to a sliver on small
 * panes, so the user kept missing the harness they wanted to drop on.
 * Capping each edge band at 32 px keeps splits reachable but lets the
 * interior dominate as soon as the pane is wider than ~210 px.
 *
 * Hysteresis: if `prevZone` is an edge zone on this same target, the
 * classifier sticks with it until the pointer crosses the wider EXIT
 * band (also px-capped). Without this dead band, sub-pixel jitter at
 * the boundary flips the zone every pointermove.
 */
export function paneZone(
  px: number,
  py: number,
  rect: DOMRect,
  prevZone: DropZone | null = null,
): DropZone {
  const dLeft = px - rect.left;
  const dRight = rect.right - px;
  const dTop = py - rect.top;
  const dBottom = rect.bottom - py;
  const enterX = Math.min(rect.width * EDGE_ENTER_FRACTION, MAX_EDGE_BAND_PX);
  const enterY = Math.min(rect.height * EDGE_ENTER_FRACTION, MAX_EDGE_BAND_PX);
  const exitX = Math.min(rect.width * EDGE_EXIT_FRACTION, MAX_EDGE_EXIT_PX);
  const exitY = Math.min(rect.height * EDGE_EXIT_FRACTION, MAX_EDGE_EXIT_PX);

  // Hysteresis: stay on the prev edge until the pointer has moved past
  // its (px-capped) EXIT band. Falls through to fresh classification
  // once the cursor is clearly off the prev edge.
  if (prevZone === "left" && dLeft <= exitX) return "left";
  if (prevZone === "right" && dRight <= exitX) return "right";
  if (prevZone === "top" && dTop <= exitY) return "top";
  if (prevZone === "bottom" && dBottom <= exitY) return "bottom";

  // Fresh classification: the cursor must be inside *some* edge band
  // for an edge zone to win. If every edge distance is bigger than its
  // enter threshold, the cursor is in the snap interior.
  const inLeft = dLeft <= enterX;
  const inRight = dRight <= enterX;
  const inTop = dTop <= enterY;
  const inBottom = dBottom <= enterY;
  if (!inLeft && !inRight && !inTop && !inBottom) return "center";

  // Pick the closest edge among those whose band the cursor is in.
  let best: DropZone = "center";
  let bestDist = Infinity;
  if (inLeft && dLeft < bestDist) {
    best = "left";
    bestDist = dLeft;
  }
  if (inRight && dRight < bestDist) {
    best = "right";
    bestDist = dRight;
  }
  if (inTop && dTop < bestDist) {
    best = "top";
    bestDist = dTop;
  }
  if (inBottom && dBottom < bestDist) {
    best = "bottom";
    bestDist = dBottom;
  }
  return best;
}

/** Expand a rect by `px` on every side. Used to compute the snap's
 *  hysteresis bounds: the snap stays engaged as long as the cursor is
 *  inside the inflated rect. */
function inflateRect(r: DOMRect, px: number): DOMRect {
  return new DOMRect(r.left - px, r.top - px, r.width + 2 * px, r.height + 2 * px);
}

/** Half-open hit-test (right/bottom exclusive) so adjacent rects don't
 *  both claim a 1-px seam. */
function pointerInRect(x: number, y: number, r: DOMRect): boolean {
  return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
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
