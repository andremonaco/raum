/**
 * Mirror of `raum_core::agent::AgentKind` for the webview. Serde serializes
 * the Rust enum as kebab-case, so the string literals must stay in sync.
 */
export type AgentKind = "shell" | "claude-code" | "codex" | "opencode";
