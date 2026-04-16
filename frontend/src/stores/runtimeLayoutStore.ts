/**
 * §10.6 — runtime layout store.
 *
 * Drags and resizes in `<TerminalGrid>` land here *without* touching
 * `layouts.toml`. The runtime store is the volatile working copy of the grid;
 * persistence is explicit via "Save as new preset" / "Save to current preset"
 * buttons in the grid UI, which read the runtime snapshot and hand it to
 * `layoutPresetStore.savePreset`.
 *
 * Maximize state (§10.7.1) also lives here so double-clicking pane chrome
 * hides siblings visually without affecting geometry in the saved preset.
 */

import { createStore, reconcile } from "solid-js/store";
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import type { CellKind, LayoutPreset } from "./layoutPresetStore";

// ---- active-layout persistence types (mirrors raum-core ActiveLayoutState) --

export interface ActiveLayoutTab {
  id: string;
  session_id?: string;
}

export interface ActiveLayoutCell {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: CellKind;
  title?: string;
  active_tab_id: string;
  tabs: ActiveLayoutTab[];
}

export interface ActiveLayoutState {
  saved_at: number;
  source_preset?: string;
  project_slug?: string;
  worktree_id?: string;
  cells: ActiveLayoutCell[];
}

/** A single tab within a terminal cell. Each tab owns one tmux session. */
export interface CellTab {
  id: string;
  /** Session id returned by `terminal_spawn`, once the tab's pane is live. */
  sessionId?: string;
}

/** Runtime cell — adds a stable `id` so Gridstack change events can be tied
 *  back to the Solid `<For>` key. */
export interface RuntimeCell {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: CellKind;
  title?: string;
  /** Ordered list of tabs; always contains at least one entry. */
  tabs: CellTab[];
  /** ID of the currently-visible tab. */
  activeTabId: string;
  /** Spawn context — forwarded to `<TerminalPane>` so `terminal_spawn` tags
   *  the tmux session with the owning project/worktree. Both optional so a
   *  raw shell (no active project) still works. */
  projectSlug?: string;
  worktreeId?: string;
  /** Content snapshot taken from the xterm buffer at minimize-time. Null until
   *  the pane has been minimized at least once. */
  lastSnippet?: string;
  /** Date.now() value captured when `lastSnippet` was taken. */
  lastActivityMs?: number;
}

interface RuntimeLayoutState {
  cells: RuntimeCell[];
  /** Name of the preset the runtime layout was derived from, if any. Used
   *  to wire "Save to current preset" and to display the active-preset
   *  badge in the grid toolbar. */
  sourcePreset: string | null;
}

const [runtimeLayoutStore, setRuntimeLayoutStore] = createStore<RuntimeLayoutState>({
  cells: [],
  sourcePreset: null,
});

/** §10.7.1 — id of the currently-maximized pane; `null` when no pane is
 *  maximized. Not persisted across worktree switches. */
const [maximizedPaneId, setMaximizedPaneId] = createSignal<string | null>(null);

/** §10.7 — id of the currently-focused pane. Used by cycle-focus hotkeys. */
const [focusedPaneId, setFocusedPaneId] = createSignal<string | null>(null);

/** Set of pane ids currently minimized — the cell still occupies its grid
 *  footprint but the body (xterm) is hidden; the chrome header stays visible
 *  so the user can un-minimize without losing placement. Not persisted. */
const [minimizedPaneIds, setMinimizedPaneIds] = createSignal<ReadonlySet<string>>(new Set());

export { runtimeLayoutStore, maximizedPaneId, focusedPaneId, setFocusedPaneId, minimizedPaneIds };

export function isPaneMinimized(id: string): boolean {
  return minimizedPaneIds().has(id);
}

export function toggleMinimize(paneId: string): void {
  const curr = minimizedPaneIds();
  const next = new Set(curr);
  if (next.has(paneId)) next.delete(paneId);
  else next.add(paneId);
  setMinimizedPaneIds(next);
}

/** Store the content snapshot captured from the xterm buffer at minimize-time. */
export function setLastSnippet(cellId: string, snippet: string, activityMs: number): void {
  const idx = runtimeLayoutStore.cells.findIndex((c) => c.id === cellId);
  if (idx === -1) return;
  setRuntimeLayoutStore("cells", idx, { lastSnippet: snippet, lastActivityMs: activityMs });
}

let idCounter = 0;
export function nextCellId(): string {
  idCounter += 1;
  return `cell-${Date.now()}-${idCounter}`;
}

