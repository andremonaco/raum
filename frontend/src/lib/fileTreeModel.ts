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

// ---------------------------------------------------------------------------
// Name filter
// ---------------------------------------------------------------------------

/** Loaded directory levels, keyed by the relative path passed to
 *  `worktree_list_dir` (`""` is the worktree root). Only expanded directories
 *  are present — the filter is deliberately scoped to what's been fetched;
 *  project-wide file search is the spotlight dock's job. */
export type DirCache = ReadonlyMap<string, readonly DirEntry[]>;

export interface FilterResult {
  /** Relative paths that should render. */
  visible: Set<string>;
  /** Directories to force open because a descendant matched. */
  autoExpand: Set<string>;
  /** Files whose NAME matched the filter. Deliberately not `visible.size`: a
   *  matched directory drags its whole loaded subtree into `visible` so the
   *  user can look inside it, and counting those would report hits that
   *  aren't hits. Computed here so the caller doesn't re-walk the cache. */
  fileMatchCount: number;
}

/** Case-insensitive substring match. An empty filter matches everything. */
export function matchesFilter(name: string, filter: string): boolean {
  if (filter.length === 0) return true;
  return name.toLowerCase().includes(filter.toLowerCase());
}

/**
 * Resolve which loaded entries survive `filter`.
 *
 * A file is visible when its name matches. A directory is visible when its own
 * name matches — in which case its whole loaded subtree comes along, so the
 * user can look inside a hit folder — or when some loaded descendant matches,
 * in which case it also auto-expands so the hit isn't buried.
 */
export function filterTree(cache: DirCache, filter: string): FilterResult {
  const visible = new Set<string>();
  const autoExpand = new Set<string>();
  let fileMatchCount = 0;
  if (filter.length === 0) return { visible, autoExpand, fileMatchCount };

  // Defensive: a symlinked directory could otherwise recurse forever. Two sets,
  // not one with prefixed keys — colons are legal in filenames, so a prefixed
  // key could collide with a real path.
  const walked = new Set<string>();
  const marked = new Set<string>();

  const markSubtree = (dirRel: string): void => {
    if (marked.has(dirRel)) return;
    marked.add(dirRel);
    for (const entry of cache.get(dirRel) ?? []) {
      visible.add(entry.relPath);
      if (entry.isDir) markSubtree(entry.relPath);
    }
  };

  const walk = (dirRel: string): boolean => {
    if (walked.has(dirRel)) return false;
    walked.add(dirRel);
    let hit = false;
    for (const entry of cache.get(dirRel) ?? []) {
      if (!entry.isDir) {
        if (matchesFilter(entry.name, filter)) {
          visible.add(entry.relPath);
          fileMatchCount += 1;
          hit = true;
        }
        continue;
      }
      const descendantHit = walk(entry.relPath);
      const selfHit = matchesFilter(entry.name, filter);
      if (descendantHit) autoExpand.add(entry.relPath);
      if (selfHit) markSubtree(entry.relPath);
      if (descendantHit || selfHit) {
        visible.add(entry.relPath);
        hit = true;
      }
    }
    return hit;
  };

  walk("");
  return { visible, autoExpand, fileMatchCount };
}
