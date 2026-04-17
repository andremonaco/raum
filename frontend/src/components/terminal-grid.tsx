/**
 * §10 — `<TerminalGrid>` Solid component.
 *
 * Wraps Gridstack via `lib/gridstackAdapter`. Each cell renders a
 * `<TerminalPane>` (owned by Wave 3A). Geometry is driven by
 * `runtimeLayoutStore`; drags and resizes patch that store in-memory and
 * never mutate `layouts.toml` directly (§10.6). The "Save" toolbar wires to
 * `layoutPresetStore.savePreset` which takes care of the 500 ms debounce.
 *
 * Maximize support (§10.7.1): double-clicking the pane *chrome* (the border
 * handle, NOT the xterm body) toggles maximize. When maximized, siblings are
 * hidden via `hidden` class on their gridstack item. Maximize is
 * volatile — not persisted across worktree switches — and lives in the
 * runtime store.
 *
 * Focus hotkeys (§10.7) dispatch `focus-pane-<n>` / `cycle-focus-*` actions
 * through window `CustomEvent`s that the Wave 3E keymap provider also emits;
 * we catch both paths here.
 *
 * Tmux resize (§10.8) is handled exclusively by `<TerminalPane>` via its
 * internal `ResizeObserver` + FitAddon. The grid used to also push an
 * approximate `terminal_resize` on `onResizeStop`, but that raced the pane's
 * measurement and drove Ink-based harnesses (Claude Code, Codex, OpenCode) to
 * repaint their banner at the wrong size first — stacking duplicates in
 * scrollback. Single resize path = single SIGWINCH per settle.
 */

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import { TerminalPane } from "./terminal-pane";
import { initGrid, onChange, type GridHandle } from "../lib/gridstackAdapter";
import {
  addCellTab,
  cycleFocus,
  focusedPaneId,
  focusPaneByIndex,
  maximizedPaneId,
  minimizedPaneIds,
  nextCellId,
  nextTabId,
  patchGeometry,
  removeCell,
  removeCellTab,
  runtimeLayoutStore,
  setActiveTabId,
  setFocusedPaneId,
  setLastSnippet,
  setTabSessionId,
  snapshotPreset,
  toggleMaximize,
  toggleMinimize,
  upsertCell,
  type CellTab,
} from "../stores/runtimeLayoutStore";
import { agentStore } from "../stores/agentStore";
import type { AgentState } from "../stores/agentStore";
import { AlertCircleIcon, CheckIcon, HARNESS_ICONS, LoaderIcon } from "./icons";
import { activeProjectSlug } from "../stores/projectStore";
import type { CellKind } from "../stores/layoutPresetStore";
import { createPreset, layoutPresetStore, savePreset } from "../stores/layoutPresetStore";
import { extractSnippet } from "../lib/terminalSnippet";
import { MinimizedDock } from "./minimized-dock";

// ---- tiling layout ---------------------------------------------------------

/**
 * Compute a column-first tiling layout for N cells within a 12-column grid.
 *
 * Strategy: fill columns first (one row) until cell width would drop below
 * MIN_COL_UNITS (3), then add a second row, and so on. The last row always
 * stretches its cells to fill the full 12 units even when it has fewer cells
 * than the other rows.
 *
 * Examples:
 *   1 → 12×12          4 → 3×12 × 4 cols        7 → 3×6 × 4 + 4×6 × 3
 *   2 → 6×12 × 2 cols  5 → 4×6 × 3 + 6×6 × 2   8 → 3×6 × 4 + 3×6 × 4
 *   3 → 4×12 × 3 cols  6 → 4×6 × 3 × 2 rows     9 → 4×4 × 3 × 3 rows
 */
const MIN_COL_UNITS = 3;

interface CellGeom {
  x: number;
  y: number;
  w: number;
  h: number;
}

