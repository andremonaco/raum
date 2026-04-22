/**
 * Runtime layout store — BSP split-tree edition.
 *
 * State:
 *   - `tree`  — `LayoutNode` tree describing how the viewport is partitioned.
 *     Splits carry ratios that sum to 1.0; leaves reference pane ids.
 *   - `panes` — map from pane id → `PaneContent` (kind, tabs, title, …).
 *   - `cells` — **derived** flat view reconstructed from `tree` + `panes`
 *     every time the tree or a pane mutates. Exposed so existing consumers
 *     (`<Dock>`, rehydration in `app.tsx`) keep working unchanged. Each
 *     cell's x/y/w/h live on a 10 000-unit virtual
 *     grid — coarser than a pixel, fine enough that the round-trip through
 *     the existing flat-cell TOML is lossless for editor-produced layouts.
 *
 * Mutations are pure-tree (splitAtLeaf / removeLeaf / swapLeaves / …) and run
 * through `compact()` to maintain the tree invariants.
 *
 * Persistence: the debounced `active_layout_save` still emits flat cells on
 * the same 10 000-unit grid. Rehydration in `app.tsx` hands those cells to
 * `setRuntimeLayout`, which rebuilds the tree via `buildFromRects`.
 */

import { createStore, reconcile, unwrap } from "solid-js/store";
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { AgentKind } from "../lib/agentKind";
import {
  buildFromRects,
  compact,
  equalizeRatios,
  leaf,
  leafIds as treeLeafIds,
  normalizeRatios,
  pathToLeaf,
  projectToRects,
  removeLeaf,
  splitAtLeaf,
  splitAtRoot,
  swapLeaves,
  tileLeaves,
  type Direction,
  type LayoutNode,
  type Rect,
} from "../lib/layoutTree";

// ---- virtual grid unit for flat-cell persistence --------------------------

/** Scale for projecting the tree into integer x/y/w/h for the existing TOML
 *  schema. 10 000 is fine enough that ratio round-trip error is well below
 *  one pixel on any reasonable screen. */
export const LAYOUT_UNIT = 10000;

/** A pane kind. Mirrors `raum_core::agent::AgentKind` serialized as kebab-case,
 *  with `"empty"` reserved as a UI-only placeholder that is never persisted. */
export type CellKind = AgentKind | "empty";

// ---- persistence types (mirror raum-core ActiveLayoutState) ---------------

export interface ActiveLayoutTab {
  id: string;
  session_id?: string;
  label?: string;
}

export interface ActiveLayoutCell {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: CellKind;
  title?: string;
  project_slug?: string;
  worktree_id?: string;
  active_tab_id: string;
  tabs: ActiveLayoutTab[];
}

export interface ActiveLayoutState {
  saved_at: number;
  project_slug?: string;
  worktree_id?: string;
  cells: ActiveLayoutCell[];
}

// ---- pane content ---------------------------------------------------------

export interface CellTab {
  id: string;
  sessionId?: string;
  /** User-chosen display label shown in the pane's tab strip. Undefined
   *  when the user has not renamed the tab. Empty / whitespace-only values
   *  are normalized to undefined by `setTabLabel`. */
  label?: string;
  /** tmux-derived automatic label (pane title, window name, or shell context)
   *  displayed when the user hasn't set an explicit `label`. Polled by the
   *  pane; not persisted to the saved layout. */
  autoLabel?: string;
}

/** Everything we track per pane that ISN'T layout geometry. Keyed by pane id
 *  in `runtimeLayoutStore.panes`. */
export interface PaneContent {
  id: string;
  kind: CellKind;
  title?: string;
  tabs: CellTab[];
  activeTabId: string;
  projectSlug?: string;
  worktreeId?: string;
  lastSnippet?: string;
  lastActivityMs?: number;
}

/** Back-compat shape: content + geometry combined. Built on every tree/panes
 *  mutation so consumers that iterate `runtimeLayoutStore.cells` keep working.
 *  x/y/w/h live on the 10 000-unit grid. */
