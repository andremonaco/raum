import type { AgentKind } from "./agentKind";

export const TERMINAL_RESIZE_THROTTLE_MS = 32;
export const HARNESS_RESIZE_SETTLE_MS = 180;
export const HARNESS_FORCE_RESIZE_SETTLE_MS = 80;

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

export function terminalResizeScheduleDelay(
  kind: AgentKind,
  force: boolean,
  elapsedSinceLastDispatchMs: number,
): number {
  if (kind !== "shell") {
    return force ? HARNESS_FORCE_RESIZE_SETTLE_MS : HARNESS_RESIZE_SETTLE_MS;
  }
  return force ? 0 : Math.max(0, TERMINAL_RESIZE_THROTTLE_MS - elapsedSinceLastDispatchMs);
}
