/**
 * §9 — shared prop and value types for the sidebar module folder. Everything
 * here is pure-data so it can be imported from any sub-module without
 * triggering JSX/runtime cycles.
 */

import type { ProjectListItem } from "../../stores/projectStore";
import type {
  FileChange,
  FileChangeKind,
  Worktree,
  WorktreeStatus,
} from "../../stores/worktreeStore";
import type { CommitFileChange } from "./git-commands";

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

export interface WorktreeRowProps {
  worktree: Worktree;
  projectSlug: string;
  isActive: boolean;
  projectColor?: string;
  projectSigil?: string;
  /** True when this worktree is the project root (set at project creation). */
  isMain: boolean;
  /**
   * Branch of the project's main worktree — best-effort "sprouted from"
   * fallback for additional worktrees created before raum started persisting
   * `branch.<name>.raumBase` (or whose upstream is unset).
   */
  mainBranchFallback: string | null;
  /** Called when the user clicks the row-level delete icon. */
  onRequestDelete: () => void;
  /**
   * Called when the user clicks the row-level merge icon.
   * `null` for main worktrees (no merge target — they ARE the target).
   */
  onRequestMerge?: () => void;
}

/** What the diff-viewer modal should show: a working-tree diff (staged or
 *  unstaged side) or a file's diff within one commit. */
export type DiffTarget =
  | { mode: "worktree"; file: string; staged: boolean }
  | { mode: "commit"; file: string; hash: string; shortHash: string };

export type ExpandedTabId = "changes" | "history" | "files";

export interface SegmentedSwitcherProps {
  tabs: readonly { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}

export interface WorktreeExpandedProps {
  worktree: Worktree;
  projectSlug: string;
  status: WorktreeStatus;
  /** True until the first status (push or fetch) lands for this path. */
  statusPending: boolean;
  onOpenDiff: (target: DiffTarget) => void;
  onOpenEditor: (absPath: string) => void;
}

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
  isActive: boolean;
  counts: HarnessCounts;
}

export interface ProjectSectionProps {
  project: ProjectListItem;
  worktreeFilter: string;
  /** When true, this section should open the create-worktree modal. */
  createOpen: boolean;
  /** Called when the modal closes or a worktree is created. */
  onCreateClose: () => void;
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
