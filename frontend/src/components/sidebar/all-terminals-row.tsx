/**
 * §9 — "All scopes" aggregate divider.
 *
 * Sits between the worktree toolbar and the worktree list as a labelled
 * separator rather than a free-floating row: just the harness counter riding a
 * hairline rule, no text or icon. It represents "every terminal for this
 * project across every worktree" — clicking switches the sidebar scope
 * back to `all`, which drops the worktree-level prune in the terminal grid and
 * brings every worktree's terminals into focus. A tooltip carries the meaning
 * the dropped label used to. Doubling as the toolbar/list divider keeps it
 * embedded in the chrome instead of reading as another tappable worktree row.
 */

import { Component } from "solid-js";
import { setActiveWorktreeAll } from "../../stores/worktreeStore";
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from "../ui/tooltip";
import { HarnessCounter } from "./harness-counter";
import type { AllTerminalsRowProps } from "./types";

export const AllTerminalsRow: Component<AllTerminalsRowProps> = (rowProps) => {
  const lineClass = () =>
    rowProps.isActive ? "h-px flex-1 bg-border-strong" : "h-px flex-1 bg-border-subtle";
  return (
    <li class="relative select-none">
      <Tooltip>
        <TooltipTrigger
          as="button"
          type="button"
          class="flex w-full items-center gap-2.5 rounded px-1.5 py-1.5 hover:bg-hover"
          aria-current={rowProps.isActive ? "true" : undefined}
          aria-label={`All terminals across every worktree in ${rowProps.projectName}`}
          onClick={() => setActiveWorktreeAll(rowProps.projectSlug)}
        >
          <span class={lineClass()} />
          <HarnessCounter counts={rowProps.counts} compact />
          <span class={lineClass()} />
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent>
            All terminals across every worktree in {rowProps.projectName} · click to focus all
          </TooltipContent>
        </TooltipPortal>
      </Tooltip>
    </li>
  );
};
