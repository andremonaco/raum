import { describe, expect, it } from "vitest";

import { permissionSummary } from "./permissionSummary";

describe("permissionSummary", () => {
  it("reads the shell command from a Claude Code payload", () => {
    expect(
      permissionSummary("claude-code", {
        tool_name: "Bash",
        tool_input: { command: "rm -rf node_modules\necho done", description: "cleanup" },
      }),
    ).toEqual({ tool: "Bash", head: "rm -rf node_modules" });

    expect(
      permissionSummary("claude-code", {
        tool_name: "Edit",
        tool_input: { file_path: "/repo/src/main.rs", old_string: "a", new_string: "b" },
      }),
    ).toEqual({ tool: "Edit", head: "/repo/src/main.rs" });
  });

  it("pulls the touched file out of a Codex apply_patch blob", () => {
    expect(
      permissionSummary("codex", {
        tool_name: "apply_patch",
        tool_input: {
          command: "*** Begin Patch\n*** Update File: crates/raum-core/src/lib.rs\n@@\n-a\n+b\n",
        },
      }),
    ).toEqual({ tool: "apply_patch", head: "crates/raum-core/src/lib.rs" });

    expect(
      permissionSummary("codex", {
        tool_name: "Bash",
        tool_input: { command: "cargo test", description: "network-access https://x" },
      }),
    ).toEqual({ tool: "Bash", head: "cargo test" });
  });

  it("composes an OpenCode summary from permission + metadata", () => {
    expect(
      permissionSummary("opencode", {
        id: "per_1",
        permission: "bash",
        patterns: ["rm *"],
        metadata: { command: "rm -f /tmp/x" },
      }),
    ).toEqual({ tool: "bash", head: "rm -f /tmp/x" });

    // `metadata` is `{}` for read/glob/grep — fall back to the patterns.
    expect(
      permissionSummary("opencode", {
        permission: "read",
        patterns: ["/etc/hosts"],
        metadata: {},
      }),
    ).toEqual({ tool: "read", head: "/etc/hosts" });
  });

  it("never throws on malformed payloads", () => {
    const fallback = { tool: "permission", head: "" };
    expect(permissionSummary("claude-code", null)).toEqual(fallback);
    expect(permissionSummary("claude-code", undefined)).toEqual(fallback);
    expect(permissionSummary("", {})).toEqual(fallback);
    expect(permissionSummary("codex", { tool_name: 42, tool_input: "nope" } as never)).toEqual(
      fallback,
    );
    expect(
      permissionSummary("opencode", { permission: "bash", metadata: null, patterns: "not-array" }),
    ).toEqual({ tool: "bash", head: "" });
  });

  it("truncates a long head to 80 chars", () => {
    const { head } = permissionSummary("claude-code", {
      tool_name: "Bash",
      tool_input: { command: "x".repeat(200) },
    });
    expect(head).toHaveLength(80);
    expect(head.endsWith("…")).toBe(true);
  });
});
