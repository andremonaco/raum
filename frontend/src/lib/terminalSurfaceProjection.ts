import type { AgentKind } from "./agentKind";
import type { Rect } from "./layoutTree";
import type { PaneContent, RuntimeCell } from "../stores/runtimeLayoutStore";
import type { TerminalRecord } from "../stores/terminalStore";

export type SurfaceSource = "layout" | "orphan";

export interface TerminalSurfaceDescriptor {
  key: string;
  source: SurfaceSource;
  kind: AgentKind;
  sessionId?: string;
  cellId?: string;
  tabId?: string;
  projectSlug?: string;
  worktreeId?: string;
  rect: Rect | null;
  visible: boolean;
  active: boolean;
  maximized: boolean;
  /** Cross-harness review: forwarded into the next `terminal_spawn`. Set on
   *  the tab by the review-intent drop handler; cleared once consumed. */
  initialPrompt?: string;
  /** Cross-harness review: forwarded into the next `terminal_spawn` as
   *  `model_override`. Set by the pre-spawn picker; cleared once consumed. */
  modelOverride?: { model: string; effort?: string };
  /** Mirrors `TerminalRecord.recoverable_after_reboot` for the surface's
   *  session. Drives `<TerminalPane>`'s auto-fire of `terminal_respawn_dead`
   *  on first mount when the previous tmux server died across a reboot. */
  recoverableAfterReboot?: boolean;
}

export interface ProjectTerminalSurfacesArgs {
  cells: readonly RuntimeCell[];
  /** Panes that are registered (in `runtimeLayoutStore.panes`) but not in
   *  the BSP `tree` — minimized harnesses living in the dock. They produce
   *  invisible, no-rect surfaces so xterm stays mounted across the
   *  in-tree → off-tree transition. */
  offTreePanes?: readonly PaneContent[];
  activeRectMap: ReadonlyMap<string, Rect>;
  minimizedPaneIds: ReadonlySet<string>;
  crossProjectMode: string | null;
  projectedSessionIds: readonly string[];
  projectedRectMap: ReadonlyMap<string, Rect>;
  terminalById: Readonly<Record<string, TerminalRecord | undefined>>;
  focusedPaneId: string | null;
  maximizedPaneId: string | null;
  /**
   * Speculative cell rects from the live drag preview tree. When present and
   * the cell is not the drag source, takes precedence over `activeRectMap` so
   * sibling terminals reflow in lockstep with their chrome during a drag.
   * Cross-project mode still wins (`projectedRectMap` is consulted first).
   */
  previewRectMap?: ReadonlyMap<string, Rect> | null;
  /**
   * Cell id of the pane currently being dragged. Excluded from preview-rect
   * routing so its surface stays anchored to the committed slot — the
   * `.surface-dragging-source` CSS class then ghost-translates it to follow
   * the cursor (matching the chrome's existing `--drag-dx`/`--drag-dy`
   * transform).
   */
  dragSourceId?: string | null;
  /**
   * Once the drag latches an edge/root zone (dwell armed), route the SOURCE to
   * its preview rect too — so the dragged pane (chrome + this surface) settles
   * into the exact slot it will occupy, rather than being faked by a separate
   * placeholder. The chrome's `.is-edge-snapped` rule drops its cursor
   * transform so both layers sit at that slot.
   */
  routeDragSource?: boolean;
}

function isAgentKind(kind: RuntimeCell["kind"]): kind is AgentKind {
  return kind !== "empty";
}

function isPaneAgentKind(kind: PaneContent["kind"]): kind is AgentKind {
  return kind !== "empty";
}

function rankSurface(surface: TerminalSurfaceDescriptor, activeTab: boolean): number {
  let rank = 0;
  if (surface.visible) rank += 100;
  if (surface.source === "layout") rank += 20;
  if (activeTab) rank += 10;
  if (surface.rect) rank += 1;
  return rank;
}

