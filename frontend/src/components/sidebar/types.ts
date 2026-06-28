/**
 * §9 — shared prop and value types for the sidebar module folder. Everything
 * here is pure-data so it can be imported from any sub-module without
 * triggering JSX/runtime cycles.
 */

import type { Component, ComponentProps } from "solid-js";
import type {
  FileChange,
  FileChangeKind,
  Worktree,
  WorktreeStatus,
} from "../../stores/worktreeStore";
import type { CommitFileChange } from "./git-commands";
import type { ProjectListItem } from "../../stores/projectStore";

export interface HarnessCounts {
  active: number;
  waiting: number;
  idle: number;
}

export interface HarnessCounterProps {
  counts: HarnessCounts;
  /** Compact variant drops the bordered pill — used in dense rows. */
  compact?: boolean;
}

/** What the diff-viewer modal should show: a working-tree diff (staged or
 *  unstaged side) or a file's diff within one commit. */
export type DiffTarget =
  | { mode: "worktree"; file: string; staged: boolean }
  | { mode: "commit"; file: string; hash: string; shortHash: string };

export type ExpandedTabId = "changes" | "history" | "files";

// ── Tab bar (replaces SegmentedSwitcherProps) ───────────────────────────────
/** One entry in the icon-only underline view-tab bar. */
export interface ViewTabItem {
  id: ExpandedTabId;
  /** Surfaced as the tooltip + `aria-label` (the bar renders no text). */
  label: string;
  /** Tab icon (rendered at `size-4`, inherits `currentColor`). */
  icon: Component<ComponentProps<"svg">>;
}
export interface ViewTabBarProps {
  tabs: readonly ViewTabItem[];
  active: ExpandedTabId;
  onChange: (id: ExpandedTabId) => void;
}

// ── Worktree accordion (the expanded sidebar body) ──────────────────────────
// A vertical stack of collapsible worktree "tabs". The main worktree is pinned
// first as the local base repo; the open tab expands its Changes/History/Files
// detail in one focused scroll.
export interface WorktreeAccordionProps {
  /** Active project, or `undefined` when none is registered/selected. */
  project: ProjectListItem | undefined;
  /** True while the create-worktree modal should be open for this project. */
  createOpen: boolean;
  /** The "+" button asks the owner (index.tsx) to open the create modal so the
   *  keymap action and the button share one source of truth. */
  onRequestCreate: () => void;
  onCreateClose: () => void;
}

// ── WorktreeDetail (renamed from WorktreeExpandedProps; same shape) ──────────
export interface WorktreeDetailProps {
  worktree: Worktree;
  projectSlug: string;
  status: WorktreeStatus;
  /** True until the first status (push or fetch) lands for this path. */
  statusPending: boolean;
  onOpenDiff: (target: DiffTarget) => void;
  onOpenEditor: (absPath: string) => void;
  /** Abs path of the file most recently opened in the editor (active-file highlight). */
  activeEditorPath?: string | null;
}

// ── Worktree tab (one vertical accordion tab: header + expandable detail) ────
export interface WorktreeTabProps {
  worktree: Worktree;
  projectSlug: string;
  /** This worktree is the active terminal scope (drives the row highlight). */
  isActive: boolean;
  /** This tab's detail panel is expanded (single-open accordion). */
  isOpen: boolean;
  /** True when this worktree is the project root — pinned first as the base. */
  isMain: boolean;
  projectColor?: string;
  projectSigil?: string;
  /**
   * Branch of the project's main worktree — best-effort "sprouted from"
   * fallback for additional worktrees created before raum started persisting
   * `branch.<name>.raumBase` (or whose upstream is unset).
   */
  mainBranchFallback: string | null;
  /** Toggle this tab open/closed; opening also focuses the worktree. */
  onToggle: () => void;
  /** Called when the user clicks the row-level delete/unlink icon. */
  onRequestDelete: () => void;
  /** Called when the user clicks the row-level merge icon (additional only). */
  onRequestMerge?: () => void;
}

// ── View props: drop inner-scroll assumptions; add active-file + diff to Files ─
export interface ChangesViewProps {
  worktree: Worktree;
  projectSlug: string;
  status: WorktreeStatus;
  statusPending: boolean;
  onOpenDiff: (target: DiffTarget) => void;
  onOpenEditor: (absPath: string) => void;
}

export interface HistoryViewProps {
  worktree: Worktree;
  /** True while the History tab is the visible panel — used to refresh the
   *  newest page on re-activation. */
  active: boolean;
  onOpenDiff: (target: DiffTarget) => void;
}

export interface FileBrowserProps {
  worktree: Worktree;
  status: WorktreeStatus;
  onOpenEditor: (absPath: string) => void;
  /** NEW: enables "Open diff" in the Files context menu (tracked entries only). */
  onOpenDiff?: (target: DiffTarget) => void;
  /** NEW: active-file highlight — abs path of the last file opened in the editor. */
  activeEditorPath?: string | null;
}

export interface FileChangeRowProps {
  path: string;
  origPath?: string | null;
  kind: FileChangeKind;
  insertions?: number | null;
  deletions?: number | null;
  /** Brighter filename — used for staged rows (matches the old styling). */
  emphasized?: boolean;
  title?: string;
  onOpen: () => void;
  onContextMenu?: (e: MouseEvent) => void;
}

export interface StatusLetterProps {
  kind: FileChangeKind;
}

/** Re-exported domain types so sidebar sub-modules can import from one
 *  place without reaching into the store/lib modules directly. */
export type { CommitFileChange, FileChange };

export interface DiscardConfirmDialogProps {
  target: { kind: "file"; file: string } | { kind: "all" } | null;
  worktreeName: string;
  unstagedCount: number;
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export interface AllTerminalsRowProps {
  projectSlug: string;
  projectName: string;
  isActive: boolean;
  counts: HarnessCounts;
}

export interface ResizeHandleProps {
  onChange: (width: number) => void;
  onCommit: (width: number) => void;
  onDragChange: (active: boolean) => void;
  getWidth: () => number;
}

export interface MainBranchPickerProps {
  projectSlug: string;
  anchor: { x: number; y: number };
  onClose: () => void;
}

export interface BranchListResult {
  branches: string[];
  current: string | null;
}
