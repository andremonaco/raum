import { Component, Show } from "solid-js";

import { TooltipContent } from "../ui/tooltip";

/**
 * Hover card for a pane tab: the tab label plus a clamped preview of the
 * last submitted prompt. The text is already capped by `formatPromptPreview`;
 * the `max-h` / `overflow-wrap` here are the second line of defence so an
 * unbroken URL or hash can't push the card past its box.
 */
export const TabTooltipContent: Component<{ label?: string; prompt?: string }> = (props) => (
  <TooltipContent class="max-h-64 max-w-md overflow-hidden">
    <Show when={props.label}>
      <div class="text-[10px] font-medium uppercase tracking-wide [overflow-wrap:anywhere]">
        {props.label}
      </div>
    </Show>
    <Show when={props.prompt}>
      <div
        class="whitespace-pre-wrap text-[11px] leading-snug text-popover-foreground/85 [overflow-wrap:anywhere]"
        classList={{ "mt-1": !!props.label }}
      >
        {props.prompt}
      </div>
    </Show>
  </TooltipContent>
);
