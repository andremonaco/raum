/**
 * DEV-mode performance instrumentation for filter/project-switch hot paths.
 *
 * Gated on `import.meta.env.DEV` — every helper compiles to a no-op in
 * production, so the bundle pays zero cost. Use `markStart` before a
 * user-triggered signal write, then pair it with `markEnd` once the
 * derived memo has settled (via `timeMemoSettle`).
 *
 * Measurements below the FLOOR are dropped so a spammy event bus doesn't
 * flood the console.
 */

import { createEffect, untrack } from "solid-js";

const DEV: boolean = import.meta.env.DEV;
const FLOOR_MS = 0.5;

/** Start a named measurement. Safe to call when DEV is false. */
export function markStart(name: string): void {
  if (!DEV) return;
  try {
    performance.mark(`${name}-start`);
  } catch {
    /* SSR / jsdom without the mark API — ignore. */
  }
}

/** Finish a named measurement started with `markStart` and log it once. */
export function markEnd(name: string, detail?: unknown): void {
  if (!DEV) return;
  try {
    performance.measure(name, `${name}-start`);
    const last = performance.getEntriesByName(name, "measure").at(-1);
    performance.clearMarks(`${name}-start`);
    performance.clearMeasures(name);
    if (!last || last.duration < FLOOR_MS) return;
    if (detail === undefined) {
      console.log(`%c[perf] ${name} ${last.duration.toFixed(2)}ms`, "color:#888");
    } else {
      console.log(`%c[perf] ${name} ${last.duration.toFixed(2)}ms`, "color:#888", detail);
    }
  } catch {
    /* mark missing — markStart wasn't called or was already consumed. */
  }
}

/**
 * Pair a one-shot `markEnd` with the next value-identity change of `src`.
 *
 * Must be called inside a tracking scope (component setup, `createRoot`).
 * The first value is captured silently; subsequent identity changes emit
 * a `markEnd(name)` call. If no `markStart(name)` is pending when the
 * memo settles, `markEnd` becomes a no-op — safe to leave wired.
 *
 * Pass a function for `name` when the measurement label depends on other
 * reactive state (e.g. a component prop that can change without
 * remounting). The accessor runs inside `untrack` so it doesn't pull its
 * signals into the effect's dependency set.
 */
export function timeMemoSettle<T>(name: string | (() => string), src: () => T): void {
  if (!DEV) return;
  let prev: T;
  let started = false;
  createEffect(() => {
    const v = src();
    if (!started) {
      prev = v;
      started = true;
      return;
    }
    if (Object.is(v, prev)) return;
    prev = v;
    untrack(() => {
      const resolved = typeof name === "function" ? name() : name;
      markEnd(resolved);
    });
  });
}