let tabIdCounter = 0;
export function nextTabId(): string {
  tabIdCounter += 1;
  return `tab-${Date.now()}-${tabIdCounter}`;
}

// ---- active-layout auto-save -----------------------------------------------

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounce-schedule a write of the current runtime layout to
 *  `state/active-layout.toml` via the Rust backend. Called at the end of
 *  every mutation so the on-disk snapshot stays current without hammering the
 *  filesystem on rapid drag/resize events. */
function scheduleActiveSave(): void {
  if (_saveTimer !== null) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    const cells = runtimeLayoutStore.cells;
    if (cells.length === 0) return;
    const payload: ActiveLayoutState = {
      saved_at: Math.floor(Date.now() / 1000),
      source_preset: runtimeLayoutStore.sourcePreset ?? undefined,
      cells: cells.map((c) => ({
        id: c.id,
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        kind: c.kind,
        title: c.title,
        active_tab_id: c.activeTabId,
        tabs: c.tabs.map((t) => ({ id: t.id, session_id: t.sessionId })),
      })),
    };
    invoke("active_layout_save", { layout: payload }).catch(console.warn);
  }, 500);
}

// ---- mutations -------------------------------------------------------------

/** Replace the runtime layout wholesale. Used when applying a preset.
 *  Cells that lack tabs (e.g. from a persisted preset) are auto-initialized
 *  with a single blank tab. */
export function setRuntimeLayout(
  cells: (RuntimeCell | Omit<RuntimeCell, "tabs" | "activeTabId">)[],
  sourcePreset: string | null,
): void {
  const initialized: RuntimeCell[] = cells.map((c) => {
    if ("tabs" in c && Array.isArray(c.tabs) && c.tabs.length > 0) {
      return c as RuntimeCell;
    }
    const tabId = nextTabId();
    return {
      ...(c as Omit<RuntimeCell, "tabs" | "activeTabId">),
      tabs: [{ id: tabId }],
      activeTabId: tabId,
    };
  });
  setRuntimeLayoutStore("cells", reconcile(initialized, { key: "id" }));
  setRuntimeLayoutStore("sourcePreset", sourcePreset);
  // Exiting a layout drops any maximize state.
  setMaximizedPaneId(null);
  scheduleActiveSave();
}

/** Apply a geometry patch from a Gridstack change event. Only x/y/w/h are
 *  merged; `kind` / `title` / tabs stay intact. */
export function patchGeometry(
  updates: { id: string; x: number; y: number; w: number; h: number }[],
): void {
  for (const u of updates) {
    const idx = runtimeLayoutStore.cells.findIndex((c) => c.id === u.id);
    if (idx === -1) continue;
    setRuntimeLayoutStore("cells", idx, {
      x: u.x,
      y: u.y,
      w: u.w,
      h: u.h,
    });
  }
  scheduleActiveSave();
}

export function upsertCell(cell: RuntimeCell): void {
  const idx = runtimeLayoutStore.cells.findIndex((c) => c.id === cell.id);
  if (idx === -1) {
    setRuntimeLayoutStore("cells", (prev) => [...prev, cell]);
  } else {
    setRuntimeLayoutStore("cells", idx, cell);
  }
  scheduleActiveSave();
}

export function removeCell(id: string): void {
  setRuntimeLayoutStore("cells", (prev) => prev.filter((c) => c.id !== id));
  if (maximizedPaneId() === id) setMaximizedPaneId(null);
  if (focusedPaneId() === id) setFocusedPaneId(null);
  const mins = minimizedPaneIds();
  if (mins.has(id)) {
    const next = new Set(mins);
    next.delete(id);
    setMinimizedPaneIds(next);
  }
  scheduleActiveSave();
}

/** Set the sessionId for a specific tab within a cell. */
export function setTabSessionId(cellId: string, tabId: string, sessionId: string): void {
  const cellIdx = runtimeLayoutStore.cells.findIndex((c) => c.id === cellId);
  if (cellIdx === -1) return;
  const tabIdx = runtimeLayoutStore.cells[cellIdx].tabs.findIndex((t) => t.id === tabId);
  if (tabIdx === -1) return;
  setRuntimeLayoutStore("cells", cellIdx, "tabs", tabIdx, { sessionId });
  scheduleActiveSave();
}

