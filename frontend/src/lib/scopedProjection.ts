/**
 * Scoped projection cache — memoises `pruneTreeByScope` + `projectToRects`
 * so revisiting a project tab or a worktree scope on an unchanged layout
 * is a single map lookup instead of two full tree walks.
 *
 * The cache key is `(layoutRev, slug, scope, mainPath)`:
 *  - `layoutRev` is bumped inside `rebuildCells()` in `runtimeLayoutStore.ts`
 *    after any real tree or pane mutation, so entries from earlier revs
 *    are structurally stale and never reused (they may still live in the
 *    map until LRU eviction — the key change alone is enough to miss).
 *  - `slug` / `scope` / `mainPath` are the three inputs to
 *    `pruneTreeByScope` that vary with the sidebar / tab state.
 *
 * Size is capped dynamically at `max(16, projects * 2)` so users with
 * many projects don't thrash, and an LRU policy evicts the oldest entry
 * when we exceed the cap. True LRU is maintained by re-inserting on hit.
 */

import { LAYOUT_UNIT, pruneTreeByScope } from "../stores/runtimeLayoutStore";
import type { PaneContent } from "../stores/runtimeLayoutStore";
import type { WorktreeScope } from "../stores/worktreeStore";
import { projectToRects, type LayoutNode, type Rect } from "./layoutTree";

export interface ScopedProjection {
  readonly tree: LayoutNode | null;
  readonly rects: ReadonlyMap<string, Rect>;
}

const EMPTY_RECT_MAP: ReadonlyMap<string, Rect> = new Map();
const cache = new Map<string, ScopedProjection>();
let configuredMaxSize = 16;

function scopeKey(scope: WorktreeScope): string {
  return scope.mode === "all" ? "*" : `w:${scope.path}`;
}

export function setProjectionCacheMaxSize(size: number): void {
  configuredMaxSize = Math.max(4, size);
  evictAsNeeded();
}

function evictAsNeeded(): void {
  while (cache.size > configuredMaxSize) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }
}

export function getScopedProjection(params: {
  layoutRev: number;
  tree: LayoutNode | null;
  panes: Record<string, PaneContent>;
  slug: string | undefined;
  scope: WorktreeScope;
  mainPath: string | undefined;
}): ScopedProjection {
  const key = `${params.layoutRev}|${params.slug ?? ""}|${scopeKey(params.scope)}|${params.mainPath ?? ""}`;
  const hit = cache.get(key);
  if (hit) {
    // Refresh insertion order so LRU eviction targets the truly oldest
    // entry on the next miss.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const pruned = pruneTreeByScope(
    params.tree,
    params.slug,
    params.scope,
    params.panes,
    params.mainPath,
  );
  const rects: ReadonlyMap<string, Rect> = pruned
    ? new Map(projectToRects(pruned, LAYOUT_UNIT).map((r) => [r.id, r]))
    : EMPTY_RECT_MAP;
  const entry: ScopedProjection = { tree: pruned, rects };
  cache.set(key, entry);
  evictAsNeeded();
  return entry;
}

export function __resetProjectionCacheForTests(): void {
  cache.clear();
  configuredMaxSize = 16;
}

export function __projectionCacheSizeForTests(): number {
  return cache.size;
}
