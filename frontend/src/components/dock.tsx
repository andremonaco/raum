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
import { invoke } from "@tauri-apps/api/core";

import { leafIds as treeLeafIds } from "../lib/layoutTree";
import { kindDisplayLabel, type AgentKind } from "../lib/agentKind";
import { listTerminals } from "../lib/terminalRegistry";
import {
  adoptOrphanSession,
  compactTree,
  equalizeAllRatios,
  minimizedPaneIds,
  runtimeLayoutStore,
  setFocusedPaneId,
  tileAll,
} from "../stores/runtimeLayoutStore";
import type { PaneContent, RuntimeCell } from "../stores/runtimeLayoutStore";
import { agentStore } from "../stores/agentStore";
import type { AgentState, Reliability } from "../stores/agentStore";
import { activeProjectSlug } from "../stores/projectStore";
import {
  clearTerminalClosing,
  closingTerminalIds,
  markTerminalClosing,
  terminalStore,
  type TerminalRecord,
} from "../stores/terminalStore";
import {
  AlertCircleIcon,
  CheckIcon,
  ClockIcon,
  CompactIcon,
  GridEqualIcon,
  GridTileIcon,
  HARNESS_ICONS,
  LoaderIcon,
} from "./icons";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from "./ui/tooltip";

// ── Filter mode persisted across reloads ─────────────────────────────────────
//
// Each icon in the Filter group narrows the minimized chip list to chips
// whose agent is in a matching state. `null` means "show everything, sorted
// by working priority" — the default on first launch.

export type DockFilterMode = "awaiting" | "recent" | "working";

const DOCK_FILTER_KEY = "raum:dock-filter";

function loadInitialFilter(): DockFilterMode | null {
  try {
    const v = localStorage.getItem(DOCK_FILTER_KEY);
    if (v === "awaiting" || v === "recent" || v === "working") return v;
  } catch {
    /* non-browser / blocked storage */
  }
  return null;
}

const [dockFilterMode, setDockFilterMode] = createSignal<DockFilterMode | null>(
  loadInitialFilter(),
);

export { dockFilterMode };

/**
 * Toggle a filter icon. Clicking the active filter clears it (mode → null),
 * so the same icon acts as both "on" and "off". Persisted to localStorage so
 * the choice survives a reload.
 */