export interface RuntimeCell extends PaneContent {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---- store ----------------------------------------------------------------

interface RuntimeLayoutState {
  tree: LayoutNode | null;
  panes: Record<string, PaneContent>;
  cells: RuntimeCell[];
}

const [runtimeLayoutStore, setRuntimeLayoutStore] = createStore<RuntimeLayoutState>({
  tree: null,
  panes: {},
  cells: [],
});

const [maximizedPaneId, setMaximizedPaneId] = createSignal<string | null>(null);
const [focusedPaneId, setFocusedPaneId] = createSignal<string | null>(null);
const [minimizedPaneIds, setMinimizedPaneIds] = createSignal<ReadonlySet<string>>(new Set());

export { runtimeLayoutStore, maximizedPaneId, focusedPaneId, setFocusedPaneId, minimizedPaneIds };

// ---- derived cells recompute ----------------------------------------------

/** Return a detached, plain-object copy of the tree. Solid wraps everything
 *  put into a store in Proxies; when we read a subtree out and then splice
 *  it into a new parent handed back to setStore, the re-proxy pass can create
 *  cyclic proxy-of-proxy structures that blow the stack on deep reads.
 *  Deep-cloning here keeps every mutation pipeline on plain objects. */
function currentTree(): LayoutNode | null {
  const t = runtimeLayoutStore.tree;
  if (!t) return null;
  return JSON.parse(JSON.stringify(unwrap(t))) as LayoutNode;
}

/** Rebuild `cells` from the current `tree` + `panes`. Called by every
 *  mutation. Projects the tree to rectangles on the LAYOUT_UNIT grid and
 *  stitches in pane content. */
function rebuildCells(): void {
  const tree = currentTree();
  if (!tree) {
    setRuntimeLayoutStore("cells", []);
    return;
  }
  const rects = projectToRects(tree, LAYOUT_UNIT);
  const cells: RuntimeCell[] = rects
    .map((r) => {
      const pane = runtimeLayoutStore.panes[r.id];
      if (!pane) return null;
      // Unwrap the pane content so the reconciled array is composed of plain
      // objects (reconcile compares structure, not proxies).
      const plain = unwrap(pane) as PaneContent;
      return { ...plain, x: r.x, y: r.y, w: r.w, h: r.h };
    })
    .filter((c): c is RuntimeCell => c !== null);
  // `reconcile` diffs the current cells array against `cells` by the `id`
  // key, producing surgical updates so existing <For> children (the
  // `<LeafFrame>` that hosts each TerminalPane + xterm instance) stay mounted
  // across layout mutations. Without this, every tree change would replace
  // the cells array wholesale, remount all LeafFrames, and destroy the
  // underlying xterm sessions — which is exactly what was making terminals
  // die on the first drag or spawn.
  setRuntimeLayoutStore("cells", reconcile(cells, { key: "id", merge: true }));
}

// ---- minimize / focus -----------------------------------------------------

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

export function setLastSnippet(cellId: string, snippet: string, activityMs: number): void {
  if (!runtimeLayoutStore.panes[cellId]) return;
  setRuntimeLayoutStore("panes", cellId, {
    lastSnippet: snippet,
    lastActivityMs: activityMs,
  });
  rebuildCells();
  scheduleActiveSave();
}

/** Bump `lastActivityMs` on whichever pane owns `sessionId`. No-op if no pane
 *  tab currently points at that session. Used to keep the dock's Recent sort
 *  accurate for minimized panes (which are unmounted — their TerminalPane
 *  channel isn't running — so we rely on harness state-change events
 *  propagated from the backend). */
export function touchPaneBySession(sessionId: string): void {
  if (!sessionId) return;
  for (const pane of Object.values(runtimeLayoutStore.panes)) {
    if (pane.tabs.some((t) => t.sessionId === sessionId)) {
      setRuntimeLayoutStore("panes", pane.id, { lastActivityMs: Date.now() });
      rebuildCells();
      return;
    }
  }
}

/** Listen for `agent-state-changed` events and bump the owning pane's
 *  `lastActivityMs` on each transition. Call once at app startup; the
 *  returned function unsubscribes. Runs in parallel with the existing
 *  `subscribeAgentEvents()` in `agentStore`. */
export async function subscribePaneActivity(): Promise<UnlistenFn> {
  const unlisten = await listen<{ session_id: string | Record<string, unknown> }>(
    "agent-state-changed",
    (ev) => {
      const raw = ev.payload.session_id;
      const id =
        typeof raw === "string"
          ? raw
          : raw && typeof raw === "object"
            ? (((raw as Record<string, unknown>)["0"] as string | undefined) ?? "")
            : "";
      if (id) touchPaneBySession(id);
    },
  );
  return () => {
    unlisten();
  };
}

// ---- per-project pruning --------------------------------------------------

/**
 * Return a pruned copy of `tree` that contains only leaves whose owning pane
 * either has no `projectSlug` (shell panes — unowned, visible across every
 * project tab) or whose `projectSlug === activeSlug`. Returns `null` when
 * every leaf ends up pruned.
 *
 * Used by the grid render layer to scope the visible BSP tree to the active
 * project tab. Pure — does not touch the store; `runtimeLayoutStore.tree`
 * still holds every project's layout so switching tabs restores geometry.
 */
export function pruneTreeByProject(
  tree: LayoutNode | null,
  activeSlug: string | undefined,
  panes: Record<string, PaneContent>,
): LayoutNode | null {
  if (!tree) return null;
  let result: LayoutNode | null = tree;
  for (const id of treeLeafIds(tree)) {
    const pane = panes[id];
    if (!pane) continue;
    if (pane.projectSlug === undefined) continue;
    if (pane.projectSlug === activeSlug) continue;
    result = removeLeaf(result, id);
    if (!result) return null;
  }
  return result;
}

// ---- id counters ----------------------------------------------------------

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

// ---- debounced active-layout save ----------------------------------------

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleActiveSave(): void {
  if (_saveTimer !== null) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    const cells = runtimeLayoutStore.cells;
    if (cells.length === 0) return;
    const payload: ActiveLayoutState = {
      saved_at: Math.floor(Date.now() / 1000),
      cells: cells.map((c) => ({
        id: c.id,
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        kind: c.kind,
        title: c.title,
        project_slug: c.projectSlug,
        worktree_id: c.worktreeId,
        active_tab_id: c.activeTabId,
        tabs: c.tabs.map((t) => ({
          id: t.id,
          session_id: t.sessionId,
          ...(t.label ? { label: t.label } : {}),
        })),
      })),
    };
    invoke("active_layout_save", { layout: payload }).catch(console.warn);
  }, 500);
}

