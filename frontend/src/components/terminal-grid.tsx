/**
 * <TerminalGrid> — BSP split-tree terminal grid with persistent panes.
 *
 * Architecture:
 *   - **Pane layer** — a single flat `<For each={cells}>` keyed on pane id.
 *     Each `<LeafFrame>` is positioned absolutely via percentage coords
 *     derived from the tree projection (`x/y/w/h` on a 10 000-unit grid,
 *     divided by 100 for CSS `%`). Because panes stay at the same DOM
 *     position across any layout mutation, xterm instances persist and tmux
 *     sessions keep streaming. Only `top/left/width/height` changes — like
 *     gridstack did, but with arbitrary asymmetric geometry.
 *   - **Divider layer** — `<DividerLayer>` walks the tree and overlays one
 *     draggable divider between every pair of adjacent siblings at every
 *     split. Coordinates also in percentage-of-root, so the browser layout
 *     engine keeps dividers aligned with panes on window resize.
 *   - **DnD layer** — drop zones + drag ghost rendered above both when a
 *     drag is in flight (driven by `dragState()` in `lib/paneDnD.ts`).
 *
 * Gestures (all drag & drop):
 *   - Drag pane header → 5-zone overlay on the hovered target:
 *       • outer 20% rim on each side → split in that direction
 *       • middle 60% → swap pane contents
 *     Drop near the grid's outer edge (within 24 px) → the whole tree gets
 *     wrapped, so the dragged pane becomes a top-level column/row — this is
 *     how you build the `o/u | i` layout.
 *   - Drag divider between siblings → resize adjacent panes with rAF
 *     throttling; double-click divider → reset to 50/50.
 *   - Double-click pane header → maximize/restore.
 *   - Spawn event → splits the focused pane along its longer axis; nothing
 *     else is disturbed.
 *   - Close pane → collapses the tree; the sibling absorbs freed space.
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
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";

import { TerminalPane } from "./terminal-pane";
import { DividerLayer } from "./divider-layer";
import {
  addCellTab,
  cycleFocus,
  focusedPaneId,
  focusPaneByIndex,
  LAYOUT_UNIT,
  layoutRev,
  maximizeLayoutSnap,
  maximizedPaneId,
  minimizedPaneIds,
  movePaneToEdge,
  movePaneToRootEdge,
  nextCellId,
  nextTabId,
  removeCellTab,
  removePane,
  runtimeLayoutStore,
  setActiveTabId,
  setFocusedPaneId,
  setLastSnippet,
  setTabLabel,
  setTabAutoLabel,
  setTabSessionId,
  splitFocusedOrRoot,
  toggleMaximize,
  clearMaximize,
  minimizePane,
  restorePane,
  replacePaneForReview,
  clearTabReviewPending,
  tabPendingReviewOf,
  type CellKind,
  type CellTab,
  type PaneContent,
  type RuntimeCell,
} from "../stores/runtimeLayoutStore";
import { agentStore } from "../stores/agentStore";
import type { AgentState } from "../stores/agentStore";
import {
  clearTerminalClosing,
  listCrossProjectHarnessSessions,
  markTerminalClosing,
  terminalStore,
} from "../stores/terminalStore";
import {
  activeWorktreeStore,
  ALL_WORKTREES_SCOPE,
  worktreesByProject,
} from "../stores/worktreeStore";
import { kindDisplayLabel, type AgentKind } from "../lib/agentKind";
import { resolveSpawnWorktree } from "../lib/resolveSpawnWorktree";
import { HARNESS_ICONS } from "./icons";
import { activeProjectSlug, projectBySlug, setActiveProjectSlug } from "../stores/projectStore";
import { timeMemoSettle } from "../lib/perf";
import { projectStore } from "../stores/projectStore";
import {
  getScopedProjection as getScopedProjectionCached,
  prewarmProjectionCache,
  setProjectionCacheMaxSize,
  type ScopedProjection,
} from "../lib/scopedProjection";
import {
  getCrossProjectProjection,
  setCrossProjectProjectionCacheMaxSize,
} from "../lib/crossProjectProjection";
import {
  projectTerminalSurfaces,
  type TerminalSurfaceDescriptor,
} from "../lib/terminalSurfaceProjection";
import { listTerminals } from "../lib/terminalRegistry";
import { allReviewLinks, isReviewLinked } from "../stores/reviewLinkStore";
import { ensureFirstPromptLoaded, firstPromptForSession } from "../lib/firstPromptCache";
import { crossProjectViewMode, setCrossProjectViewMode } from "./top-row";
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from "./ui/tooltip";

function getScopedProjection(
  rev: number,
  slug: string | undefined,
  scope: import("../stores/worktreeStore").WorktreeScope,
  mainPath: string | undefined,
): ScopedProjection {
  // Scale the cache to a reasonable multiple of the project count so a
  // user juggling 10 projects × 2 worktree scopes doesn't thrash.
  setProjectionCacheMaxSize(Math.max(16, projectStore.items.length * 2));
  return getScopedProjectionCached({
    layoutRev: rev,
    tree: runtimeLayoutStore.tree,
    panes: runtimeLayoutStore.panes,
    slug,
    scope,
    mainPath,
  });
}
import { extractSnippet } from "../lib/terminalSnippet";
import { Dock } from "./dock";
import { beginDrag, dragState, ROOT_TARGET, type DropZone } from "../lib/paneDnD";
import {
  projectToRects,
  removeLeaf,
  splitAtLeaf,
  splitAtRoot,
  type Direction,
  type LayoutNode,
  type Rect,
} from "../lib/layoutTree";
import { resolveDisplayedTabLabel, resolveHarnessAutoLabel } from "../lib/terminalTabLabel";
import { useKeymap } from "../lib/keymapContext";

const KIND_LABELS: Record<string, string> = {
  shell: "Shell",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  empty: "Empty",
};

function requestTerminalKill(sessionId: string | undefined, context: string): void {
  if (!sessionId) return;
  markTerminalClosing(sessionId);
  void invoke("terminal_kill", { sessionId }).catch((e: unknown) => {
    clearTerminalClosing(sessionId);
    console.warn(`[${context}] terminal_kill failed`, e);
  });
}

// ---- cross-harness review -------------------------------------------------

interface ReviewSpawnPayload {
  initialPrompt: string;
  reviewerKind: AgentKind;
  projectSlug: string;
  worktreeId: string | null;
  reviewedSessionId: string;
  reviewerSessionId: string;
}

function activeSessionForCell(cellId: string): string | undefined {
  const pane = runtimeLayoutStore.panes[cellId];
  if (!pane) return undefined;
  return pane.tabs.find((t) => t.id === pane.activeTabId)?.sessionId;
}

/**
 * Cross-harness review: kick off a review when the user drops the source
 * pane onto a sibling pane. Resolves the active sessions, asks the backend
 * to render the brief, then converts the source pane into a reviewer pane.
 * The TerminalPane's normal spawn loop takes over once the tab is replaced
 * (the brief rides along on `initialPrompt`).
 */
async function startReviewFromDrop(sourceCellId: string, targetCellId: string): Promise<void> {
  const reviewerSessionId = activeSessionForCell(sourceCellId);
  const reviewedSessionId = activeSessionForCell(targetCellId);
  if (!reviewerSessionId || !reviewedSessionId) {
    console.warn("[review] missing session id on source or target cell", {
      sourceCellId,
      targetCellId,
    });
    return;
  }
  if (reviewerSessionId === reviewedSessionId) return;

  let payload: ReviewSpawnPayload;
  try {
    payload = await invoke<ReviewSpawnPayload>("prepare_review", {
      args: { reviewerSessionId, reviewedSessionId },
    });
  } catch (e) {
    console.warn("[review] prepare_review failed", e);
    return;
  }
  // Replace the source pane in-place with a reviewer pane carrying the
  // brief. `<TerminalPane>` will spawn a fresh harness because the new
  // tab has no sessionId. After spawn, `consumeReviewSpawn` fires
  // `record_review_link` so both sides show as linked.
  const newTabId = replacePaneForReview(sourceCellId, {
    kind: payload.reviewerKind,
    projectSlug: payload.projectSlug,
    worktreeId: payload.worktreeId ?? undefined,
    initialPrompt: payload.initialPrompt,
    reviewedSessionId: payload.reviewedSessionId,
  });
  if (!newTabId) {
    console.warn("[review] source pane went away before review could start");
    return;
  }
  // Snap the reviewer to sit immediately right of the reviewed pane, so
  // they read left→right as "reviewed → reviewer" and the brace UI has
  // a stable shared edge to hang on. No-op when they're already
  // adjacent in the right direction; otherwise re-tiles the BSP tree
  // with the existing edge-drop helper.
  movePaneToEdge(sourceCellId, targetCellId, "right");

  // Tear down the source pane's old session. Done after the tab swap so the
  // terminal-session-removed event doesn't try to remove a tab that's
  // already been replaced with a fresh one.
  requestTerminalKill(reviewerSessionId, "review-replace-source");
}

/**
 * Called from `<TerminalPane>`'s `onSpawned` callback. If the tab was
 * created as a reviewer pane (has `pendingReviewOf`), tells the backend to
 * record the link and clears the pending fields so a later respawn doesn't
 * re-link.
 */
function consumeReviewSpawn(
  cellId: string | undefined,
  tabId: string | undefined,
  newSessionId: string,
): void {
  if (!cellId || !tabId) return;
  const reviewedSessionId = tabPendingReviewOf(cellId, tabId);
  if (!reviewedSessionId) {
    console.debug("[review] consumeReviewSpawn: no pendingReviewOf on tab", {
      cellId,
      tabId,
      newSessionId,
    });
    return;
  }
  console.info("[review] recording link", {
    reviewerSessionId: newSessionId,
    reviewedSessionId,
  });
  void invoke("record_review_link", {
    args: {
      reviewerSessionId: newSessionId,
      reviewedSessionId,
    },
  }).catch((e: unknown) => {
    console.warn("[review] record_review_link failed", e);
  });
  clearTabReviewPending(cellId, tabId);
}

// ---- TerminalGrid ---------------------------------------------------------

