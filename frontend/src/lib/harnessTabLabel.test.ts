import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

import {
  __resetRuntimeLayoutForTests,
  LAYOUT_UNIT,
  setRuntimeLayout,
  setTabAutoLabel,
  setTabLabel,
  type RuntimeCell,
} from "../stores/runtimeLayoutStore";
import { __resetTerminalStoreForTests, upsertTerminal } from "../stores/terminalStore";
import { resolveSessionTabLabel } from "./harnessTabLabel";

function cellWith(id: string, tabId: string, sessionId: string): RuntimeCell {
  return {
    id,
    x: 0,
    y: 0,
    w: LAYOUT_UNIT,
    h: LAYOUT_UNIT,
    kind: "claude-code",
    tabs: [{ id: tabId, sessionId }],
    activeTabId: tabId,
  };
}

describe("resolveSessionTabLabel", () => {
  beforeEach(() => {
    __resetRuntimeLayoutForTests();
    __resetTerminalStoreForTests();
  });

  it("prefers the user-chosen tab label", () => {
    setRuntimeLayout([cellWith("pane-1", "tab-1", "session-A")]);
    setTabAutoLabel("pane-1", "tab-1", "auto-from-tmux");
    setTabLabel("pane-1", "tab-1", "Add new feature");

    expect(resolveSessionTabLabel("session-A")).toBe("Add new feature");
  });

  it("falls back to the autoLabel when no user label is set", () => {
    setRuntimeLayout([cellWith("pane-1", "tab-1", "session-A")]);
    setTabAutoLabel("pane-1", "tab-1", "auto-from-tmux");

    expect(resolveSessionTabLabel("session-A")).toBe("auto-from-tmux");
  });

  it("falls back to paneContext-derived label when the session isn't in the layout", () => {
    upsertTerminal({
      session_id: "session-detached",
      project_slug: "alpha",
      worktree_id: "/tmp/alpha",
      kind: "claude-code",
      created_unix: 1,
    });
    // The terminal record exists but has no paneContext — resolver should
    // still produce a sensible last-resort label instead of the session id.
    const label = resolveSessionTabLabel("session-detached");
    expect(label).not.toBe("session-detached");
    expect(label.length).toBeGreaterThan(0);
  });

  it("returns a kind-display fallback for unknown sessions", () => {
    expect(resolveSessionTabLabel("ghost")).not.toBe("ghost");
    expect(resolveSessionTabLabel("ghost").length).toBeGreaterThan(0);
  });
});
