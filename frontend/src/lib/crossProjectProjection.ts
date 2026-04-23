import { LAYOUT_UNIT } from "../stores/runtimeLayoutStore";
import { projectToRects, tileLeaves, type LayoutNode, type Rect } from "./layoutTree";

export interface CrossProjectProjection {
  readonly tree: LayoutNode | null;
  readonly rects: ReadonlyMap<string, Rect>;
}

const EMPTY_RECT_MAP: ReadonlyMap<string, Rect> = new Map();
const cache = new Map<string, CrossProjectProjection>();
let configuredMaxSize = 16;

export function setCrossProjectProjectionCacheMaxSize(size: number): void {
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

export function getCrossProjectProjection(params: {
  mode: string;
  orderedIds: readonly string[];
}): CrossProjectProjection {
  const key = `${params.mode}|${params.orderedIds.join("\u0001")}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const tree = tileLeaves([...params.orderedIds]);
  const rects: ReadonlyMap<string, Rect> = tree
    ? new Map(projectToRects(tree, LAYOUT_UNIT).map((rect) => [rect.id, rect]))
    : EMPTY_RECT_MAP;
  const entry: CrossProjectProjection = { tree, rects };
  cache.set(key, entry);
  evictAsNeeded();
  return entry;
}

export function __resetCrossProjectProjectionCacheForTests(): void {
  cache.clear();
  configuredMaxSize = 16;
}

export function __crossProjectProjectionCacheSizeForTests(): number {
  return cache.size;
}
