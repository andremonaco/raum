/**
 * Pure model helpers for the per-worktree file browser. The backend
 * (`worktree_list_dir`) returns unsorted entries with `.git` already
 * hidden; sorting (and a defensive re-filter) happens here so it's unit
 * testable.
 */

/** One entry of a lazily-expanded directory level (`worktree_list_dir`). */
export interface DirEntry {
  name: string;
  /** Worktree-root-relative path, forward-slashed. */
  relPath: string;
  isDir: boolean;
}

/** Directories first, then case-insensitive natural-numeric name order
 *  within each group. Defensively drops `.git` even though the backend
 *  already filters it. */
export function sortDirEntries(entries: readonly DirEntry[]): DirEntry[] {
  return entries
    .filter((entry) => entry.name !== ".git")
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    });
}
