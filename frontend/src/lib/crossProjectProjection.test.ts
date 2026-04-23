import { describe, expect, it, beforeEach } from "vitest";

import {
  __crossProjectProjectionCacheSizeForTests,
  __resetCrossProjectProjectionCacheForTests,
  getCrossProjectProjection,
  setCrossProjectProjectionCacheMaxSize,
} from "./crossProjectProjection";

describe("crossProjectProjection cache", () => {
  beforeEach(() => {
    __resetCrossProjectProjectionCacheForTests();
  });

  it("returns identical objects for repeated calls on unchanged ordered ids", () => {
    const first = getCrossProjectProjection({
      mode: "working",
      orderedIds: ["a", "b", "c"],
    });
    const second = getCrossProjectProjection({
      mode: "working",
      orderedIds: ["a", "b", "c"],
    });

    expect(second).toBe(first);
    expect([...second.rects.keys()]).toEqual(["a", "b", "c"]);
  });

  it("misses the cache when either mode or order changes", () => {
    const first = getCrossProjectProjection({
      mode: "working",
      orderedIds: ["a", "b", "c"],
    });
    const second = getCrossProjectProjection({
      mode: "recent",
      orderedIds: ["a", "b", "c"],
    });
    const third = getCrossProjectProjection({
      mode: "working",
      orderedIds: ["c", "b", "a"],
    });

    expect(second).not.toBe(first);
    expect(third).not.toBe(first);
  });

  it("enforces the configured max size via LRU eviction", () => {
    setCrossProjectProjectionCacheMaxSize(4);

    getCrossProjectProjection({ mode: "working", orderedIds: ["a"] });
    getCrossProjectProjection({ mode: "working", orderedIds: ["b"] });
    getCrossProjectProjection({ mode: "working", orderedIds: ["c"] });
    getCrossProjectProjection({ mode: "working", orderedIds: ["d"] });

    expect(__crossProjectProjectionCacheSizeForTests()).toBeLessThanOrEqual(4);

    getCrossProjectProjection({ mode: "working", orderedIds: ["e"] });

    expect(__crossProjectProjectionCacheSizeForTests()).toBeLessThanOrEqual(4);
  });
});