export const TerminalGrid: Component = () => {
  const keymap = useKeymap();
  const [rootEl, setRootEl] = createSignal<HTMLDivElement | null>(null);

  // Main-worktree path for the active project. Used by the scope prune as
  // the fallback bucket for panes that carry no `worktreeId` (pre-change
  // terminals — see `pruneTreeByScope`).
  const activeMainPath = createMemo<string | undefined>(
    () => projectBySlug().get(activeProjectSlug() ?? "")?.rootPath,
  );
  const activeScope = createMemo(
    () => activeWorktreeStore.byProject[activeProjectSlug() ?? ""] ?? ALL_WORKTREES_SCOPE,
  );

  createEffect(() => {
    const projects = projectStore.items;
    if (projects.length === 0) return;
    setProjectionCacheMaxSize(Math.max(16, projects.length * 2));
    prewarmProjectionCache({
      layoutRev: layoutRev(),
      tree: runtimeLayoutStore.tree,
      panes: runtimeLayoutStore.panes,
      projects,
      scopesByProject: activeWorktreeStore.byProject,
    });
  });

  // Pruned tree + rect projection for the active project tab. Both drop
  // every leaf whose pane belongs to a different project or worktree.
  // Results are keyed on the layout revision + scope, so repeat tab
  // switches to the same project are a single map lookup.
  const projection = createMemo<ScopedProjection>(() =>
    getScopedProjection(layoutRev(), activeProjectSlug(), activeScope(), activeMainPath()),
  );
  const activeTree = createMemo<LayoutNode | null>(() => projection().tree);
  const activeRectMap = createMemo<ReadonlyMap<string, Rect>>(() => projection().rects);

  // LIVE-PREVIEW TREE.
  //
  // As the user hovers over a drop zone, replay the would-be mutation
  // *locally* using the same pure tree ops that the commit path uses. Panes
  // then render at their projected positions, so the grid reflows under
  // the cursor and the user sees the final layout before releasing. Nothing
  // touches the real store until pointerup — if the user drifts away from
  // the zone, the preview clears and the real layout is untouched.
  //
  // Mutation replay mirrors onDrop exactly (swap vs. split, root vs. pane).
  // Defined here (above `terminalSurfaces`) so the surface projection memo
  // can route preview rects to non-source surfaces without a forward TDZ.
  const previewTree = createMemo<LayoutNode | null>(() => {
    const s = dragState();
    const base = activeTree();
    if (!s || !s.targetId || !s.zone || !base) return null;
    if (s.sourceId === s.targetId) return null;

    if (s.zone === "center") {
      // Center zone now means "start a cross-harness review", not a swap.
      // The actual change (kill source session + respawn with the brief)
      // happens in `startReviewFromDrop` on pointerup; nothing about the
      // tree changes during the drag, so the preview tree is unmodified.
      // This also keeps the source pane anchored to its original slot
      // instead of animating over the target — the user wants to see
      // "this pane will become the reviewer" stay in place, not swap.
      return null;
    }

    const direction = zoneToDirection(s.zone);
    if (!direction) return null;
    const removed = removeLeaf(base, s.sourceId);
    if (!removed) return null;
    const newLeaf: LayoutNode = { kind: "leaf", id: s.sourceId };
    return s.targetId === ROOT_TARGET
      ? splitAtRoot(removed, direction, newLeaf)
      : splitAtLeaf(removed, s.targetId, direction, newLeaf);
  });

  // Projected cell geometry keyed by pane id. Both `LeafFrame` (chrome) and
  // `terminalSurfaces` (live PTY) consume this so chrome and surfaces reflow
  // in lockstep during a drag.
  const previewCellMap = createMemo<Map<string, Rect> | null>(() => {
    const pt = previewTree();
    if (!pt) return null;
    const rects = projectToRects(pt, LAYOUT_UNIT);
    return new Map(rects.map((r) => [r.id, r]));
  });

  // Cells that belong to the active tree, preserving store identity so xterm
  // instances stay mounted across `activeTree` recomputes.
  const activeCells = createMemo(() => {
    const map = activeRectMap();
    return runtimeLayoutStore.cells.filter((c) => map.has(c.id));
  });
  timeMemoSettle("project-switch:active", activeCells);

  // Maximize is global runtime state but must only affect the active project's
  // view. If the maximized pane isn't in the current project's active cells,
  // treat it as "no maximize" for render purposes — without clearing the
  // signal, so switching back to that project restores the maximized state.
  const effectiveMaximizedPaneId = createMemo<string | null>(() => {
    const id = maximizedPaneId();
    if (!id) return null;
    return activeCells().some((c) => c.id === id) ? id : null;
  });
  const crossProjectMode = createMemo(() => crossProjectViewMode());

  const projectedSessionIds = createMemo<string[]>(() => {
    const mode = crossProjectMode();
    if (mode === null) return [];

    return listCrossProjectHarnessSessions(mode)
      .filter((terminal) => terminal.project_slug !== null)
      .map((terminal) => terminal.session_id);
  });
  timeMemoSettle(() => {
    const mode = crossProjectMode();
    return mode ? `filter-click:${mode}` : "filter-click:inactive";
  }, projectedSessionIds);

  const projectedRectMap = createMemo<ReadonlyMap<string, Rect>>(() => {
    const mode = crossProjectMode();
    if (mode === null) return new Map();
    setCrossProjectProjectionCacheMaxSize(Math.max(16, projectStore.items.length * 4));
    return getCrossProjectProjection({
      mode,
      orderedIds: projectedSessionIds(),
    }).rects;
  });

  // Panes registered in the store but not in the BSP tree — minimized
  // harnesses living in the dock. Feed them into the surface projector so
  // xterm stays mounted across the in-tree → off-tree transition (preserves
  // scrollback). Geometry is null; the surface layer hides them.
  const offTreePanes = createMemo(() => {
    const inTreeIds = new Set(runtimeLayoutStore.cells.map((c) => c.id));
    const mins = minimizedPaneIds();
    const out = [];
    for (const pane of Object.values(runtimeLayoutStore.panes)) {
      if (!mins.has(pane.id)) continue;
      if (inTreeIds.has(pane.id)) continue;
      out.push(pane);
    }
    return out;
  });

  const terminalSurfaces = createMemo<TerminalSurfaceDescriptor[]>(() =>
    projectTerminalSurfaces({
      cells: runtimeLayoutStore.cells,
      offTreePanes: offTreePanes(),
      activeRectMap: activeRectMap(),
      minimizedPaneIds: minimizedPaneIds(),
      crossProjectMode: crossProjectMode(),
      projectedSessionIds: projectedSessionIds(),
      projectedRectMap: projectedRectMap(),
      terminalById: terminalStore.byId,
      focusedPaneId: focusedPaneId(),
      maximizedPaneId: effectiveMaximizedPaneId(),
      // Live drag preview: route sibling cells to their projected rects so
      // their terminals reflow in lockstep with the chrome layer's
      // `previewCellMap`. Source cell stays at committed rect; the
      // `surface-dragging-source` class translates it to follow the cursor.
      previewRectMap: previewCellMap(),
      dragSourceId: dragState()?.sourceId ?? null,
    }),
  );

  type SpawnKind = "shell" | "claude-code" | "codex" | "opencode";
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

  const canSpawnKind = (kind: SpawnKind): boolean => kind === "shell" || !!activeProjectSlug();

  // Pane-scoped hotkeys registered via the keymap provider.
  onMount(() => {
    const unregs: Array<() => void> = [];

    for (let i = 1; i <= 9; i++) {
      const n = i;
      unregs.push(keymap.register(`focus-pane-${n}`, () => focusPaneByIndex(n)));
    }
    unregs.push(keymap.register("cycle-focus-forward", () => cycleFocus("forward")));
    unregs.push(keymap.register("cycle-focus-back", () => cycleFocus("back")));
    unregs.push(
      keymap.register("maximize-pane", () => {
        const id = focusedPaneId();
        if (id) toggleMaximize(id);
      }),
    );
    unregs.push(
      keymap.register("reset-harness", () => {
        const paneId = focusedPaneId();
        if (!paneId) return;
        const pane = runtimeLayoutStore.panes[paneId];
        if (!pane || pane.kind === "empty") return;
        const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
        if (!activeTab?.sessionId) return;
        window.dispatchEvent(
          new CustomEvent("raum:terminal-self-heal", {
            detail: {
              cellId: paneId,
              tabId: activeTab.id,
              sessionId: activeTab.sessionId,
            },
          }),
        );
      }),
    );
    unregs.push(
      keymap.register("new-tab-same-harness", () => {
        const paneId = focusedPaneId();
        if (!paneId) return;
        const pane = runtimeLayoutStore.panes[paneId];
        if (!pane || pane.kind === "empty") return;
        const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
        addCellTab(paneId, {
          projectSlug: activeTab?.projectSlug ?? pane.projectSlug,
          worktreeId: activeTab?.worktreeId ?? pane.worktreeId,
        });
      }),
    );

    onCleanup(() => {
      for (const fn of unregs) fn();
    });
  });

  onMount(() => {
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === "Escape" && crossProjectViewMode() !== null) {
        ev.preventDefault();
        setCrossProjectViewMode(null);
      }
    }
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // New-terminal spawn: split the focused pane along its longer axis, or
  // seed the tree if empty. Never redistributes the existing layout.
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
      if (detail.kind !== "shell" && !detail.projectSlug) return;

      const id = nextCellId();
      const tabId = nextTabId();
      const newPane: PaneContent = {
        id,
        kind: detail.kind,
        tabs: [{ id: tabId }],
        activeTabId: tabId,
        projectSlug: detail.projectSlug,
        worktreeId: detail.worktreeId,
      };
      splitFocusedOrRoot(newPane);
      setFocusedPaneId(id);
      // Drop maximize when a new pane appears — the user just asked for a new
      // terminal to type in, so they want to see (and reach) it.
      clearMaximize();
    }
    window.addEventListener("raum:spawn-requested", onSpawn);
    onCleanup(() => window.removeEventListener("raum:spawn-requested", onSpawn));
  });

  function focusRegisteredSession(sessionId: string): void {
    requestAnimationFrame(() => {
      const registered = listTerminals().find((terminal) => terminal.sessionId === sessionId);
      registered?.focus();
    });
  }

  function findLayoutOwner(
    sessionId: string,
  ): { cellId: string; tabId: string; projectSlug?: string } | null {
    for (const cell of runtimeLayoutStore.cells) {
      for (const tab of cell.tabs) {
        if (tab.sessionId !== sessionId) continue;
        return {
          cellId: cell.id,
          tabId: tab.id,
          projectSlug: tab.projectSlug ?? cell.projectSlug,
        };
      }
    }
    return null;
  }

  onMount(() => {
    function onTerminalFocusRequested(ev: Event): void {
      const sessionId = (ev as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!sessionId) return;

      const owner = findLayoutOwner(sessionId);
      if (owner) {
        if (owner.projectSlug) setActiveProjectSlug(owner.projectSlug);
        setActiveTabId(owner.cellId, owner.tabId);
        if (minimizedPaneIds().has(owner.cellId)) restorePane(owner.cellId);
        setFocusedPaneId(owner.cellId);
        setCrossProjectViewMode(null);
      }

      focusRegisteredSession(sessionId);
    }

    window.addEventListener("terminal-focus-requested", onTerminalFocusRequested);
    onCleanup(() =>
      window.removeEventListener("terminal-focus-requested", onTerminalFocusRequested),
    );
  });

  function onRestoreFromDock(cellId: string): void {
    restorePane(cellId);
    setFocusedPaneId(cellId);
  }

  // Drive --drag-dx / --drag-dy on the grid root from the drag pointer.
  // The source pane's transform reads these via CSS var inheritance so the
  // pane literally follows the cursor 1:1, with zero Solid re-renders on
  // the pane layer — only the root's inline style changes per pointermove.
  //
  // While the magnetic snap is engaged we ALSO emit `--snap-dx/--snap-dy`,
  // the delta from the source pane's resting centre to the snapped
  // target's centre. The `.is-snapped` rule in styles.css swaps from the
  // cursor-tracking translate to this target-anchored translate so the
  // dragged card visibly docks into the target's middle (the "click into
  // place" beat). When the snap releases (Escape, drift past hysteresis,
  // or pointerup), the vars are removed and the rule reverts to cursor
  // tracking — same 120 ms ease animates the release.
  createEffect(() => {
    const s = dragState();
    const root = rootEl();
    if (!root) return;
    if (!s) {
      root.style.removeProperty("--drag-dx");
      root.style.removeProperty("--drag-dy");
      root.style.removeProperty("--snap-dx");
      root.style.removeProperty("--snap-dy");
      return;
    }
    root.style.setProperty("--drag-dx", `${s.pointerX - s.startPointerX}px`);
    root.style.setProperty("--drag-dy", `${s.pointerY - s.startPointerY}px`);

    // Compute --snap-dx/dy only while snapped on a real pane (root-edge
    // magnets keep cursor tracking). Both the source's resting pixel
    // rect and `s.targetRect` are derived from the same projection
    // (`cellToRect` math against `root.getBoundingClientRect()`), so the
    // centre-to-centre delta is exact — no sub-pixel drift between the
    // chrome and surface mirrors.
    if (s.snapped && s.targetRect && s.targetId !== null && s.targetId !== ROOT_TARGET) {
      const sourceCell = runtimeLayoutStore.cells.find((c) => c.id === s.sourceId);
      if (sourceCell) {
        const rootRect = root.getBoundingClientRect();
        const sx = rootRect.width / LAYOUT_UNIT;
        const sy = rootRect.height / LAYOUT_UNIT;
        const sourceLeft = rootRect.left + sourceCell.x * sx;
        const sourceTop = rootRect.top + sourceCell.y * sy;
        const sourceCx = sourceLeft + (sourceCell.w * sx) / 2;
        const sourceCy = sourceTop + (sourceCell.h * sy) / 2;
        const targetCx = s.targetRect.left + s.targetRect.width / 2;
        const targetCy = s.targetRect.top + s.targetRect.height / 2;
        root.style.setProperty("--snap-dx", `${targetCx - sourceCx}px`);
        root.style.setProperty("--snap-dy", `${targetCy - sourceCy}px`);
        return;
      }
    }
    root.style.removeProperty("--snap-dx");
    root.style.removeProperty("--snap-dy");
  });

  // Tree passed to DividerLayer — preview while hovering a zone so dividers
  // reflow with the panes (otherwise they'd be stuck at pre-drag positions
  // while panes animate to projected ones). Falls back to the real tree.
  // (`previewTree` and `previewCellMap` are defined above so the surface
  // projection memo can read them.)
  const renderTree = createMemo<LayoutNode | null>(() => previewTree() ?? activeTree());

  return (
    <div class="flex h-full w-full flex-col">
      {/* The grid canvas fills the entire main region with zero outer
        padding — the chrome (top-row, sidebar, dock) is `bg-background`
        and the canvas is `var(--selected)`, so the colour contrast IS the
        visual separation, no padding moat required. This keeps the gap
        between the top-row buttons and the canvas equal to the top-row's
        own internal slack (≈6 px above buttons, 6 px below = canvas top),
        and matches the canvas's left/right/bottom against sidebar/right
        edge/dock with the same hairline contrast on every side. */}
      <div class="flex-1 min-h-0 overflow-hidden bg-background">
        <div
          class="relative h-full w-full overflow-hidden rounded-xl"
          classList={{ "maximize-layout-snap": maximizeLayoutSnap() }}
          ref={setRootEl}
          data-dnd-root="true"
        >
          <Show when={crossProjectMode() === null && activeCells().length === 0}>
            <div
              class="absolute inset-0 z-10 grid h-full w-full gap-px bg-border-subtle"
              style={{
                "grid-template-columns": `repeat(${Math.min(availableKinds()?.length ?? 1, 2)}, 1fr)`,
              }}
            >
              <For each={availableKinds() ?? []}>
                {(kind) => {
                  const Icon = HARNESS_ICONS[kind];
                  const disabled = () => !canSpawnKind(kind);
                  return (
                    <button
                      type="button"
                      class="group flex flex-col items-center justify-center gap-3 bg-surface-sunken text-foreground-dim transition-colors duration-[var(--motion-base)] ease-[var(--motion-ease)] hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-surface-sunken disabled:hover:text-foreground-dim"
                      disabled={disabled()}
                      title={disabled() ? "Add a project before spawning a harness" : undefined}
                      onClick={() => {
                        if (disabled()) return;
                        const slug = activeProjectSlug();
                        window.dispatchEvent(
                          new CustomEvent("raum:spawn-requested", {
                            detail: {
                              kind,
                              projectSlug: slug,
                              worktreeId: slug ? resolveSpawnWorktree(slug) : undefined,
                            },
                          }),
                        );
                      }}
                    >
                      <Icon class="size-7 transition-transform group-hover:scale-110" />
                      <span class="text-[11px] uppercase tracking-widest">{KIND_LABELS[kind]}</span>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>

          <Show when={crossProjectMode() !== null && projectedSessionIds().length === 0}>
            <div class="absolute inset-0 grid place-items-center text-sm text-foreground-subtle">
              No matching sessions across your projects.
            </div>
          </Show>

          <TerminalSurfaceLayer surfaces={terminalSurfaces()} />

          <Show when={crossProjectMode() === null}>
            <Show when={activeCells().length > 0}>
              <div class="terminal-chrome-layer absolute inset-0">
                <For each={activeCells()}>
                  {(cell) => {
                    const effective = createMemo<RuntimeCell>(() => {
                      if (dragState()?.sourceId === cell.id) return cell;
                      const preview = previewCellMap()?.get(cell.id);
                      if (preview) {
                        return {
                          ...cell,
                          x: preview.x,
                          y: preview.y,
                          w: preview.w,
                          h: preview.h,
                        };
                      }
                      const active = activeRectMap().get(cell.id);
                      if (!active) return cell;
                      return {
                        ...cell,
                        x: active.x,
                        y: active.y,
                        w: active.w,
                        h: active.h,
                      };
                    });
                    return (
                      <LeafFrame cell={effective()} maximizedPaneId={effectiveMaximizedPaneId()} />
                    );
                  }}
                </For>
              </div>
            </Show>

            {/* Hide dividers while a pane is maximized: there's nothing to
                resize when one pane fills the canvas, and the chrome frame
                renders transparent (only the 28 px header is opaque), so
                the small grip pills would otherwise show through the
                maximized terminal. */}
            <Show when={effectiveMaximizedPaneId() === null}>
              <DividerLayer tree={renderTree()} />
              <ReviewBracesLayer />
            </Show>
          </Show>

          <Show when={crossProjectMode() !== null && projectedSessionIds().length > 0}>
            <div class="terminal-chrome-layer absolute inset-0">
              <For each={projectedSessionIds()}>
                {(sessionId) => {
                  const rect = createMemo(() => projectedRectMap().get(sessionId) ?? null);
                  return <ProjectedSessionFrame sessionId={sessionId} rect={rect()} />;
                }}
              </For>
            </div>
          </Show>

          {/* No drop-zone overlay layer here — the cross-harness review
          "snap" state is rendered inside the target's `LeafFrame` (see
          `ReviewSnapOverlay` below) so it inherits the pane's bounds and
          can blur its own body without a global overlay. Edge drops
          continue to rely on layout reflow as the only feedback. */}
        </div>
      </div>
      <Dock minimizedPanes={offTreePanes()} onRestore={onRestoreFromDock} />
    </div>
  );
};

export default TerminalGrid;

// ---- AutoLabelBinder: synthesizes the tab autoLabel ------------------------
//
// Harness panes: react to the backend's live tmux pane/window title stream
// and prefer the richest title the inner CLI publishes. When tmux only
// exposes generic names (for example `node` or a bare version), fall back to
// the existing `kind · project/branch` synthesis from raum-side state.
//
// Shell panes: the inner command/cwd IS the interesting signal, so the global
// shell context poller writes paneContext into terminalStore and this binder
// composes `"Shell · <cwd-basename> · <command>"` from the cached value.
//
// Returns null — the effect is the side effect.

const SHELL_IDLE_COMMANDS = new Set(["zsh", "bash", "fish", "sh", "-zsh", "-bash"]);

interface AutoLabelBinderProps {
  cellId: string;
  tabId: string;
  kind: CellKind;
  projectSlug?: string;
  worktreeId?: string;
  sessionId?: string;
}

const AutoLabelBinder: Component<AutoLabelBinderProps> = (props) => {
  const harnessFallbackLabel = createMemo(() => {
    if (props.kind === "empty") return "Empty";
    if (props.kind === "shell") return kindDisplayLabel("shell");
    const kind = props.kind as AgentKind;
    const slug = props.projectSlug;
    const worktreePath = props.worktreeId;
    const kindPart = kindDisplayLabel(kind);

    let label = kindPart;
    if (slug) {
      const worktrees = worktreesByProject()[slug];
      const wt = worktreePath ? worktrees?.find((w) => w.path === worktreePath) : undefined;
      const branch =
        wt?.branch ?? wt?.baseBranch ?? wt?.upstream?.replace(/^origin\//, "") ?? undefined;
      return branch ? `${kindPart} · ${slug}/${branch}` : `${kindPart} · ${slug}`;
    }

    return label;
  });

  const livePaneContext = createMemo(() =>
    props.sessionId ? terminalStore.byId[props.sessionId]?.paneContext : undefined,
  );

  // Harness-pane branch: react to the live tmux pane/window titles, but keep
  // the raum-side project/branch label as a fallback whenever tmux only
  // exposes generic process names.
  createEffect(() => {
    if (props.kind === "shell" || props.kind === "empty") return;
    const sid = props.sessionId;
    const fallback = harnessFallbackLabel();

    if (!sid) {
      setTabAutoLabel(props.cellId, props.tabId, fallback);
      return;
    }
    const ctx = livePaneContext();
    const label = resolveHarnessAutoLabel({
      kind: props.kind as AgentKind,
      paneTitle: ctx?.paneTitle,
      windowName: ctx?.windowName,
      currentCommand: ctx?.currentCommand,
      fallbackLabel: fallback,
    });
    setTabAutoLabel(props.cellId, props.tabId, label);
  });

  // Shell-pane branch: globally-polled tmux context.
  createEffect(() => {
    if (props.kind !== "shell") return;
    const sid = props.sessionId;
    if (!sid) {
      setTabAutoLabel(props.cellId, props.tabId, kindDisplayLabel("shell"));
      return;
    }

    const ctx = livePaneContext();
    if (!ctx) return;
    const basename = ctx.currentPath ? ctx.currentPath.split("/").pop() || "" : "";
    const cmd = ctx.currentCommand.trim();
    const showCmd = cmd && !SHELL_IDLE_COMMANDS.has(cmd);
    const parts = ["Shell"];
    if (basename) parts.push(basename);
    if (showCmd) parts.push(cmd);
    setTabAutoLabel(props.cellId, props.tabId, parts.join(" · "));
  });

  return null;
};

// ---- TerminalSurfaceLayer: one persistent terminal per tab/session ----------

const TerminalSurfaceLayer: Component<{ surfaces: TerminalSurfaceDescriptor[] }> = (props) => {
  const byKey = createMemo(() => new Map(props.surfaces.map((surface) => [surface.key, surface])));
  const keys = createMemo(() => props.surfaces.map((surface) => surface.key));

  return (
    <div class="terminal-surface-layer absolute inset-0">
      <For each={keys()}>
        {(key) => {
          const surface = createMemo(() => byKey().get(key) ?? null);
          return (
            <Show when={surface()}>{(current) => <TerminalSurfaceHost surface={current()} />}</Show>
          );
        }}
      </For>
    </div>
  );
};

const TerminalSurfaceHost: Component<{ surface: TerminalSurfaceDescriptor }> = (props) => {
  const [lastRect, setLastRect] = createSignal<Rect | null>(null);
  createEffect(() => {
    const rect = props.surface.rect;
    if (rect && rect.w > 0 && rect.h > 0) setLastRect(rect);
  });

  const rect = createMemo(() => props.surface.rect ?? lastRect());
  const visible = createMemo(() => props.surface.visible && rect() !== null);
  // True when this surface owns the pane currently being dragged. The
  // `.surface-dragging-source` CSS rule then translates it with the same
  // `--drag-dx`/`--drag-dy` the chrome uses, so the live terminal rides
  // alongside its chrome card while the rest of the grid reflows underneath.
  const isDragSource = createMemo(
    () => !!props.surface.cellId && props.surface.cellId === dragState()?.sourceId,
  );
  // Mirror the chrome's `is-snapped` toggle so the surface reads the same
  // `--snap-*` transform as its chrome card while the magnetic snap is
  // engaged. Without this, the terminal pixels would keep tracking the
  // cursor while the chrome docked onto the target — visible mismatch.
  const isSnappedSource = createMemo(() => {
    if (!isDragSource()) return false;
    const s = dragState();
    return s?.snapped === true && s.targetId !== null && s.targetId !== ROOT_TARGET;
  });
  const style = createMemo<Record<string, string>>(() => {
    const r = rect() ?? { id: props.surface.key, x: 0, y: 0, w: LAYOUT_UNIT, h: LAYOUT_UNIT };
    return {
      ...rectStyle(r),
      visibility: visible() ? "visible" : "hidden",
      // Ghost surface must pass pointer events through so destination panes
      // remain hit-testable during the drag.
      "pointer-events": visible() && !isDragSource() ? "auto" : "none",
    };
  });

  function claimFocus(): void {
    const { cellId, tabId } = props.surface;
    if (!cellId) return;
    if (tabId && runtimeLayoutStore.panes[cellId]?.activeTabId !== tabId) {
      setActiveTabId(cellId, tabId);
    }
    setFocusedPaneId(cellId);
  }

  function onSurfaceDoubleClick(e: MouseEvent): void {
    const { cellId } = props.surface;
    if (!cellId) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("input")) return;
    e.stopPropagation();
    e.preventDefault();
    toggleMaximize(cellId);
  }

  function closeSurface(): void {
    const { sessionId, cellId, tabId } = props.surface;
    requestTerminalKill(sessionId, "TerminalSurfaceHost");
    if (cellId && tabId) removeCellTab(cellId, tabId);
  }

  return (
    <div
      class="leaf-frame terminal-surface-frame flex min-h-0 min-w-0 flex-col"
      classList={{
        "pane-maximized": props.surface.maximized,
        "surface-dragging-source": isDragSource(),
        "is-snapped": isSnappedSource(),
      }}
      data-surface-key={props.surface.key}
      data-cell-id={props.surface.cellId}
      data-session-id={props.surface.sessionId ?? ""}
      data-dragging={isDragSource() ? "true" : "false"}
      style={style()}
      onFocusIn={claimFocus}
      onClick={claimFocus}
      onDblClick={onSurfaceDoubleClick}
    >
      <Show when={props.surface.cellId && props.surface.tabId}>
        <AutoLabelBinder
          cellId={props.surface.cellId!}
          tabId={props.surface.tabId!}
          kind={props.surface.kind}
          projectSlug={props.surface.projectSlug}
          worktreeId={props.surface.worktreeId}
          sessionId={props.surface.sessionId}
        />
      </Show>
      <div class="terminal-surface-body">
        <TerminalPane
          surfaceKey={props.surface.key}
          kind={props.surface.kind}
          sessionId={props.surface.sessionId}
          projectSlug={props.surface.projectSlug}
          worktreeId={props.surface.worktreeId}
          cellId={props.surface.cellId}
          tabId={props.surface.tabId}
          borderColor="transparent"
          visible={visible()}
          active={props.surface.active}
          initialPrompt={props.surface.initialPrompt}
          onSpawned={(sessionId) => {
            if (props.surface.cellId && props.surface.tabId) {
              setTabSessionId(props.surface.cellId, props.surface.tabId, sessionId);
              // Cross-harness review: if this tab was created as a reviewer
              // pane, link the new session to the reviewed one and clear the
              // pending fields so re-spawn paths don't re-link.
              consumeReviewSpawn(props.surface.cellId, props.surface.tabId, sessionId);
            }
          }}
          onRequestClose={() => {
            closeSurface();
          }}
        />
      </div>
    </div>
  );
};

// ---- LeafFrame: absolute-positioned pane ----------------------------------

/**
 * Cross-harness review "snap" overlay. Rendered *inside* the target
 * pane's `LeafFrame` while the user is hovering the center zone of a
 * review-eligible target. The body of the target pane gets blurred via
 * the `pane-review-snap-target` class on the LeafFrame; this overlay
 * sits over the blur and shows the visual contract of what's about to
 * happen:
 *
 *     [reviewer-icon]   reviews →   [reviewed-icon]
 *     ─────────────────────────────────────────────
 *     <target's last user prompt>
 *
 * Snap-on is `dragState.zone === "center"` over a sibling agent pane.
 * Snap-off is any other zone (move further toward an edge → unsnaps,
 * pane reflow takes over again). The hit-test's enter/exit hysteresis
 * (paneDnD.ts EDGE_ENTER_FRACTION / EDGE_EXIT_FRACTION) gives the
 * "you have to move further to leave the snap" feel.
 *
 * The overlay is mounted inside the LeafFrame and uses `position:
 * absolute; inset: 0` instead of viewport-pinned positioning, so it can
 * never land over a *different* pane's xterm canvas. The blur is a CSS
 * transition triggered by the class swap, not a per-frame re-render —
 * xterm's canvas isn't repainted continuously.
 */
interface ReviewSnapOverlayProps {
  cellId: string;
  cellKind: CellKind;
  targetSessionId: string | undefined;
}

const ReviewSnapOverlay: Component<ReviewSnapOverlayProps> = (props) => {
  const dragData = createMemo<{
    sourceKind: AgentKind;
    sourceLabel: string;
  } | null>(() => {
    const s = dragState();
    if (!s) return null;
    if (!s.snapped) return null;
    if (s.targetId !== props.cellId) return null;
    if (s.sourceKind === "shell" || s.sourceKind === "empty") return null;
    if (props.cellKind === "shell" || props.cellKind === "empty") return null;
    return {
      sourceKind: s.sourceKind as AgentKind,
      sourceLabel: s.sourceLabel,
    };
  });

  // Lazy-load the first prompt the moment the snap activates, so the
  // overlay can show "what task is being reviewed" without paying a
  // Tauri call per session at startup. The cache dedupes in-flight
  // fetches and keeps results forever (a session's first prompt is
  // immutable once recorded).
  createEffect(() => {
    if (dragData()) ensureFirstPromptLoaded(props.targetSessionId);
  });

  const firstPrompt = createMemo<string | null | undefined>(() =>
    firstPromptForSession(props.targetSessionId),
  );

  return (
    <Show when={dragData()}>
      {(data) => {
        const ReviewerIcon = HARNESS_ICONS[data().sourceKind as keyof typeof HARNESS_ICONS];
        const ReviewedIcon = HARNESS_ICONS[props.cellKind as keyof typeof HARNESS_ICONS];
        return (
          <div
            class="pane-review-snap-overlay pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center text-center"
            data-testid="review-snap-overlay"
          >
            <div class="pane-review-snap-icons">
              {ReviewerIcon ? <ReviewerIcon class="pane-review-snap-icon" /> : null}
              <span class="pane-review-snap-arrow">reviews →</span>
              {ReviewedIcon ? <ReviewedIcon class="pane-review-snap-icon" /> : null}
            </div>
            <Show
              when={firstPrompt()}
              fallback={
                <div class="pane-review-snap-prompt pane-review-snap-prompt-empty">
                  {firstPrompt() === undefined
                    ? "Loading original task…"
                    : "No original task captured — the reviewer will work from the diff alone."}
                </div>
              }
            >
              {(text) => <div class="pane-review-snap-prompt">{text()}</div>}
            </Show>
            <div class="pane-review-snap-hint">Release to review</div>
          </div>
        );
      }}
    </Show>
  );
};

/**
 * Persistent visual link between two reviewed-and-reviewing panes once the
 * snap completes. Renders an oval chip that floats at the shared edge of
 * the two cells:
 *
 *      ┌──────────────┬──────────────┐
 *      │              │              │
 *      │  reviewed    │   reviewer   │
 *      │           ┌──────┐          │
 *      │           │  🅡 → 🅒  │     │  ← the brace, half-overlapping each
 *      │           └──────┘          │     pane, anchored on the divider
 *      │              │              │
 *      └──────────────┴──────────────┘
 *
 * The brace is the structural "you are looking at one bound unit" signal.
 * Together with the forced-adjacent layout (movePaneToEdge on snap) it
 * replaces the previously-too-quiet header badge as the primary review
 * affordance.
 *
 * Renders only for *adjacent* linked pairs. Non-adjacent links (e.g.
 * after the user manually rearranged the layout) fall back to the small
 * header badge in `<PaneHeader>` so the link is still visible somewhere.
 */
interface ReviewTetherPosition {
  /** Viewport-pixel x: midpoint of the gap between the two panes. */
  x: number;
  /** Viewport-pixel y: midpoint of the y-overlap between the two panes. */
  y: number;
  reviewerKind: AgentKind;
  reviewedKind: AgentKind;
  /** Cell ids on each side, used by the renderer to dim the tether when
   *  the user is hovering over or focused on either linked pane. */
  reviewerCellId: string;
  reviewedCellId: string;
  key: string;
}

const ReviewBracesLayer: Component = () => {
  // Tick that bumps whenever something that affects pane geometry changes:
  // layout mutations (`layoutRev`), window resizes, sidebar/dock collapses
  // (ResizeObserver on the dnd root). Each bump re-runs `positions` to
  // re-read DOM rects.
  const [tick, setTick] = createSignal(0);

  // Stable identity for tether items across `positions()` reruns. Keyed by
  // `${reviewerSessionId}::${reviewedSessionId}`. Without this, every
  // recompute hands `<For>` brand-new objects, which Solid treats as
  // entirely new items — triggering a full unmount/remount of the dot+line
  // DOM and visibly restarting the `review-tether-fade-in` CSS animation.
  const positionCache = new Map<string, ReviewTetherPosition>();

  // Cell id currently under the mouse (any pane, not just linked ones).
  // Cheap to track because we only listen for `mouseover` (fires once per
  // pane crossing, never per-pixel), and we update only on transitions.
  const [hoveredCellId, setHoveredCellId] = createSignal<string | null>(null);

  onMount(() => {
    const bump = (): void => {
      setTick((t) => t + 1);
    };
    window.addEventListener("resize", bump);

    // Watch the dnd-root for any size change. Layout commits inside the
    // store flip `layoutRev`, but the DOM reflow that *applies* those
    // commits to pane rects can lag a frame, so we observe the actual
    // geometry too.
    const root = document.querySelector<HTMLElement>('[data-dnd-root="true"]');
    let ro: ResizeObserver | null = null;
    if (root) {
      ro = new ResizeObserver(bump);
      ro.observe(root);
    }

    // Track which pane the cursor is over so the tether can dim out when
    // the user reaches into a linked pane to interact with it. We attach
    // to the dnd-root (covers every pane) and use bubbling `mouseover`
    // which fires on element-crossing transitions, not on every pixel.
    function onMouseOver(e: Event): void {
      const target = e.target as HTMLElement | null;
      const cell = target?.closest<HTMLElement>("[data-cell-id]");
      const id = cell?.getAttribute("data-cell-id") ?? null;
      setHoveredCellId(id);
    }
    function onMouseLeave(): void {
      setHoveredCellId(null);
    }
    if (root) {
      root.addEventListener("mouseover", onMouseOver);
      root.addEventListener("mouseleave", onMouseLeave);
    }

    onCleanup(() => {
      window.removeEventListener("resize", bump);
      ro?.disconnect();
      if (root) {
        root.removeEventListener("mouseover", onMouseOver);
        root.removeEventListener("mouseleave", onMouseLeave);
      }
    });
  });

  // Topology: the slice of `runtimeLayoutStore.cells` that the tether
  // actually depends on (id → kind, active session, project). Pulled
  // into its own memo with a signature-based equality so per-cell churn
  // that doesn't change topology — most importantly the `lastActivityMs`
  // bumps emitted on every `agent-state-changed` event (~1 Hz while a
  // harness is alive) — does not invalidate `positions` and force a
  // tether re-render every tick.
  interface CellTopology {
    sessionToCell: Map<string, string>;
    cellsByKind: Map<string, AgentKind>;
    cellProjectById: Map<string, string | undefined>;
    signature: string;
  }
  // Hand-rolled identity cache: when the rebuilt object's signature
  // matches the previous result, hand back the exact same object so the
  // downstream `positions` memo (which subscribes to `topology()`) does
  // not re-run on a no-op recompute. Equivalent to passing `equals` to
  // `createMemo`, but sidesteps the overload that would otherwise require
  // an initial value of `CellTopology`.
  let prevTopology: CellTopology | null = null;
  // Diagnostic counters for the tether's reactive chain. Exposed on `window`
  // so the user can verify in devtools whether the tether is re-running on
  // idle harness activity. Reset by reloading the page.
  if (import.meta.env.DEV) {
    const w = window as unknown as { __raumTether?: Record<string, number> };
    w.__raumTether ??= {
      topologyRuns: 0,
      topologyEmits: 0,
      positionsRuns: 0,
      positionsForReturns: 0,
      positionsCacheHits: 0,
      positionsCacheMisses: 0,
    };
  }
  const bumpDebug = (key: string): void => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __raumTether: Record<string, number> };
    w.__raumTether[key] = (w.__raumTether[key] ?? 0) + 1;
  };

  const topology = createMemo<CellTopology>(() => {
    bumpDebug("topologyRuns");
    const sessionToCell = new Map<string, string>();
    const cellsByKind = new Map<string, AgentKind>();
    const cellProjectById = new Map<string, string | undefined>();
    const sigParts: string[] = [];
    for (const cell of runtimeLayoutStore.cells) {
      const activeTab = cell.tabs.find((t) => t.id === cell.activeTabId);
      const sessionId = activeTab?.sessionId ?? "";
      if (sessionId) sessionToCell.set(sessionId, cell.id);
      if (cell.kind !== "empty") cellsByKind.set(cell.id, cell.kind as AgentKind);
      cellProjectById.set(cell.id, cell.projectSlug);
      sigParts.push(
        `${cell.id}|${cell.kind}|${cell.activeTabId ?? ""}|${sessionId}|${cell.projectSlug ?? ""}`,
      );
    }
    const signature = sigParts.join("\n");
    if (prevTopology && prevTopology.signature === signature) return prevTopology;
    bumpDebug("topologyEmits");
    prevTopology = { sessionToCell, cellsByKind, cellProjectById, signature };
    return prevTopology;
  });

  const positions = createMemo<ReviewTetherPosition[]>(() => {
    bumpDebug("positionsRuns");
    // Track reactive deps explicitly so the memo re-runs whenever the
    // visible view changes — otherwise the memo holds stale viewport
    // coords from before the change and the tether lingers over the
    // wrong project / cross-project view / maximized pane.
    layoutRev();
    tick();
    const projectSlug = activeProjectSlug();
    const xMode = crossProjectViewMode();
    const maxId = maximizedPaneId();

    // Tether is a per-project, in-grid affordance only. Hide it during
    // any "view is changing" state so it doesn't render against panes
    // that aren't actually on screen.
    if (xMode !== null) return [];
    if (maxId !== null) return [];
    if (!projectSlug) return [];

    const links = allReviewLinks();
    if (links.length === 0) return [];

    // Topology drives the (session → cell, cell → kind, cell → project)
    // lookups. `cellProjectById` gates panes that belong to a different
    // project — they may linger in `runtimeLayoutStore.cells` after a
    // project switch but their LeafFrames aren't in the DOM, so the
    // querySelector below also catches that case.
    const { sessionToCell: cellIdByActiveSession, cellsByKind, cellProjectById } = topology();

    const out: ReviewTetherPosition[] = [];
    const seen = new Set<string>();
    for (const { reviewerSessionId, reviewedSessionId } of links) {
      const reviewerCellId = cellIdByActiveSession.get(reviewerSessionId);
      const reviewedCellId = cellIdByActiveSession.get(reviewedSessionId);
      if (!reviewerCellId || !reviewedCellId) continue;

      // Skip when either pane belongs to a different project — even if
      // the cells exist in the store, they aren't rendered for the
      // current project tab.
      if (cellProjectById.get(reviewerCellId) !== projectSlug) continue;
      if (cellProjectById.get(reviewedCellId) !== projectSlug) continue;

      // Pull the *actually rendered* rects from the DOM. This bypasses
      // any layout-coord ↔ pixel translation we'd otherwise have to do,
      // and works regardless of pane-gap insets, scroll, or zoom.
      const reviewerEl = document.querySelector<HTMLElement>(`[data-cell-id="${reviewerCellId}"]`);
      const reviewedEl = document.querySelector<HTMLElement>(`[data-cell-id="${reviewedCellId}"]`);
      if (!reviewerEl || !reviewedEl) continue;

      const rA = reviewedEl.getBoundingClientRect();
      const rB = reviewerEl.getBoundingClientRect();

      // Decide which is left/right by their actual x positions.
      let leftRect: DOMRect;
      let rightRect: DOMRect;
      if (rA.right <= rB.left + 4) {
        leftRect = rA;
        rightRect = rB;
      } else if (rB.right <= rA.left + 4) {
        leftRect = rB;
        rightRect = rA;
      } else {
        // Not horizontally adjacent (overlapping or stacked).
        continue;
      }

      const overlapTop = Math.max(leftRect.top, rightRect.top);
      const overlapBottom = Math.min(leftRect.bottom, rightRect.bottom);
      if (overlapBottom <= overlapTop) continue;

      // Center the tether in the gap between the two panes.
      const x = (leftRect.right + rightRect.left) / 2;
      const y = (overlapTop + overlapBottom) / 2;

      const reviewerKind = cellsByKind.get(reviewerCellId);
      const reviewedKind = cellsByKind.get(reviewedCellId);
      if (!reviewerKind || !reviewedKind) continue;

      // Reuse the previous object when *every* field matches. Solid's
      // `<For>` is reference-keyed, so handing back the exact same item
      // skips the whole "remove DOM, fade-in new DOM" cycle that would
      // otherwise visibly flicker the tether on every `positions()`
      // rerun. We can't mutate the cached object to update coords —
      // `pos.x`/`pos.y` are read non-reactively in the For body, so
      // mutations would not propagate to the DOM. Coord drift therefore
      // forces a fresh object (and a one-shot fade-in for that tether),
      // which is the correct UX when geometry actually changes.
      const key = `${reviewerSessionId}::${reviewedSessionId}`;
      seen.add(key);
      const existing = positionCache.get(key);
      if (
        existing &&
        existing.x === x &&
        existing.y === y &&
        existing.reviewerKind === reviewerKind &&
        existing.reviewedKind === reviewedKind &&
        existing.reviewerCellId === reviewerCellId &&
        existing.reviewedCellId === reviewedCellId
      ) {
        bumpDebug("positionsCacheHits");
        out.push(existing);
      } else {
        bumpDebug("positionsCacheMisses");
        const fresh: ReviewTetherPosition = {
          x,
          y,
          reviewerKind,
          reviewedKind,
          reviewerCellId,
          reviewedCellId,
          key,
        };
        positionCache.set(key, fresh);
        out.push(fresh);
      }
    }
    // Drop cache entries for links that vanished — otherwise the map
    // would grow unbounded as users link/unlink different pane pairs.
    for (const cachedKey of positionCache.keys()) {
      if (!seen.has(cachedKey)) positionCache.delete(cachedKey);
    }
    return out;
  });

  return (
    <Show when={positions().length > 0}>
      {/* `<Portal>` mounts at `document.body` so the tether escapes
          every ancestor's stacking context, overflow:hidden, and
          transform-induced clip. Combined with `position: fixed` on
          each child, the tether is guaranteed to render at the right
          viewport coords regardless of any chrome wrapper geometry. */}
      <Portal>
        <For each={positions()}>
          {(pos) => {
            const ReviewerIcon = HARNESS_ICONS[pos.reviewerKind as keyof typeof HARNESS_ICONS];
            const ReviewedIcon = HARNESS_ICONS[pos.reviewedKind as keyof typeof HARNESS_ICONS];
            // Tether recedes when the user reaches into either linked
            // pane (mouse-hover OR focus). Stays present but dimmed so
            // it doesn't compete with the work the user's doing inside
            // the pane. Pure CSS opacity transition — no layout work,
            // no impact on xterm.
            const recede = (): boolean => {
              const fid = focusedPaneId();
              const hid = hoveredCellId();
              return (
                fid === pos.reviewerCellId ||
                fid === pos.reviewedCellId ||
                hid === pos.reviewerCellId ||
                hid === pos.reviewedCellId
              );
            };
            return (
              <div
                class="review-tether"
                classList={{ "review-tether--recede": recede() }}
                data-testid={`review-tether-${pos.key}`}
                style={{
                  position: "fixed",
                  left: `${pos.x}px`,
                  top: `${pos.y}px`,
                  "z-index": "9999",
                }}
                aria-label="cross-harness review link"
              >
                <div class="review-tether-dot" data-side="reviewed">
                  {ReviewedIcon ? <ReviewedIcon class="review-tether-icon" /> : null}
                </div>
                <div class="review-tether-line" aria-hidden="true" />
                <div class="review-tether-dot" data-side="reviewer">
                  {ReviewerIcon ? <ReviewerIcon class="review-tether-icon" /> : null}
                </div>
              </div>
            );
          }}
        </For>
      </Portal>
    </Show>
  );
};

