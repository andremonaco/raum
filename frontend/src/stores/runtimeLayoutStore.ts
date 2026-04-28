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
import { matchesWorktreeScope, type WorktreeScope } from "./worktreeStore";
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
  project_slug?: string;
  worktree_id?: string;
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
  /** Pane is registered but not in the BSP layout (lives in the dock).
   *  When true, x/y/w/h are unused on rehydrate. */
  minimized?: boolean;
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
  /** Per-tab project binding, captured at tab-spawn time. When set, a tab
   *  spawns into this worktree instead of inheriting the pane-level value —
   *  lets `+` open new tabs in the current sidebar-scoped worktree without
   *  rewriting the owning pane's `projectSlug`/`worktreeId` (which would
   *  break the pane-pruning filter). */
  projectSlug?: string;
  worktreeId?: string;
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
const [maximizeLayoutSnap, setMaximizeLayoutSnap] = createSignal(false);
const [focusedPaneId, setFocusedPaneId] = createSignal<string | null>(null);
const [minimizedPaneIds, setMinimizedPaneIds] = createSignal<ReadonlySet<string>>(new Set());
let maximizeLayoutSnapTimer: ReturnType<typeof setTimeout> | null = null;

function snapMaximizeLayoutOnce(): void {
  setMaximizeLayoutSnap(true);
  if (maximizeLayoutSnapTimer !== null) clearTimeout(maximizeLayoutSnapTimer);
  maximizeLayoutSnapTimer = setTimeout(() => {
    maximizeLayoutSnapTimer = null;
    setMaximizeLayoutSnap(false);
  }, 50);
}

// Monotonic layout revision, bumped inside `rebuildCells()` after every
// tree or pane mutation. Consumers that cache layout-derived projections
// (e.g. the scoped-projection cache in `terminal-grid.tsx`) key entries
// on the value so a single signal read tells them whether their cached
// value is still valid.
const [layoutRev, setLayoutRev] = createSignal(0);

export {
  runtimeLayoutStore,
  maximizedPaneId,
  maximizeLayoutSnap,
  focusedPaneId,
  setFocusedPaneId,
  minimizedPaneIds,
  layoutRev,
};

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
  setLayoutRev((prev) => prev + 1);
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
  // key, producing surgical updates so chrome/projection consumers keep
  // stable cell identity across layout mutations.
  setRuntimeLayoutStore("cells", reconcile(cells, { key: "id", merge: true }));
}

// ---- minimize / focus -----------------------------------------------------

export function isPaneMinimized(id: string): boolean {
  return minimizedPaneIds().has(id);
}

/** Take a pane out of the active BSP layout and stash it to the dock.
 *  Removes its leaf from `tree` so siblings reflow to fill the freed space.
 *  The `PaneContent` stays in `panes` and the xterm surface keeps mounting
 *  off-tree (see `projectTerminalSurfaces`), so scrollback survives. */
export function minimizePane(paneId: string): void {
  if (!runtimeLayoutStore.panes[paneId]) return;
  const mins = minimizedPaneIds();
  if (mins.has(paneId)) return;

  const tree = currentTree();
  if (tree && treeContains(tree, paneId)) {
    const next = removeLeaf(tree, paneId);
    setRuntimeLayoutStore("tree", next);
  }
  if (maximizedPaneId() === paneId) {
    snapMaximizeLayoutOnce();
    setMaximizedPaneId(null);
  }
  if (focusedPaneId() === paneId) setFocusedPaneId(null);
  const nextSet = new Set(mins);
  nextSet.add(paneId);
  setMinimizedPaneIds(nextSet);
  rebuildCells();
  scheduleActiveSave();
}

/** Lift a previously-minimized pane back into the grid. Reuses the
 *  spawn-style auto-placement (`splitFocusedOrRoot`) so the pane lands
 *  next to the focused leaf — same gesture as opening a new harness. */