function computeTilingLayout(N: number): CellGeom[] {
  if (N === 0) return [];

  // Find the fewest rows such that columns are at least MIN_COL_UNITS wide.
  let rows = 1;
  let cols = N;
  for (let r = 1; r <= N; r++) {
    const c = Math.ceil(N / r);
    if (Math.floor(12 / c) >= MIN_COL_UNITS) {
      rows = r;
      cols = c;
      break;
    }
  }

  const result: CellGeom[] = [];

  for (let i = 0; i < N; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;

    // Last row may have fewer cells — stretch them to fill 12 units.
    const cellsInRow = row === rows - 1 ? N - row * cols : cols;

    const baseW = Math.floor(12 / cellsInRow);
    const extraW = 12 % cellsInRow;
    const w = baseW + (col < extraW ? 1 : 0);
    const x = col * baseW + Math.min(col, extraW);

    const baseH = Math.floor(12 / rows);
    const extraH = 12 % rows;
    const h = baseH + (row < extraH ? 1 : 0);
    const y = row * baseH + Math.min(row, extraH);

    result.push({ x, y, w, h });
  }

  return result;
}

/**
 * Apply a column-first tiling to all *visible* (non-minimized) runtime cells,
 * updating both the Solid store (via `patchGeometry`) and the live gridstack
 * widgets. Minimized cells are excluded so the grid fills the freed space.
 */
function redistributeGrid(handle: import("../lib/gridstackAdapter").GridHandle | null): void {
  const minimized = minimizedPaneIds();
  const cells = runtimeLayoutStore.cells.filter((c) => !minimized.has(c.id));
  const layout = computeTilingLayout(cells.length);
  layout.forEach((geom, i) => {
    const cell = cells[i];
    if (!cell) return;
    patchGeometry([{ id: cell.id, ...geom }]);
    if (handle) {
      const el = document.querySelector(`[data-cell-id="${cell.id}"]`) as HTMLElement | null;
      if (el) {
        try {
          handle.grid.update(el, geom);
        } catch {
          /* best-effort: new cell widget not yet registered */
        }
      }
    }
  });
}

