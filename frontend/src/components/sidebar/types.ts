/**
 * §9 — shared prop and value types for the sidebar module folder. Everything
 * here is pure-data so it can be imported from any sub-module without
 * triggering JSX/runtime cycles.
 */

import type { ProjectListItem } from "../../stores/projectStore";
import type { Worktree } from "../../stores/worktreeStore";

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