export function toggleFilterMode(mode: DockFilterMode): void {
  const next = dockFilterMode() === mode ? null : mode;
  setDockFilterMode(next);
  try {
    if (next === null) localStorage.removeItem(DOCK_FILTER_KEY);
    else localStorage.setItem(DOCK_FILTER_KEY, next);
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

function resolvedCellState(cell: PaneContent): AgentState | null {
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
function resolvedCellReliability(cell: PaneContent): Reliability | null {
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

const DOCK_TOOLTIP_CLASS =
  "w-[min(24rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] overflow-hidden space-y-1 bg-surface-raised p-2 text-foreground ring-1 ring-border";

// ── Dock ──────────────────────────────────────────────────────────────────────

export interface DockProps {
  /** Off-tree minimized panes. The dock chip path used to filter the
   *  in-tree `RuntimeCell[]` by `minimizedPaneIds`; now that minimize
   *  removes the leaf from the BSP tree, those panes live exclusively in
   *  `runtimeLayoutStore.panes` and don't carry geometry — `PaneContent`
   *  is everything the dock needs. */
  minimizedPanes: readonly PaneContent[];
  /** Fires when user clicks a chip. The cell should be restored to the grid. */
  onRestore: (cellId: string) => void;
}

/**
 * Pure derivation of orphan terminal sessions for a given project. An "orphan"
 * is a backend-known tmux session that:
 *   • belongs to the active project
 *   • is **alive** (not flagged `dead` by the rehydrate path)
 *   • is **not** owned by any persisted layout tab or live layout terminal
 *
 * Dead sessions are excluded: dead-pane recovery still happens via the
 * in-pane Recover overlay if the pane is mounted.
 *
 * Pulled out of the component so unit tests exercise it without rendering.
 */
export function selectOrphanRecords(
  slug: string | undefined,
  cells: ReadonlyArray<RuntimeCell>,
  byId: Readonly<Record<string, TerminalRecord>>,
  mountedLayoutSessionIds: ReadonlySet<string> = new Set(),
  closingSessionIds: ReadonlySet<string> = new Set(),
): TerminalRecord[] {
  if (!slug) return [];
  const inLayout = new Set<string>(mountedLayoutSessionIds);
  for (const c of cells) {
    for (const t of c.tabs) {
      if (t.sessionId) inLayout.add(t.sessionId);
    }
  }
  const out: TerminalRecord[] = [];
  for (const r of Object.values(byId)) {
    if (r.dead) continue;
    if (r.project_slug !== slug) continue;
    if (inLayout.has(r.session_id)) continue;
    if (closingSessionIds.has(r.session_id)) continue;
    out.push(r);
  }
  // Most recently created sits left so the user's last-spawned orphan is
  // easiest to grab.
  out.sort((a, b) => b.created_unix - a.created_unix);
  return out;
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
    // The caller hands us only the off-tree minimized panes; defensively
    // re-filter here so a stale prop snapshot never resurrects a chip after
    // its pane was restored or removed.
    let list = props.minimizedPanes.filter((p) => ids.has(p.id)).slice();
    const mode = dockFilterMode();

    // Filter first, then apply the mode-specific ordering. When no filter is
    // active the list keeps its original working-priority order so the most
    // interesting chips sit left — matching the pre-filter behaviour.
    if (mode === "awaiting") {
      list = list.filter((c) => resolvedCellState(c) === "waiting");
      list.sort(
        (a, b) => attentionPriority(resolvedCellState(a)) - attentionPriority(resolvedCellState(b)),
      );
      return list;
    }
    if (mode === "working") {
      list = list.filter((c) => resolvedCellState(c) === "working");
      list.sort(
        (a, b) => workingPriority(resolvedCellState(a)) - workingPriority(resolvedCellState(b)),
      );
      return list;
    }
    if (mode === "recent") {
      // "Recent" is a sort + cap, not a state filter — show the most recent
      // 9 chips regardless of state so the user can jump back to whatever
      // they touched last.
      list.sort((a, b) => (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0));
      return list.slice(0, 9);
    }

    return list.sort(
      (a, b) => workingPriority(resolvedCellState(a)) - workingPriority(resolvedCellState(b)),
    );
  });

  // Orphan terminal sessions for the active project. Filter pills intentionally
  // don't apply: a live tmux session that fell out of the layout should always
  // stay reachable until the user restores or kills it.
  const orphanRecords = createMemo<TerminalRecord[]>(() => {
    void tick();
    const slug = activeProjectSlug();
    const mountedLayoutSessionIds = new Set<string>();
    for (const terminal of listTerminals()) {
      if (terminal.paneId.startsWith("orphan:")) continue;
      if (terminal.sessionId) mountedLayoutSessionIds.add(terminal.sessionId);
    }
    return selectOrphanRecords(
      slug,
      runtimeLayoutStore.cells,
      terminalStore.byId,
      mountedLayoutSessionIds,
      closingTerminalIds(),
    );
  });

  return (
    <div class="flex h-8 shrink-0 items-center bg-background" aria-label="Dock">
      <div class="flex shrink-0 items-center gap-2 px-2">
        <FilterGroup />
        <SortGroup />
      </div>
      <div class="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pr-0.5">
        <For each={minimizedCells()}>
          {(cell) => <DockChip cell={cell} tick={tick()} onRestore={props.onRestore} />}
        </For>
        <Show when={orphanRecords().length > 0 && minimizedCells().length > 0}>
          <span class="h-4 w-px shrink-0 bg-border" aria-hidden />
        </Show>
        <For each={orphanRecords()}>{(record) => <OrphanChip record={record} />}</For>
      </div>
    </div>
  );
};

// ── Filter icons ─────────────────────────────────────────────────────────────

interface FilterConfig {
  mode: DockFilterMode;
  title: string;
  icon: typeof AlertCircleIcon;
}

const FILTERS: FilterConfig[] = [
  { mode: "awaiting", title: "Show only waiting (project)", icon: AlertCircleIcon },
  { mode: "recent", title: "Show 9 most recent (project)", icon: ClockIcon },
  { mode: "working", title: "Show only working (project)", icon: LoaderIcon },
];

const FilterGroup: Component = () => {
  return (
    <div class="flex shrink-0 items-center gap-1" aria-label="Filter chips">
      <span class="text-[10px] uppercase tracking-wide text-foreground-subtle">Filter</span>
      <div class="flex items-center gap-0.5" role="group">
        <For each={FILTERS}>
          {(f) => {
            const active = () => dockFilterMode() === f.mode;
            const Icon = f.icon;
            return (
              <Tooltip>
                <TooltipTrigger
                  as="button"
                  type="button"
                  aria-pressed={active()}
                  class="flex h-6 w-6 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  classList={{
                    "bg-active text-foreground": active(),
                    "text-foreground-subtle hover:text-foreground hover:bg-hover": !active(),
                  }}
                  onClick={() => toggleFilterMode(f.mode)}
                >
                  <Icon class="size-3" />
                </TooltipTrigger>
                <TooltipPortal>
                  <TooltipContent>{f.title}</TooltipContent>
                </TooltipPortal>
              </Tooltip>
            );
          }}
        </For>
      </div>
    </div>
  );
};

// ── Sort / layout actions (grid fix-up buttons) ──────────────────────────────