export const TerminalGrid: Component = () => {
  // Host is a signal so the init effect re-runs the moment the ref callback
  // assigns the DOM node. With a plain `let` the effect fired when cells
  // transitioned 0 → 1 but the `<Show>` child hadn't painted yet, so the
  // first spawn into an empty grid left gridstack uninitialised.
  const [host, setHost] = createSignal<HTMLDivElement | null>(null);
  const [handle, setHandle] = createSignal<GridHandle | null>(null);
  const [saveName, setSaveName] = createSignal("");
  const [saveError, setSaveError] = createSignal<string | null>(null);

  // Cells that are visible (not minimized). Used to decide when to show the
  // spawn-button overlay — it appears both when there are no cells at all and
  // when every cell is currently minimized to the dock.
  const visibleCells = createMemo(() => {
    const minimized = minimizedPaneIds();
    return runtimeLayoutStore.cells.filter((c) => !minimized.has(c.id));
  });

  // Fetch once which harnesses are installed. Shell is always available;
  // the backend excludes it from the report, so we prepend it manually.
  type SpawnKind = "shell" | "claude-code" | "codex" | "opencode";
  const LABELS: Record<SpawnKind, string> = {
    shell: "Shell",
    "claude-code": "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
  };
  const [availableKinds] = createResource<SpawnKind[]>(async () => {
    try {
      const report = await invoke<{ harnesses: { kind: SpawnKind; found: boolean }[] }>(
        "harnesses_check",
      );
      const found = report.harnesses.filter((h) => h.found).map((h) => h.kind);
      return ["shell", ...found.filter((k) => k !== "shell")];
    } catch {
      return ["shell", "claude-code", "codex", "opencode"];
    }
  });

  // Gridstack lifecycle. The host div is wrapped in `<Show when=cells.length>0>`,
  // so it unmounts when the last cell closes and remounts on the next spawn.
  // We must tear down the grid when the host goes away — otherwise the stale
  // `handle` blocks re-init on the fresh host, and new cells render without
  // gridstack styles (tiny box in the top-left corner).
  let cleanupGrid: (() => void) | null = null;
  createEffect(() => {
    const hasCells = runtimeLayoutStore.cells.length > 0;
    const el = host();
    const h = handle();

    // Teardown: host unmounted or grid emptied while a handle is live.
    if (h && (!hasCells || !el)) {
      cleanupGrid?.();
      cleanupGrid = null;
      setHandle(null);
      return;
    }

    // Init: first cell after empty, host is mounted, no live handle.
    if (!hasCells || !el || h) return;

    const newH = initGrid(el);
    if (!newH) return;
    setHandle(newH);

    const unsubChange = onChange(newH, (cells) => {
      // Runtime store is the source of truth; gridstack reports new geometry
      // after a drag or resize settles. Patch only geometry (not kind).
      //
      // Resize-to-tmux lives in `<TerminalPane>`'s ResizeObserver: it measures
      // xterm post-fit and pushes accurate cols/rows. A grid-level approximate
      // `terminal_resize` here would race the pane's measurement and deliver
      // wrong-size SIGWINCH to the harness — Ink-based TUIs repaint their
      // banner on every SIGWINCH, which is how the glitchy-banner bug shows up.
      patchGeometry(cells);
    });
    cleanupGrid = () => {
      unsubChange();
      newH.destroy();
    };
  });
  onCleanup(() => {
    cleanupGrid?.();
    cleanupGrid = null;
  });

  // §10.7 — focus pane hotkeys via CustomEvent. Wave 3E dispatches
  // `raum-action` with action name; we listen for the ones we own.
  onMount(() => {
    function onAction(ev: Event) {
      const action = (ev as CustomEvent<string>).detail;
      if (typeof action !== "string") return;
      if (action.startsWith("focus-pane-")) {
        const n = Number.parseInt(action.slice("focus-pane-".length), 10);
        if (Number.isFinite(n) && n >= 1 && n <= 9) focusPaneByIndex(n);
      } else if (action === "cycle-focus-forward") {
        cycleFocus("forward");
      } else if (action === "cycle-focus-back") {
        cycleFocus("back");
      } else if (action === "maximize-pane") {
        const id = focusedPaneId();
        if (id) toggleMaximize(id);
      }
    }
    window.addEventListener("raum-action", onAction);
    onCleanup(() => window.removeEventListener("raum-action", onAction));
  });

  // §8.2 — top-row spawn buttons dispatch `raum:spawn-requested` with the
  // harness kind + active project/worktree context. We materialise it into a
  // new runtime cell; `<TerminalPane>` will then call `terminal_spawn` once
  // it mounts.
  //
  // Placement: column-first tiling. Cells fill horizontally first (multiple
  // columns, one row) until the minimum column width (3 units) would be
  // exceeded, then a second row is added. Every cell always covers the full
  // grid area — no wasted space. The last row stretches its cells to fill
  // the remaining 12 units even if it has fewer cells than the other rows.
  onMount(() => {
    function onSpawn(ev: Event) {
      const detail = (
        ev as CustomEvent<{
          kind: CellKind;
          projectSlug?: string;
          worktreeId?: string;
        }>
      ).detail;
      if (!detail || !detail.kind || detail.kind === "empty") return;

      const id = nextCellId();
      const tabId = nextTabId();
      // Insert new cell with a placeholder geometry first so the store
      // includes it in the count before we compute the layout.
      upsertCell({
        id,
        x: 0,
        y: 0,
        w: 12,
        h: 1,
        kind: detail.kind,
        tabs: [{ id: tabId }],
        activeTabId: tabId,
        projectSlug: detail.projectSlug,
        worktreeId: detail.worktreeId,
      });

      redistributeGrid(handle());
      setFocusedPaneId(id);
    }
    window.addEventListener("raum:spawn-requested", onSpawn);
    onCleanup(() => window.removeEventListener("raum:spawn-requested", onSpawn));
  });

  // §10.7.1 — `hidden` siblings are driven by class; reflect maximize state
  // onto the host element data attribute so CSS can hide siblings.
  createEffect(() => {
    const el = host();
    if (!el) return;
    const maxId = maximizedPaneId();
    el.dataset.maximized = maxId ?? "";
  });

  function onSaveAsNew(): void {
    const name = saveName().trim();
    if (!name) {
      setSaveError("name required");
      return;
    }
    const res = createPreset(snapshotPreset(name));
    if (!res.ok) {
      setSaveError(res.error ?? "failed to save preset");
      return;
    }
    setSaveError(null);
    setSaveName("");
  }

  function onSaveCurrent(): void {
    const source = runtimeLayoutStore.sourcePreset;
    if (!source) {
      setSaveError("no current preset — use 'Save as new'");
      return;
    }
    savePreset(snapshotPreset(source));
    setSaveError(null);
  }

  // Restore a minimized pane: mark as no longer minimized in the store first,
  // then dispatch to GridCell (which holds the `itemRef` needed for makeWidget).
  function onRestoreFromDock(cellId: string): void {
    toggleMinimize(cellId);
    window.dispatchEvent(new CustomEvent("raum:restore-cell", { detail: { cellId } }));
  }

  return (
    <div class="flex h-full w-full flex-col">
      <Toolbar
        saveName={saveName()}
        onSaveNameChange={(v) => setSaveName(v)}
        onSaveAsNew={onSaveAsNew}
        onSaveCurrent={onSaveCurrent}
        sourcePreset={runtimeLayoutStore.sourcePreset}
        saveError={saveError()}
        presetCount={layoutPresetStore.presets.length}
      />
      <div class="relative flex-1 min-h-0">
        {/* Spawn-button grid: shown when there are no visible cells — either
            because none have been created yet, or because every cell is
            currently minimized to the dock. Rendered as an absolute overlay so
            the gridstack host (and the xterm instances inside it) stays mounted
            whenever cells exist, preserving live terminal sessions. */}
        <Show when={visibleCells().length === 0}>
          <div
            class="absolute inset-0 z-10 grid h-full w-full gap-px bg-zinc-800/30"
            style={{
              "grid-template-columns": `repeat(${Math.min(availableKinds()?.length ?? 1, 2)}, 1fr)`,
            }}
          >
            <For each={availableKinds() ?? []}>
              {(kind) => {
                const Icon = HARNESS_ICONS[kind];
                return (
                  <button
                    type="button"
                    class="group flex flex-col items-center justify-center gap-3 bg-zinc-950 text-zinc-600 transition-colors hover:bg-zinc-900 hover:text-zinc-300"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent("raum:spawn-requested", {
                          detail: { kind, projectSlug: activeProjectSlug() },
                        }),
                      )
                    }
                  >
                    <Icon class="size-7 transition-transform group-hover:scale-110" />
                    <span class="text-[11px] uppercase tracking-widest">{LABELS[kind]}</span>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
        {/* Gridstack host: kept mounted whenever cells exist (even if all are
            minimized) so xterm instances stay alive and can be restored without
            re-spawning a new process. */}
        <Show when={runtimeLayoutStore.cells.length > 0}>
          <div ref={setHost} class="grid-stack terminal-grid-host h-full w-full overflow-hidden">
            <For each={runtimeLayoutStore.cells}>
              {(cell) => (
                <GridCell
                  id={cell.id}
                  x={cell.x}
                  y={cell.y}
                  w={cell.w}
                  h={cell.h}
                  kind={cell.kind}
                  title={cell.title}
                  tabs={cell.tabs}
                  activeTabId={cell.activeTabId}
                  projectSlug={cell.projectSlug}
                  worktreeId={cell.worktreeId}
                  handle={handle}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
      <MinimizedDock onRestore={onRestoreFromDock} />
      <style>{`
        .terminal-grid-host[data-maximized]:not([data-maximized=""]) .grid-stack-item:not([data-cell-id=""]) {
          visibility: hidden;
        }
        .terminal-grid-host[data-maximized]:not([data-maximized=""]) .grid-stack-item[data-maximized-self="true"] {
          visibility: visible !important;
          position: absolute !important;
          inset: 0 !important;
          width: 100% !important;
          height: 100% !important;
          z-index: 20;
        }
      `}</style>
    </div>
  );
};

// ---- toolbar ---------------------------------------------------------------

interface ToolbarProps {
  saveName: string;
  onSaveNameChange: (v: string) => void;
  onSaveAsNew: () => void;
  onSaveCurrent: () => void;
  sourcePreset: string | null;
  saveError: string | null;
  presetCount: number;
}

const Toolbar: Component<ToolbarProps> = (props) => {
  return (
    <div class="flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-950/70 px-2 py-1 text-xs text-zinc-400">
      <span class="shrink-0 uppercase tracking-wide text-zinc-500">Grid</span>
      <Show when={props.sourcePreset}>
        <span class="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-300">
          preset: {props.sourcePreset}
        </span>
      </Show>
      <div class="ml-auto flex items-center gap-1">
        <button
          type="button"
          class="rounded px-2 py-0.5 text-xs hover:bg-zinc-900 disabled:opacity-40"
          onClick={() => props.onSaveCurrent()}
          disabled={!props.sourcePreset}
          title={props.sourcePreset ? `Save to '${props.sourcePreset}'` : "No current preset"}
        >
          Save
        </button>
        <input
          type="text"
          class="w-36 rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-xs text-zinc-200"
          placeholder="New preset name…"
          value={props.saveName}
          onInput={(e) => props.onSaveNameChange(e.currentTarget.value)}
        />
        <button
          type="button"
          class="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
          onClick={() => props.onSaveAsNew()}
          disabled={props.saveName.trim().length === 0}
        >
          Save as new
        </button>
        <span class="ml-1 text-[10px] text-zinc-500">({props.presetCount})</span>
      </div>
      <Show when={props.saveError}>
        <span class="ml-2 text-[10px] text-red-400">{props.saveError}</span>
      </Show>
    </div>
  );
};

// ---- single grid cell ------------------------------------------------------

interface GridCellProps {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: string;
  title: string | undefined;
  tabs: CellTab[];
  activeTabId: string;
  projectSlug: string | undefined;
  worktreeId: string | undefined;
  handle: () => GridHandle | null;
}

const GridCell: Component<GridCellProps> = (props) => {
  let itemRef: HTMLDivElement | undefined;

  const isMaximized = () => maximizedPaneId() === props.id;
  const isFocused = () => focusedPaneId() === props.id;

  // Track whether this cell's DOM element is registered in gridstack.
  let inGrid = false;

  // Register with gridstack once the handle is available. We run this as an
  // effect so the order (parent onMount → child onMount) doesn't matter.
  createEffect(() => {
    const h = props.handle();
    if (!h || !itemRef || inGrid) return;
    try {
      h.grid.makeWidget(itemRef);
      inGrid = true;
    } catch (err) {
      console.warn("[TerminalGrid] makeWidget failed", err);
    }
  });
  onCleanup(() => {
    const h = props.handle();
    if (!h || !itemRef || !inGrid) return;
    try {
      // `removeDOM=false` because Solid has already removed the element.
      h.grid.removeWidget(itemRef, false);
    } catch {
      /* best-effort */
    }
  });

  // raum:minimize-cell — snapshot was already stored by PaneHeader; here we
  // remove the widget from gridstack and hide the element imperatively so the
  // timing is correct (Solid's reactive display update is a microtask, but
  // gridstack must see the element still visible when removeWidget is called).
  // raum:restore-cell  — make the element visible first, re-register with
  // gridstack, then redistribute the layout.
  onMount(() => {
    function onMinimizeCell(ev: Event) {
      const detail = (ev as CustomEvent<{ cellId: string }>).detail;
      if (detail?.cellId !== props.id) return;
      const h = props.handle();
      if (h && itemRef && inGrid) {
        try {
          h.grid.removeWidget(itemRef, false);
        } catch {
          /* best-effort */
        }
        inGrid = false;
      }
      if (itemRef) itemRef.style.display = "none";
      redistributeGrid(h);
    }

    function onRestoreCell(ev: Event) {
      const detail = (ev as CustomEvent<{ cellId: string }>).detail;
      if (detail?.cellId !== props.id) return;
      const h = props.handle();
      // Make visible before makeWidget so gridstack can measure the element.
      if (itemRef) itemRef.style.display = "";
      if (h && itemRef && !inGrid) {
        // Stamp fresh gs-* attributes from the store so makeWidget reads valid
        // geometry even if gridstack cleared them during the previous removeWidget.
        const stored = runtimeLayoutStore.cells.find((c) => c.id === props.id);
        if (stored) {
          itemRef.setAttribute("gs-x", String(stored.x));
          itemRef.setAttribute("gs-y", String(stored.y));
          itemRef.setAttribute("gs-w", String(stored.w));
          itemRef.setAttribute("gs-h", String(stored.h));
        }
        try {
          h.grid.makeWidget(itemRef);
          inGrid = true;
        } catch (err) {
          console.warn("[TerminalGrid] makeWidget on restore failed", err);
        }
      }
      redistributeGrid(h);
    }

    window.addEventListener("raum:minimize-cell", onMinimizeCell);
    window.addEventListener("raum:restore-cell", onRestoreCell);
    onCleanup(() => {
      window.removeEventListener("raum:minimize-cell", onMinimizeCell);
      window.removeEventListener("raum:restore-cell", onRestoreCell);
    });
  });

  // Mirror maximize state onto a data-attribute so the host's CSS selector
  // above can hide siblings.
  createEffect(() => {
    if (!itemRef) return;
    itemRef.dataset.maximizedSelf = isMaximized() ? "true" : "";
    itemRef.dataset.cellId = props.id;
  });

  // §10.7.1 — capture-phase dblclick so xterm can't swallow the event.
  // stopPropagation prevents xterm word-selection from firing simultaneously.
  onMount(() => {
    if (!itemRef) return;
    const el = itemRef;
    function handleDblClick(e: MouseEvent) {
      e.stopPropagation();
      e.preventDefault();
      toggleMaximize(props.id);
    }
    el.addEventListener("dblclick", handleDblClick, true);
    onCleanup(() => el.removeEventListener("dblclick", handleDblClick, true));
  });

  function onFocusCapture() {
    setFocusedPaneId(props.id);
  }

  return (
    <div
      ref={(el) => (itemRef = el)}
      class="grid-stack-item"
      gs-id={props.id}
      gs-x={String(props.x)}
      gs-y={String(props.y)}
      gs-w={String(props.w)}
      gs-h={String(props.h)}
      data-cell-id={props.id}
      onFocusIn={onFocusCapture}
      onClick={onFocusCapture}
    >
      <div
        class="grid-stack-item-content flex flex-col overflow-hidden rounded-lg bg-zinc-950 shadow-lg shadow-black/60 ring-1 ring-white/[0.08]"
        classList={{ "pane-selected": isFocused() }}
      >
        <PaneHeader
          id={props.id}
          kind={props.kind}
          title={props.title}
          tabs={props.tabs}
          activeTabId={props.activeTabId}
          isMaximized={isMaximized()}
          handle={props.handle}
        />
        {/* Body is always rendered (no <Show>) so xterm stays mounted while the
            cell is minimized. Visibility is controlled imperatively via the
            outer grid-stack-item's display style in the event handlers above. */}
        <div class="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <Show
            when={props.kind !== "empty"}
            fallback={
              <div class="grid h-full w-full place-items-center text-xs text-zinc-600">empty</div>
            }
          >
            <For each={props.tabs}>
              {(tab) => (
                <div
                  class="absolute inset-0"
                  style={{
                    visibility: tab.id === props.activeTabId ? "visible" : "hidden",
                  }}
                >
                  <TerminalPane
                    kind={props.kind as Parameters<typeof TerminalPane>[0]["kind"]}
                    sessionId={tab.sessionId}
                    projectSlug={props.projectSlug}
                    worktreeId={props.worktreeId}
                    borderColor="transparent"
                    onSpawned={(sid) => setTabSessionId(props.id, tab.id, sid)}
                    onRequestClose={async () => {
                      try {
                        if (tab.sessionId) {
                          await invoke("terminal_kill", {
                            sessionId: tab.sessionId,
                          });
                        }
                      } catch (e) {
                        console.warn("[GridCell] terminal_kill on exit failed", e);
                      }
                      removeCellTab(props.id, tab.id);
                      const stillExists = runtimeLayoutStore.cells.some((c) => c.id === props.id);
                      if (!stillExists) redistributeGrid(props.handle());
                    }}
                  />
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default TerminalGrid;

// ---- per-cell chrome header -----------------------------------------------

interface PaneHeaderProps {
  id: string;
  kind: string;
  title: string | undefined;
  tabs: CellTab[];
  activeTabId: string;
  isMaximized: boolean;
  handle: () => GridHandle | null;
}

const PaneHeader: Component<PaneHeaderProps> = (props) => {
  const HarnessIcon = () => {
    const Icon = HARNESS_ICONS[props.kind as keyof typeof HARNESS_ICONS];
    if (!Icon) return null;
    return <Icon class="h-3 w-3 shrink-0" />;
  };

  async function killSession(sessionId: string | undefined) {
    if (!sessionId) return;
    try {
      await invoke("terminal_kill", { sessionId });
    } catch (e) {
      console.warn("[GridCell] terminal_kill failed", e);
    }
  }

  async function onCloseTab(ev: MouseEvent, tab: CellTab) {
    ev.stopPropagation();
    await killSession(tab.sessionId);
    removeCellTab(props.id, tab.id);
    // If removeCellTab removed the last tab it also calls removeCell, so we
    // only need to redistributeGrid if the cell itself survives.
    const stillExists = runtimeLayoutStore.cells.some((c) => c.id === props.id);
    if (!stillExists) redistributeGrid(props.handle());
  }

  async function onCloseCell(ev: MouseEvent) {
    ev.stopPropagation();
    // Kill all live sessions before removing the cell.
    for (const tab of props.tabs) {
      await killSession(tab.sessionId);
    }
    removeCell(props.id);
    redistributeGrid(props.handle());
  }

  function onAddTab(ev: MouseEvent) {
    ev.stopPropagation();
    addCellTab(props.id);
  }

  return (
    <div
      class="pane-drag-handle flex h-7 shrink-0 cursor-grab items-center border-b border-zinc-800 bg-zinc-950/80 active:cursor-grabbing"
      data-testid={`pane-header-${props.id}`}
    >
      {/* ── tab strip ─────────────────────────────────────────── */}
      <div class="no-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto">
        <For each={props.tabs}>
          {(tab) => {
            const tabState = (): AgentState | null =>
              agentStore.sessions[tab.sessionId ?? ""]?.state ?? null;
            const isActive = () => tab.id === props.activeTabId;

            return (
              <div
                class="group flex shrink-0 cursor-pointer items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors"
                classList={{
                  "bg-zinc-900 text-zinc-200": isActive(),
                  "text-zinc-500 hover:bg-zinc-900/60 hover:text-zinc-300": !isActive(),
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveTabId(props.id, tab.id);
                }}
              >
                <HarnessIcon />
                <StateIndicator state={tabState()} />
                <Show when={props.tabs.length > 1}>
                  <button
                    type="button"
                    title="Close tab"
                    aria-label="Close tab"
                    class="ml-0.5 hidden rounded p-0.5 hover:bg-zinc-700 hover:text-zinc-100 group-hover:flex"
                    onClick={(e) => {
                      void onCloseTab(e, tab);
                    }}
                  >
                    <CloseGlyph />
                  </button>
                </Show>
              </div>
            );
          }}
        </For>

        {/* add-tab button */}
        <button
          type="button"
          title="New tab"
          aria-label="New tab"
          class="ml-1 flex shrink-0 items-center rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          onClick={onAddTab}
        >
          <PlusGlyph />
        </button>
      </div>

      {/* ── window chrome ─────────────────────────────────────── */}
      <div class="flex shrink-0 items-center gap-1 px-1.5">
        <ChromeButton
          label="Minimize to dock"
          onClick={(e) => {
            e.stopPropagation();
            // Snapshot the xterm buffer content BEFORE the pane is hidden.
            const activeTab = props.tabs.find((t) => t.id === props.activeTabId);
            const snippet = extractSnippet(
              activeTab?.sessionId,
              props.kind as import("../lib/agentKind").AgentKind,
            );
            setLastSnippet(props.id, snippet, Date.now());
            // Mark as minimized in the store.
            toggleMinimize(props.id);
            // Signal GridCell to remove from gridstack and redistribute.
            window.dispatchEvent(
              new CustomEvent("raum:minimize-cell", {
                detail: { cellId: props.id },
              }),
            );
          }}
        >
          <MinusGlyph />
        </ChromeButton>
        <ChromeButton
          label={props.isMaximized ? "Restore" : "Maximize"}
          onClick={(e) => {
            e.stopPropagation();
            toggleMaximize(props.id);
          }}
        >
          {props.isMaximized ? <RestoreGlyph /> : <MaximizeGlyph />}
        </ChromeButton>
        <ChromeButton
          label="Close"
          danger
          onClick={(e) => {
            void onCloseCell(e);
          }}
        >
          <CloseGlyph />
        </ChromeButton>
      </div>
    </div>
  );
};

/**
 * Per-tab harness state indicator. Uses the exact same icons and colors as
 * the global top-right harness counter so users recognise the symbols
 * immediately wherever they appear.
 *
 *   working   → spinning LoaderIcon   (emerald-400)
 *   waiting   → AlertCircleIcon       (amber-400)
 *   idle      → CheckIcon             (zinc-500)
 *   completed → CheckIcon             (sky-400)
 *   errored   → AlertCircleIcon       (red-400)
 */
function StateIndicator(props: { state: AgentState | null }) {
  const title = () => props.state ?? "unknown";
  return (
    <span class="flex items-center" title={title()}>
      <Show when={props.state === "working"}>
        <LoaderIcon class="h-3 w-3 animate-spin text-emerald-400" />
      </Show>
      <Show when={props.state === "waiting"}>
        <AlertCircleIcon class="h-3 w-3 text-amber-400" />
      </Show>
      <Show when={props.state === "idle" || props.state === null}>
        <CheckIcon class="h-3 w-3 text-zinc-500" />
      </Show>
      <Show when={props.state === "completed"}>
        <CheckIcon class="h-3 w-3 text-sky-400" />
      </Show>
      <Show when={props.state === "errored"}>
        <AlertCircleIcon class="h-3 w-3 text-red-400" />
      </Show>
    </span>
  );
}

function ChromeButton(props: {
  label: string;
  onClick: (e: MouseEvent) => void;
  children: import("solid-js").JSX.Element;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      class="flex h-4 w-4 items-center justify-center rounded text-zinc-500"
      classList={{
        "hover:bg-red-900/60 hover:text-red-200": props.danger === true,
        "hover:bg-zinc-800 hover:text-zinc-100": props.danger !== true,
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function PlusGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      class="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    >
      <line x1="6" y1="2" x2="6" y2="10" />
      <line x1="2" y1="6" x2="10" y2="6" />
    </svg>
  );
}

function MinusGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      class="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    >
      <line x1="2" y1="6" x2="10" y2="6" />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      class="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
    >
      <rect x="2" y="2" width="8" height="8" rx="1" />
    </svg>
  );
}

function RestoreGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      class="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
    >
      <rect x="4" y="2" width="6" height="6" rx="1" />
      <rect x="2" y="4" width="6" height="6" rx="1" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      class="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    >
      <line x1="3" y1="3" x2="9" y2="9" />
      <line x1="9" y1="3" x2="3" y2="9" />
    </svg>
  );
}
