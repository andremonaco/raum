import { describe, expect, it } from "vitest";

import {
  HARNESS_FORCE_RESIZE_SETTLE_MS,
  HARNESS_RESIZE_SETTLE_MS,
  isViewportAtBottom,
  shouldAutoStickToBottomOnResize,
  terminalResizeScheduleDelay,
} from "./terminalResize";

describe("terminalResize", () => {
  it("only auto-sticks OpenCode panes on resize", () => {
    expect(shouldAutoStickToBottomOnResize("opencode")).toBe(true);
    expect(shouldAutoStickToBottomOnResize("claude-code")).toBe(false);
    expect(shouldAutoStickToBottomOnResize("codex")).toBe(false);
    expect(shouldAutoStickToBottomOnResize("shell")).toBe(false);
  });

  it("detects whether the viewport is already at the buffer tail", () => {
    expect(
      isViewportAtBottom({
        buffer: { active: { baseY: 42, viewportY: 42 } },
      }),
    ).toBe(true);
    expect(
      isViewportAtBottom({
        buffer: { active: { baseY: 42, viewportY: 40 } },
      }),
    ).toBe(false);
  });

  it("treats missing terminals as not anchored to the tail", () => {
    expect(isViewportAtBottom(null)).toBe(false);
    expect(isViewportAtBottom(undefined)).toBe(false);
  });

  it("throttles shell resizes but debounces harness resizes until geometry settles", () => {
    expect(terminalResizeScheduleDelay("shell", false, 10)).toBe(22);
    expect(terminalResizeScheduleDelay("shell", true, 10)).toBe(0);
    expect(terminalResizeScheduleDelay("claude-code", false, 10)).toBe(HARNESS_RESIZE_SETTLE_MS);
    expect(terminalResizeScheduleDelay("claude-code", true, 10)).toBe(
      HARNESS_FORCE_RESIZE_SETTLE_MS,
    );
    expect(terminalResizeScheduleDelay("codex", false, 1000)).toBe(HARNESS_RESIZE_SETTLE_MS);
    expect(terminalResizeScheduleDelay("opencode", false, 1000)).toBe(HARNESS_RESIZE_SETTLE_MS);
  });
});
