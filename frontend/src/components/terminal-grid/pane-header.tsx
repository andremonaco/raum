import { Component, For, Show, createMemo } from "solid-js";

import { type AgentKind } from "../../lib/agentKind";
import { agentStore, isAcknowledgedReactive } from "../../stores/agentStore";
import { ROOT_TARGET, beginDrag } from "../../lib/paneDnD";
import { resolveSpawnWorktree } from "../../lib/resolveSpawnWorktree";
import { extractSnippet } from "../../lib/terminalSnippet";
import { activeProjectSlug, projectBySlug } from "../../stores/projectStore";
import {
  LAYOUT_UNIT,
  addCellTab,
  layoutRev,
  minimizePane,
  movePaneToEdge,
  movePaneToRootEdge,
  removeCellTab,
  removePane,
  runtimeLayoutStore,
  setLastSnippet,
  toggleMaximize,
  type CellTab,
} from "../../stores/runtimeLayoutStore";
import { ALL_WORKTREES_SCOPE, activeWorktreeStore } from "../../stores/worktreeStore";
import { KIND_LABELS } from "./constants";
import {
  ChromeButton,
  CloseGlyph,
  MaximizeGlyph,
  MinusGlyph,
  PlusGlyph,
  RestoreGlyph,
} from "./glyphs";
import { startReviewFromDrop } from "./review-spawn";
import { TabItem } from "./tab-item";
import { type PaneHeaderProps } from "./types";
import { getScopedProjection, requestTerminalKill, zoneToDirection } from "./utils";

export const PaneHeader: Component<PaneHeaderProps> = (props) => {
  // True when at least one non-active tab in this pane points at a
  // harness session whose Completed transition the user hasn't
  // acknowledged yet. Surfaces as a small green dot next to the chrome
  // buttons so completions sitting behind the active tab still nudge for
  // attention. Active-tab completions are already tinted in the tab
  // strip, so they don't contribute.
  const hasHiddenCompletion = createMemo(() => {
    return props.tabs.some((tab) => {
      if (tab.id === props.activeTabId) return false;
      const sid = tab.sessionId;
      if (!sid) return false;
      if (agentStore.sessions[sid]?.state !== "completed") return false;
      return !isAcknowledgedReactive(sid);
    });
  });

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
      // No dwell gate: a review now spawns a *fresh* reviewer pane next
      // to the reviewed pane and leaves the dragged source pane intact,
      // so there's no destructive commit to defend against. The release
      // arms instantly regardless of whether the source has history.
      const armDelayMs = 0;

      beginDrag({
        sourceId: props.cellId,
        sourceKind: props.kind,
        sourceLabel: KIND_LABELS[props.kind] ?? props.kind,
        event: ev,
        rootEl,
        cells: cellsSnapshot,
        layoutUnit: LAYOUT_UNIT,
        armDelayMs,
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
        onDrop: ({ sourceId, targetId, zone, snapped, armed }) => {
          if (!targetId || !zone || sourceId === targetId) return;
          if (zone === "center") {
            // Center drop on a sibling pane = start a cross-harness review.
            // Center drop on the root sentinel = no-op (no target to review).
            if (targetId === ROOT_TARGET) return;
            // The review now spawns a fresh reviewer pane next to the
            // reviewed pane and leaves the source intact, so no dwell
            // gate is required — `armDelayMs === 0` means `armed` is
            // always set on release here. We still require `snapped` so
            // the gesture only fires when the magnet was visually
            // engaged at the moment of release.
            if (!snapped || !armed) return;
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
      <div class="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pl-1.5">
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
          class="pane-header-chrome-button flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-foreground-subtle transition-colors duration-150 hover:bg-hover hover:text-foreground"
          onClick={onAddTab}
        >
          <PlusGlyph />
        </button>
      </div>

      <div class="flex shrink-0 items-center gap-1 px-1.5">
        <Show when={hasHiddenCompletion()}>
          <span
            aria-label="Completed harness in this pane"
            title="Completed harness in this pane"
            class="mr-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-success"
          />
        </Show>
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
