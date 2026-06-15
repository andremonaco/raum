/**
 * §9 — quiet three-way view switcher inside an expanded worktree row.
 * Deliberately NOT `ui/tabs.tsx`: the Kobalte wrapper carries h-7 chrome,
 * borders, and an animated shadowed indicator — exactly the loud tab styling
 * this sidebar avoids — and its `Tabs.Content` unmounts inactive panels,
 * which would defeat the keep-alive panels in `worktree-expanded.tsx`.
 * Selection reads purely as a slightly lighter tile on a slightly sunken
 * track.
 */

import { Component, For } from "solid-js";

import type { SegmentedSwitcherProps } from "./types";

export const SegmentedSwitcher: Component<SegmentedSwitcherProps> = (props) => {
  const move = (dir: 1 | -1) => {
    const idx = props.tabs.findIndex((t) => t.id === props.active);
    const next = props.tabs[(idx + dir + props.tabs.length) % props.tabs.length];
    if (next) props.onChange(next.id);
  };

  return (
    <div
      role="tablist"
      aria-label="Worktree views"
      class="flex h-6 w-full items-center gap-0.5 rounded-md bg-surface-sunken/60 p-0.5"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      <For each={props.tabs}>
        {(t) => (
          <button
            type="button"
            role="tab"
            aria-selected={props.active === t.id}
            tabIndex={props.active === t.id ? 0 : -1}
            class="focus-ring h-5 min-w-0 flex-1 truncate rounded px-1.5 font-mono text-[10px] uppercase tracking-wide transition-colors"
            classList={{
              "bg-hover text-foreground": props.active === t.id,
              "text-foreground-dim hover:text-foreground-subtle": props.active !== t.id,
            }}
            onClick={() => props.onChange(t.id)}
          >
            {t.label}
          </button>
        )}
      </For>
    </div>
  );
};
