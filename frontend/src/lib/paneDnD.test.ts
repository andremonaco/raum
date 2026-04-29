import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __setDragStateForTests,
  beginDrag,
  cancelDrag,
  dragState,
  paneZone,
  ROOT_TARGET,
  SNAP_HYST_PX,
} from "./paneDnD";

// ---- paneZone (pure) ------------------------------------------------------

describe("paneZone — fractional + px-capped edge bands", () => {
  it("classifies a center hit when the cursor is in the interior", () => {
    expect(paneZone(100, 100, new DOMRect(0, 0, 200, 200))).toBe("center");
  });

  it("classifies an edge hit when the cursor is inside the band", () => {
    // 200 px pane: 15 % = 30 px enter band; cursor at x=10 is well inside left.
    expect(paneZone(10, 100, new DOMRect(0, 0, 200, 200))).toBe("left");
  });

  it("on a small pane the fraction binds, not the px cap", () => {
    // 100 px pane: 15 % = 15 px; px cap is 32 → fraction wins.
    // Cursor at 16 px from left = outside the 15 px enter band → center.
    expect(paneZone(16, 50, new DOMRect(0, 0, 100, 100))).toBe("center");
    // At 12 px = inside the 15 px enter band → left.
    expect(paneZone(12, 50, new DOMRect(0, 0, 100, 100))).toBe("left");
  });

  it("on a large pane the px cap binds, not the fraction", () => {
    // 1000 px pane: 15 % = 150 px (would swallow the snap interior);
    // px cap is 32 → cap wins, snap interior is 1000 - 64 = 936 px.
    // Cursor at 50 px from left = past the 32 px cap → center.
    expect(paneZone(50, 500, new DOMRect(0, 0, 1000, 1000))).toBe("center");
    // At 30 px = inside the 32 px cap → left.
    expect(paneZone(30, 500, new DOMRect(0, 0, 1000, 1000))).toBe("left");
  });

  it("hysteresis: prev edge holds until cursor crosses the (capped) exit band", () => {
    const r = new DOMRect(0, 0, 1000, 1000);
    // Enter band = 32 px; exit band = 64 px (also px-capped).
    // Cursor at 50 px from left, prev = "left" → still inside exit band (64 px).
    expect(paneZone(50, 500, r, "left")).toBe("left");
    // Cursor at 70 px from left, prev = "left" → past exit band → fresh = center.
    expect(paneZone(70, 500, r, "left")).toBe("center");
  });

  it("picks the closest edge when the cursor is inside multiple bands (corner)", () => {
    // 200 px pane, cursor at (5, 8): inside both left band and top band.
    // dLeft = 5, dTop = 8 → left wins (smaller distance).
    expect(paneZone(5, 8, new DOMRect(0, 0, 200, 200))).toBe("left");
    // Same pane, cursor at (8, 5): top wins.
    expect(paneZone(8, 5, new DOMRect(0, 0, 200, 200))).toBe("top");
  });
});

// ---- magnetic snap state machine ------------------------------------------

