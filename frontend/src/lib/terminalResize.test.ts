import { describe, expect, it } from "vitest";

import {
  HARNESS_FORCE_RESIZE_SETTLE_MS,
  HARNESS_RESIZE_SETTLE_MS,
  isForcedResizeReason,
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

  it("only forces a backend sync for attach and recovery reasons", () => {
    expect(isForcedResizeReason("attach-sync")).toBe(true);
    expect(isForcedResizeReason("recovery-sync")).toBe(true);
    expect(isForcedResizeReason("show")).toBe(false);
    expect(isForcedResizeReason("geometry")).toBe(false);
    expect(isForcedResizeReason("geometry-commit")).toBe(false);
    expect(isForcedResizeReason("font")).toBe(false);
    expect(isForcedResizeReason("dpr")).toBe(false);
  });

  it("throttles shell resizes but debounces harness resizes until geometry settles", () => {
    expect(terminalResizeScheduleDelay("shell", "geometry", 10)).toBe(22);
    expect(terminalResizeScheduleDelay("claude-code", "geometry", 10)).toBe(
      HARNESS_RESIZE_SETTLE_MS,
    );
    expect(terminalResizeScheduleDelay("codex", "geometry", 1000)).toBe(HARNESS_RESIZE_SETTLE_MS);
    expect(terminalResizeScheduleDelay("opencode", "geometry", 1000)).toBe(
      HARNESS_RESIZE_SETTLE_MS,
    );
  });

  it("never puts the settle window in front of a one-shot resize", () => {
    // Showing, focusing, zooming and attaching are all one-shot: the geometry
    // stream that the settle window exists to damp is not running.
    for (const reason of ["show", "geometry-commit", "font", "dpr", "attach-sync"] as const) {
      expect(terminalResizeScheduleDelay("shell", reason, 10)).toBe(0);
      expect(terminalResizeScheduleDelay("claude-code", reason, 10)).toBe(
        HARNESS_FORCE_RESIZE_SETTLE_MS,
      );
    }
  });
});
