import type { AgentKind } from "./agentKind";
import type { Rect } from "./layoutTree";
import type { RuntimeCell } from "../stores/runtimeLayoutStore";
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
}

export interface ProjectTerminalSurfacesArgs {
  cells: readonly RuntimeCell[];
  activeRectMap: ReadonlyMap<string, Rect>;
  minimizedPaneIds: ReadonlySet<string>;
  crossProjectMode: string | null;
  projectedSessionIds: readonly string[];
  projectedRectMap: ReadonlyMap<string, Rect>;
  terminalById: Readonly<Record<string, TerminalRecord | undefined>>;
  focusedPaneId: string | null;
  maximizedPaneId: string | null;
}

function cellHomeRect(cell: RuntimeCell): Rect {
  return { id: cell.id, x: cell.x, y: cell.y, w: cell.w, h: cell.h };
}

function isAgentKind(kind: RuntimeCell["kind"]): kind is AgentKind {
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
    const homeRect = cellHomeRect(cell);
    const activeRect = args.activeRectMap.get(cell.id) ?? null;
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
      const rect = crossVisible ? projectedRect : normalVisible ? activeRect : homeRect;
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
        },
        activeTab,
      );
    }
  }

  for (const [sessionId, record] of Object.entries(args.terminalById)) {
    if (ownedSessions.has(sessionId)) continue;
    if (!record || record.kind === "shell") continue;
    const projectedRect = args.projectedRectMap.get(sessionId) ?? null;
    const visible = isCrossProject && projectedRect !== null && projectedIds.has(sessionId);
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
      },
    });
  }

  return [...unsessioned, ...Array.from(sessionOwners.values(), (entry) => entry.surface)];
}
