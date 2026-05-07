/**
 * `<PromptOverlay>` — glanceable banner that floats above an agent
 * pane's xterm canvas showing the **first** user prompt (the original
 * task) and the **last** user prompt (most recent direction).
 *
 * Visibility is parent-controlled via the `visible` prop, which is
 * driven by the global `mouseIdle()` signal so any mouse movement
 * fades every overlay out at once. The overlay itself is
 * `pointer-events: none`, so xterm continues to receive mouse and
 * focus events normally.
 *
 * Layout adapts to the pane's shape via a CSS container query: the
 * overlay declares itself a container, and the inner content switches
 * from a stacked layout to a two-column grid as soon as the overlay's
 * own width passes ~480 px. There's no JS observer — the browser
 * recomputes the columns automatically on every resize, so the rule
 * works on any pane shape without hand-picked pixel thresholds.
 *
 * Both rows always get equal width (in two-column mode) and equal
 * line-clamp (in either mode), so the Task and Latest prompts read as
 * a balanced pair even when one is much shorter than the other.
 *
 * Data sources are reused as-is:
 *   - First prompt: `firstPromptForSession()` / `ensureFirstPromptLoaded()`
 *     from `firstPromptCache` (lazy Tauri fetch, immutable).
 *   - Last prompt: `terminalStore.byId[sessionId]?.lastPrompt?.text`,
 *     kept fresh by the existing `pane:prompt-updated` event listener.
 */

import { Component, For, Show, createEffect, createMemo } from "solid-js";
import { ensureFirstPromptLoaded, firstPromptForSession } from "../lib/firstPromptCache";
import { terminalStore } from "../stores/terminalStore";

export interface PromptOverlayProps {
  sessionId: string | null | undefined;
  visible: boolean;
}

/** Trim whitespace and collapse so duplicate detection works robustly. */
function normalize(text: string | null | undefined): string {
  if (!text) return "";
  return text.trim().replace(/\s+/g, " ");
}

interface OverlayRow {
  label: string;
  text: string;
}

const PromptOverlay: Component<PromptOverlayProps> = (props) => {
  const lastPrompt = createMemo<string | null>(() => {
    if (!props.sessionId) return null;
    return terminalStore.byId[props.sessionId]?.lastPrompt?.text ?? null;
  });

  // Defer the first-prompt fetch until the live `UserPromptSubmit`
  // hook has fired at least once for this pane. Why this matters:
  //
  // The backend resolves "first prompt" by picking the newest
  // harness-side transcript file (e.g. `~/.claude/projects/<cwd>/*.jsonl`)
  // for the pane's worktree. That heuristic only identifies the
  // *correct* session AFTER the new pane has touched its own
  // transcript — which only happens once the user submits a prompt.
  //
  // Without this gate, a brand-new harness with no submitted prompt
  // resolves to a previous session's transcript and the overlay
  // surfaces somebody else's task. Tying the fetch to `lastPrompt`
  // means the lookup only runs when our own jsonl is guaranteed to
  // exist and be the newest in the directory.
  createEffect(() => {
    if (lastPrompt()) {
      ensureFirstPromptLoaded(props.sessionId);
    }
  });

  const firstPrompt = createMemo<string | null>(() => {
    // Mirror the gate above — never expose a cached first prompt for
    // a pane that hasn't had a hook fire (e.g. a stale entry from a
    // previous mount or test seed).
    if (!lastPrompt()) return null;
    const cached = firstPromptForSession(props.sessionId);
    return cached ?? null;
  });

  // Build the list of rows to render. The whole banner is gated on
  // `lastPrompt` — an empty harness (no prompt submitted) shows
  // nothing, which is what the user expects on a fresh pane. Once a
  // prompt lands, render Task + Latest, deduping when they match.
  const rows = createMemo<OverlayRow[]>(() => {
    const last = lastPrompt();
    if (!last) return [];
    const first = firstPrompt();
    if (first && normalize(first) !== normalize(last)) {
      return [
        { label: "Task", text: first },
        { label: "Latest", text: last },
      ];
    }
    // first === last, or first not yet loaded — show the prompt once,
    // labeled as the original directive.
    return [{ label: "Task", text: first ?? last }];
  });

  return (
    <Show when={rows().length > 0}>
      {/*
        Aesthetic: a quiet floating card. No border, no ring — the
        `--shadow-lg` token bundles a 1px outline that reads as a ring
        on translucent surfaces, so we use `--shadow-md` and let
        depth come from a generous backdrop-blur and a soft drop
        shadow alone.

        Three calm signals make the banner unmistakably "overlay" over
        any terminal theme:
          1. Heavy `backdrop-blur-xl` softens the live xterm text
             behind into a glassy texture.
          2. `bg-popover/80` is meaningfully lighter than `--background`
             without resorting to a hard-edged surface change.
          3. A wide, soft drop shadow falls onto the canvas below,
             implying float without underlining the edge.

        `@container` makes the overlay itself the query target so the
        column count tracks the pane's actual width with no JS.
      */}
      <div
        class="@container pointer-events-none absolute inset-x-3 top-3 z-[15] overflow-hidden rounded-md bg-popover/80 px-4 py-3 shadow-[var(--shadow-md)] backdrop-blur-xl transition-opacity duration-200"
        classList={{ "opacity-100": props.visible, "opacity-0": !props.visible }}
        aria-hidden={!props.visible}
        data-testid="prompt-overlay"
      >
        <div class="grid grid-cols-1 gap-x-5 gap-y-2.5 @[480px]:grid-cols-2">
          <For each={rows()}>
            {(row) => (
              <div
                class="min-w-0"
                // When only one row exists (no Latest, or Latest matches
                // Task), span the whole grid so wide panes don't leave
                // a dead empty column to the right of the lone Task.
                classList={{ "@[480px]:col-span-2": rows().length === 1 }}
              >
                <div class="text-[10px] font-medium uppercase tracking-[0.18em] text-foreground/40">
                  {row.label}
                </div>
                <div class="mt-0.5 line-clamp-3 whitespace-pre-wrap text-[13px] leading-snug text-foreground/90 @[480px]:line-clamp-4">
                  {row.text}
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
};

export default PromptOverlay;