/** Legacy compat: set the sessionId on the active tab of a cell. */
export function setSessionId(cellId: string, sessionId: string | undefined): void {
  if (!sessionId) return;
  const cell = runtimeLayoutStore.cells.find((c) => c.id === cellId);
  if (!cell) return;
  setTabSessionId(cellId, cell.activeTabId, sessionId);
}

/** Add a new blank tab to a cell and make it active. Returns the new tab id. */
export function addCellTab(cellId: string): string {
  const cellIdx = runtimeLayoutStore.cells.findIndex((c) => c.id === cellId);
  if (cellIdx === -1) return "";
  const tabId = nextTabId();
  setRuntimeLayoutStore("cells", cellIdx, "tabs", (prev) => [...prev, { id: tabId }]);
  setRuntimeLayoutStore("cells", cellIdx, "activeTabId", tabId);
  scheduleActiveSave();
  return tabId;
}

/** Remove a tab from a cell. If it was the active tab, activates the nearest
 *  neighbor. If it was the last tab, removes the entire cell. */
export function removeCellTab(cellId: string, tabId: string): void {
  const cellIdx = runtimeLayoutStore.cells.findIndex((c) => c.id === cellId);
  if (cellIdx === -1) return;
  const cell = runtimeLayoutStore.cells[cellIdx];
  if (cell.tabs.length <= 1) {
    // Last tab — remove the whole cell. removeCell schedules the save.
    removeCell(cellId);
    return;
  }
  // Activate a neighbor if we're removing the active tab.
  if (cell.activeTabId === tabId) {
    const idx = cell.tabs.findIndex((t) => t.id === tabId);
    const neighbor = idx > 0 ? cell.tabs[idx - 1] : cell.tabs[idx + 1];
    if (neighbor) {
      setRuntimeLayoutStore("cells", cellIdx, "activeTabId", neighbor.id);
    }
  }
  setRuntimeLayoutStore("cells", cellIdx, "tabs", (prev) => prev.filter((t) => t.id !== tabId));
  scheduleActiveSave();
}

/** Switch the active tab within a cell. */
export function setActiveTabId(cellId: string, tabId: string): void {
  const cellIdx = runtimeLayoutStore.cells.findIndex((c) => c.id === cellId);
  if (cellIdx === -1) return;
  setRuntimeLayoutStore("cells", cellIdx, "activeTabId", tabId);
  scheduleActiveSave();
}

// ---- maximize (§10.7.1) ----------------------------------------------------

/** Toggle the maximize state of `paneId`. If another pane is maximized, switch
 *  to `paneId`; if `paneId` is already maximized, restore. */
export function toggleMaximize(paneId: string): void {
  const current = maximizedPaneId();
  setMaximizedPaneId(current === paneId ? null : paneId);
}

/** Force-clear the maximize state. Called on worktree switch and on grid
 *  teardown. */
export function clearMaximize(): void {
  setMaximizedPaneId(null);
}

// ---- focus cycling (§10.7) -------------------------------------------------

export function focusPaneByIndex(oneBasedIndex: number): void {
  const cell = runtimeLayoutStore.cells[oneBasedIndex - 1];
  if (cell) setFocusedPaneId(cell.id);
}

export function cycleFocus(direction: "forward" | "back"): void {
  const cells = runtimeLayoutStore.cells;
  if (cells.length === 0) return;
  const current = focusedPaneId();
  const idx = current ? cells.findIndex((c) => c.id === current) : -1;
  const next =
    direction === "forward"
      ? (idx + 1 + cells.length) % cells.length
      : (idx - 1 + cells.length) % cells.length;
  setFocusedPaneId(cells[next].id);
}

// ---- serialization ---------------------------------------------------------

/**
 * Snapshot the runtime layout into a savable `LayoutPreset`. Used by the
 * `<GridBuilder>` + `<TerminalGrid>` "save" actions. Does not persist — the
 * caller hands the result to `layoutPresetStore.savePreset`.
 */
export function snapshotPreset(name: string): LayoutPreset {
  return {
    name,
    created_at: Math.floor(Date.now() / 1000),
    cells: runtimeLayoutStore.cells.map((c) => ({
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      kind: c.kind,
      ...(c.title ? { title: c.title } : {}),
    })),
  };
}

/** Test-only helper: wipe runtime state. */
export function __resetRuntimeLayoutForTests(): void {
  setRuntimeLayoutStore({ cells: [], sourcePreset: null });
  setMaximizedPaneId(null);
  setFocusedPaneId(null);
  idCounter = 0;
  tabIdCounter = 0;
}