export function projectTerminalSurfaces(
  args: ProjectTerminalSurfacesArgs,
): TerminalSurfaceDescriptor[] {
  const sessionOwners = new Map<string, { surface: TerminalSurfaceDescriptor; rank: number }>();
  const unsessioned: TerminalSurfaceDescriptor[] = [];
  const projectedIds = new Set(args.projectedSessionIds);
  const ownedSessions = new Set<string>();
  const isCrossProject = args.crossProjectMode !== null;

  const addLayoutSurface = (surface: TerminalSurfaceDescriptor, activeTab: boolean): void => {
    if (!surface.sessionId) {
      if (!surface.visible) return;
      unsessioned.push(surface);
      return;
    }
    ownedSessions.add(surface.sessionId);
    const rank = rankSurface(surface, activeTab);
    const existing = sessionOwners.get(surface.sessionId);
    if (!existing || rank > existing.rank) {
      sessionOwners.set(surface.sessionId, { surface, rank });
    }
  };

  for (const cell of args.cells) {
    if (!isAgentKind(cell.kind)) continue;
    const committedRect = args.activeRectMap.get(cell.id) ?? null;
    // Sibling cells reflow to their preview rect; the drag source stays
    // anchored to its committed rect (CSS ghost-translate moves it visually) —
    // UNLESS the drag has latched (`routeDragSource`), in which case the source
    // also routes to its slot so the dragged pane settles into place.
    const previewRect =
      args.previewRectMap && (cell.id !== args.dragSourceId || args.routeDragSource)
        ? (args.previewRectMap.get(cell.id) ?? null)
        : null;
    const activeRect = previewRect ?? committedRect;
    // Siblings of a maximized pane stay rendered at their committed rects so
    // the maximize/restore animation can grow/shrink the maximized pane over
    // them without the others snapping in and out. The `.pane-maximized`
    // rule's z-index lifts the maximized surface above siblings within the
    // surface layer, so they're visually covered for the duration of the
    // maximize state without needing to be hidden.
    const normalCellVisible =
      !isCrossProject && activeRect !== null && !args.minimizedPaneIds.has(cell.id);

    for (const tab of cell.tabs) {
      const activeTab = tab.id === cell.activeTabId;
      const sessionId = tab.sessionId;
      const projectedRect = sessionId ? (args.projectedRectMap.get(sessionId) ?? null) : null;
      const crossVisible =
        isCrossProject &&
        sessionId !== undefined &&
        projectedRect !== null &&
        projectedIds.has(sessionId);
      const normalVisible = normalCellVisible && activeTab;
      const visible = normalVisible || crossVisible;
      const rect = crossVisible ? projectedRect : normalVisible ? activeRect : null;
      const projectSlug = tab.projectSlug ?? cell.projectSlug;
      const worktreeId = tab.worktreeId ?? cell.worktreeId;
      const maximized = visible && !isCrossProject && args.maximizedPaneId === cell.id;

      addLayoutSurface(
        {
          key: tab.id,
          source: "layout",
          kind: cell.kind,
          sessionId,
          cellId: cell.id,
          tabId: tab.id,
          projectSlug,
          worktreeId,
          rect,
          visible,
          active: visible && activeTab && args.focusedPaneId === cell.id,
          maximized,
          initialPrompt: tab.initialPrompt,
          modelOverride: tab.modelOverride,
          recoverableAfterReboot: sessionId
            ? !!args.terminalById[sessionId]?.recoverable_after_reboot
            : false,
        },
        activeTab,
      );
    }
  }

  // Off-tree minimized panes: emit invisible/no-rect descriptors keyed on
  // `tab.id` so the xterm component stays mounted across the in-tree →
  // off-tree transition (preserves scrollback). The surface layer hides
  // them via `visible: false` (no positioning, `display: none`).
  for (const pane of args.offTreePanes ?? []) {
    if (!isPaneAgentKind(pane.kind)) continue;
    for (const tab of pane.tabs) {
      const projectSlug = tab.projectSlug ?? pane.projectSlug;
      const worktreeId = tab.worktreeId ?? pane.worktreeId;
      addLayoutSurface(
        {
          key: tab.id,
          source: "layout",
          kind: pane.kind,
          sessionId: tab.sessionId,
          cellId: pane.id,
          tabId: tab.id,
          projectSlug,
          worktreeId,
          rect: null,
          visible: false,
          active: false,
          maximized: false,
          recoverableAfterReboot: tab.sessionId
            ? !!args.terminalById[tab.sessionId]?.recoverable_after_reboot
            : false,
        },
        tab.id === pane.activeTabId,
      );
    }
  }

  for (const [sessionId, record] of Object.entries(args.terminalById)) {
    if (ownedSessions.has(sessionId)) continue;
    if (!record || record.kind === "shell") continue;
    const projectedRect = args.projectedRectMap.get(sessionId) ?? null;
    const visible = isCrossProject && projectedRect !== null && projectedIds.has(sessionId);
    if (!visible) continue;
    sessionOwners.set(sessionId, {
      rank: 0,
      surface: {
        key: `orphan:${sessionId}`,
        source: "orphan",
        kind: record.kind,
        sessionId,
        projectSlug: record.project_slug ?? undefined,
        worktreeId: record.worktree_id ?? undefined,
        rect: visible ? projectedRect : null,
        visible,
        active: false,
        maximized: false,
        recoverableAfterReboot: !!record.recoverable_after_reboot,
      },
    });
  }

  return [...unsessioned, ...Array.from(sessionOwners.values(), (entry) => entry.surface)];
}
