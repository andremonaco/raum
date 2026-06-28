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
import { invoke } from "@tauri-apps/api/core";

import { resolveSpawnWorktree } from "../../lib/resolveSpawnWorktree";
import {
  getCrossProjectProjection,
  setCrossProjectProjectionCacheMaxSize,
} from "../../lib/crossProjectProjection";
import { useKeymap } from "../../lib/keymapContext";
import {
  projectToRects,
  removeLeaf,
  splitAtLeaf,
  splitAtRoot,
  type LayoutNode,
  type Rect,
} from "../../lib/layoutTree";
import { ROOT_TARGET, dragState } from "../../lib/paneDnD";
import { installWindowResizeClass } from "../../lib/gridResizeClass";
import { timeMemoSettle } from "../../lib/perf";
import {
  prewarmProjectionCache,
  setProjectionCacheMaxSize,
  type ScopedProjection,
} from "../../lib/scopedProjection";
import {
  projectTerminalSurfaces,
  type TerminalSurfaceDescriptor,
} from "../../lib/terminalSurfaceProjection";
import { listTerminals } from "../../lib/terminalRegistry";
import {
  activeProjectSlug,
  projectBySlug,
  projectStore,
  setActiveProjectSlug,
} from "../../stores/projectStore";
import {
  LAYOUT_UNIT,
  addCellTab,
  activeLayoutHydrationSettled,
  clearMaximize,
  cycleFocus,
  focusPaneByIndex,
  focusByDirection,
  focusedPaneId,
  layoutRev,
  maximizeAnim,
  maximizedPaneId,
  minimizePane,
  minimizedPaneIds,
  movePaneDirectional,
  nextCellId,
  nextTabId,
  nudgeFocusedDivider,
  removeCell,
  restorePane,
  runtimeLayoutStore,
  setActiveTabId,
  setFocusedPaneId,
  splitFocusedOrRoot,
  toggleMaximize,
  undoLayout,
  type CellKind,
  type PaneContent,
  type RuntimeCell,
} from "../../stores/runtimeLayoutStore";
import { toast } from "solid-sonner";
import { listCrossProjectHarnessSessions, terminalStore } from "../../stores/terminalStore";
import {
  ALL_WORKTREES_SCOPE,
  activeWorktreeStore,
  matchesWorktreeScope,
} from "../../stores/worktreeStore";
import { DividerLayer } from "../divider-layer";
import { Dock } from "../dock";
import { FolderIcon, HARNESS_ICONS } from "../icons";
import { crossProjectViewMode, setCrossProjectViewMode } from "../top-row";
import { DropZoneGuides } from "./drop-zone-guides";
import { PlusGlyph } from "./glyphs";
import { LeafFrame } from "./leaf-frame";
import { ProjectedSessionFrame } from "./projected-frame";
import { ReviewBracesLayer } from "./review-overlay";
import { TerminalSurfaceLayer } from "./surfaces";
import { KIND_LABELS } from "./constants";
import { getScopedProjection, requestTerminalKill, zoneToDirection } from "./utils";

