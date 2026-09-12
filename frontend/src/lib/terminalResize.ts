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

/**
 * Why a resize was requested. The reason replaces the old ambiguous `force`
 * boolean, which conflated two unrelated questions: "may this skip the harness
 * settle window?" and "must tmux be told even though nothing moved?".
 *
 *  - `show`            — a hidden view came back; geometry is only re-checked.
 *  - `geometry`        — a live stream of host size changes (window/divider drag).
 *  - `geometry-commit` — the end of such a stream (pointerup); nothing more is
 *                        coming, so it must not sit behind the settle window.
 *  - `font` / `dpr`    — cell metrics changed under an unchanged host box.
 *  - `attach-sync` / `recovery-sync` — the backend PTY was just (re)created and
 *                        must be told our dimensions even if xterm's are unchanged.
 */
export type ResizeReason =
  | "show"
  | "geometry"
  | "geometry-commit"
  | "font"
  | "dpr"
  | "attach-sync"
  | "recovery-sync";

/** Only these two dispatch a backend `terminal_resize` at unchanged rows/cols. */
export function isForcedResizeReason(reason: ResizeReason): boolean {
  return reason === "attach-sync" || reason === "recovery-sync";
}

export function terminalResizeScheduleDelay(
  kind: AgentKind,
  reason: ResizeReason,
  elapsedSinceLastDispatchMs: number,
): number {
  // Only an in-progress geometry stream waits out the settle window — a TUI
  // repainting on every intermediate drag frame is the cost that buys. Every
  // other reason is one-shot, so the delay must never sit in front of a view
  // becoming usable.
  const settling = reason === "geometry";
  if (kind !== "shell") {
    return settling ? HARNESS_RESIZE_SETTLE_MS : HARNESS_FORCE_RESIZE_SETTLE_MS;
  }
  return settling ? Math.max(0, TERMINAL_RESIZE_THROTTLE_MS - elapsedSinceLastDispatchMs) : 0;
}
