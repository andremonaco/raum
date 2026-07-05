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
import { activeProjectSlug } from "./projectStore";
import { activeWorktreeStore, matchesWorktreeScope, type WorktreeScope } from "./worktreeStore";
import {
  buildFromRects,
  compact,
  equalizeRatios,
  findBoundaryLCA,
  leaf,
  leafIds as treeLeafIds,
  MIN_RATIO,
  normalizeRatios,
  pathToLeaf,
  projectToRects,
  removeLeaf,
  splitAtLeaf,
  splitAtRoot,
  swapLeaves,
  tileLeaves,
  type Axis,
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
  /** Per-project sidebar scope: `slug → worktree path`. Missing slugs map to
   *  the cross-worktree "all" view on rehydrate. Round-tripped so the user's
   *  per-project worktree pin survives a restart and is reapplied as soon as
   *  they switch back to that project. */
  worktree_scopes?: Record<string, string>;
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
  /** Cross-harness review: when the tab is spawned, this string is forwarded
   *  to `terminal_spawn` as `initial_prompt`. Cleared after the first
   *  successful spawn so reattach paths don't see it. Not persisted. */
  initialPrompt?: string;
  /** Cross-harness review: when set, the next successful spawn for this tab
   *  will record a review link with the given session id (= the reviewed
   *  session) and clear this field. Not persisted. */
  pendingReviewOf?: string;
  /** Cross-harness review: per-spawn model + effort override picked by the
   *  user in the pre-spawn picker. Forwarded to `terminal_spawn` as
   *  `modelOverride` on the next spawn and cleared by `clearTabReviewPending`.
   *  Not persisted. */
  modelOverride?: { model: string; effort?: string };
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

// ---- bounded layout-undo history ------------------------------------------
//
// Contract B (undo): every *structural* mutation (split / move / swap / remove)
// snapshots the prior tree + focus into a capped LIFO stack BEFORE applying its
// change. `undoLayout()` pops the newest snapshot and restores it. We snapshot
// only topology-changing ops — not ratio nudges or tab edits — so a single undo
// reverses one meaningful layout gesture rather than a sub-pixel divider drag.
//
// The tree is deep-cloned on capture (via `currentTree()`, which already
// JSON-round-trips out of the Solid proxy) so a later in-place mutation can't
// retroactively corrupt a stored snapshot.

interface LayoutSnapshot {
  tree: LayoutNode | null;
  focusedPaneId: string | null;
  /** Off-tree visibility flags captured alongside the tree. Without these,
   *  undoing a minimize/restore (or a reshape done while a pane was
   *  minimized/maximized) would leave the dock and the tree disagreeing —
   *  e.g. a pane both present in the restored tree AND still flagged
   *  minimized, i.e. an invisible-in-grid live session. */
  minimized: ReadonlySet<string>;
  maximized: string | null;
}

const LAYOUT_HISTORY_LIMIT = 50;
const layoutHistory: LayoutSnapshot[] = [];
const [layoutHistoryDepth, setLayoutHistoryDepth] = createSignal(0);

/** Capture the current tree + focus onto the undo stack. Called at the START of
 *  every structural mutation, before the tree is replaced. Caps the stack at
 *  `LAYOUT_HISTORY_LIMIT` by dropping the oldest entry. */
export function pushLayoutHistory(): void {
  layoutHistory.push({
    tree: currentTree(),
    focusedPaneId: focusedPaneId(),
    minimized: new Set(minimizedPaneIds()),
    maximized: maximizedPaneId(),
  });
  if (layoutHistory.length > LAYOUT_HISTORY_LIMIT) layoutHistory.shift();
  setLayoutHistoryDepth(layoutHistory.length);
}

/** True when there is at least one layout snapshot to restore. Reactive. */
export function canUndoLayout(): boolean {
  return layoutHistoryDepth() > 0;
}

/** Restore the most recent layout snapshot (Contract B). Pops one entry, swaps
 *  the tree back, and re-points focus at the snapshot's focused pane when it
 *  still exists (else clears focus so we never highlight a vanished pane).
 *  Schedules a save so the restored layout persists. No-op when the stack is
 *  empty. Does NOT itself push history — undo is not undoable. Returns `true`
 *  when a snapshot was actually restored, `false` when the stack was empty —
 *  callers use this to keep the "Undid…" toast honest. */
export function undoLayout(): boolean {
  const snap = layoutHistory.pop();
  setLayoutHistoryDepth(layoutHistory.length);
  if (!snap) return false;
  setRuntimeLayoutStore("tree", snap.tree);
  // Restore the off-tree visibility flags captured with the tree, then
  // reconcile against the restored tree so the dock and grid can never
  // disagree: a pane that is back in the tree must NOT remain flagged
  // minimized, and a maximized id that isn't in the tree must be cleared.
  const restoredMin = new Set<string>();
  for (const id of snap.minimized) {
    if (!snap.tree || !treeContains(snap.tree, id)) restoredMin.add(id);
  }
  // Retain any pane that is minimized RIGHT NOW but absent from the restored
  // tree. Such a pane was minimized after this snapshot was taken — most
  // importantly a tab the inactivity auto-dock extracted into its own off-tree
  // pane (`minimizeTab`, which deliberately records no history). Without this,
  // undo would rebuild the minimized set purely from `snap.minimized`, dropping
  // that pane's flag while its `panes` entry survives — stranding it off-tree
  // AND unminimized: invisible in both grid and dock, yet a live session.
  // (A pane minimized *and* present in `snap.tree` is the normal undo-a-minimize
  // case and must still be un-minimized, so the tree-absence check is required.)
  for (const id of minimizedPaneIds()) {
    if ((!snap.tree || !treeContains(snap.tree, id)) && runtimeLayoutStore.panes[id]) {
      restoredMin.add(id);
    }
  }
  setMinimizedPaneIds(restoredMin);
  setMaximizedPaneId(
    snap.maximized && snap.tree && treeContains(snap.tree, snap.maximized) ? snap.maximized : null,
  );
  // Restore focus only if that pane is still part of the restored tree.
  if (snap.focusedPaneId && snap.tree && treeContains(snap.tree, snap.focusedPaneId)) {
    setFocusedPaneId(snap.focusedPaneId);
  } else if (focusedPaneId() && (!snap.tree || !treeContains(snap.tree, focusedPaneId()!))) {
    setFocusedPaneId(null);
  }
  rebuildCells();
  scheduleActiveSave();
  return true;
}

const [maximizedPaneId, setMaximizedPaneId] = createSignal<string | null>(null);
// True for the duration of a maximize/restore transition. Drives the
// `.maximize-anim` class on the grid root, which extends the chrome's
// position transition to `.terminal-surface-frame` so live xterm pixels
// grow/shrink in lockstep with the chrome (without polluting the rest
// of the surface's lifecycle, which intentionally avoids transitions).
const [maximizeAnim, setMaximizeAnim] = createSignal(false);
// Pane whose position is currently animating. While maximizing it equals
// the new `maximizedPaneId`; while restoring it equals the previous one.
// Used in CSS to keep that pane painted (and every other one
// `visibility: hidden`) for the full transition window — the chrome layer
// sits above the surface layer, so without this the headers of the other
// panes would paint over the maximized terminal during restore.
const [maxAnimTargetId, setMaxAnimTargetId] = createSignal<string | null>(null);
const [focusedPaneId, setFocusedPaneId] = createSignal<string | null>(null);
const [minimizedPaneIds, setMinimizedPaneIds] = createSignal<ReadonlySet<string>>(new Set());
let maximizeAnimTimer: ReturnType<typeof setTimeout> | null = null;

// Slightly longer than the spring transition (180 ms) so the window outlasts
// the overshoot tail and the surface stays glued to the chrome end-to-end.
const MAXIMIZE_ANIM_MS = 240;

function pulseMaximizeAnim(targetId: string | null): void {
  setMaximizeAnim(true);
  setMaxAnimTargetId(targetId);
  if (maximizeAnimTimer !== null) clearTimeout(maximizeAnimTimer);
  maximizeAnimTimer = setTimeout(() => {
    maximizeAnimTimer = null;
    setMaximizeAnim(false);
    setMaxAnimTargetId(null);
  }, MAXIMIZE_ANIM_MS);
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
  maximizeAnim,
  maxAnimTargetId,
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
export function minimizePane(paneId: string, opts?: { recordHistory?: boolean }): void {
  if (!runtimeLayoutStore.panes[paneId]) return;
  const mins = minimizedPaneIds();
  if (mins.has(paneId)) return;
  // Snapshot pre-minimize (pane in tree, not minimized) so Cmd+Z brings it
  // back into the grid — minimize is a reversible visibility change. The
  // inactivity auto-dock passes `recordHistory: false` so a background dock
  // doesn't bury the user's last manual action under undo entries they never
  // made (the dock chip is the recovery affordance there).
  if (opts?.recordHistory !== false) pushLayoutHistory();

  const tree = currentTree();
  if (tree && treeContains(tree, paneId)) {
    const next = removeLeaf(tree, paneId);
    setRuntimeLayoutStore("tree", next);
  }
  if (maximizedPaneId() === paneId) {
    // Pane is leaving the tree entirely (minimize). No restore animation
    // possible — the chrome it would have shrunk back into is gone.
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
  // Snapshot pre-restore (pane in dock, not in tree) so Cmd+Z re-minimizes
  // it. Safe single push: insertExistingPaneFocused does not record history.
  pushLayoutHistory();
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

/** Pull a single tab out of a multi-tab pane and stash it in the dock as its
 *  own minimized single-tab pane. The tab's session stays alive — this is a
 *  MOVE, not a close (unlike `removeCellTab`, which tears the pane down when its
 *  last tab goes). A `CellTab` carries no `kind`, so the new pane inherits the
 *  source pane's `kind` (every tab in a pane shares it). When the pane holds
 *  only this one tab, the tab *is* the pane, so we minimize the whole pane.
 *
 *  Returns the id of the resulting minimized pane (the new single-tab pane for
 *  the multi-tab case, or `paneId` for the whole-pane case), or `null` on a
 *  no-op. `opts.activityMs` stamps the dock chip's "last used" time; the
 *  inactivity auto-dock passes the tab's computed idle time so the chip's
 *  relative timestamp + Recent sort stay accurate.
 *
 *  The multi-tab EXTRACTION path is intentionally NOT an undo step: the undo
 *  snapshot captures only the tree + visibility flags, not the `panes` map, so
 *  undoing the tab move (which mutates `panes[source].tabs`) would strand the
 *  extracted session off-tree and invisible. The dock chip is its recovery
 *  affordance instead. `opts.recordHistory` therefore only governs the
 *  single-tab delegate to `minimizePane` (a whole-pane minimize IS undoable). */
export function minimizeTab(
  paneId: string,
  tabId: string,
  opts?: { recordHistory?: boolean; activityMs?: number },
): string | null {
  const pane = runtimeLayoutStore.panes[paneId];
  if (!pane) return null;
  const tab = pane.tabs.find((t) => t.id === tabId);
  if (!tab) return null;

  if (pane.tabs.length <= 1) {
    minimizePane(paneId, { recordHistory: opts?.recordHistory });
    if (opts?.activityMs !== undefined && runtimeLayoutStore.panes[paneId]) {
      setRuntimeLayoutStore("panes", paneId, { lastActivityMs: opts.activityMs });
      applyCellActivityMirror(paneId, { lastActivityMs: opts.activityMs });
    }
    return paneId;
  }

  const newId = nextCellId();
  const movedTab = unwrap(tab) as CellTab;
  const newPane: PaneContent = {
    id: newId,
    kind: pane.kind,
    tabs: [movedTab],
    activeTabId: movedTab.id,
  };
  const projectSlug = movedTab.projectSlug ?? pane.projectSlug;
  const worktreeId = movedTab.worktreeId ?? pane.worktreeId;
  if (projectSlug !== undefined) newPane.projectSlug = projectSlug;
  if (worktreeId !== undefined) newPane.worktreeId = worktreeId;
  if (opts?.activityMs !== undefined) newPane.lastActivityMs = opts.activityMs;
  setRuntimeLayoutStore("panes", newId, newPane);

  // Reassign the source pane's active tab if we're moving the active one
  // (mirror `removeCellTab`'s neighbor pick), then drop the tab from it.
  if (pane.activeTabId === tabId) {
    const idx = pane.tabs.findIndex((t) => t.id === tabId);
    const neighbor = idx > 0 ? pane.tabs[idx - 1] : pane.tabs[idx + 1];
    if (neighbor) setRuntimeLayoutStore("panes", paneId, "activeTabId", neighbor.id);
  }
  setRuntimeLayoutStore("panes", paneId, "tabs", (prev) => prev.filter((t) => t.id !== tabId));

  const nextSet = new Set(minimizedPaneIds());
  nextSet.add(newId);
  setMinimizedPaneIds(nextSet);
  rebuildCells();
  scheduleActiveSave();
  return newId;
}

/** Mirror `panes[id]` activity metadata into the matching `cells[i]`
 *  entry without going through `rebuildCells()`. The full rebuild bumps
 *  `layoutRev`, which downstream layout-derived memos (notably the
 *  review-tether `positions` memo in `terminal-grid.tsx`) read as a
 *  signal that pane geometry changed — forcing a `<For>` rebuild that
 *  visibly remounts the tether DOM and replays its fade-in animation.
 *  Activity bumps don't change geometry, so we update `cells` surgically
 *  instead and skip the layout-rev signal. The dock and any consumer
 *  that subscribes to `cells[i].lastActivityMs` / `lastSnippet` directly
 *  still sees the new value via fine-grained store reactivity. */
function applyCellActivityMirror(
  paneId: string,
  patch: Partial<Pick<PaneContent, "lastActivityMs" | "lastSnippet">>,
): void {
  const idx = runtimeLayoutStore.cells.findIndex((c) => c.id === paneId);
  if (idx < 0) return;
  setRuntimeLayoutStore("cells", idx, patch);
}

export function setLastSnippet(cellId: string, snippet: string, activityMs: number): void {
  if (!runtimeLayoutStore.panes[cellId]) return;
  setRuntimeLayoutStore("panes", cellId, {
    lastSnippet: snippet,
    lastActivityMs: activityMs,
  });
  applyCellActivityMirror(cellId, { lastSnippet: snippet, lastActivityMs: activityMs });
  scheduleActiveSave();
}

/** Bump `lastActivityMs` on whichever pane owns `sessionId`. No-op if no pane
 *  tab currently points at that session. Used to keep the dock's Recent sort
 *  accurate for minimized/hidden panes. Terminal surfaces now stay mounted,
 *  but backend state-change events remain the lowest-churn signal for dock
 *  ordering. */
export function touchPaneBySession(sessionId: string): void {
  if (!sessionId) return;
  const now = Date.now();
  for (const pane of Object.values(runtimeLayoutStore.panes)) {
    if (pane.tabs.some((t) => t.sessionId === sessionId)) {
      setRuntimeLayoutStore("panes", pane.id, { lastActivityMs: now });
      applyCellActivityMirror(pane.id, { lastActivityMs: now });
      return;
    }
  }
}

/** Set of every session id currently bound to a tab of some pane in the
 *  layout — i.e. every session the user can actually see or restore (minimized
 *  panes stay in `panes`, so they count as placed). The complement of this set
 *  against the backend's `terminal_list` is the orphan set: live/tracked
 *  sessions with no on-screen home, surfaced for the user to close. Reactive —
 *  reads `runtimeLayoutStore.panes`, so callers inside a memo re-run when the
 *  layout changes. */
export function placedSessionIds(): Set<string> {
  const ids = new Set<string>();
  for (const pane of Object.values(runtimeLayoutStore.panes)) {
    for (const tab of pane.tabs) {
      if (tab.sessionId) ids.add(tab.sessionId);
    }
  }
  return ids;
}

/** Listen for `agent-state-changed` events and bump the owning pane's
 *  `lastActivityMs` on each transition. Call once at app startup; the
 *  returned function unsubscribes. Runs in parallel with the existing
 *  `subscribeAgentEvents()` in `agentStore`. */
export async function subscribePaneActivity(): Promise<UnlistenFn> {
  const unlisten = await listen<{ session_id: string | Record<string, unknown>; seeded?: boolean }>(
    "agent-state-changed",
    (ev) => {
      // Seed emits replay persisted state at boot — treating them as fresh
      // activity would stamp `lastActivityMs = now` on every restored pane and
      // flatten the dock's Recent ordering to a single instant. Ignore them;
      // only live transitions should bump activity.
      if (ev.payload.seeded) return;
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

/** Until `hydrateActiveLayout` finishes (or explicitly opens the gate when
 *  there is nothing to hydrate), `scheduleActiveSave` will queue saves but
 *  never actually invoke `active_layout_save`. This prevents a save fired
 *  by an early `setActiveProjectSlug` (from the project-list refresh that
 *  races layout hydration on launch) from overwriting the on-disk layout
 *  with `cells: []` before the saved cells are read back into the store. */
let _saveGateOpen = false;
let _savePendingWhileGated = false;

/** True once this session has actually READ a layout off disk (even an empty
 *  one) into the store. Stays false when the on-disk file failed to parse or
 *  the read never settled — in that case we must never let an early save write
 *  `cells: []` over a layout the user might still be able to salvage.
 *
 *  Signal-backed (Contract B) so reactive consumers — the rehydrate-ready gate
 *  in `app.tsx`, the recovery banner, the palette — can subscribe to
 *  `didActiveLayoutHydrate()` and re-run the instant hydration lands. The
 *  internal save-path reads (`isSavePayloadSafe`, the empty-save guard) go
 *  through the same accessor so the plain-`let` semantics are preserved.
 *
 *  The boot sequence (`hydrateActiveLayout`) flips this via
 *  `markActiveLayoutHydrated()` only on a clean read. Tests default it true
 *  (see `__resetRuntimeLayoutForTests`) so save-path tests keep working. */
const [didActiveLayoutHydrate, setDidActiveLayoutHydrate] = createSignal(false);

export { didActiveLayoutHydrate };

/** Mark that a real layout read completed this session. Called by
 *  `hydrateActiveLayout` after `active_layout_get` resolved (even with zero
 *  cells) so subsequent empty saves are legitimate. Not called on a read
 *  failure / timeout, which keeps the empty-save guard armed. Flips the
 *  reactive `didActiveLayoutHydrate()` signal true (Contract B). */
export function markActiveLayoutHydrated(): void {
  setDidActiveLayoutHydrate(true);
}

/** Distinct from {@link didActiveLayoutHydrate}: this flips true once the
 *  hydration ATTEMPT has finished, on EVERY exit path — clean read, zero
 *  cells, timeout, OR corrupt/quarantined TOML. The skeleton/empty-state UI
 *  gates on this so it always resolves (to the saved grid, the first-run CTA,
 *  or the spawn picker) and never hangs forever on a failed read; meanwhile
 *  `didActiveLayoutHydrate` stays unset on failures so the empty-save
 *  anti-clobber guard remains armed. */
const [activeLayoutHydrationSettled, setActiveLayoutHydrationSettled] = createSignal(false);

export { activeLayoutHydrationSettled };

/** Mark the hydration attempt as finished (any outcome). Call from
 *  `hydrateActiveLayout`'s `finally` so the skeleton can resolve. */
export function markActiveLayoutHydrationSettled(): void {
  setActiveLayoutHydrationSettled(true);
}

/** Open the save gate. Called by `hydrateActiveLayout` once hydration has
 *  either restored the saved cells or confirmed there were none. Any save
 *  request that arrived while the gate was closed is honoured here. */
export function openActiveLayoutSaveGate(): void {
  if (_saveGateOpen) return;
  _saveGateOpen = true;
  if (_savePendingWhileGated) {
    _savePendingWhileGated = false;
    scheduleActiveSave();
  }
}

/** Snapshot the per-project sidebar scope into a plain `slug → worktree path`
 *  map suitable for the active-layout TOML. "all" mode is encoded as an
 *  absent entry so the resulting map matches `BTreeMap::is_empty` on the
 *  Rust side and we don't bloat the file with default-valued rows. */
function collectWorktreeScopes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slug, scope] of Object.entries(activeWorktreeStore.byProject)) {
    if (!scope) continue;
    if (scope.mode === "worktree") out[slug] = scope.path;
  }
  return out;
}

/** Build the `ActiveLayoutState` payload from the current store. Pure read of
 *  the store — extracted so both the debounced save and `flushActiveLayoutNow`
 *  serialize the layout identically. */
function buildActiveLayoutPayload(): ActiveLayoutState {
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
  const scopes = collectWorktreeScopes();
  return {
    saved_at: Math.floor(Date.now() / 1000),
    ...(activeProjectSlug() !== undefined ? { project_slug: activeProjectSlug() } : {}),
    ...(Object.keys(scopes).length > 0 ? { worktree_scopes: scopes } : {}),
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
}

/** Guard against the destructive clobber: never overwrite a (possibly
 *  non-empty) on-disk layout with `cells: []` until this session has actually
 *  read the saved layout back into the store. Without this, an early save fired
 *  by the boot project-tab select (or fired after a corrupt/timed-out read that
 *  left the gate handling deferred) could replace a recoverable layout with a
 *  definitively empty one. Once a real layout has loaded, empty saves are
 *  legitimate (the user closed every pane). */
function isSavePayloadSafe(payload: ActiveLayoutState): boolean {
  if (payload.cells.length > 0) return true;
  return didActiveLayoutHydrate();
}

/** Record that a genuine non-empty layout has been written to disk THIS
 *  session. After a corrupt/timed-out read `didActiveLayoutHydrate()` stays
 *  false to block the boot-time empty clobber — but once the user has built and
 *  persisted a real layout, the on-disk file is known to be raum-owned and
 *  overwritable. From that point a later legitimate empty save (the user closed
 *  every pane) must persist `cells: []`; otherwise the next launch reloads the
 *  stale non-empty layout instead of the empty grid the user actually left.
 *
 *  The boot-time anti-clobber guarantee is preserved: this only flips on a
 *  NON-empty write, so an empty save fired before any read still hits the
 *  `!didActiveLayoutHydrate()` block. */
function markLayoutOwnedAfterNonEmptySave(): void {
  setDidActiveLayoutHydrate(true);
}

export function scheduleActiveSave(): void {
  if (!_saveGateOpen) {
    // Hydration hasn't finished yet — record that a save was requested and
    // bail. The gate-opener will retrigger this once hydration is done.
    _savePendingWhileGated = true;
    return;
  }
  if (_saveTimer !== null) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    const payload = buildActiveLayoutPayload();
    if (!isSavePayloadSafe(payload)) return;
    if (payload.cells.length > 0) markLayoutOwnedAfterNonEmptySave();
    invoke("active_layout_save", { layout: payload }).catch(console.warn);
  }, 500);
}

/** Contract 1 (quit-flush): clear the debounce timer and persist the current
 *  layout immediately, awaiting the backend write so a quit landing inside the
 *  500 ms quiet window doesn't lose the last layout mutation. No-op when the
 *  save gate is closed (hydration never opened it) or when the payload would
 *  destructively blank a never-hydrated layout. Errors are swallowed by the
 *  caller (`quitFlush.ts`) so one failing flush still acks the quit. */
export async function flushActiveLayoutNow(): Promise<void> {
  if (_saveTimer !== null) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  if (!_saveGateOpen) return;
  const payload = buildActiveLayoutPayload();
  if (!isSavePayloadSafe(payload)) return;
  if (payload.cells.length > 0) markLayoutOwnedAfterNonEmptySave();
  await invoke("active_layout_save", { layout: payload });
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
 *  otherwise. Returns nothing; this is the "new terminal" gesture. When
 *  `directionHint` is given (keyboard split-right / split-down), it forces the
 *  split orientation instead of the aspect-ratio heuristic. */
export function splitFocusedOrRoot(newPane: PaneContent, directionHint?: Direction): void {
  // Snapshot the pre-split tree so `undoLayout()` can reverse this spawn.
  // Registering pane *content* below doesn't touch the tree, so capturing
  // here still records the layout exactly as it was before the new leaf lands.
  pushLayoutHistory();
  setRuntimeLayoutStore("panes", newPane.id, newPane);
  insertExistingPaneFocused(newPane.id, directionHint);
}

/** Insert an already-registered pane (must already exist in
 *  `runtimeLayoutStore.panes`) into the tree using the same focused-or-root
 *  auto-placement rule as `splitFocusedOrRoot`. Used by both spawn
 *  (`splitFocusedOrRoot`) and `restorePane`. `directionHint`, when supplied,
 *  forces the split orientation (keyboard directional splits) instead of the
 *  aspect-ratio heuristic. */
function insertExistingPaneFocused(paneId: string, directionHint?: Direction): void {
  const focus = focusedPaneId();
  const tree = currentTree();
  const newLeaf = leaf(paneId);
  let nextTree: LayoutNode;
  if (!tree) {
    nextTree = newLeaf;
  } else if (focus && focus !== paneId && treeContains(tree, focus)) {
    // Honor an explicit direction (keyboard split-right/down); otherwise bias
    // toward bottom splits so the grid grows row-first: only split right when
    // the focused pane is substantially wider than tall. On a typical 16:9
    // viewport this still produces a first 2-column split (w/h ≈ 1.78), but
    // once columns exist further splits stack rows.
    const cell = runtimeLayoutStore.cells.find((c) => c.id === focus);
    const direction: Direction =
      directionHint ?? (cell && cell.w > cell.h * 1.6 ? "right" : "bottom");
    nextTree = splitAtLeaf(tree, focus, direction, newLeaf);
  } else {
    nextTree = splitAtRoot(tree, directionHint ?? "right", newLeaf);
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
  if (tree && treeContains(tree, id)) {
    // Deliberately NOT snapshotted for undo: closing a pane kills its
    // tmux session AND drops `panes[id]` below, so a restored leaf would
    // point at a dead session with no content. Close is final; layout-undo
    // covers reversible rearrangement (split/move/swap/minimize/reshape),
    // not destructive teardown.
    const next = removeLeaf(tree, id);
    setRuntimeLayoutStore("tree", next);
  }
  setRuntimeLayoutStore("panes", id, undefined as unknown as PaneContent);
  // Clear volatile per-pane state. The pane is gone — no restore animation
  // needed (and none possible: the chrome it would shrink back into has
  // been unmounted).
  if (maximizedPaneId() === id) {
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
  pushLayoutHistory();
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
  pushLayoutHistory();
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
  pushLayoutHistory();
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

/**
 * Adjust the ratio on whichever runtime split actually owns the visible
 * boundary between two adjacent groups of leaves. Dividers are computed
 * against the *pruned* tree (visible panes only), but the runtime tree
 * may have hidden siblings between the two visible neighbours, so a
 * pruned-tree path can land on the wrong split — or a leaf — when
 * applied verbatim. Looking up the matching split by leaf-id on each
 * side stays correct under any pruning + compaction.
 *
 * `prunedLeftRatio` / `prunedRightRatio` are the new shares the user
 * wants the two visible siblings to occupy *within their pruned
 * parent*. We rescale them by the runtime parent's visible-share so
 * hidden siblings keep their absolute ratios (they're invisible to
 * the user; touching them would surprise the next time the scope
 * filter changes).
 */
export function setSplitRatiosByBoundary(args: {
  axis: Axis;
  leftLeafIds: readonly string[];
  rightLeafIds: readonly string[];
  visibleLeafIds: readonly string[];
  prunedLeftRatio: number;
  prunedRightRatio: number;
}): void {
  const tree = currentTree();
  if (!tree || tree.kind === "leaf") return;
  const leftSet = new Set(args.leftLeafIds);
  const rightSet = new Set(args.rightLeafIds);
  const visibleSet = new Set(args.visibleLeafIds);
  const lca = findBoundaryLCA(tree, leftSet, rightSet);
  if (!lca) return;
  if (lca.node.axis !== args.axis) return;

  // Sum of LCA child-ratios whose subtree currently has any visible leaf.
  // Pruned ratios are runtime ratios divided by this sum; we invert to map
  // the user's pruned-space delta back to runtime-space deltas.
  let visibleSum = 0;
  for (let i = 0; i < lca.node.children.length; i++) {
    if (subtreeContainsAny(lca.node.children[i], visibleSet)) {
      visibleSum += lca.node.ratios[i];
    }
  }
  if (!Number.isFinite(visibleSum) || visibleSum <= 0) return;

  // Floor the requested pruned ratios so a single pane can't be dragged
  // into oblivion. The downstream `normalizeRatios` would re-floor anyway,
  // but doing it here keeps the left+right sum stable so hidden siblings
  // retain their original ratios after the rebuild.
  const minPruned = MIN_RATIO;
  let l = Math.max(args.prunedLeftRatio, minPruned);
  let r = Math.max(args.prunedRightRatio, minPruned);
  const prunedSum = l + r;
  if (prunedSum <= 0) return;

  // Original combined share at the LCA, in runtime coords.
  const oldCombined = lca.node.ratios[lca.leftIdx] + lca.node.ratios[lca.rightIdx];
  // Distribute that combined share by the new pruned ratio.
  l = (l / prunedSum) * oldCombined;
  r = (r / prunedSum) * oldCombined;

  const nextRatios = [...lca.node.ratios];
  nextRatios[lca.leftIdx] = l;
  nextRatios[lca.rightIdx] = r;
  const next = setRatiosAt(tree, lca.path, normalizeRatios(nextRatios));
  setRuntimeLayoutStore("tree", next);
  rebuildCells();
  scheduleActiveSave();
}

function subtreeContainsAny(node: LayoutNode, ids: ReadonlySet<string>): boolean {
  if (node.kind === "leaf") return ids.has(node.id);
  for (const c of node.children) {
    if (subtreeContainsAny(c, ids)) return true;
  }
  return false;
}

/** Reset every split in the tree to even ratios. Topology preserved; only
 *  divider positions move. No-op when the tree is null or a bare leaf. */
export function equalizeAllRatios(): void {
  const tree = currentTree();
  if (!tree || tree.kind === "leaf") return;
  pushLayoutHistory();
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
  pushLayoutHistory();
  setRuntimeLayoutStore("tree", next);
  rebuildCells();
  scheduleActiveSave();
}

/** Run a `compact()` pass: collapse unary splits and merge adjacent same-axis
 *  splits. Idempotent. */
export function compactTree(): void {
  const tree = currentTree();
  if (!tree) return;
  pushLayoutHistory();
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

/** Replace every tab reference to a backend session id.
 *
 * Used when restart recovery swaps a stale tmux session for a provider-resumed
 * replacement. The visual tab remains the same; only its backend identity
 * changes.
 */
export function replaceTabsSessionId(oldSessionId: string, newSessionId: string): void {
  if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) return;
  let changed = false;
  for (const pane of Object.values(runtimeLayoutStore.panes)) {
    pane.tabs.forEach((tab, idx) => {
      if (tab.sessionId !== oldSessionId) return;
      setRuntimeLayoutStore("panes", pane.id, "tabs", idx, { sessionId: newSessionId });
      changed = true;
    });
  }
  if (!changed) return;
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

/**
 * Cross-harness review: spawn a fresh reviewer pane next to the reviewed
 * pane. The new pane carries a single tab with `initialPrompt` and
 * `pendingReviewOf` so `<TerminalPane>` will spawn a fresh harness with
 * the review brief seeded as its first turn, and the post-spawn callback
 * can record the link via the backend.
 *
 * The reviewer runs in the *reviewed pane's* worktree; the dragged source
 * pane that triggered the gesture is left untouched — its session keeps
 * running in its original slot.
 *
 * Returns the freshly created pane + tab ids, or null if the target pane
 * no longer exists.
 */
export function spawnReviewerPane(
  reviewedCellId: string,
  args: {
    kind: CellKind;
    projectSlug?: string;
    worktreeId?: string;
    initialPrompt: string;
    reviewedSessionId: string;
    modelOverride?: { model: string; effort?: string };
  },
): { paneId: string; tabId: string } | null {
  if (!runtimeLayoutStore.panes[reviewedCellId]) return null;
  const paneId = nextCellId();
  const tabId = nextTabId();
  const tab: CellTab = {
    id: tabId,
    initialPrompt: args.initialPrompt,
    pendingReviewOf: args.reviewedSessionId,
    projectSlug: args.projectSlug,
    worktreeId: args.worktreeId,
    modelOverride: args.modelOverride,
  };
  const pane: PaneContent = {
    id: paneId,
    kind: args.kind,
    tabs: [tab],
    activeTabId: tabId,
    projectSlug: args.projectSlug,
    worktreeId: args.worktreeId,
  };
  splitPane(pane, reviewedCellId, "right");
  return { paneId, tabId };
}

/**
 * Clear the cross-harness-review pending fields on a tab once the linked
 * spawn has resolved. Idempotent — calling it on a tab that has neither
 * field set is a no-op.
 */
export function clearTabReviewPending(cellId: string, tabId: string): void {
  const pane = runtimeLayoutStore.panes[cellId];
  if (!pane) return;
  const tabIdx = pane.tabs.findIndex((t) => t.id === tabId);
  if (tabIdx === -1) return;
  const tab = pane.tabs[tabIdx];
  if (!tab.initialPrompt && !tab.pendingReviewOf && !tab.modelOverride) return;
  setRuntimeLayoutStore("panes", cellId, "tabs", tabIdx, {
    initialPrompt: undefined,
    pendingReviewOf: undefined,
    modelOverride: undefined,
  });
}

/** Read the pending-review session id for a given tab, if any. */
export function tabPendingReviewOf(cellId: string, tabId: string): string | undefined {
  const pane = runtimeLayoutStore.panes[cellId];
  if (!pane) return undefined;
  const tab = pane.tabs.find((t) => t.id === tabId);
  return tab?.pendingReviewOf;
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
  // Animation target = the pane that's actually moving. On maximize that's
  // the new max; on restore it's the one that just stopped being max.
  pulseMaximizeAnim(next ?? current);
  setMaximizedPaneId(next);
}

export function clearMaximize(): void {
  const current = maximizedPaneId();
  if (current === null) return;
  pulseMaximizeAnim(current);
  setMaximizedPaneId(null);
}

/**
 * Imperative maximize setter. Unlike `toggleMaximize`, the caller specifies
 * the desired end state. Pulses the maximize animation symmetrically on
 * open and restore so the chrome transition matches user-driven double-click.
 * No-op when already at target.
 *
 * Use case: transient overlays (e.g. the review picker) that need the host
 * pane full-window for the duration of the overlay.
 */
export function forceMaximizedPane(paneId: string | null): void {
  const current = maximizedPaneId();
  if (current === paneId) return;
  pulseMaximizeAnim(paneId ?? current);
  setMaximizedPaneId(paneId);
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

// ---- spatial keyboard primitives (Contract B) -----------------------------
//
// These drive the "navigate / move / resize panes from the keyboard" keymap
// actions registered by the GRID lane. All geometry is computed against the
// pixel-space projection of the *current* runtime tree (`projectToRects` on
// the LAYOUT_UNIT grid) so the spatial reasoning matches what the user sees.

type KeyDirection = "left" | "right" | "up" | "down";

/** Map a keyboard direction onto the BSP `Direction`/`Axis` vocabulary.
 *  up/down → vertical (col axis); left/right → horizontal (row axis). */
function keyDirToBsp(dir: KeyDirection): { direction: Direction; axis: Axis } {
  switch (dir) {
    case "left":
      return { direction: "left", axis: "row" };
    case "right":
      return { direction: "right", axis: "row" };
    case "up":
      return { direction: "top", axis: "col" };
    case "down":
      return { direction: "bottom", axis: "col" };
  }
}

/** Center point of a projected rect. */
function rectCenter(r: Rect): { cx: number; cy: number } {
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2 };
}

/**
 * Pick the pane spatially nearest the focused pane in `dir`. A candidate
 * qualifies only when its center lies on the correct side of the focused
 * pane's center along the primary axis (e.g. for "right", its cx must be
 * greater). Among qualifying candidates we minimize a weighted distance that
 * favours small cross-axis (perpendicular) offset, so a pane directly to the
 * right beats one that's both to the right and far up/down — the same heuristic
 * tmux/i3 use for directional focus.
 */
function nearestPaneInDirection(dir: KeyDirection): string | null {
  const tree = currentTree();
  if (!tree) return null;
  const current = focusedPaneId();
  if (!current) return null;
  const rects = projectToRects(tree, LAYOUT_UNIT);
  const from = rects.find((r) => r.id === current);
  if (!from) return null;
  const { cx, cy } = rectCenter(from);

  let best: { id: string; score: number } | null = null;
  for (const r of rects) {
    if (r.id === current) continue;
    const { cx: ox, cy: oy } = rectCenter(r);
    // Primary delta (must be positive in the travel direction) and the
    // perpendicular offset we penalize.
    let primary: number;
    let perp: number;
    switch (dir) {
      case "left":
        primary = cx - ox;
        perp = Math.abs(oy - cy);
        break;
      case "right":
        primary = ox - cx;
        perp = Math.abs(oy - cy);
        break;
      case "up":
        primary = cy - oy;
        perp = Math.abs(ox - cx);
        break;
      case "down":
        primary = oy - cy;
        perp = Math.abs(ox - cx);
        break;
    }
    if (primary <= 0) continue; // wrong side — skip
    // Weight perpendicular offset heavily so we prefer the pane that's most
    // directly in line. Primary distance breaks ties between equally-aligned
    // candidates.
    const score = primary + perp * 2;
    if (!best || score < best.score) best = { id: r.id, score };
  }
  return best ? best.id : null;
}

/** Move focus to the spatially-nearest pane in `dir`. No-op when there is no
 *  focused pane or no neighbour in that direction. */
export function focusByDirection(dir: KeyDirection): void {
  const next = nearestPaneInDirection(dir);
  if (next) setFocusedPaneId(next);
}

/**
 * Reposition the focused pane spatially: detach it and re-insert it adjacent to
 * its current neighbour in `dir`, via the same `movePaneToEdge` semantics that
 * back DnD edge-drops. When there is no neighbour in that direction (the pane is
 * already at the grid edge) we instead wrap the whole layout's outer edge with
 * `movePaneToRootEdge`, so e.g. "move-left" on the leftmost pane pushes it to
 * span the new far-left column. Both paths snapshot history for undo.
 */
export function movePaneDirectional(dir: KeyDirection): void {
  const current = focusedPaneId();
  if (!current) return;
  const { direction } = keyDirToBsp(dir);
  const neighbour = nearestPaneInDirection(dir);
  if (neighbour) {
    movePaneToEdge(current, neighbour, direction);
  } else {
    movePaneToRootEdge(current, direction);
  }
  // movePaneToEdge/RootEdge rebuild + save; keep focus on the moved pane so a
  // chain of moves stays anchored to the same pane.
  setFocusedPaneId(current);
}

/**
 * Keyboard divider resize. `dir` reads as "grow the focused pane toward `dir`":
 * "right" widens it by pushing its right divider rightward, "left" narrows it by
 * pulling that same divider back (or, on a left-edge pane, pulling its left
 * divider). The two concerns are deliberately separated:
 *
 *   1. WHICH divider — the boundary adjacent to the focused pane on the active
 *      axis. We prefer the neighbour on the `dir` side; when the pane sits at
 *      that grid edge (no neighbour there) we fall back to the divider on the
 *      opposite side so an edge pane can still resize.
 *   2. GROW vs SHRINK — set purely by `dir` relative to the focused pane, not by
 *      which side the chosen divider happens to be on.
 *
 * The actual ratio mutation is delegated to `setSplitRatiosByBoundary`, so the
 * hidden-sibling rescaling (when the scope filter hides panes between the two
 * visible neighbours) lives in exactly one place.
 */
export function nudgeFocusedDivider(dir: KeyDirection, stepFrac = 0.03): void {
  const current = focusedPaneId();
  if (!current) return;
  const tree = currentTree();
  if (!tree || tree.kind === "leaf") return;
  const opposite: Record<KeyDirection, KeyDirection> = {
    left: "right",
    right: "left",
    up: "down",
    down: "up",
  };
  // Grow/shrink INTENT comes from the direction: right/down grow the focused
  // pane, left/up shrink it (matches the Cmd+Alt+= / Cmd+Alt+- bindings). The
  // intent is independent of which physical divider we move, so it stays
  // correct whether the focused pane is on the low OR high side of its split
  // (the old dir-side heuristic inverted grow/shrink for high-side panes).
  const growIntent = dir === "right" || dir === "down";

  // Find ANY divider the focused pane borders. Prefer the requested axis
  // (dir + its opposite); if the pane has no neighbour on that axis — e.g. a
  // grow/shrink key pressed on a vertically-stacked pane, where left/right
  // both return null — fall back to the perpendicular axis so the keys never
  // silently no-op.
  const perpendicular: Record<KeyDirection, [KeyDirection, KeyDirection]> = {
    left: ["up", "down"],
    right: ["up", "down"],
    up: ["left", "right"],
    down: ["left", "right"],
  };
  let neighbour = nearestPaneInDirection(dir) ?? nearestPaneInDirection(opposite[dir]);
  let axis = keyDirToBsp(dir).axis;
  if (!neighbour) {
    const [pa, pb] = perpendicular[dir];
    neighbour = nearestPaneInDirection(pa) ?? nearestPaneInDirection(pb);
    axis = keyDirToBsp(pa).axis;
  }
  if (!neighbour) return;

  // Determine low/high ordering of the pair along the axis from their actual
  // projected positions — robust regardless of which side the neighbour is on.
  const rects = projectToRects(tree, LAYOUT_UNIT);
  const curRect = rects.find((r) => r.id === current);
  const nbrRect = rects.find((r) => r.id === neighbour);
  if (!curRect || !nbrRect) return;
  const curStart = axis === "row" ? curRect.x : curRect.y;
  const nbrStart = axis === "row" ? nbrRect.x : nbrRect.y;
  const focusedIsLow = curStart < nbrStart;
  const lowId = focusedIsLow ? current : neighbour;
  const highId = focusedIsLow ? neighbour : current;

  const lowRect = focusedIsLow ? curRect : nbrRect;
  const highRect = focusedIsLow ? nbrRect : curRect;
  const lowExtent = axis === "row" ? lowRect.w : lowRect.h;
  const highExtent = axis === "row" ? highRect.w : highRect.h;
  const combined = lowExtent + highExtent;
  if (combined <= 0) return;
  let lowFrac = lowExtent / combined;
  let highFrac = highExtent / combined;

  // Apply the grow/shrink intent to the FOCUSED pane's fraction (grow =
  // bigger), whichever side of the divider it sits on.
  const focusedDelta = growIntent ? stepFrac : -stepFrac;
  if (focusedIsLow) {
    lowFrac += focusedDelta;
    highFrac -= focusedDelta;
  } else {
    highFrac += focusedDelta;
    lowFrac -= focusedDelta;
  }
  // Clamp into [MIN_RATIO, 1 - MIN_RATIO]; setSplitRatiosByBoundary re-floors
  // anyway, but clamping here keeps the pair summing to ~1 so the divider lands
  // where we intend.
  lowFrac = Math.min(Math.max(lowFrac, MIN_RATIO), 1 - MIN_RATIO);
  highFrac = Math.min(Math.max(highFrac, MIN_RATIO), 1 - MIN_RATIO);

  setSplitRatiosByBoundary({
    axis,
    leftLeafIds: [lowId],
    rightLeafIds: [highId],
    visibleLeafIds: [lowId, highId],
    prunedLeftRatio: lowFrac,
    prunedRightRatio: highFrac,
  });
}

// ---- test helper ----------------------------------------------------------

export function __resetRuntimeLayoutForTests(): void {
  setRuntimeLayoutStore({
    tree: null,
    panes: {},
    cells: [],
  });
  setMaximizedPaneId(null);
  setMaximizeAnim(false);
  setMaxAnimTargetId(null);
  if (maximizeAnimTimer !== null) {
    clearTimeout(maximizeAnimTimer);
    maximizeAnimTimer = null;
  }
  setFocusedPaneId(null);
  setMinimizedPaneIds(new Set<string>());
  setLayoutRev(0);
  idCounter = 0;
  tabIdCounter = 0;
  pendingResetKeys.clear();
  // Tests run without an `app.tsx` boot so they never call
  // `openActiveLayoutSaveGate`; default the gate open here so existing
  // tests that exercise `scheduleActiveSave` keep their previous behaviour.
  _saveGateOpen = true;
  _savePendingWhileGated = false;
  // Likewise default the hydration flag true so save-path tests aren't blocked
  // by the empty-save guard (which only fires on the never-hydrated boot path).
  setDidActiveLayoutHydrate(true);
  setActiveLayoutHydrationSettled(true);
  layoutHistory.length = 0;
  setLayoutHistoryDepth(0);
  if (_saveTimer !== null) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
}

/** Test helper: force the boot-time gate/hydration flags so tests can exercise
 *  the launch path (gate closed until hydration, empty-save guard armed) that
 *  `__resetRuntimeLayoutForTests` deliberately bypasses. */
export function __setActiveLayoutBootStateForTests(state: {
  gateOpen: boolean;
  didHydrate: boolean;
}): void {
  _saveGateOpen = state.gateOpen;
  _savePendingWhileGated = false;
  setDidActiveLayoutHydrate(state.didHydrate);
  if (_saveTimer !== null) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
}
