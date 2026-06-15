/**
 * Pure display helpers for per-file git status — letter/color mapping,
 * staged/unstaged partitioning, and path splitting for the dim-dir /
 * bright-name file rows. Kept free of JSX and Tauri imports so vitest can
 * cover every branch.
 */

import type { FileChange, FileChangeKind } from "../stores/worktreeStore";

/** Small colored monospace letter per change kind (VS Code-style column). */
export const STATUS_LETTER: Record<FileChangeKind, { letter: string; colorClass: string }> = {
  modified: { letter: "M", colorClass: "text-warning" },
  added: { letter: "A", colorClass: "text-success" },
  deleted: { letter: "D", colorClass: "text-destructive" },
  renamed: { letter: "R", colorClass: "text-info" },
  untracked: { letter: "U", colorClass: "text-success" },
  conflicted: { letter: "C", colorClass: "text-destructive" },
  typeChange: { letter: "T", colorClass: "text-warning" },
};

/** Partition status entries into the sidebar's two buckets, preserving git
 *  order within each. A path with both index and worktree changes arrives as
 *  two entries and lands in both buckets. */
export function splitChanges(changes: readonly FileChange[]): {
  staged: FileChange[];
  unstaged: FileChange[];
} {
  const staged: FileChange[] = [];
  const unstaged: FileChange[] = [];
  for (const change of changes) {
    (change.staged ? staged : unstaged).push(change);
  }
  return { staged, unstaged };
}

/** Split `dir/sub/name.ext` into `{ dir: "dir/sub", name: "name.ext" }`;
 *  root-level files get `dir: ""`. */
export function splitPath(path: string): { dir: string; name: string } {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash < 0) return { dir: "", name: path };
  return { dir: path.slice(0, lastSlash), name: path.slice(lastSlash + 1) };
}

/**
 * Index changes by path for badge lookup in the file browser. When a path
 * has both a staged and an unstaged entry, the unstaged one wins (it
 * reflects what's on disk right now). Renames are keyed by their *new* path
 * — the name that actually exists in the tree.
 */
export function changesByPath(changes: readonly FileChange[]): Map<string, FileChange> {
  const map = new Map<string, FileChange>();
  for (const change of changes) {
    const existing = map.get(change.path);
    if (!existing || (existing.staged && !change.staged)) {
      map.set(change.path, change);
    }
  }
  return map;
}