// ---- layout replacement (back-compat entry point) -------------------------

/** Replace the runtime layout wholesale from a flat cell list. Called at
 *  startup during rehydration. Cells without tabs are auto-initialized with
 *  one blank tab. The flat cells are converted into a BSP tree via
 *  `buildFromRects`. */
export function setRuntimeLayout(
  cells: Array<
    | RuntimeCell
    | (Omit<RuntimeCell, "tabs" | "activeTabId"> & { tabs?: CellTab[]; activeTabId?: string })
  >,
): void {
  if (cells.length === 0) {
    setRuntimeLayoutStore({
      tree: null,
      panes: {},
      cells: [],
    });
    setMaximizedPaneId(null);
    scheduleActiveSave();
    return;
  }

  const panes: Record<string, PaneContent> = {};
  const rects: Rect[] = [];
  for (const raw of cells) {
    const tabs = raw.tabs && raw.tabs.length > 0 ? raw.tabs : [{ id: nextTabId() }];
    const activeTabId = raw.activeTabId ?? tabs[0].id;
    panes[raw.id] = {
      id: raw.id,
      kind: raw.kind,
      title: raw.title,
      tabs,
      activeTabId,
      projectSlug: raw.projectSlug,
      worktreeId: raw.worktreeId,
      lastSnippet: (raw as Partial<PaneContent>).lastSnippet,
      lastActivityMs: (raw as Partial<PaneContent>).lastActivityMs,
    };
    rects.push({
      id: raw.id,
      x: raw.x,
      y: raw.y,
      w: raw.w,
      h: raw.h,
    });
  }
  // Normalize rectangles onto the LAYOUT_UNIT grid even if the incoming data
  // used a different scale (e.g. legacy 12×12 presets). buildFromRects is
  // scale-invariant as long as all rects share the same extent.
  const rebuilt = buildFromRects(rects, LAYOUT_UNIT);

  setRuntimeLayoutStore({
    tree: rebuilt,
    panes,
  });
  rebuildCells();
  setMaximizedPaneId(null);
  scheduleActiveSave();
}

// ---- tree-level mutations -------------------------------------------------

/** Insert a new pane next to `targetPaneId` in the given direction. Used by
 *  spawn and by DnD "drop on edge of target". If targetPaneId is null and
 *  the tree is empty, the new pane becomes the root; if the tree is non-empty
 *  but targetPaneId is null, the pane is inserted at the root's right edge. */