const LeafFrame: Component<{ cell: RuntimeCell; maximizedPaneId: string | null }> = (props) => {
  const isMaximized = () => props.maximizedPaneId === props.cell.id;
  const anyMaximized = () => props.maximizedPaneId !== null;
  const isFocused = () => focusedPaneId() === props.cell.id;
  // Sample the source id once and memoize so every pointermove doesn't re-run
  // this for every leaf. Only the source leaf toggles its .pane-dragging class.
  const dragSourceId = createMemo(() => dragState()?.sourceId ?? null);
  const isDragSource = () => dragSourceId() === props.cell.id;

  function onFocusCapture(): void {
    setFocusedPaneId(props.cell.id);
  }

  let cellRef: HTMLDivElement | undefined;

  // Capture-phase dblclick so xterm can't swallow the event for word-selection.
  // Covers both the header (empty space only — tabs own dblclick-to-rename)
  // and the xterm body, so double-clicking anywhere on the pane maximizes it.
  onMount(() => {
    const el = cellRef;
    if (!el) return;
    function handleDblClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".pane-header-tab")) return;
      if (target?.closest(".pane-header-chrome-button")) return;
      if (target?.closest("input")) return;
      e.stopPropagation();
      e.preventDefault();
      toggleMaximize(props.cell.id);
    }
    el.addEventListener("dblclick", handleDblClick, true);
    onCleanup(() => el.removeEventListener("dblclick", handleDblClick, true));
  });

  // CSS-variable positioning. The actual left/top/width/height are derived
  // inside styles.css via `calc(var(--x-pct) + var(--inset))` so the same
  // gutter arithmetic runs for panes, placeholders, and drop zones.
  const style = () => {
    const pct = 100 / LAYOUT_UNIT;
    return {
      "--x-pct": `${props.cell.x * pct}%`,
      "--y-pct": `${props.cell.y * pct}%`,
      "--w-pct": `${props.cell.w * pct}%`,
      "--h-pct": `${props.cell.h * pct}%`,
    };
  };

  /** Active session id of the cell, for review-link lookups. */
  const activeSession = createMemo<string | undefined>(
    () => props.cell.tabs.find((t) => t.id === props.cell.activeTabId)?.sessionId,
  );
  const isLinked = () => isReviewLinked(activeSession());

  /**
   * Cross-harness review snap target: this cell is the destination of an
   * engaged magnetic snap (paneDnD's `snapped` flag, gated on kind via
   * `canSnapTo`). Drives both the body blur (`.pane-review-snap-target`)
   * and the conditional render of `<ReviewSnapOverlay>` below. The kind
   * checks here are belt-and-suspenders against the eligibility callback.
   */
  const isReviewSnapTarget = createMemo(() => {
    const s = dragState();
    if (!s) return false;
    if (!s.snapped) return false;
    if (s.targetId !== props.cell.id) return false;
    if (props.cell.kind === "empty" || props.cell.kind === "shell") return false;
    if (s.sourceKind === "shell" || s.sourceKind === "empty") return false;
    return true;
  });

  /** Source pane that has snapped onto a target. Drives the
   *  `.is-snapped` chrome modifier so the pane stops following the
   *  cursor and visually docks onto the target's rect (the user's
   *  "hard border where the drag stops" cue). */
  const isSnappedSource = createMemo(() => {
    if (!isDragSource()) return false;
    const s = dragState();
    return s?.snapped === true && s.targetId !== null && s.targetId !== ROOT_TARGET;
  });

  return (
    <div
      ref={(el) => {
        cellRef = el;
      }}
      data-dnd-target-pane-id={props.cell.id}
      data-cell-id={props.cell.id}
      data-review-linked={isLinked() ? "true" : undefined}
      class="leaf-frame terminal-chrome-frame flex min-h-0 min-w-0 flex-col"
      classList={{
        "pane-selected": isFocused(),
        "pane-dragging": isDragSource(),
        "is-snapped": isSnappedSource(),
        "pane-maximized": isMaximized(),
        "pane-review-linked": isLinked(),
        "pane-review-snap-target": isReviewSnapTarget(),
        hidden: anyMaximized() && !isMaximized(),
      }}
      style={style()}
      onFocusIn={onFocusCapture}
      onClick={onFocusCapture}
    >
      <PaneHeader
        cellId={props.cell.id}
        kind={props.cell.kind}
        title={props.cell.title}
        tabs={props.cell.tabs}
        activeTabId={props.cell.activeTabId}
        isMaximized={isMaximized()}
      />
      <div class="terminal-chrome-body relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <Show
          when={props.cell.kind !== "empty"}
          fallback={
            <div class="grid h-full w-full place-items-center text-xs text-foreground-dim">
              empty
            </div>
          }
        >
          <div class="h-full w-full" />
        </Show>
        <ReviewSnapOverlay
          cellId={props.cell.id}
          cellKind={props.cell.kind}
          targetSessionId={activeSession()}
        />
      </div>
    </div>
  );
};

