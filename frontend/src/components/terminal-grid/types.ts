import { type AgentKind } from "../../lib/agentKind";
import { type CellKind, type CellTab } from "../../stores/runtimeLayoutStore";

// ---- cross-harness review -------------------------------------------------

export interface ReviewSpawnPayload {
  initialPrompt: string;
  reviewerKind: AgentKind;
  projectSlug: string;
  worktreeId: string | null;
  reviewedSessionId: string;
  reviewerSessionId: string;
}

// ---- AutoLabelBinder ------------------------------------------------------

export interface AutoLabelBinderProps {
  cellId: string;
  tabId: string;
  kind: CellKind;
  projectSlug?: string;
  worktreeId?: string;
  sessionId?: string;
}

// ---- ReviewSnapOverlay ----------------------------------------------------

export interface ReviewSnapOverlayProps {
  cellId: string;
  cellKind: CellKind;
  targetSessionId: string | undefined;
}

// ---- ReviewBracesLayer ----------------------------------------------------

export interface ReviewTetherPosition {
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

// ---- PaneHeader -----------------------------------------------------------

export interface PaneHeaderProps {
  cellId: string;
  kind: string;
  title: string | undefined;
  tabs: CellTab[];
  activeTabId: string;
  isMaximized: boolean;
}