export function splitPane(
  newPane: PaneContent,
  targetPaneId: string | null,
  direction: Direction,
): void {
  // Register pane content first.
  setRuntimeLayoutStore("panes", newPane.id, newPane);

  const tree = currentTree();
  const newLeaf = leaf(newPane.id);
  let nextTree: LayoutNode;
  if (!tree) {
    nextTree = newLeaf;
  } else if (targetPaneId && treeContains(tree, targetPaneId)) {
    nextTree = splitAtLeaf(tree, targetPaneId, direction, newLeaf);
  } else {
    nextTree = splitAtRoot(tree, direction, newLeaf);
  }
  setRuntimeLayoutStore("tree", nextTree);
  rebuildCells();
  scheduleActiveSave();
}

/** Split the focused pane (if any) along its longer axis, or at the root
 *  otherwise. Returns nothing; this is the "new terminal" gesture. */
export function splitFocusedOrRoot(newPane: PaneContent): void {
  const focus = focusedPaneId();
  const tree = currentTree();
  if (!tree) {
    splitPane(newPane, null, "right");
    return;
  }
  if (focus && treeContains(tree, focus)) {
    // Bias toward bottom splits so the grid grows row-first: only split
    // right when the focused pane is substantially wider than tall. On a
    // typical 16:9 viewport this still produces a first 2-column split
    // (w/h ≈ 1.78), but once columns exist further splits stack rows.
    const cell = runtimeLayoutStore.cells.find((c) => c.id === focus);
    const direction: Direction = cell && cell.w > cell.h * 1.6 ? "right" : "bottom";
    splitPane(newPane, focus, direction);
    return;
  }
  splitPane(newPane, null, "right");
}

/** Remove a pane and its content. Collapses unary parents automatically. */
export function removePane(id: string): void {
  const tree = currentTree();
  if (tree) {
    const next = removeLeaf(tree, id);
    setRuntimeLayoutStore("tree", next);
  }
  setRuntimeLayoutStore("panes", id, undefined as unknown as PaneContent);
  // Clear volatile per-pane state.
  if (maximizedPaneId() === id) setMaximizedPaneId(null);
  if (focusedPaneId() === id) setFocusedPaneId(null);
  const mins = minimizedPaneIds();
  if (mins.has(id)) {
    const next = new Set(mins);
    next.delete(id);
    setMinimizedPaneIds(next);
  }
  rebuildCells();
  scheduleActiveSave();
}

/** Swap which pane occupies which slot in the tree (same layout, different
 *  content). Used by DnD "drop on center of target". */
export function swapPanes(a: string, b: string): void {
  const tree = currentTree();
  if (!tree) return;
  const next = swapLeaves(tree, a, b);
  setRuntimeLayoutStore("tree", next);
  rebuildCells();
  scheduleActiveSave();
}

/** DnD drop on an edge of another leaf: remove the dragged pane from its
 *  current slot, then re-insert adjacent to the target. */
export function movePaneToEdge(
  sourcePaneId: string,
  targetPaneId: string,
  direction: Direction,
): void {
  if (sourcePaneId === targetPaneId) return;
  const tree = currentTree();
  if (!tree) return;
  if (!treeContains(tree, sourcePaneId) || !treeContains(tree, targetPaneId)) return;
  const stripped = removeLeaf(tree, sourcePaneId);
  if (!stripped) {
    // Source was the only leaf — nothing to do.
    return;
  }
  const reinserted = splitAtLeaf(stripped, targetPaneId, direction, leaf(sourcePaneId));
  setRuntimeLayoutStore("tree", compact(reinserted));
  rebuildCells();
  scheduleActiveSave();
}

/** DnD drop on the OUTER edge of the grid: move the dragged pane to wrap
 *  the entire existing layout. */
export function movePaneToRootEdge(sourcePaneId: string, direction: Direction): void {
  const tree = currentTree();
  if (!tree) return;
  if (!treeContains(tree, sourcePaneId)) return;
  const stripped = removeLeaf(tree, sourcePaneId);
  if (!stripped) return;
  const reinserted = splitAtRoot(stripped, direction, leaf(sourcePaneId));
  setRuntimeLayoutStore("tree", compact(reinserted));
  rebuildCells();
  scheduleActiveSave();
}

/** Set the ratios on an internal split node, addressed by a child-index path
 *  from the root. Used by divider drag. `ratios` is normalized. */