// ---- PaneHeader: tabs + window chrome + drag source ------------------------

interface PaneHeaderProps {
  cellId: string;
  kind: string;
  title: string | undefined;
  tabs: CellTab[];
  activeTabId: string;
  isMaximized: boolean;
}

const PaneHeader: Component<PaneHeaderProps> = (props) => {
  function onCloseTab(ev: MouseEvent, tab: CellTab) {
    ev.stopPropagation();
    requestTerminalKill(tab.sessionId, "PaneHeader");
    removeCellTab(props.cellId, tab.id);
  }

  function onCloseCell(ev: MouseEvent) {
    ev.stopPropagation();
    for (const tab of props.tabs) requestTerminalKill(tab.sessionId, "PaneHeader");
    removePane(props.cellId);
  }

  function onAddTab(ev: MouseEvent) {
    ev.stopPropagation();
    // Mirror the top-row spawn path: new tabs land in the *current*
    // sidebar-scoped worktree, not the pane's original worktree. Falls back
    // to the pane's stored slug only if no project is active — which
    // shouldn't happen for a visible harness pane.
    const pane = runtimeLayoutStore.panes[props.cellId];
    const slug = activeProjectSlug() ?? pane?.projectSlug;
    const worktreeId = slug ? resolveSpawnWorktree(slug) : pane?.worktreeId;
    addCellTab(props.cellId, { projectSlug: slug, worktreeId });
  }

  function onHeaderPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest(".pane-header-chrome-button")) return;
    if (target?.closest(".pane-header-tab-close")) return;
    if (target?.closest("input")) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const THRESHOLD = 4;

    function onMove(ev: PointerEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (dx * dx + dy * dy < THRESHOLD * THRESHOLD) return;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      const rootEl = document.querySelector<HTMLElement>('[data-dnd-root="true"]');
      if (!rootEl) return;
      // Snapshot the cells so hit-testing uses the stable REAL layout
      // throughout the drag, not the live (animating) DOM bounds. See
      // BeginDragOptions.cells for the rationale — mixing animating rects
      // with the cursor created a target/preview feedback loop. Scope the
      // snapshot to the active project's pruned tree so DnD can't target
      // panes from other tabs that aren't in the DOM.
      const slug = activeProjectSlug();
      const mainPath = projectBySlug().get(slug ?? "")?.rootPath;
      const scope = activeWorktreeStore.byProject[slug ?? ""] ?? ALL_WORKTREES_SCOPE;
      // Reuse the active-projection cache — the pointerdown path reads
      // the same (layoutRev, slug, scope, mainPath) key that the grid's
      // `projection()` memo just populated, so this is a map hit.
      const projected = getScopedProjection(layoutRev(), slug, scope, mainPath);
      const cellsSnapshot = runtimeLayoutStore.cells.flatMap((c) => {
        const r = projected.rects.get(c.id);
        return r ? [{ id: c.id, x: r.x, y: r.y, w: r.w, h: r.h }] : [];
      });
      beginDrag({
        sourceId: props.cellId,
        sourceKind: props.kind,
        sourceLabel: KIND_LABELS[props.kind] ?? props.kind,
        event: ev,
        rootEl,
        cells: cellsSnapshot,
        layoutUnit: LAYOUT_UNIT,
        // Magnetic snap eligibility: only engage when both source and
        // target are review-eligible harnesses. Shell/empty panes never
        // snap — dragging onto a Shell pane just falls through to normal
        // edge-zone classification, which means edge-splits still work.
        canSnapTo: (targetId) => {
          if (props.kind === "shell" || props.kind === "empty") return false;
          const target = runtimeLayoutStore.panes[targetId];
          if (!target) return false;
          return target.kind !== "shell" && target.kind !== "empty";
        },
        onDrop: ({ sourceId, targetId, zone, snapped }) => {
          if (!targetId || !zone || sourceId === targetId) return;
          if (zone === "center") {
            // Center drop on a sibling pane = start a cross-harness review.
            // Center drop on the root sentinel = no-op (no target to review).
            if (targetId === ROOT_TARGET) return;
            // **Magnetic snap gate.** A review kills the source pane's
            // session and respawns a new harness, so we never commit
            // unless the snap was visibly engaged at release. An
            // unsnapped center release is treated as "changed mind" —
            // silently cancelled, no toast spam.
            if (!snapped) return;
            void startReviewFromDrop(sourceId, targetId);
            return;
          }
          const direction = zoneToDirection(zone);
          if (!direction) return;
          if (targetId === ROOT_TARGET) {
            movePaneToRootEdge(sourceId, direction);
          } else {
            movePaneToEdge(sourceId, targetId, direction);
          }
        },
      });
    }

    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  return (
    <div
      class="pane-drag-handle flex h-8 shrink-0 cursor-grab items-center border-b border-border-subtle active:cursor-grabbing"
      data-testid={`pane-header-${props.cellId}`}
      onPointerDown={onHeaderPointerDown}
    >
      <div class="no-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto pl-1.5">
        <For each={props.tabs}>
          {(tab) => (
            <TabItem
              cellId={props.cellId}
              tab={tab}
              kind={props.kind}
              isActive={tab.id === props.activeTabId}
              showClose={props.tabs.length > 1}
              onClose={(e) => onCloseTab(e, tab)}
            />
          )}
        </For>

        <button
          type="button"
          title="New tab"
          aria-label="New tab"
          class="pane-header-chrome-button ml-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md text-foreground-subtle hover:bg-hover hover:text-foreground"
          onClick={onAddTab}
        >
          <PlusGlyph />
        </button>
      </div>

      <div class="flex shrink-0 items-center gap-1 px-1.5">
        <ChromeButton
          label="Minimize to dock"
          onClick={(e) => {
            e.stopPropagation();
            const activeTab = props.tabs.find((t) => t.id === props.activeTabId);
            const snippet = extractSnippet(activeTab?.sessionId, props.kind as AgentKind);
            setLastSnippet(props.cellId, snippet, Date.now());
            minimizePane(props.cellId);
          }}
        >
          <MinusGlyph />
        </ChromeButton>
        <ChromeButton
          label={props.isMaximized ? "Restore" : "Maximize"}
          onClick={(e) => {
            e.stopPropagation();
            toggleMaximize(props.cellId);
          }}
        >
          {props.isMaximized ? <RestoreGlyph /> : <MaximizeGlyph />}
        </ChromeButton>
        <ChromeButton label="Close" danger onClick={onCloseCell}>
          <CloseGlyph />
        </ChromeButton>
      </div>
    </div>
  );
};

