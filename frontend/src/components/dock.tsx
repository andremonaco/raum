/**
 * Bottom dock.
 *
 * Always-mounted strip at the bottom of the terminal grid. Houses:
 *
 *   • Sort pills (Working / Recent / Attention) — reorders the chip list.
 *     The selection persists to localStorage so it survives a reload.
 *   • Layout actions (Equalize / Tile / Compact) — grid-wide fix-ups that
 *     dispatch to runtimeLayoutStore mutations. Equalize preserves the
 *     topology and just snaps dividers to even ratios; Tile rebuilds the
 *     tree as a near-square grid; Compact flattens redundant splits.
 *     Disabled when the tree has fewer than two panes.
 *   • A horizontally-scrolling row of chips for every minimized pane. Each
 *     chip shows the harness icon, a live state badge, the output snippet
 *     captured at minimize-time, and a relative timestamp. Click restores
 *     the pane into the grid.
 *
 * Sort pills + layout actions sit in a pinned left cluster so they stay
 * visible regardless of how many minimized chips are in the scrolling row.
 */

import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import { leafIds as treeLeafIds } from "../lib/layoutTree";
import {
  compactTree,
  equalizeAllRatios,
  minimizedPaneIds,
  runtimeLayoutStore,
  tileAll,
} from "../stores/runtimeLayoutStore";
import type { RuntimeCell } from "../stores/runtimeLayoutStore";
import { agentStore } from "../stores/agentStore";
import type { AgentState, Reliability } from "../stores/agentStore";
import {
  AlertCircleIcon,
  CheckIcon,
  CompactIcon,
  GridEqualIcon,
  GridTileIcon,
  HARNESS_ICONS,
  LoaderIcon,
} from "./icons";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from "./ui/tooltip";

// ── Sort mode persisted across reloads ───────────────────────────────────────

export type DockSortMode = "working" | "recent" | "attention";

const DOCK_SORT_KEY = "raum:dock-sort";

function loadInitialSort(): DockSortMode {
  try {
    const v = localStorage.getItem(DOCK_SORT_KEY);
    if (v === "working" || v === "recent" || v === "attention") return v;
  } catch {
    /* non-browser / blocked storage */
  }
  return "working";
}

const [dockSortMode, setDockSortMode] = createSignal<DockSortMode>(loadInitialSort());

export { dockSortMode };

export function setSortMode(mode: DockSortMode): void {
  setDockSortMode(mode);
  try {
    localStorage.setItem(DOCK_SORT_KEY, mode);
  } catch {
    /* ignore — the signal still drives the UI for this session */
  }
}

// ── Relative timestamp helpers ────────────────────────────────────────────────

function relativeTime(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ── State priority tables ────────────────────────────────────────────────────

/** Default order — "what's actively moving" floats left. */
function workingPriority(state: AgentState | null): number {
  if (state === "working") return 0;
  if (state === "waiting") return 1;
  if (state === "errored") return 2;
  return 3; // idle / completed / null
}

/** Attention-first — things that need the human surface left. */
function attentionPriority(state: AgentState | null): number {
  if (state === "waiting") return 0;
  if (state === "errored") return 1;
  if (state === "working") return 2;
  return 3;
}

// ── Cell-level state (resolved across all tabs of the cell) ──────────────────

function resolvedCellState(cell: RuntimeCell): AgentState | null {
  let best: AgentState | null = null;
  let bestP = Infinity;
  for (const tab of cell.tabs) {
    const s = tab.sessionId ? (agentStore.sessions[tab.sessionId]?.state ?? null) : null;
    const p = workingPriority(s);
    if (p < bestP) {
      best = s;
      bestP = p;
    }
  }
  return best;
}

/**
 * Reliability of the winning tab for this cell (the one that drove the
 * resolved state). Used by the Waiting-state badge to distinguish a
 * deterministic hook-driven wait from a silence-heuristic guess.
 */
function resolvedCellReliability(cell: RuntimeCell): Reliability | null {
  let bestP = Infinity;
  let reliability: Reliability | null = null;
  for (const tab of cell.tabs) {
    const session = tab.sessionId ? agentStore.sessions[tab.sessionId] : undefined;
    const s = session?.state ?? null;
    const p = workingPriority(s);
    if (p < bestP) {
      bestP = p;
      reliability = session?.reliability ?? null;
    }
  }
  return reliability;
}

// ── Dock ──────────────────────────────────────────────────────────────────────

export interface DockProps {
  /** Fires when user clicks a chip. The cell should be restored to the grid. */
  onRestore: (cellId: string) => void;
}

export const Dock: Component<DockProps> = (props) => {
  // Tick so relative timestamps re-compute every second.
  const [tick, setTick] = createSignal(0);
  onMount(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    onCleanup(() => clearInterval(id));
  });

  const minimizedCells = createMemo(() => {
    void tick(); // refresh timestamps
    const ids = minimizedPaneIds();
    const list = runtimeLayoutStore.cells.filter((c) => ids.has(c.id)).slice();
    const mode = dockSortMode();
    if (mode === "recent") {
      return list.sort((a, b) => (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0));
    }
    if (mode === "attention") {
      return list.sort(
        (a, b) => attentionPriority(resolvedCellState(a)) - attentionPriority(resolvedCellState(b)),
      );
    }
    return list.sort(
      (a, b) => workingPriority(resolvedCellState(a)) - workingPriority(resolvedCellState(b)),
    );
  });

  return (
    <div class="flex h-8 shrink-0 items-center bg-background" aria-label="Dock">
      <div class="flex shrink-0 items-center gap-1.5 px-2">
        <SortPills />
        <LayoutActions />
      </div>
      <div class="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pr-0.5">
        <For each={minimizedCells()}>
          {(cell) => <DockChip cell={cell} tick={tick()} onRestore={props.onRestore} />}
        </For>
      </div>
    </div>
  );
};

