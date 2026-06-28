/**
 * §4 — icon-only underline tab bar (replaces the sunken-pill `SegmentedSwitcher`).
 *
 * Three evenly-spread icons (Changes / History / Files); the label is exposed as
 * a tooltip + `aria-label` rather than rendered text, so the bar stays quiet.
 *
 * Restraint rule (`styles.css:553`): the ONLY active emphasis is a thin
 * foreground-tint under-segment (`--tab-underline`, the 35% os-theme-raum
 * idle-scrollbar intensity) painted on top of a full-width hairline baseline
 * rail. No pill, fill, accent hue, or glow. Inactive tabs are
 * `text-foreground-dim`, hover lifts to `text-foreground-subtle`.
 *
 * Keyboard: ArrowLeft/ArrowRight roving-tabindex `move()` preserved verbatim
 * from `SegmentedSwitcher`, with `aria-selected` + `role="tab"`.
 */

import { Component, For } from "solid-js";
import { Dynamic } from "solid-js/web";

import type { ViewTabBarProps } from "./types";

export const ViewTabBar: Component<ViewTabBarProps> = (props) => {
  // Roving move: wrap-around step through the tab list. Identical semantics to
  // the retired SegmentedSwitcher so muscle memory carries over.
  const move = (dir: 1 | -1) => {
    const idx = props.tabs.findIndex((t) => t.id === props.active);
    const next = props.tabs[(idx + dir + props.tabs.length) % props.tabs.length];
    if (next) props.onChange(next.id);
  };

  return (
    <div
      role="tablist"
      aria-label="Worktree views"
      // `sticky top-0` pins the bar to the top of the open worktree tab's
      // single scroll viewport so it never scrolls away (§8) while the tab state
      // lives in WorktreeDetail (its keep-alive owner). `bg-background` masks the
      // rows scrolling beneath it.
      class="sticky top-0 z-10 flex h-8 shrink-0 items-stretch gap-1 border-b border-border-subtle bg-background px-1"
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
            aria-label={t.label}
            title={t.label}
            tabIndex={props.active === t.id ? 0 : -1}
            // `-mb-px` pulls the 1.5px under-segment over the rail's hairline so
            // the active border sits *on* the baseline, not below it.
            class="focus-ring -mb-px flex flex-1 items-center justify-center border-b-[1.5px] py-1.5 transition-colors"
            classList={{
              "text-foreground border-[color:var(--tab-underline)]": props.active === t.id,
              "text-foreground-dim hover:text-foreground-subtle border-transparent":
                props.active !== t.id,
            }}
            onClick={() => props.onChange(t.id)}
          >
            <Dynamic component={t.icon} class="size-4" />
          </button>
        )}
      </For>
    </div>
  );
};