function zoneToDirection(zone: DropZone): Direction | null {
  if (zone === "top" || zone === "bottom" || zone === "left" || zone === "right") return zone;
  return null;
}

// ---- TabItem (unchanged — rename + context menu) --------------------------

const TabItem: Component<{
  cellId: string;
  tab: CellTab;
  kind: string;
  isActive: boolean;
  showClose: boolean;
  onClose: (e: MouseEvent) => void;
}> = (props) => {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuX, setMenuX] = createSignal(0);
  const [menuY, setMenuY] = createSignal(0);
  // "main" shows Rename + Review with → ; "review" shows the picker.
  const [menuMode, setMenuMode] = createSignal<"main" | "review">("main");

  /** Other open agent panes (excluding this tab's own pane and shells). The
   *  context menu's "Review with →" submenu lists these as targets. */
  const reviewCandidates = createMemo<Array<{ cellId: string; kind: AgentKind; label: string }>>(
    () => {
      const out: Array<{ cellId: string; kind: AgentKind; label: string }> = [];
      runtimeLayoutStore.cells.forEach((cell, idx) => {
        if (cell.id === props.cellId) return;
        if (cell.kind === "empty" || cell.kind === "shell") return;
        const sessionId = cell.tabs.find((t) => t.id === cell.activeTabId)?.sessionId;
        if (!sessionId) return; // can't review a pane that hasn't spawned yet
        const harnessLabel = KIND_LABELS[cell.kind] ?? cell.kind;
        out.push({
          cellId: cell.id,
          kind: cell.kind as AgentKind,
          label: `P${idx} · ${harnessLabel}`,
        });
      });
      return out;
    },
  );
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const tabLabel = () => resolveDisplayedTabLabel(props.tab);

  const tabState = (): AgentState | null =>
    agentStore.sessions[props.tab.sessionId ?? ""]?.state ?? null;

  const [bumping, setBumping] = createSignal(false);
  let prevTabState: AgentState | null = null;
  createEffect(() => {
    const s = tabState();
    const transitioned =
      (s === "waiting" && prevTabState !== "waiting") ||
      (s === "completed" && prevTabState === "working");
    if (transitioned) {
      setBumping(true);
      setTimeout(() => setBumping(false), 400);
    }
    prevTabState = s;
  });

  const harnessAnimating = () => {
    const s = tabState();
    return s === "working" || s === "waiting";
  };

  const HarnessIcon = () => {
    const Icon = HARNESS_ICONS[props.kind as keyof typeof HARNESS_ICONS];
    if (!Icon) return null;
    return <Icon class="h-3 w-3 shrink-0" classList={{ "harness-pulse": harnessAnimating() }} />;
  };

  const lastPromptText = (): string | undefined => {
    const sid = props.tab.sessionId;
    if (!sid) return undefined;
    const text = terminalStore.byId[sid]?.lastPrompt?.text;
    if (!text) return undefined;
    return text;
  };

  // Subtitles render only the first line of multi-line prompts. The
  // `title=` tooltip carries the full text (newlines preserved) so the
  // user can hover for the rest.
  const lastPromptSubtitle = (): string | undefined => {
    const text = lastPromptText();
    if (!text) return undefined;
    const idx = text.indexOf("\n");
    return idx >= 0 ? text.slice(0, idx) : text;
  };

  function openMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenuX(e.clientX);
    setMenuY(e.clientY);
    setMenuMode("main");
    setMenuOpen(true);
  }

  function closeMenu() {
    setMenuOpen(false);
    setMenuMode("main");
  }

  function pickReviewTarget(targetCellId: string) {
    closeMenu();
    void startReviewFromDrop(props.cellId, targetCellId);
  }

  function startRename() {
    setDraft(props.tab.label ?? props.tab.autoLabel ?? "");
    setEditing(true);
    closeMenu();
  }

  function commitRename() {
    if (!editing()) return;
    setTabLabel(props.cellId, props.tab.id, draft());
    setEditing(false);
  }

  function cancelRename() {
    setEditing(false);
  }

  return (
    <Tooltip>
      <TooltipTrigger
        as="div"
        class="pane-header-tab group relative flex min-w-[120px] max-w-[300px] grow basis-[180px] cursor-pointer items-center gap-1 rounded-md px-2 text-[10px] uppercase leading-none tracking-wide transition-colors"
        classList={{
          "h-[22px]": !!lastPromptSubtitle(),
          "h-[18px]": !lastPromptSubtitle(),
          "bg-selected text-foreground": props.isActive && tabState() !== "waiting",
          "bg-selected text-warning": props.isActive && tabState() === "waiting",
          "text-foreground-subtle hover:bg-hover hover:text-foreground":
            !props.isActive && tabState() !== "waiting",
          "bg-warning/15 text-warning hover:bg-warning/25":
            !props.isActive && tabState() === "waiting",
          wiggle: bumping(),
        }}
        onClick={(e: MouseEvent) => {
          if (editing()) return;
          e.stopPropagation();
          setActiveTabId(props.cellId, props.tab.id);
        }}
        onContextMenu={openMenu}
        onDblClick={(e: MouseEvent) => {
          e.stopPropagation();
          startRename();
        }}
      >
        <HarnessIcon />
        <div class="flex min-w-0 flex-1 flex-col justify-center">
          <div class="flex min-w-0 items-center gap-1">
            <Show when={editing()}>
              <input
                type="text"
                class="h-4 w-28 rounded-sm border border-border bg-background px-1 text-[10px] uppercase tracking-wide text-foreground outline-none focus:border-ring"
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                onBlur={commitRename}
                ref={(el) => {
                  queueMicrotask(() => {
                    el.focus();
                    el.select();
                  });
                }}
              />
            </Show>
            <Show when={!editing() && tabLabel()}>
              <span class="min-w-0 flex-1 truncate normal-case">{tabLabel()}</span>
            </Show>
            <Show when={props.showClose && !editing()}>
              <button
                type="button"
                aria-label="Close tab"
                class="pane-header-tab-close ml-0.5 hidden shrink-0 rounded-sm p-0.5 hover:bg-hover hover:text-foreground group-hover:flex"
                onClick={(e) => {
                  props.onClose(e);
                }}
              >
                <CloseGlyph />
              </button>
            </Show>
          </div>
          <Show when={lastPromptSubtitle()}>
            <div class="mt-px min-w-0 truncate text-[9px] font-normal leading-none normal-case tracking-normal opacity-85">
              {lastPromptSubtitle()}
            </div>
          </Show>
        </div>

        <Show when={menuOpen()}>
          <div
            class="floating-surface fixed z-50 w-48 rounded-xl border border-border bg-popover p-1 text-xs normal-case"
            role="menu"
            style={{ left: `${menuX()}px`, top: `${menuY()}px` }}
            onMouseLeave={closeMenu}
            onClick={(e) => e.stopPropagation()}
          >
            <Show when={menuMode() === "main"}>
              <button
                type="button"
                class="block w-full rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                onClick={startRename}
              >
                Rename…
              </button>
              <Show when={props.kind !== "shell" && props.kind !== "empty"}>
                <button
                  type="button"
                  class="flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                  disabled={reviewCandidates().length === 0}
                  onClick={() => setMenuMode("review")}
                  title={
                    reviewCandidates().length === 0
                      ? "No other harness panes are open"
                      : "Pick a pane whose work this harness should review"
                  }
                >
                  <span>Review with</span>
                  <span aria-hidden="true">→</span>
                </button>
              </Show>
            </Show>
            <Show when={menuMode() === "review"}>
              <div class="mb-1 flex items-center justify-between px-2 py-1 text-foreground-subtle">
                <button
                  type="button"
                  class="hover:text-foreground"
                  onClick={() => setMenuMode("main")}
                  aria-label="Back"
                >
                  ←
                </button>
                <span class="text-[10px] uppercase tracking-wide">Review which pane?</span>
                <span aria-hidden="true" class="w-3" />
              </div>
              <For each={reviewCandidates()}>
                {(c) => {
                  const Icon = HARNESS_ICONS[c.kind as keyof typeof HARNESS_ICONS];
                  return (
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                      onClick={() => pickReviewTarget(c.cellId)}
                    >
                      {Icon ? <Icon class="h-3 w-3 shrink-0" /> : null}
                      <span class="truncate">{c.label}</span>
                    </button>
                  );
                }}
              </For>
            </Show>
          </div>
        </Show>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent class="max-w-md">
          <Show when={tabLabel()}>
            <div class="text-[10px] font-medium uppercase tracking-wide">{tabLabel()}</div>
          </Show>
          <Show when={lastPromptText()}>
            <div
              class="whitespace-pre-wrap text-[11px] leading-snug text-popover-foreground/85"
              classList={{ "mt-1": !!tabLabel() }}
            >
              {lastPromptText()}
            </div>
          </Show>
        </TooltipContent>
      </TooltipPortal>
    </Tooltip>
  );
};

