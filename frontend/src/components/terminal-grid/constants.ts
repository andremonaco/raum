export const KIND_LABELS: Record<string, string> = {
  shell: "Shell",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  empty: "Empty",
};

export const SHELL_IDLE_COMMANDS = new Set(["zsh", "bash", "fish", "sh", "-zsh", "-bash"]);
