/**
 * §9 — harness counter widget.
 *
 * Mirrors the top-right harness widget in `top-row.tsx`. Same icons, same
 * colour treatment, scoped to a worktree or aggregated across a project.
 *
 * Animations are deliberately subtle: `animate-spin` on the loader (already
 * built-in) for active work, `animate-pulse` on the alert circle when input
 * is waited on. Idle gets no motion.
 */

import { Component, Show } from "solid-js";
import { harnessCountsForWorktree } from "../../stores/terminalStore";
import { ActivityIcon, CheckIcon, LoaderIcon, TriangleAlertIcon } from "../icons";
import type { HarnessCounterProps, HarnessCounts } from "./types";

export const HarnessCounter: Component<HarnessCounterProps> = (counterProps) => {
  const c = () => counterProps.counts;
  const containerClass = () =>
    counterProps.compact
      ? "flex shrink-0 items-center gap-1 font-mono text-[10px]"
      : "flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-card/30 px-1 py-0.5 font-mono text-[10px]";
  const cellClass = "inline-flex items-center gap-0.5 px-0.5";
  return (
    <span class={containerClass()} data-testid="worktree-harness-counts">
      <span
        class={cellClass}
        classList={{
          "text-success": c().active > 0,
          "text-foreground-dim": c().active === 0,
        }}
        title={`${c().active} active`}
      >
        <Show when={c().active > 0} fallback={<ActivityIcon class="size-2.5" />}>
          <LoaderIcon class="size-2.5 animate-spin" />
        </Show>
        {c().active}
      </span>
      <span
        class={cellClass}
        classList={{
          "text-warning": c().waiting > 0,
          "text-foreground-dim": c().waiting === 0,
        }}
        title={`${c().waiting} waiting`}
      >
        {/* Angular triangle rather than a thin circle: it holds visual parity
            with the activity/check strokes at the same size-2.5 box, where a
            circle outline reads optically smaller. */}
        <TriangleAlertIcon class="size-2.5" classList={{ "animate-pulse": c().waiting > 0 }} />
        {c().waiting}
      </span>
      <span
        class={cellClass}
        classList={{
          "text-muted-foreground": c().idle > 0,
          "text-foreground-dim": c().idle === 0,
        }}
        title={`${c().idle} idle`}
      >
        <CheckIcon class="size-2.5" />
        {c().idle}
      </span>
    </span>
  );
};

/** Sum harness counts across every terminal whose `worktree_id` is in `paths`. */
export function countHarnessesForPaths(paths: Set<string>): HarnessCounts {
  let active = 0;
  let waiting = 0;
  let idle = 0;
  for (const path of paths) {
    const counts = harnessCountsForWorktree(path);
    active += counts.active;
    waiting += counts.waiting;
    idle += counts.idle;
  }
  return { active, waiting, idle };
}