export function setSplitRatios(nodePath: number[], ratios: number[]): void {
  const tree = currentTree();
  if (!tree) return;
  const next = setRatiosAt(tree, nodePath, normalizeRatios(ratios));
  setRuntimeLayoutStore("tree", next);
  rebuildCells();
  scheduleActiveSave();
}

/** Reset every split in the tree to even ratios. Topology preserved; only
 *  divider positions move. No-op when the tree is null or a bare leaf. */
export function equalizeAllRatios(): void {
  const tree = currentTree();
  if (!tree || tree.kind === "leaf") return;
  setRuntimeLayoutStore("tree", equalizeRatios(tree));
  rebuildCells();
  scheduleActiveSave();
}

/** Rebuild the tree as a near-square tiled grid of all current leaves, in
 *  in-order traversal order. Pane ids (and their content) are preserved;
 *  only the tree shape changes. No-op for a tree of <2 leaves. */
export function tileAll(): void {
  const tree = currentTree();
  if (!tree) return;
  const ids = treeLeafIds(tree);
  if (ids.length < 2) return;
  const next = tileLeaves(ids);
  if (!next) return;
  setRuntimeLayoutStore("tree", next);
  rebuildCells();
  scheduleActiveSave();
}

/** Run a `compact()` pass: collapse unary splits and merge adjacent same-axis
 *  splits. Idempotent. */
export function compactTree(): void {
  const tree = currentTree();
  if (!tree) return;
  setRuntimeLayoutStore("tree", compact(tree));
  rebuildCells();
  scheduleActiveSave();
}

function setRatiosAt(node: LayoutNode, path: number[], ratios: number[]): LayoutNode {
  if (node.kind === "leaf") return node;
  if (path.length === 0) return { ...node, ratios };
  const [head, ...rest] = path;
  const nextChildren = [...node.children];
  nextChildren[head] = setRatiosAt(node.children[head], rest, ratios);
  return { ...node, children: nextChildren };
}

function treeContains(tree: LayoutNode, id: string): boolean {
  return pathToLeaf(tree, id) !== null;
}

// ---- tab mutations (unchanged semantics, tree-aware) ----------------------

export function setTabSessionId(cellId: string, tabId: string, sessionId: string): void {
  const pane = runtimeLayoutStore.panes[cellId];
  if (!pane) return;
  const tabIdx = pane.tabs.findIndex((t) => t.id === tabId);
  if (tabIdx === -1) return;
  setRuntimeLayoutStore("panes", cellId, "tabs", tabIdx, { sessionId });
  rebuildCells();
  scheduleActiveSave();
}

/** Legacy: set sessionId on the active tab. */
export function setSessionId(cellId: string, sessionId: string | undefined): void {
  if (!sessionId) return;
  const pane = runtimeLayoutStore.panes[cellId];
  if (!pane) return;
  setTabSessionId(cellId, pane.activeTabId, sessionId);
}

export function addCellTab(cellId: string): string {
  const pane = runtimeLayoutStore.panes[cellId];
  if (!pane) return "";
  const tabId = nextTabId();
  setRuntimeLayoutStore("panes", cellId, "tabs", (prev) => [...prev, { id: tabId }]);
  setRuntimeLayoutStore("panes", cellId, "activeTabId", tabId);
  rebuildCells();
  scheduleActiveSave();
  return tabId;
}

export function removeCellTab(cellId: string, tabId: string): void {
  const pane = runtimeLayoutStore.panes[cellId];
  if (!pane) return;
  if (pane.tabs.length <= 1) {
    removePane(cellId);
    return;
  }
  if (pane.activeTabId === tabId) {
    const idx = pane.tabs.findIndex((t) => t.id === tabId);
    const neighbor = idx > 0 ? pane.tabs[idx - 1] : pane.tabs[idx + 1];
    if (neighbor) {
      setRuntimeLayoutStore("panes", cellId, "activeTabId", neighbor.id);
    }
  }
  setRuntimeLayoutStore("panes", cellId, "tabs", (prev) => prev.filter((t) => t.id !== tabId));
  rebuildCells();
  scheduleActiveSave();
}

/** Set (or clear) the user-chosen label on a tab. Whitespace-only inputs
 *  clear the label so the tab strip falls back to icon-only rendering. */
