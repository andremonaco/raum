import { describe, it, expect } from "vitest";

import { pasteModeForKind } from "./fileDrop";

describe("pasteModeForKind", () => {
  it("returns 'harness' for Claude Code", () => {
    expect(pasteModeForKind("claude-code")).toBe("harness");
  });

  it("returns 'harness' for Codex", () => {
    expect(pasteModeForKind("codex")).toBe("harness");
  });

  it("returns 'harness' for OpenCode", () => {
    expect(pasteModeForKind("opencode")).toBe("harness");
  });

  it("returns 'shell' for a shell pane", () => {
    expect(pasteModeForKind("shell")).toBe("shell");
  });

  it("returns 'shell' when the kind is unknown / missing", () => {
    expect(pasteModeForKind(undefined)).toBe("shell");
  });
});
