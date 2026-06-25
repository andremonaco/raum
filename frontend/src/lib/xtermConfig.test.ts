import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clampFontSize,
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  nudgeTerminalFontSize,
  resetTerminalFontSize,
  setTerminalFontSize,
  terminalFontSize,
} from "./xtermConfig";

describe("clampFontSize", () => {
  it("clamps below the minimum", () => {
    expect(clampFontSize(MIN_FONT_SIZE - 4)).toBe(MIN_FONT_SIZE);
  });

  it("clamps above the maximum", () => {
    expect(clampFontSize(MAX_FONT_SIZE + 10)).toBe(MAX_FONT_SIZE);
  });

  it("rounds fractional sizes", () => {
    expect(clampFontSize(13.6)).toBe(14);
  });

  it("falls back to the default for non-finite input", () => {
    // NaN and ±Infinity are not finite, so they reset to the default rather
    // than clamping to a bound (a non-finite size can't be meaningfully clamped).
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_FONT_SIZE);
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_FONT_SIZE);
  });
});

describe("terminal font zoom store", () => {
  beforeEach(() => {
    try {
      localStorage.removeItem("raum.terminal.fontSize");
    } catch {
      /* jsdom always has localStorage; ignore otherwise */
    }
    resetTerminalFontSize();
  });

  afterEach(() => {
    resetTerminalFontSize();
  });

  it("resets to the default", () => {
    setTerminalFontSize(20);
    expect(terminalFontSize()).toBe(20);
    resetTerminalFontSize();
    expect(terminalFontSize()).toBe(DEFAULT_FONT_SIZE);
  });

  it("nudges up and down within bounds", () => {
    setTerminalFontSize(13);
    expect(nudgeTerminalFontSize(2)).toBe(15);
    expect(terminalFontSize()).toBe(15);
    expect(nudgeTerminalFontSize(-2)).toBe(13);
  });

  it("never zooms past the supported range", () => {
    setTerminalFontSize(MAX_FONT_SIZE);
    expect(nudgeTerminalFontSize(10)).toBe(MAX_FONT_SIZE);
    setTerminalFontSize(MIN_FONT_SIZE);
    expect(nudgeTerminalFontSize(-10)).toBe(MIN_FONT_SIZE);
  });

  it("persists the level to localStorage", () => {
    setTerminalFontSize(18);
    expect(localStorage.getItem("raum.terminal.fontSize")).toBe("18");
  });
});
