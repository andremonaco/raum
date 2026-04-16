/**
 * Bottom dock that shows minimized panes as compact, contextual chips.
 *
 * Each chip displays:
 *   - Harness icon (shell / claude-code / codex / opencode)
 *   - Live state badge (spinner=working, alert=waiting, check=idle, red=errored)
 *   - Content snippet captured at minimize-time from the xterm buffer
 *   - Relative timestamp of last activity
 *
 * Hover opens a tooltip with 3 lines of snippet context, state, and tab count.
 * Click restores the pane into the grid.
 *
 * The dock is only rendered when at least one pane is minimized.
 *
 * Sort order: waiting first (needs attention), then working, then idle/rest —
 * mirrors the urgency-priority used in Warp's vertical tabs.
 */

import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import { runtimeLayoutStore, minimizedPaneIds } from "../stores/runtimeLayoutStore";
import type { RuntimeCell } from "../stores/runtimeLayoutStore";
import { agentStore } from "../stores/agentStore";
import type { AgentState } from "../stores/agentStore";
import { AlertCircleIcon, CheckIcon, LoaderIcon, HARNESS_ICONS } from "./icons";
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from "./ui/tooltip";

// ── Relative timestamp helpers ────────────────────────────────────────────────

function relativeTime(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ── State priority for sort order ─────────────────────────────────────────────

function statePriority(state: AgentState | null): number {
  if (state === "waiting") return 0;
  if (state === "working") return 1;
  if (state === "errored") return 2;
  return 3; // idle / completed / null
}

// ── Cell-level state (resolved across all tabs of the cell) ──────────────────

function resolvedCellState(cell: RuntimeCell): AgentState | null {
  let best: AgentState | null = null;
  for (const tab of cell.tabs) {
    const s = tab.sessionId ? (agentStore.sessions[tab.sessionId]?.state ?? null) : null;
    if (best === null || statePriority(s) < statePriority(best)) best = s;
  }
  return best;
}

// ── MinimizedDock ─────────────────────────────────────────────────────────────

export interface MinimizedDockProps {
  /** Fires when user clicks a chip. The cell should be restored to the grid. */
  onRestore: (cellId: string) => void;
}

export const MinimizedDock: Component<MinimizedDockProps> = (props) => {
  // Tick signal so relative timestamps re-compute every second.
  const [tick, setTick] = createSignal(0);
  onMount(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    onCleanup(() => clearInterval(id));
  });

  const minimizedCells = createMemo(() => {
    void tick(); // subscribe to tick so memo refreshes timestamps
    const ids = minimizedPaneIds();
    return runtimeLayoutStore.cells
      .filter((c) => ids.has(c.id))
      .slice()
      .sort((a, b) => statePriority(resolvedCellState(a)) - statePriority(resolvedCellState(b)));
  });

  return (
    <Show when={minimizedCells().length > 0}>
      <div
        class="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-zinc-800 bg-zinc-950/80 px-2 py-1.5"
        aria-label="Minimized panes"
      >
        <span class="shrink-0 pr-1 text-[9px] uppercase tracking-widest text-zinc-600">Dock</span>
        <For each={minimizedCells()}>
          {(cell) => <DockChip cell={cell} tick={tick()} onRestore={props.onRestore} />}
        </For>
      </div>
    </Show>
  );
};

// ── DockChip ──────────────────────────────────────────────────────────────────

interface DockChipProps {
  cell: RuntimeCell;
  tick: number;
  onRestore: (cellId: string) => void;
}

const DockChip: Component<DockChipProps> = (props) => {
  const Icon = () => {
    const I = HARNESS_ICONS[props.cell.kind as keyof typeof HARNESS_ICONS];
    return I ? <I class="h-3 w-3 shrink-0" /> : null;
  };

  const state = () => resolvedCellState(props.cell);

  const snippet = () => props.cell.lastSnippet ?? "";
  const timestamp = () =>
    props.cell.lastActivityMs ? relativeTime(props.cell.lastActivityMs) : "";

  const label = () => props.cell.title ?? props.cell.kind;

  const tabCount = () => props.cell.tabs.length;

  // Tooltip content: up to 3 lines of snippet + state + tab badge.
  const tooltipSnippet = () => {
    const s = snippet();
    if (!s) return null;
    return s
      .split(" ↵ ")
      .map((line) => (
        <span class="block max-w-xs truncate font-mono text-[10px] text-zinc-300">{line}</span>
      ));
  };

  return (
    <Tooltip openDelay={150} closeDelay={0} placement="top">
      <TooltipTrigger
        as="button"
        type="button"
        class="flex h-7 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-600"
        onClick={() => props.onRestore(props.cell.id)}
        title={`Restore ${label()}`}
      >
        <Icon />
        <DockStateIndicator state={state()} />
        <Show when={snippet()}>
          <span class="min-w-0 truncate font-mono text-[10px] text-zinc-500">{snippet()}</span>
        </Show>
        <Show when={!snippet()}>
          <span class="min-w-0 truncate text-[10px]">{label()}</span>
        </Show>
        <Show when={timestamp()}>
          <span class="ml-auto shrink-0 text-[9px] text-zinc-600">{timestamp()}</span>
        </Show>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent class="max-w-xs space-y-1 bg-zinc-900 p-2 text-zinc-300 ring-1 ring-zinc-700">
          <div class="flex items-center gap-1.5">
            <Icon />
            <span class="font-medium">{label()}</span>
            <Show when={tabCount() > 1}>
              <span class="rounded bg-zinc-800 px-1 text-[9px] text-zinc-500">
                {tabCount()} tabs
              </span>
            </Show>
            <DockStateLabel state={state()} />
          </div>
          <Show when={tooltipSnippet()}>
            <div class="mt-1 space-y-0.5 border-t border-zinc-800 pt-1">{tooltipSnippet()}</div>
          </Show>
          <Show when={timestamp()}>
            <p class="text-[9px] text-zinc-600">{timestamp()}</p>
          </Show>
          <p class="text-[9px] text-zinc-600">Click to restore</p>
        </TooltipContent>
      </TooltipPortal>
    </Tooltip>
  );
};

// ── State badge (compact dot in chip) ────────────────────────────────────────

function DockStateIndicator(props: { state: AgentState | null }) {
  return (
    <span class="flex shrink-0 items-center">
      <Show when={props.state === "working"}>
        <LoaderIcon class="h-3 w-3 animate-spin text-emerald-400" />
      </Show>
      <Show when={props.state === "waiting"}>
        <AlertCircleIcon class="h-3 w-3 text-amber-400" />
      </Show>
      <Show when={props.state === "errored"}>
        <AlertCircleIcon class="h-3 w-3 text-red-400" />
      </Show>
      <Show when={props.state === "idle" || props.state === "completed" || props.state === null}>
        <CheckIcon class="h-3 w-3 text-zinc-600" />
      </Show>
    </span>
  );
}

// ── State label (verbose, used in tooltip) ────────────────────────────────────

function DockStateLabel(props: { state: AgentState | null }) {
  const label = () => {
    switch (props.state) {
      case "working":
        return { text: "working", cls: "text-emerald-400" };
      case "waiting":
        return { text: "needs input", cls: "text-amber-400" };
      case "errored":
        return { text: "errored", cls: "text-red-400" };
      case "completed":
        return { text: "done", cls: "text-sky-400" };
      default:
        return { text: "idle", cls: "text-zinc-500" };
    }
  };
  return (
    <span class={`ml-auto text-[9px] uppercase tracking-wide ${label().cls}`}>{label().text}</span>
  );
}