// ── Sort pills ────────────────────────────────────────────────────────────────

interface PillConfig {
  mode: DockSortMode;
  label: string;
  title: string;
}

const PILLS: PillConfig[] = [
  { mode: "working", label: "Working", title: "Currently working first" },
  { mode: "recent", label: "Recent", title: "Most recent activity first" },
  { mode: "attention", label: "Attention", title: "Waiting / errored first" },
];

const SortPills: Component = () => {
  return (
    <div class="flex shrink-0 items-center gap-1" role="tablist" aria-label="Sort dock">
      <For each={PILLS}>
        {(pill) => {
          const active = () => dockSortMode() === pill.mode;
          return (
            <button
              type="button"
              role="tab"
              aria-selected={active()}
              title={pill.title}
              class="rounded px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              classList={{
                "bg-active text-foreground": active(),
                "text-foreground-subtle hover:text-foreground hover:bg-hover": !active(),
              }}
              onClick={() => setSortMode(pill.mode)}
            >
              {pill.label}
            </button>
          );
        }}
      </For>
    </div>
  );
};

// ── Layout actions (grid fix-up buttons) ─────────────────────────────────────

const LayoutActions: Component = () => {
  const leafCount = createMemo(() => treeLeafIds(runtimeLayoutStore.tree).length);
  const disabled = () => leafCount() < 2;

  return (
    <div class="flex shrink-0 items-center gap-0.5" role="group" aria-label="Grid layout actions">
      <Tooltip>
        <TooltipTrigger
          as={Button}
          type="button"
          variant="ghost"
          class="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          onClick={() => equalizeAllRatios()}
          aria-label="Equalize"
          disabled={disabled()}
        >
          <GridEqualIcon class="size-3" />
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent>
            Equalize
            <span class="ml-1 opacity-70">keep layout, even out pane sizes</span>
          </TooltipContent>
        </TooltipPortal>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          as={Button}
          type="button"
          variant="ghost"
          class="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          onClick={() => tileAll()}
          aria-label="Tile grid"
          disabled={disabled()}
        >
          <GridTileIcon class="size-3" />
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent>
            Tile grid
            <span class="ml-1 opacity-70">rebuild as a near-square grid</span>
          </TooltipContent>
        </TooltipPortal>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          as={Button}
          type="button"
          variant="ghost"
          class="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          onClick={() => compactTree()}
          aria-label="Compact"
          disabled={disabled()}
        >
          <CompactIcon class="size-3" />
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent>
            Compact
            <span class="ml-1 opacity-70">flatten redundant splits</span>
          </TooltipContent>
        </TooltipPortal>
      </Tooltip>
    </div>
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
  const reliability = () => resolvedCellReliability(props.cell);

  const snippet = () => props.cell.lastSnippet ?? "";
  const timestamp = () =>
    props.cell.lastActivityMs ? relativeTime(props.cell.lastActivityMs) : "";

  const label = () => props.cell.title ?? props.cell.kind;

  const tabCount = () => props.cell.tabs.length;

  const tooltipSnippet = () => {
    const s = snippet();
    if (!s) return null;
    return s
      .split(" ↵ ")
      .map((line) => (
        <span class="block max-w-xs truncate font-mono text-[10px] text-foreground">{line}</span>
      ));
  };

  return (
    <Tooltip openDelay={150} closeDelay={0} placement="top">
      <TooltipTrigger
        as="button"
        type="button"
        class="flex h-6 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-surface-raised px-2 text-[10px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => props.onRestore(props.cell.id)}
        title={`Restore ${label()}`}
      >
        <Icon />
        <DockStateIndicator state={state()} reliability={reliability()} />
        <Show when={snippet()}>
          <span class="min-w-0 truncate font-mono text-[10px] text-foreground-subtle">
            {snippet()}
          </span>
        </Show>
        <Show when={!snippet()}>
          <span class="min-w-0 truncate text-[10px]">{label()}</span>
        </Show>
        <Show when={timestamp()}>
          <span class="ml-auto shrink-0 text-[9px] text-foreground-dim">{timestamp()}</span>
        </Show>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent class="max-w-xs space-y-1 bg-surface-raised p-2 text-foreground ring-1 ring-border">
          <div class="flex items-center gap-1.5">
            <Icon />
            <span class="font-medium">{label()}</span>
            <Show when={tabCount() > 1}>
              <span class="rounded bg-active px-1 text-[9px] text-foreground-subtle">
                {tabCount()} tabs
              </span>
            </Show>
            <DockStateLabel state={state()} />
          </div>
          <Show when={tooltipSnippet()}>
            <div class="mt-1 space-y-0.5 border-t border-border pt-1">{tooltipSnippet()}</div>
          </Show>
          <Show when={timestamp()}>
            <p class="text-[9px] text-foreground-dim">{timestamp()}</p>
          </Show>
          <p class="text-[9px] text-foreground-dim">Click to restore</p>
        </TooltipContent>
      </TooltipPortal>
    </Tooltip>
  );
};

// ── State badge (compact dot in chip) ────────────────────────────────────────

function DockStateIndicator(props: { state: AgentState | null; reliability: Reliability | null }) {
  // Waiting-state reliability ring (per-harness notification plan, Phase 1):
  //   • Heuristic (silence fallback)        → dotted ring
  //   • Deterministic / event-driven / null → solid ring (fallback)
  // The ring is a tiny visual cue around the exclamation icon; it stays
  // invisible outside the Waiting state.
  const waitingRingClass = () => {
    if (props.reliability === "heuristic") {
      return "rounded-full ring-1 ring-dotted ring-amber-500/70";
    }
    return "rounded-full ring-1 ring-amber-400/70";
  };
  const waitingTitle = () => {
    switch (props.reliability) {
      case "heuristic":
        return "Waiting (silence heuristic)";
      case "event-driven":
        return "Waiting (event stream)";
      case "deterministic":
      default:
        return "Waiting";
    }
  };
  return (
    <span class="flex shrink-0 items-center">
      <Show when={props.state === "working"}>
        <LoaderIcon class="h-3 w-3 animate-spin text-success" />
      </Show>
      <Show when={props.state === "waiting"}>
        <span class={waitingRingClass()} title={waitingTitle()} aria-label={waitingTitle()}>
          <AlertCircleIcon class="h-3 w-3 text-warning" />
        </span>
      </Show>
      <Show when={props.state === "errored"}>
        <AlertCircleIcon class="h-3 w-3 text-destructive" />
      </Show>
      <Show when={props.state === "idle" || props.state === "completed" || props.state === null}>
        <CheckIcon class="h-3 w-3 text-foreground-dim" />
      </Show>
    </span>
  );
}

// ── State label (verbose, used in tooltip) ────────────────────────────────────

function DockStateLabel(props: { state: AgentState | null }) {
  const label = () => {
    switch (props.state) {
      case "working":
        return { text: "working", cls: "text-success" };
      case "waiting":
        return { text: "needs input", cls: "text-warning" };
      case "errored":
        return { text: "errored", cls: "text-destructive" };
      case "completed":
        return { text: "done", cls: "text-info" };
      default:
        return { text: "idle", cls: "text-foreground-subtle" };
    }
  };
  return (
    <span class={`ml-auto text-[9px] uppercase tracking-wide ${label().cls}`}>{label().text}</span>
  );
}