const SortGroup: Component = () => {
  return (
    <div class="flex shrink-0 items-center gap-1" aria-label="Sort layout">
      <span class="text-[10px] uppercase tracking-wide text-foreground-subtle">Sort</span>
      <LayoutActions />
    </div>
  );
};

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
  cell: PaneContent;
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
        <span class="block max-w-full truncate font-mono text-[10px] text-foreground">{line}</span>
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
        <TooltipContent class={DOCK_TOOLTIP_CLASS}>
          <div class="flex min-w-0 items-center gap-1.5">
            <Icon />
            <span class="min-w-0 flex-1 truncate font-medium">{label()}</span>
            <Show when={tabCount() > 1}>
              <span class="rounded bg-active px-1 text-[9px] text-foreground-subtle">
                {tabCount()} tabs
              </span>
            </Show>
            <DockStateLabel state={state()} />
          </div>
          <Show when={tooltipSnippet()}>
            <div class="mt-1 min-w-0 space-y-0.5 overflow-hidden border-t border-border pt-1">
              {tooltipSnippet()}
            </div>
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

// ── OrphanChip ───────────────────────────────────────────────────────────────
//
// Renders an alive project session that exists on the tmux socket but
// isn't mounted in any cell of the current runtime layout. Two affordances:
//
//   • Click body  → recover into the grid via `adoptOrphanSession`.
//                   `<TerminalPane>` reattaches via `terminal_reattach` on
//                   mount.
//   • Click ×     → permanently kill the session via `terminal_kill`. The
//                   backend's `terminal-session-removed` event flows
//                   through `subscribeTerminalEvents` and the chip drops
//                   on its own — no local optimistic state.
//
// Dead sessions are filtered out upstream (`selectOrphanRecords`), so this
// component never has to handle the `dead` branch.

function shortSessionId(id: string): string {
  // Session ids look like `claude-code-1714235692-12`. Trim to a 6-char
  // suffix when there's no other label so the chip stays narrow but
  // distinguishable.
  if (id.length <= 6) return id;
  return id.slice(-6);
}

function orphanLabel(record: TerminalRecord): string {
  const kindLabel = kindDisplayLabel(record.kind as AgentKind);
  if (record.worktree_id) return `${kindLabel} · ${record.worktree_id}`;
  return `${kindLabel} · ${shortSessionId(record.session_id)}`;
}

interface OrphanChipProps {
  record: TerminalRecord;
}

const OrphanChip: Component<OrphanChipProps> = (props) => {
  const Icon = () => {
    const I = HARNESS_ICONS[props.record.kind as keyof typeof HARNESS_ICONS];
    return I ? <I class="h-3 w-3 shrink-0" /> : null;
  };

  const state = () => agentStore.sessions[props.record.session_id]?.state ?? null;
  const reliability = () => agentStore.sessions[props.record.session_id]?.reliability ?? null;

  const onAdopt = (): void => {
    const newPaneId = adoptOrphanSession({
      sessionId: props.record.session_id,
      kind: props.record.kind,
      projectSlug: props.record.project_slug ?? undefined,
      worktreeId: props.record.worktree_id ?? undefined,
    });
    setFocusedPaneId(newPaneId);
  };

  const onKill = (e: MouseEvent): void => {
    e.stopPropagation();
    const sessionId = props.record.session_id;
    markTerminalClosing(sessionId);
    void invoke("terminal_kill", { sessionId }).catch((err: unknown) => {
      clearTerminalClosing(sessionId);
      // Non-fatal — the chip stays visible until the backend confirms
      // removal. Surface to the console so a CI bisect can find the
      // root cause if this ever starts failing silently.
      console.warn("[dock] terminal_kill failed", err);
    });
  };

  return (
    <Tooltip openDelay={150} closeDelay={0} placement="top">
      <TooltipTrigger
        as="div"
        class="group flex h-6 max-w-56 shrink-0 items-center rounded-md bg-surface-raised text-[10px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
      >
        <button
          type="button"
          class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={onAdopt}
          title="Restore to grid"
        >
          <Icon />
          <DockStateIndicator state={state()} reliability={reliability()} />
          <span class="min-w-0 truncate text-[10px]">{orphanLabel(props.record)}</span>
        </button>
        <button
          type="button"
          aria-label={`Close ${orphanLabel(props.record)}`}
          class="mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[12px] leading-none text-foreground-dim opacity-0 transition-opacity hover:bg-active hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
          onClick={onKill}
        >
          ×
        </button>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent class={DOCK_TOOLTIP_CLASS}>
          <div class="flex min-w-0 items-center gap-1.5">
            <Icon />
            <span class="min-w-0 flex-1 truncate font-medium">
              {orphanLabel(props.record)} — not in grid
            </span>
            <DockStateLabel state={state()} />
          </div>
          <p class="text-[9px] text-foreground-dim">Click to restore into the grid; × to kill</p>
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
