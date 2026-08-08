/**
 * xterm.js scrollback bounds + normalization for user-supplied values.
 *
 * Raum's scrollback lives entirely in xterm.js now — tmux's `history-limit`
 * is only a defense-in-depth cushion for manual `tmux attach` debugging.
 */

export const SCROLLBACK_MIN = 100;
export const SCROLLBACK_MAX = 100_000;
export const SCROLLBACK_DEFAULT = 100_000;
/** Shells are interactive, not transcript stores — 100k retained lines per
 *  shell pane is pure resident memory nobody scrolls back through. */
export const SCROLLBACK_SHELL_DEFAULT = 10_000;

/** Scrollback a freshly-created pane of `kind` should hold.
 *  // ponytail: per-kind constants; route a user setting through
 *  `normalizeScrollbackLines` here once config exposes one. */
export function scrollbackForKind(kind: string): number {
  return normalizeScrollbackLines(kind === "shell" ? SCROLLBACK_SHELL_DEFAULT : SCROLLBACK_DEFAULT);
}

/**
 * Coerce an arbitrary value into a valid scrollback line count.
 *
 * - Non-finite / non-numeric input → `SCROLLBACK_DEFAULT`.
 * - `-1` or `0` → `SCROLLBACK_MAX` (convention: "unlimited" caps to the max).
 * - Out-of-range values are clamped to `[SCROLLBACK_MIN, SCROLLBACK_MAX]`.
 */
export function normalizeScrollbackLines(value: unknown): number {
  const coerced =
    typeof value === "string" && value.trim() !== "" ? Number(value) : (value as number);

  if (!Number.isFinite(coerced)) {
    return SCROLLBACK_DEFAULT;
  }

  const intValue = Math.trunc(coerced);

  if (intValue === -1 || intValue === 0) {
    return SCROLLBACK_MAX;
  }

  if (intValue < SCROLLBACK_MIN) {
    return SCROLLBACK_MIN;
  }

  if (intValue > SCROLLBACK_MAX) {
    return SCROLLBACK_MAX;
  }

  return intValue;
}
