/**
 * `createCountUp` — a tiny reactive number tween for Solid.
 *
 * Wraps a numeric accessor and returns a derived accessor that *animates*
 * toward each new target value instead of snapping. Used by the worktree
 * switcher so a live diffstat (`+N` / `-M`) visibly counts up/down as files
 * change, rather than jumping. Deliberately dependency-free — a single
 * `requestAnimationFrame` loop, matching the codebase's no-motion-library
 * ethos.
 *
 * Behaviour:
 *  - First value is shown immediately (no intro animation from 0 unless the
 *    source itself starts at 0 and then rises — e.g. the initial status seed).
 *  - Each change cancels any in-flight tween and eases from the *currently
 *    displayed* value to the new target (ease-out cubic), so rapid updates
 *    chain smoothly instead of fighting.
 *  - The rAF loop only runs during the ~`durationMs` window; idle accessors
 *    cost nothing, so many of these on screen at once stay cheap.
 *  - Values are rounded to integers (these are line counts); the final frame
 *    snaps to the exact target so it never lands a pixel short.
 */

import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js";

/** Ease-out cubic on a normalised `t ∈ [0, 1]`. Fast start, gentle settle. */
export function easeOutCubic(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - Math.pow(1 - clamped, 3);
}

/** Rounded linear-interpolate `from → to` at eased progress `t`. */
export function tweenValue(from: number, to: number, t: number): number {
  if (t >= 1) return to;
  return Math.round(from + (to - from) * easeOutCubic(t));
}

const DEFAULT_DURATION_MS = 350;

/**
 * Returns an accessor that animates toward `target()` whenever it changes.
 * Must be called inside a reactive owner (component body / root) so its
 * effect and rAF cleanup are disposed with the owner.
 */
export function createCountUp(
  target: Accessor<number>,
  durationMs: number = DEFAULT_DURATION_MS,
): Accessor<number> {
  const [display, setDisplay] = createSignal(untrack(target));
  let raf = 0;

  createEffect(() => {
    const to = target();
    const from = untrack(display);

    // Supersede any in-flight tween FIRST — including when `to === from`. If a
    // push lands while the count is mid-animation and its target equals the
    // currently-displayed value, returning without cancelling would let the
    // old frame chain run on to its stale target (painting the wrong number).
    cancelAnimationFrame(raf);
    if (to === from) return;

    // No timeline / zero duration: snap (keeps tests and reduced-motion sane).
    if (durationMs <= 0 || typeof requestAnimationFrame !== "function") {
      setDisplay(to);
      return;
    }

    let start = 0;
    const step = (now: number) => {
      if (start === 0) start = now;
      const t = (now - start) / durationMs;
      setDisplay(tweenValue(from, to, t));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  });

  onCleanup(() => cancelAnimationFrame(raf));

  return display;
}
