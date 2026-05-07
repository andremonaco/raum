/**
 * §9 — "All terminals" aggregate row.
 *
 * Aggregate row at the top of a project's worktree list that represents
 * "every terminal for this project across every worktree". Clicking switches
 * the sidebar scope back to `all`, which drops the worktree-level prune in
 * the terminal grid.
 */

import { Component, Show, createMemo } from "solid-js";
import { setActiveWorktreeAll } from "../../stores/worktreeStore";
import { GridEqualIcon } from "../icons";
import { HarnessCounter } from "./harness-counter";
import type { AllTerminalsRowProps } from "./types";

export const AllTerminalsRow: Component<AllTerminalsRowProps> = (rowProps) => {
  const total = createMemo(() => {
    const c = rowProps.counts;
    return c.active + c.waiting + c.idle;
  });
  return (
    <li class="relative select-none">
      <button
        type="button"
        class="flex w-full items-center gap-1.5 rounded px-1.5 py-1.5 text-left hover:bg-hover"
        classList={{ "sidebar-row-active": rowProps.isActive }}
        aria-current={rowProps.isActive ? "true" : undefined}
        onClick={() => setActiveWorktreeAll(rowProps.projectSlug)}
        title="Show terminals across all worktrees; new spawns land in the project root"
      >
        <GridEqualIcon class="size-3 shrink-0 text-foreground-dim" />
        <span
          class="flex-1 truncate font-mono text-xs"
          classList={{
            "text-foreground": rowProps.isActive,
            "text-muted-foreground": !rowProps.isActive,
          }}
        >
          All terminals
        </span>
        <Show when={total() > 0}>
          <HarnessCounter counts={rowProps.counts} compact />
        </Show>
      </button>
    </li>
  );
};