// ---- ChromeButton + glyphs ------------------------------------------------

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
      class="pane-header-chrome-button flex h-4 w-4 items-center justify-center rounded-sm text-foreground-subtle transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease)]"
      classList={{
        "hover:bg-destructive/15 hover:text-destructive": props.danger === true,
        "hover:bg-hover hover:text-foreground": props.danger !== true,
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

// ---- Cross-project projected panes ----------------------------------------

function rectStyle(rect: Rect): Record<string, string> {
  const pct = 100 / LAYOUT_UNIT;
  return {
    "--x-pct": `${rect.x * pct}%`,
    "--y-pct": `${rect.y * pct}%`,
    "--w-pct": `${rect.w * pct}%`,
    "--h-pct": `${rect.h * pct}%`,
  };
}

const ProjectedSessionFrame: Component<{ sessionId: string; rect: Rect | null }> = (props) => {
  const terminal = createMemo(() => terminalStore.byId[props.sessionId]);
  const project = createMemo(() => {
    const slug = terminal()?.project_slug;
    return slug ? projectBySlug().get(slug) : undefined;
  });
  const state = () => agentStore.sessions[props.sessionId]?.state ?? null;
  const HarnessIcon = () => {
    const kind = terminal()?.kind;
    if (!kind) return null;
    const I = HARNESS_ICONS[kind as keyof typeof HARNESS_ICONS];
    if (!I) return null;
    const animating = () => {
      const s = state();
      return s === "working" || s === "waiting";
    };
    return <I class="size-3.5 shrink-0" classList={{ "harness-pulse": animating() }} />;
  };
  const label = createMemo(() => {
    const current = terminal();
    const ctx = current?.paneContext;
    const kind = current?.kind;
    if (!kind || kind === "shell") return kind ? kindDisplayLabel(kind) : "";
    return resolveHarnessAutoLabel({
      kind,
      paneTitle: ctx?.paneTitle,
      windowName: ctx?.windowName,
      currentCommand: ctx?.currentCommand,
      fallbackLabel: kindDisplayLabel(kind),
    });
  });
  const headerStyle = () =>
    ({
      "box-shadow": `inset 0 1px 0 color-mix(in oklab, ${project()?.color ?? "#6b7280"} 26%, transparent)`,
      "background-image": `linear-gradient(180deg, color-mix(in oklab, ${project()?.color ?? "#6b7280"} 7%, transparent) 0%, transparent 100%)`,
    }) as Record<string, string>;
  const projectedSubtitle = (): string | undefined => {
    const text = terminal()?.lastPrompt?.text;
    if (!text) return undefined;
    const idx = text.indexOf("\n");
    return idx >= 0 ? text.slice(0, idx) : text;
  };

  return (
    <Show when={terminal()}>
      {(currentTerminal) => (
        <Show when={props.rect}>
          {(rect) => (
            <div
              class="leaf-frame terminal-chrome-frame flex min-h-0 min-w-0 flex-col"
              data-session-id={props.sessionId}
              data-testid={`projected-session-${props.sessionId}`}
              style={rectStyle(rect())}
              title={currentTerminal().project_slug ?? ""}
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("terminal-focus-requested", {
                    detail: { sessionId: props.sessionId },
                  }),
                );
              }}
            >
              <div
                class="flex h-8 shrink-0 items-center border-b border-border-subtle"
                style={headerStyle()}
              >
                <div class="no-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto pl-1.5">
                  <Tooltip>
                    <TooltipTrigger
                      as="div"
                      class="pane-header-tab relative flex min-w-[120px] max-w-[300px] grow basis-[180px] flex-col justify-center rounded-md px-2 text-[10px] uppercase leading-none tracking-wide text-foreground"
                      classList={{
                        "h-[26px]": !!projectedSubtitle(),
                        "h-[18px]": !projectedSubtitle(),
                      }}
                    >
                      <div class="flex min-w-0 items-center gap-1">
                        <HarnessIcon />
                        <span class="min-w-0 flex-1 truncate normal-case">{label()}</span>
                      </div>
                      <Show when={projectedSubtitle()}>
                        <div class="mt-px min-w-0 truncate pl-[18px] text-[9px] font-normal normal-case tracking-normal opacity-85">
                          {projectedSubtitle()}
                        </div>
                      </Show>
                    </TooltipTrigger>
                    <TooltipPortal>
                      <TooltipContent class="max-w-md">
                        <Show when={label()}>
                          <div class="text-[10px] font-medium uppercase tracking-wide">
                            {label()}
                          </div>
                        </Show>
                        <Show when={terminal()?.lastPrompt?.text}>
                          <div
                            class="whitespace-pre-wrap text-[11px] leading-snug text-popover-foreground/85"
                            classList={{ "mt-1": !!label() }}
                          >
                            {terminal()?.lastPrompt?.text}
                          </div>
                        </Show>
                      </TooltipContent>
                    </TooltipPortal>
                  </Tooltip>
                </div>
              </div>
              <div class="terminal-chrome-body relative min-h-0 min-w-0 flex-1 overflow-hidden" />
            </div>
          )}
        </Show>
      )}
    </Show>
  );
};