describe("magnetic snap via beginDrag", () => {
  let rootEl: HTMLElement;
  let rafCallbacks: Array<FrameRequestCallback>;
  let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame;

  beforeEach(() => {
    rootEl = document.createElement("div");
    rootEl.setAttribute("data-dnd-root", "true");
    // Force a stable root rect so cellToRect math is deterministic.
    Object.defineProperty(rootEl, "getBoundingClientRect", {
      value: () => new DOMRect(0, 0, 1000, 1000),
    });
    document.body.appendChild(rootEl);

    // Synchronous rAF: queue callbacks and let tests flush them on demand.
    // The state machine is rAF-coalesced inside processMove, so without
    // this the dragState wouldn't update during tests.
    rafCallbacks = [];
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => {
      // Best-effort: replace with a noop so flushRaf doesn't double-fire.
      if (id > 0 && id <= rafCallbacks.length) {
        rafCallbacks[id - 1] = () => undefined;
      }
    }) as typeof globalThis.cancelAnimationFrame;
  });

  afterEach(() => {
    cancelDrag();
    rootEl.remove();
    __setDragStateForTests(null);
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  function flushRaf(): void {
    const pending = rafCallbacks;
    rafCallbacks = [];
    for (const cb of pending) cb(performance.now());
  }

  /** Two side-by-side panes filling the 1000×1000 root: src on the left
   *  half, tgt on the right half. */
  const LEFT_RIGHT_CELLS = [
    { id: "src", x: 0, y: 0, w: 5000, h: 10000 },
    { id: "tgt", x: 5000, y: 0, w: 5000, h: 10000 },
  ];

  function start(opts?: {
    canSnapTo?: (id: string) => boolean;
    onDrop?: (r: {
      sourceId: string;
      targetId: string | null;
      zone: string | null;
      snapped: boolean;
    }) => void;
    cells?: typeof LEFT_RIGHT_CELLS;
  }): void {
    const event = new PointerEvent("pointerdown", { clientX: 100, clientY: 500 });
    beginDrag({
      sourceId: "src",
      sourceKind: "codex",
      sourceLabel: "Codex",
      event,
      rootEl,
      cells: opts?.cells ?? LEFT_RIGHT_CELLS,
      layoutUnit: 10000,
      canSnapTo: opts?.canSnapTo,
      onDrop:
        opts?.onDrop ??
        (() => {
          /* noop */
        }),
    });
  }

  function move(x: number, y: number): void {
    document.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y }));
    flushRaf();
  }

  it("engages snap immediately on entry to a sibling pane's interior", () => {
    start();
    // Right pane spans x=500..1000. Center is (750, 500).
    move(750, 500);
    expect(dragState()?.snapped).toBe(true);
    expect(dragState()?.targetId).toBe("tgt");
    expect(dragState()?.zone).toBe("center");
    expect(dragState()?.snapHystRect).not.toBeNull();
  });

  it("holds snap when the cursor drifts inside the hysteresis ring", () => {
    start();
    move(750, 500); // engage on right pane
    expect(dragState()?.snapped).toBe(true);
    // Drift left of the right pane (x < 500) but stay inside the inflated
    // hysteresis ring (right pane left edge is at 500; ring starts at
    // `500 - SNAP_HYST_PX`). Sit half-way into the ring → snap holds.
    move(500 - Math.floor(SNAP_HYST_PX / 2), 500);
    expect(dragState()?.snapped).toBe(true);
    expect(dragState()?.targetId).toBe("tgt");
  });

  it("releases snap when the cursor exits the hysteresis ring", () => {
    start();
    move(750, 500);
    expect(dragState()?.snapped).toBe(true);
    // Far outside the ring (x = 100 → ~400 px past the ring's left edge).
    move(100, 500);
    expect(dragState()?.snapped).toBe(false);
  });

  it("re-targets snap atomically when the cursor enters another candidate", () => {
    start({
      cells: [
        { id: "src", x: 0, y: 0, w: 3333, h: 10000 },
        { id: "mid", x: 3333, y: 0, w: 3334, h: 10000 },
        { id: "rgt", x: 6667, y: 0, w: 3333, h: 10000 },
      ],
    });
    // Engage on mid (interior at x ~ 500).
    move(500, 500);
    expect(dragState()?.targetId).toBe("mid");
    expect(dragState()?.snapped).toBe(true);
    // Slide into rgt's interior (x ~ 800).
    move(800, 500);
    expect(dragState()?.targetId).toBe("rgt");
    expect(dragState()?.snapped).toBe(true);
  });

  it("releases snap when the cursor enters another pane's edge zone (wiggle-room for splits)", () => {
    // Vertical 3-pane stack with the source at the bottom.
    start({
      cells: [
        { id: "top", x: 0, y: 0, w: 10000, h: 3333 },
        { id: "mid", x: 0, y: 3333, w: 10000, h: 3334 },
        { id: "src", x: 0, y: 6667, w: 10000, h: 3333 },
      ],
    });
    // Engage on mid interior.
    move(500, 500);
    expect(dragState()?.targetId).toBe("mid");
    expect(dragState()?.snapped).toBe(true);
    // Move up into top pane's bottom edge band — even though the
    // cursor is still inside mid's inflated hysteresis ring, the
    // edge zone of top must own this region so the user can drop a
    // split between mid and top instead of being magnetised to mid.
    // Top spans y=0..333; bottom edge band cap = 32px, so y=320 sits
    // 13px from top's bottom edge — clearly inside top's "bottom"
    // zone.
    move(500, 320);
    expect(dragState()?.snapped).toBe(false);
    expect(dragState()?.targetId).toBe("top");
    expect(dragState()?.zone).toBe("bottom");
  });

  it("releases snap when the cursor enters the snapped pane's own edge zone", () => {
    // Single sibling target on the right; engage in the centre then
    // move toward its left edge band. The user is signalling "split
    // on the left of tgt", not "review tgt" — release the snap.
    start();
    move(750, 500); // engage on tgt centre
    expect(dragState()?.snapped).toBe(true);
    expect(dragState()?.targetId).toBe("tgt");
    // tgt spans x=500..1000; left edge band cap = 32px → x=510 is
    // 10 px inside the band, classified as "left".
    move(510, 500);
    expect(dragState()?.snapped).toBe(false);
    expect(dragState()?.targetId).toBe("tgt");
    expect(dragState()?.zone).toBe("left");
  });

  it("auto re-targets when the cursor reaches another pane's interior", () => {
    start({
      cells: [
        { id: "top", x: 0, y: 0, w: 10000, h: 3333 },
        { id: "mid", x: 0, y: 3333, w: 10000, h: 3334 },
        { id: "src", x: 0, y: 6667, w: 10000, h: 3333 },
      ],
    });
    move(500, 500); // engage on mid
    expect(dragState()?.targetId).toBe("mid");
    // Drag past top's edge band into top's interior — snap atomically
    // re-targets without requiring Escape.
    move(500, 150);
    expect(dragState()?.snapped).toBe(true);
    expect(dragState()?.targetId).toBe("top");
  });

  it("Escape while snapped releases the snap and keeps the drag alive", () => {
    const drops: Array<{ snapped: boolean; targetId: string | null }> = [];
    start({
      onDrop: (r) => {
        drops.push({ snapped: r.snapped, targetId: r.targetId });
      },
    });
    move(750, 500); // engage on tgt (right pane)
    expect(dragState()?.snapped).toBe(true);
    // Press Escape: snap releases, drag continues.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dragState()).not.toBeNull(); // drag still alive
    expect(dragState()?.snapped).toBe(false);
    expect(dragState()?.escapedTargetId).toBe("tgt");
    // No drop callback yet — drag is still in progress.
    expect(drops).toHaveLength(0);
  });

  it("Escape while snapped suppresses re-snap on the same target until cursor leaves", () => {
    start({
      cells: [
        { id: "top", x: 0, y: 0, w: 10000, h: 3333 },
        { id: "mid", x: 0, y: 3333, w: 10000, h: 3334 },
        { id: "src", x: 0, y: 6667, w: 10000, h: 3333 },
      ],
    });
    move(500, 500); // engage on mid
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dragState()?.snapped).toBe(false);
    expect(dragState()?.escapedTargetId).toBe("mid");
    // Cursor still in mid interior — must NOT re-engage.
    move(500, 510);
    expect(dragState()?.snapped).toBe(false);
    // Cursor enters top's interior — snap engages on the new target;
    // the suppression on mid is irrelevant here.
    move(500, 150);
    expect(dragState()?.snapped).toBe(true);
    expect(dragState()?.targetId).toBe("top");
    expect(dragState()?.escapedTargetId).toBeNull();
  });

  it("Escape with no snap engaged cancels the drag (preserves prior behavior)", () => {
    const drops: Array<{ snapped: boolean; targetId: string | null }> = [];
    start({
      onDrop: (r) => {
        drops.push({ snapped: r.snapped, targetId: r.targetId });
      },
    });
    // No snap engaged yet — Escape cancels.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dragState()).toBeNull();
    expect(drops).toHaveLength(1);
    expect(drops[0].snapped).toBe(false);
    expect(drops[0].targetId).toBeNull();
  });

  it("re-entering an escaped target after leaving it engages the snap again", () => {
    start({
      cells: [
        { id: "top", x: 0, y: 0, w: 10000, h: 3333 },
        { id: "mid", x: 0, y: 3333, w: 10000, h: 3334 },
        { id: "src", x: 0, y: 6667, w: 10000, h: 3333 },
      ],
    });
    move(500, 500); // engage on mid
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dragState()?.snapped).toBe(false);
    // Leave mid (cursor into top).
    move(500, 150);
    expect(dragState()?.targetId).toBe("top");
    // Come back to mid's interior — escape suppression is gone, snap
    // engages again.
    move(500, 500);
    expect(dragState()?.snapped).toBe(true);
    expect(dragState()?.targetId).toBe("mid");
  });

  it("does not engage snap when canSnapTo rejects the target", () => {
    start({ canSnapTo: () => false });
    move(750, 500);
    expect(dragState()?.snapped).toBe(false);
    expect(dragState()?.zone).toBe("center"); // natural classification still flows
    expect(dragState()?.targetId).toBe("tgt");
  });

  it("commits the review on pointerup while snapped", () => {
    const drops: Array<{ snapped: boolean; targetId: string | null }> = [];
    start({
      onDrop: (r) => {
        drops.push({ snapped: r.snapped, targetId: r.targetId });
      },
    });
    move(750, 500);
    document.dispatchEvent(new PointerEvent("pointerup", { clientX: 750, clientY: 500 }));
    expect(drops).toHaveLength(1);
    expect(drops[0].snapped).toBe(true);
    expect(drops[0].targetId).toBe("tgt");
  });

  it("does not commit when released outside any snap or edge zone", () => {
    const drops: Array<{ snapped: boolean; targetId: string | null }> = [];
    start({
      onDrop: (r) => {
        drops.push({ snapped: r.snapped, targetId: r.targetId });
      },
    });
    // Hover into target then drag clearly past hysteresis, then release in
    // dead space.
    move(750, 500);
    move(100, 500);
    document.dispatchEvent(new PointerEvent("pointerup", { clientX: 100, clientY: 500 }));
    expect(drops).toHaveLength(1);
    expect(drops[0].snapped).toBe(false);
  });

  it("edge zones still classify when the cursor is in the (capped) edge band", () => {
    start();
    // Right pane spans x=500..1000; left edge band cap = 32 px.
    // Cursor at x=510 (= 10 px inside the left edge band) classifies as
    // an edge "left" zone, not snap.
    move(510, 500);
    expect(dragState()?.zone).toBe("left");
    expect(dragState()?.snapped).toBe(false);
  });

  it("SNAP_HYST_PX is exposed for callers that compute hysteresis rects", () => {
    expect(SNAP_HYST_PX).toBeGreaterThan(0);
  });

  it("ROOT_TARGET sentinel is unchanged", () => {
    expect(ROOT_TARGET).toBe("__root__");
  });
});
