import { describe, it, expect, vi } from "vitest";

// jsdom + gridstack often interact poorly (gridstack reaches for computed
// layout metrics that jsdom leaves as 0/NaN). We use the adapter's graceful
// fallback: if init throws, it returns null and callers skip the grid path.
//
// This test stubs GridStack.init to throw, then asserts `initGrid` returns
// null without re-raising.

vi.mock("gridstack", () => {
  class FakeGridStack {
    static init() {
      throw new Error("jsdom cannot measure layout");
    }
  }
  return { GridStack: FakeGridStack };
});

vi.mock("gridstack/dist/gridstack.min.css", () => ({}));

import { initGrid } from "./gridstackAdapter";

describe("gridstackAdapter", () => {
  it("returns null when GridStack.init throws", () => {
    const host = document.createElement("div");
    const handle = initGrid(host);
    expect(handle).toBeNull();
  });
});