export function restorePane(paneId: string): void {
  const mins = minimizedPaneIds();
  if (!mins.has(paneId)) return;
  const nextSet = new Set(mins);
  nextSet.delete(paneId);
  setMinimizedPaneIds(nextSet);

  const pane = runtimeLayoutStore.panes[paneId];
  if (!pane) {
    rebuildCells();
    scheduleActiveSave();
    return;
  }
  const tree = currentTree();
  if (tree && treeContains(tree, paneId)) {
    rebuildCells();
    scheduleActiveSave();
    return;
  }
  insertExistingPaneFocused(paneId);
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
 *  accurate for minimized/hidden panes. Terminal surfaces now stay mounted,
 *  but backend state-change events remain the lowest-churn signal for dock
 *  ordering. */
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
 * matches the active project + the sidebar's worktree scope. Shell panes
 * (no `projectSlug`) always survive — unowned, visible across every project
 * tab. Panes whose `worktreeId` is `undefined` are treated as the main
 * worktree so terminals spawned before the worktree-id plumbing landed don't
 * disappear when the user picks the main row. Returns `null` when every leaf
 * ends up pruned.
 *
 * Used by the grid render layer to scope the visible BSP tree. Pure — does
 * not touch the store; `runtimeLayoutStore.tree` still holds every project's
 * layout so switching tabs restores geometry.
 */
export function pruneTreeByScope(
  tree: LayoutNode | null,
  activeSlug: string | undefined,
  scope: WorktreeScope,
  panes: Record<string, PaneContent>,
  mainPath: string | undefined,
): LayoutNode | null {
  if (!tree) return null;
  let result: LayoutNode | null = tree;
  for (const id of treeLeafIds(tree)) {
    const pane = panes[id];
    if (!pane) continue;
    if (pane.projectSlug === undefined) continue;
    if (pane.projectSlug !== activeSlug) {
      result = removeLeaf(result, id);
      if (!result) return null;
      continue;
    }
    if (!matchesWorktreeScope(scope, pane.worktreeId, mainPath)) {
      result = removeLeaf(result, id);
      if (!result) return null;
    }
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
    const inTreeCells = runtimeLayoutStore.cells;
    const inTreeIds = new Set(inTreeCells.map((c) => c.id));
    const mins = minimizedPaneIds();
    const offTreePanes: PaneContent[] = [];
    for (const pane of Object.values(runtimeLayoutStore.panes)) {
      if (inTreeIds.has(pane.id)) continue;
      // Only persist off-tree panes that are tracked as minimized; any other
      // off-tree pane is in-flight (mid-mutation) and shouldn't ride along.
      if (mins.has(pane.id)) offTreePanes.push(unwrap(pane) as PaneContent);
    }
    const serializeTabs = (tabs: CellTab[]): ActiveLayoutTab[] =>
      tabs.map((t) => ({
        id: t.id,
        session_id: t.sessionId,
        ...(t.label ? { label: t.label } : {}),
        ...(t.projectSlug ? { project_slug: t.projectSlug } : {}),
        ...(t.worktreeId ? { worktree_id: t.worktreeId } : {}),
      }));
    const payload: ActiveLayoutState = {
      saved_at: Math.floor(Date.now() / 1000),
      cells: [
        ...inTreeCells.map((c) => ({
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
          tabs: serializeTabs(c.tabs),
        })),
        ...offTreePanes.map((p) => ({
          id: p.id,
          x: 0,
          y: 0,
          w: 0,
          h: 0,
          kind: p.kind,
          title: p.title,
          project_slug: p.projectSlug,
          worktree_id: p.worktreeId,
          active_tab_id: p.activeTabId,
          tabs: serializeTabs(p.tabs),
          minimized: true,
        })),
      ],
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
    | (Omit<RuntimeCell, "tabs" | "activeTabId"> & {
        tabs?: CellTab[];
        activeTabId?: string;
        minimized?: boolean;
      })
  >,
): void {
  if (cells.length === 0) {
    setRuntimeLayoutStore({
      tree: null,
      panes: {},
      cells: [],
    });
    setMaximizedPaneId(null);
    setMinimizedPaneIds(new Set<string>());
    scheduleActiveSave();
    return;
  }

  const panes: Record<string, PaneContent> = {};
  const rects: Rect[] = [];
  const minimizedIds = new Set<string>();
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
    const isMinimized = (raw as { minimized?: boolean }).minimized === true;
    if (isMinimized) {
      minimizedIds.add(raw.id);
      continue;
    }
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
  const rebuilt = rects.length > 0 ? buildFromRects(rects, LAYOUT_UNIT) : null;

  setRuntimeLayoutStore({
    tree: rebuilt,
    panes,
  });
  rebuildCells();
  setMaximizedPaneId(null);
  setMinimizedPaneIds(minimizedIds);
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
  setRuntimeLayoutStore("panes", newPane.id, newPane);
  insertExistingPaneFocused(newPane.id);
}

/** Insert an already-registered pane (must already exist in
 *  `runtimeLayoutStore.panes`) into the tree using the same focused-or-root
 *  auto-placement rule as `splitFocusedOrRoot`. Used by both spawn
 *  (`splitFocusedOrRoot`) and `restorePane`. */
function insertExistingPaneFocused(paneId: string): void {
  const focus = focusedPaneId();
  const tree = currentTree();
  const newLeaf = leaf(paneId);
  let nextTree: LayoutNode;
  if (!tree) {
    nextTree = newLeaf;
  } else if (focus && focus !== paneId && treeContains(tree, focus)) {
    // Bias toward bottom splits so the grid grows row-first: only split
    // right when the focused pane is substantially wider than tall. On a
    // typical 16:9 viewport this still produces a first 2-column split
    // (w/h ≈ 1.78), but once columns exist further splits stack rows.
    const cell = runtimeLayoutStore.cells.find((c) => c.id === focus);
    const direction: Direction = cell && cell.w > cell.h * 1.6 ? "right" : "bottom";
    nextTree = splitAtLeaf(tree, focus, direction, newLeaf);
  } else {
    nextTree = splitAtRoot(tree, "right", newLeaf);
  }
  setRuntimeLayoutStore("tree", nextTree);
  rebuildCells();
  scheduleActiveSave();
}

/** Mount an existing tmux session into a freshly-created pane. Used by the
 *  dock to adopt orphan sessions back into the grid: the new pane carries the
 *  supplied `sessionId` on its sole tab so `<TerminalPane>` reattaches via
 *  `terminal_reattach` instead of spawning a new harness. Returns the new
 *  pane id so the caller can focus it. */
export function adoptOrphanSession(args: {
  sessionId: string;
  kind: CellKind;
  projectSlug?: string;
  worktreeId?: string;
}): string {
  const paneId = nextCellId();
  const tabId = nextTabId();
  const tab: CellTab = { id: tabId, sessionId: args.sessionId };
  if (args.projectSlug !== undefined) tab.projectSlug = args.projectSlug;
  if (args.worktreeId !== undefined) tab.worktreeId = args.worktreeId;
  const pane: PaneContent = {
    id: paneId,
    kind: args.kind,
    tabs: [tab],
    activeTabId: tabId,
    projectSlug: args.projectSlug,
    worktreeId: args.worktreeId,
  };
  splitFocusedOrRoot(pane);
  return paneId;
}

/** Remove a pane and its content. Collapses unary parents automatically. */
export function removePane(id: string): void {
  // Drop any pending-reset keys for this pane's tabs before we delete it from
  // the store so the spawn-cleanup helpers don't keep stale entries around.
  const pane = runtimeLayoutStore.panes[id];
  if (pane) {
    for (const t of pane.tabs) pendingResetKeys.delete(tabResetKey(id, t.id));
  }
  const tree = currentTree();
  if (tree) {
    const next = removeLeaf(tree, id);
    setRuntimeLayoutStore("tree", next);
  }
  setRuntimeLayoutStore("panes", id, undefined as unknown as PaneContent);
  // Clear volatile per-pane state.
  if (maximizedPaneId() === id) {
    snapMaximizeLayoutOnce();
    setMaximizedPaneId(null);
  }
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

export function addCellTab(
  cellId: string,
  init?: { projectSlug?: string; worktreeId?: string },
): string {
  const pane = runtimeLayoutStore.panes[cellId];
  if (!pane) return "";
  const tabId = nextTabId();
  const newTab: CellTab = { id: tabId };
  if (init?.projectSlug !== undefined) newTab.projectSlug = init.projectSlug;
  if (init?.worktreeId !== undefined) newTab.worktreeId = init.worktreeId;
  setRuntimeLayoutStore("panes", cellId, "tabs", (prev) => [...prev, newTab]);
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
    pendingResetKeys.delete(tabResetKey(cellId, tabId));
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
  pendingResetKeys.delete(tabResetKey(cellId, tabId));
  rebuildCells();
  scheduleActiveSave();
}

/** Remove every layout tab that points at a backend session id.
 *
 * Used when the backend emits `terminal-session-removed` (explicit kill,
 * natural process exit, stale reattach miss). The terminal registry is the
 * source of truth for whether a session exists; once it is gone, keeping a
 * persisted tab around just makes the next reload reattach-miss and spawn
 * confusing replacement harnesses.
 */
export function removeTabsBySessionId(sessionId: string): void {
  if (!sessionId) return;
  const matches: Array<{ cellId: string; tabId: string }> = [];
  for (const pane of Object.values(runtimeLayoutStore.panes)) {
    for (const tab of pane.tabs) {
      if (tab.sessionId === sessionId) matches.push({ cellId: pane.id, tabId: tab.id });
    }
  }
  for (const match of matches) {
    const pane = runtimeLayoutStore.panes[match.cellId];
    if (!pane) continue;
    if (!pane.tabs.some((tab) => tab.id === match.tabId)) continue;
    removeCellTab(match.cellId, match.tabId);
  }
}

// ---- pending-reset registry (transient; not persisted) --------------------
//
// Cmd+R "reset-harness" flips this flag on the old tab BEFORE awaiting the
// `terminal_kill` for its session. If the tab's spawn was still in flight
// (oldSessionId undefined), the flag tells `<TerminalPane>`'s post-spawn
// handler that the resolved session is doomed: kill it instead of plumbing
// it into the store. Mirrored by `isTabAlive`, which returns false once the
// tab is gone from `runtimeLayoutStore.panes` — covers the case where
// `removeCellTab` already pulled the tab.

const pendingResetKeys = new Set<string>();

function tabResetKey(cellId: string, tabId: string): string {
  return `${cellId}::${tabId}`;
}

export function markTabPendingReset(cellId: string, tabId: string): void {
  pendingResetKeys.add(tabResetKey(cellId, tabId));
}

export function isTabPendingReset(cellId: string, tabId: string): boolean {
  return pendingResetKeys.has(tabResetKey(cellId, tabId));
}

export function isTabAlive(cellId: string, tabId: string): boolean {
  const pane = runtimeLayoutStore.panes[cellId];
  if (!pane) return false;
  return pane.tabs.some((t) => t.id === tabId);
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
  const next = current === paneId ? null : paneId;
  if (current === next) return;
  snapMaximizeLayoutOnce();
  setMaximizedPaneId(next);
}

export function clearMaximize(): void {
  if (maximizedPaneId() === null) return;
  snapMaximizeLayoutOnce();
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
  setMaximizeLayoutSnap(false);
  if (maximizeLayoutSnapTimer !== null) {
    clearTimeout(maximizeLayoutSnapTimer);
    maximizeLayoutSnapTimer = null;
  }
  setFocusedPaneId(null);
  setMinimizedPaneIds(new Set<string>());
  setLayoutRev(0);
  idCounter = 0;
  tabIdCounter = 0;
  pendingResetKeys.clear();
  if (_saveTimer !== null) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
}
