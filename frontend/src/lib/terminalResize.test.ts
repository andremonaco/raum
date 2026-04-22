import { describe, expect, it } from "vitest";

import { isViewportAtBottom, shouldAutoStickToBottomOnResize } from "./terminalResize";

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
});
