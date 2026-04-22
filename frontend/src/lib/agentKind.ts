/**
 * Mirror of `raum_core::agent::AgentKind` for the webview. Serde serializes
 * the Rust enum as kebab-case, so the string literals must stay in sync.
 */
export type AgentKind = "shell" | "claude-code" | "codex" | "opencode";

/** Short human-readable label for each harness kind. Used in tab-strip
 *  synthesis so panes read as "Claude · raum/dev" instead of the raw
 *  kebab-case kind or tmux's thin `#{window_name}` ("Claude Code" / "node"). */
export function kindDisplayLabel(kind: AgentKind): string {
  switch (kind) {
    case "claude-code":
      return "Claude";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "shell":
      return "Shell";
  }
}
