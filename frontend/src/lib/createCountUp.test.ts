import { describe, expect, it } from "vitest";

import { easeOutCubic, tweenValue } from "./createCountUp";

describe("easeOutCubic", () => {
  it("pins the endpoints", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it("clamps out-of-range progress", () => {
    expect(easeOutCubic(-2)).toBe(0);
    expect(easeOutCubic(5)).toBe(1);
  });

  it("eases out (past the midpoint by t=0.5)", () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});

describe("tweenValue", () => {
  it("returns the exact target once complete", () => {
    expect(tweenValue(0, 42, 1)).toBe(42);
    expect(tweenValue(0, 42, 1.4)).toBe(42);
  });

  it("starts at the from value", () => {
    expect(tweenValue(10, 90, 0)).toBe(10);
  });

  it("rounds intermediate frames to integers and moves toward the target", () => {
    const mid = tweenValue(0, 100, 0.5);
    expect(Number.isInteger(mid)).toBe(true);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
  });

  it("counts down as well as up", () => {
    const mid = tweenValue(100, 0, 0.5);
    expect(mid).toBeLessThan(100);
    expect(mid).toBeGreaterThan(0);
  });
});