// Re-export the cross-harness review helpers so external imports of
// `./components/terminal-grid` (which now resolves to `index.tsx`) continue
// to find them. Internal call sites use the dedicated modules directly.
export { activeSessionForCell, consumeReviewSpawn, startReviewFromDrop } from "./review-spawn";
export type { ReviewSpawnPayload } from "./review-spawn";

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
    // Dwell gate: hovering a zone lights up its guide immediately (see
    // <DropZoneGuides>), but the grid only reflows the gap open once the short
    // hold has elapsed and paneDnD flips `armed`. Until then the guides are
    // the only feedback, so sweeping across zones doesn't thrash the layout.
    if (!s.armed) return null;
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

  // Minimized panes shown in the dock, scoped to the active project + the
  // sidebar's worktree scope — exactly mirroring `pruneTreeByScope` for the
  // in-tree grid, so a minimized chip obeys the same visibility rule as the
  // pane it came from. Project-less shells stay global (visible in every
  // project's dock), like un-minimized shells in the grid. The unscoped
  // `offTreePanes()` still feeds `projectTerminalSurfaces` below, so every
  // minimized session keeps its xterm mounted across project switches and
  // scrollback survives.
  const scopedMinimizedPanes = createMemo(() => {
    const slug = activeProjectSlug();
    const scope = activeScope();
    const mainPath = activeMainPath();
    return offTreePanes().filter(
      (p) =>
        p.projectSlug === undefined ||
        (p.projectSlug === slug && matchesWorktreeScope(scope, p.worktreeId, mainPath)),
    );
  });

  // True once the drag latches an edge/root zone (dwell armed, not a review
  // snap): the dragged pane then settles into the exact slot it will occupy,
  // so it IS its own landing preview instead of a separate placeholder.
  const dragFitsSlot = createMemo(() => {
    const s = dragState();
    return (
      !!s && s.armed && !s.snapped && s.zone !== null && s.zone !== "center" && s.targetId !== null
    );
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
      // Once latched, the dragged pane settles into its slot — route its
      // surface there too (the chrome routes via the render loop below).
      routeDragSource: dragFitsSlot(),
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

    // ---- Pane management via keyboard (Contract A action-ids) ----------
    //
    // Splits dispatch the SAME `raum:spawn-requested` event the top-row and
    // drag-spawn use, inheriting the focused pane's kind/project/worktree so
    // the new pane is a sibling of the same harness. The store's
    // `splitFocusedOrRoot` chooses the axis (longer side); the explicit
    // right/down ids exist for muscle-memory parity with tmux/VSCode even
    // though the resulting axis is the store's call. Focus/move/resize route
    // straight to the STORE directional helpers (Contract B).

    /** Re-spawn a sibling of the focused pane in an explicit direction. The
     *  `splitDirection` rides the spawn event so `splitFocusedOrRoot` forces a
     *  genuine horizontal ("right") vs. vertical ("bottom") split rather than
     *  the balanced aspect-ratio heuristic. Shell panes (no project) still
     *  split fine. */
    function spawnSiblingOfFocused(splitDirection: "right" | "bottom"): void {
      const paneId = focusedPaneId();
      if (!paneId) return;
      const pane = runtimeLayoutStore.panes[paneId];
      if (!pane || pane.kind === "empty") return;
      const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
      window.dispatchEvent(
        new CustomEvent("raum:spawn-requested", {
          detail: {
            kind: pane.kind,
            projectSlug: activeTab?.projectSlug ?? pane.projectSlug,
            worktreeId: activeTab?.worktreeId ?? pane.worktreeId,
            splitDirection,
          },
        }),
      );
    }

    unregs.push(keymap.register("split-pane-right", () => spawnSiblingOfFocused("right")));
    unregs.push(keymap.register("split-pane-down", () => spawnSiblingOfFocused("bottom")));

    unregs.push(
      keymap.register("close-pane", () => {
        const paneId = focusedPaneId();
        if (!paneId) return;
        const pane = runtimeLayoutStore.panes[paneId];
        // Mirror the header close: kill the live sessions before collapsing
        // the tree so we don't orphan tmux sessions (session-visibility
        // invariant — every live session must stay user-closable).
        if (pane) {
          for (const tab of pane.tabs) requestTerminalKill(tab.sessionId, "close-pane");
        }
        removeCell(paneId);
      }),
    );

    unregs.push(
      keymap.register("minimize-pane", () => {
        const paneId = focusedPaneId();
        if (paneId) minimizePane(paneId);
      }),
    );

    unregs.push(keymap.register("focus-pane-left", () => focusByDirection("left")));
    unregs.push(keymap.register("focus-pane-right", () => focusByDirection("right")));
    unregs.push(keymap.register("focus-pane-up", () => focusByDirection("up")));
    unregs.push(keymap.register("focus-pane-down", () => focusByDirection("down")));

    unregs.push(keymap.register("move-pane-left", () => movePaneDirectional("left")));
    unregs.push(keymap.register("move-pane-right", () => movePaneDirectional("right")));
    unregs.push(keymap.register("move-pane-up", () => movePaneDirectional("up")));
    unregs.push(keymap.register("move-pane-down", () => movePaneDirectional("down")));

    // Grow/shrink nudge the focused pane's divider. "grow" pushes the
    // trailing edge outward (right/down); "shrink" pulls it inward. The
    // STORE helper resolves which divider belongs to the focused pane.
    unregs.push(keymap.register("grow-pane", () => nudgeFocusedDivider("right")));
    unregs.push(keymap.register("shrink-pane", () => nudgeFocusedDivider("left")));

    unregs.push(
      keymap.register("undo-layout", () => {
        // Gate the toast on the actual result so it never lies: undoLayout()
        // returns false when the history stack is empty (nothing was
        // restored). The change is otherwise silent (panes just reflow), so
        // the toast anchors the gesture. Matches the worktree/merge pattern.
        if (!undoLayout()) return;
        toast("Layout restored", { description: "Undid the last pane change." });
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
          splitDirection?: "right" | "bottom";
          initialPrompt?: string;
        }>
      ).detail;
      if (!detail || !detail.kind || detail.kind === "empty") return;
      if (detail.kind !== "shell" && !detail.projectSlug) return;

      const id = nextCellId();
      const tabId = nextTabId();
      const newPane: PaneContent = {
        id,
        kind: detail.kind,
        // `initialPrompt` (set e.g. by the sidebar Commit button) is forwarded
        // to `terminal_spawn` so the harness launches pre-loaded with a task.
        tabs: [{ id: tabId, initialPrompt: detail.initialPrompt }],
        activeTabId: tabId,
        projectSlug: detail.projectSlug,
        worktreeId: detail.worktreeId,
      };
      // `splitDirection` (set by the keyboard split-right/split-down actions)
      // forces the orientation; spawns without it keep the balanced heuristic.
      splitFocusedOrRoot(newPane, detail.splitDirection);
      setFocusedPaneId(id);
      // Drop maximize when a new pane appears — the user just asked for a new
      // terminal to type in, so they want to see (and reach) it.
      clearMaximize();
    }
    window.addEventListener("raum:spawn-requested", onSpawn);
    onCleanup(() => window.removeEventListener("raum:spawn-requested", onSpawn));
  });

  // Window-resize 1:1: stamp `window-resize-active` on the grid root while
  // the OS window is mid-resize so styles.css zeroes the `.leaf-frame`
  // position transition (panes track the new geometry instead of lagging it).
  onMount(() => {
    const teardown = installWindowResizeClass(() => rootEl());
    onCleanup(teardown);
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

    // Edge / root latch is handled by routing the source to its slot rect
    // (see `dragFitsSlot`), not a transform — so no `--snap-*` vars here.
    root.style.removeProperty("--snap-dx");
    root.style.removeProperty("--snap-dy");
  });

  // Tree passed to DividerLayer — preview while hovering a zone so dividers
  // reflow with the panes (otherwise they'd be stuck at pre-drag positions
  // while panes animate to projected ones). Falls back to the real tree.
  // (`previewTree` and `previewCellMap` are defined above so the surface
  // projection memo can read them.)
  const renderTree = createMemo<LayoutNode | null>(() => previewTree() ?? activeTree());

  // Empty-state branching for the active-project view (cross-project mode has
  // its own "no matching sessions" message and is excluded here).
  //
  //   1. Hydration attempt NOT settled → skeleton. A saved layout rehydrates
  //      from TOML on cold boot; until the attempt finishes we don't yet know
  //      if there are panes, so showing the "spawn a harness" empty-state would
  //      flash "no terminals" for a frame and then snap to the restored grid.
  //      A faint skeleton holds the space instead. We gate on
  //      `activeLayoutHydrationSettled()` (flips on EVERY exit — success,
  //      empty, timeout, corrupt) rather than `didActiveLayoutHydrate()`
  //      (which stays false on failed reads), so the skeleton always resolves
  //      instead of hanging forever after a corrupt/timed-out boot (Contract B).
  //   2. Settled, zero cells, ZERO projects → first-run CTA ("Add a project").
  //      The disabled harness buttons are useless with no project to spawn into.
  //   3. Settled, zero cells, projects EXIST → the harness spawn grid (some
  //      buttons may be disabled if no project is active, but the user has a
  //      project to activate).
  const isEmptyActiveView = createMemo(
    () => crossProjectMode() === null && activeCells().length === 0,
  );
  const showSkeleton = createMemo(() => isEmptyActiveView() && !activeLayoutHydrationSettled());
  const showFirstRunCta = createMemo(
    () => isEmptyActiveView() && activeLayoutHydrationSettled() && projectStore.items.length === 0,
  );
  const showSpawnGrid = createMemo(
    () => isEmptyActiveView() && activeLayoutHydrationSettled() && projectStore.items.length > 0,
  );

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
          classList={{ "maximize-anim": maximizeAnim() }}
          ref={setRootEl}
          data-dnd-root="true"
        >
          {/* HYDRATION SKELETON — faint pane outlines while the saved layout
              is still rehydrating, so a restored grid never flashes the
              "spawn a harness" empty-state on cold boot. */}
          <Show when={showSkeleton()}>
            <div
              class="absolute inset-2 z-10 grid grid-cols-2 grid-rows-2 gap-2"
              aria-hidden="true"
            >
              <div class="grid-skeleton-pane" />
              <div class="grid-skeleton-pane" />
              <div class="grid-skeleton-pane" />
              <div class="grid-skeleton-pane" />
            </div>
          </Show>

          {/* FIRST-RUN CTA — no projects exist yet, so disabled harness
              buttons would be a dead end. Offer the one action that unblocks
              everything: add a project. */}
          <Show when={showFirstRunCta()}>
            <div class="absolute inset-0 z-10 grid place-items-center bg-surface-sunken">
              <div class="flex max-w-sm flex-col items-center gap-4 px-6 text-center">
                <FolderIcon class="size-9 text-foreground-subtle" />
                <div class="flex flex-col gap-1">
                  <span class="text-sm font-medium text-foreground">No projects yet</span>
                  <span class="text-xs text-foreground-subtle">
                    Add a git repository to start spawning agent harnesses.
                  </span>
                </div>
                <button
                  type="button"
                  class="focus-ring flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors duration-[var(--motion-base)] ease-[var(--motion-ease)] hover:bg-primary/90"
                  onClick={() => {
                    // top-row owns the Add-Project modal and listens for this
                    // event to open it (see top-row's onMount handler).
                    window.dispatchEvent(new CustomEvent("raum:add-project-requested"));
                  }}
                >
                  <PlusGlyph />
                  Add a project
                </button>
              </div>
            </div>
          </Show>

          {/* HARNESS SPAWN GRID — projects exist but no panes in this view.
              Buttons that need a project are disabled until one is active. */}
          <Show when={showSpawnGrid()}>
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
                      // Drag source: stay anchored to its committed scoped rect
                      // (the same one the surface uses) so chrome and xterm
                      // share the resting frame the `--drag-dx/--drag-dy`
                      // transform translates from. Skipping this and using the
                      // raw cell rect (global tree) would jump the chrome to a
                      // different slot than the surface the moment the drag
                      // starts — visible as the top-bar detaching from its
                      // terminal body, especially under an active worktree
                      // scope where global vs. scoped rects diverge.
                      const isSource = dragState()?.sourceId === cell.id;
                      // Siblings route to their preview rect; the source stays
                      // at its committed rect (and follows the cursor) UNTIL the
                      // drag latches, when it too settles into its slot.
                      const preview =
                        !isSource || dragFitsSlot()
                          ? (previewCellMap()?.get(cell.id) ?? null)
                          : null;
                      const rect = preview ?? activeRectMap().get(cell.id) ?? null;
                      if (!rect) return cell;
                      return {
                        ...cell,
                        x: rect.x,
                        y: rect.y,
                        w: rect.w,
                        h: rect.h,
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

          {/* DnD chrome layer — ABOVE the panes, pointer-events: none. Holds
              the drop-zone grip handles (the "where can it land" menu). The
              dragged pane is its own landing preview: once latched it settles
              into its slot, so there's no placeholder rect or drag chip.
              Active-project view only; DropZoneGuides gates on dragState(). */}
          <Show when={crossProjectMode() === null}>
            <div class="pointer-events-none absolute inset-0 z-[55]">
              <DropZoneGuides tree={activeTree()} />
            </div>
          </Show>
        </div>
      </div>
      <Dock minimizedPanes={scopedMinimizedPanes()} onRestore={onRestoreFromDock} />
    </div>
  );
};

export default TerminalGrid;
