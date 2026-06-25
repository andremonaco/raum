import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WINDOW_RESIZE_ACTIVE_CLASS, installWindowResizeClass } from "./gridResizeClass";

describe("installWindowResizeClass", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    vi.useRealTimers();
    root.remove();
  });

  it("adds the class on resize and removes it after the idle debounce", () => {
    const teardown = installWindowResizeClass(() => root);
    window.dispatchEvent(new Event("resize"));
    expect(root.classList.contains(WINDOW_RESIZE_ACTIVE_CLASS)).toBe(true);

    // Still resizing within the idle window → class stays on.
    vi.advanceTimersByTime(100);
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(100);
    expect(root.classList.contains(WINDOW_RESIZE_ACTIVE_CLASS)).toBe(true);

    // Past the idle gap with no further events → class clears.
    vi.advanceTimersByTime(200);
    expect(root.classList.contains(WINDOW_RESIZE_ACTIVE_CLASS)).toBe(false);
    teardown();
  });

  it("teardown removes the listener and strips the class", () => {
    const teardown = installWindowResizeClass(() => root);
    window.dispatchEvent(new Event("resize"));
    expect(root.classList.contains(WINDOW_RESIZE_ACTIVE_CLASS)).toBe(true);
    teardown();
    expect(root.classList.contains(WINDOW_RESIZE_ACTIVE_CLASS)).toBe(false);
    // A resize after teardown is a no-op.
    window.dispatchEvent(new Event("resize"));
    expect(root.classList.contains(WINDOW_RESIZE_ACTIVE_CLASS)).toBe(false);
  });

  it("tolerates a null root without throwing", () => {
    const teardown = installWindowResizeClass(() => null);
    expect(() => window.dispatchEvent(new Event("resize"))).not.toThrow();
    teardown();
  });
});