export function setTabLabel(cellId: string, tabId: string, label: string | undefined): void {
  const pane = runtimeLayoutStore.panes[cellId];
  if (!pane) return;
  const tabIdx = pane.tabs.findIndex((t) => t.id === tabId);
  if (tabIdx === -1) return;
  const trimmed = label?.trim();
  const next = trimmed && trimmed.length > 0 ? trimmed : undefined;
  setRuntimeLayoutStore("panes", cellId, "tabs", tabIdx, { label: next });
  rebuildCells();
  scheduleActiveSave();
}

/** Set the tab's tmux-derived automatic label. Writes only when it actually
 *  changes so Solid's reactivity doesn't rebuild cells on every poll tick.
 *  `autoLabel` is never persisted (see `scheduleActiveSave` serialization). */
export function setTabAutoLabel(
  cellId: string,
  tabId: string,
  autoLabel: string | undefined,
): void {
  const pane = runtimeLayoutStore.panes[cellId];
  if (!pane) return;
  const tabIdx = pane.tabs.findIndex((t) => t.id === tabId);
  if (tabIdx === -1) return;
  const trimmed = autoLabel?.trim();
  const next = trimmed && trimmed.length > 0 ? trimmed : undefined;
  if (pane.tabs[tabIdx].autoLabel === next) return;
  setRuntimeLayoutStore("panes", cellId, "tabs", tabIdx, { autoLabel: next });
  rebuildCells();
}

export function setActiveTabId(cellId: string, tabId: string): void {
  if (!runtimeLayoutStore.panes[cellId]) return;
  setRuntimeLayoutStore("panes", cellId, "activeTabId", tabId);
  rebuildCells();
  scheduleActiveSave();
}

// ---- legacy aliases (kept so existing callers still compile) ---------------

/** @deprecated — use `splitPane` / `splitFocusedOrRoot`. Temporarily kept for
 *  external callers that still pass a pre-computed geometry we can ignore. */
export function upsertCell(cell: RuntimeCell): void {
  // Register pane content.
  setRuntimeLayoutStore("panes", cell.id, {
    id: cell.id,
    kind: cell.kind,
    title: cell.title,
    tabs: cell.tabs,
    activeTabId: cell.activeTabId,
    projectSlug: cell.projectSlug,
    worktreeId: cell.worktreeId,
    lastSnippet: cell.lastSnippet,
    lastActivityMs: cell.lastActivityMs,
  });
  const tree = currentTree();
  if (!tree) {
    setRuntimeLayoutStore("tree", leaf(cell.id));
  } else if (!treeContains(tree, cell.id)) {
    // Splice in at the root's right edge.
    setRuntimeLayoutStore("tree", splitAtRoot(tree, "right", leaf(cell.id)));
  }
  rebuildCells();
  scheduleActiveSave();
}

/** @deprecated — gridstack is gone; kept as a no-op for callers in flight. */
export function patchGeometry(
  _updates: { id: string; x: number; y: number; w: number; h: number }[],
): void {
  // No-op. Geometry is derived from the tree.
}

/** @deprecated — use `removePane`. */
export function removeCell(id: string): void {
  removePane(id);
}

// ---- maximize -------------------------------------------------------------

export function toggleMaximize(paneId: string): void {
  const current = maximizedPaneId();
  setMaximizedPaneId(current === paneId ? null : paneId);
}

export function clearMaximize(): void {
  setMaximizedPaneId(null);
}

// ---- focus cycling --------------------------------------------------------

export function focusPaneByIndex(oneBasedIndex: number): void {
  const tree = currentTree();
  if (!tree) return;
  const ids = treeLeafIds(tree);
  const id = ids[oneBasedIndex - 1];
  if (id) setFocusedPaneId(id);
}

export function cycleFocus(direction: "forward" | "back"): void {
  const tree = currentTree();
  if (!tree) return;
  const ids = treeLeafIds(tree);
  if (ids.length === 0) return;
  const current = focusedPaneId();
  const idx = current ? ids.indexOf(current) : -1;
  const next =
    direction === "forward"
      ? (idx + 1 + ids.length) % ids.length
      : (idx - 1 + ids.length) % ids.length;
  setFocusedPaneId(ids[next]);
}

// ---- test helper ----------------------------------------------------------

export function __resetRuntimeLayoutForTests(): void {
  setRuntimeLayoutStore({
    tree: null,
    panes: {},
    cells: [],
  });
  setMaximizedPaneId(null);
  setFocusedPaneId(null);
  setMinimizedPaneIds(new Set<string>());
  idCounter = 0;
  tabIdCounter = 0;
  if (_saveTimer !== null) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
}
