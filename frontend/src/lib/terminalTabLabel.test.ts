import { describe, expect, it } from "vitest";

import { resolveDisplayedTabLabel, resolveHarnessAutoLabel } from "./terminalTabLabel";

describe("terminalTabLabel", () => {
  it("prefers a rich pane title for harness tabs", () => {
    expect(
      resolveHarnessAutoLabel({
        kind: "codex",
        paneTitle: "Investigating test flake",
        windowName: "node",
        currentCommand: "node",
        fallbackLabel: "Codex · raum/dev",
      }),
    ).toBe("Investigating test flake");
  });

  it("falls back to the window name when the pane title is just the current command", () => {
    expect(
      resolveHarnessAutoLabel({
        kind: "codex",
        paneTitle: "node",
        windowName: "checkout-fix",
        currentCommand: "node",
        fallbackLabel: "Codex · raum/dev",
      }),
    ).toBe("checkout-fix");
  });

  it("falls back to the synthetic label when tmux only exposes generic titles", () => {
    expect(
      resolveHarnessAutoLabel({
        kind: "claude-code",
        paneTitle: "",
        windowName: "2.1.114",
        currentCommand: "2.1.114",
        fallbackLabel: "Claude · raum/dev",
      }),
    ).toBe("Claude · raum/dev");
  });

  it("lets manual labels override auto labels", () => {
    expect(
      resolveDisplayedTabLabel({
        label: "Planner",
        autoLabel: "Investigating test flake",
      }),
    ).toBe("Planner");
  });

  it("normalizes whitespace before exposing a label", () => {
    expect(
      resolveDisplayedTabLabel({
        autoLabel: "  Investigating\tflake\n",
      }),
    ).toBe("Investigating flake");
  });
});
