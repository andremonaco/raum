import type { AgentKind } from "./agentKind";

interface ViewportLike {
  baseY: number;
  viewportY: number;
}

interface TerminalLike {
  buffer: {
    active: ViewportLike;
  };
}

export function shouldAutoStickToBottomOnResize(kind: AgentKind): boolean {
  return kind === "opencode";
}

export function isViewportAtBottom(terminal: TerminalLike | null | undefined): boolean {
  if (!terminal) return false;
  const { active } = terminal.buffer;
  return active.viewportY >= active.baseY;
}
