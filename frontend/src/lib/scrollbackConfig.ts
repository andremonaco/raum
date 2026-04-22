/**
 * xterm.js scrollback bounds + normalization for user-supplied values.
 *
 * Raum's scrollback lives entirely in xterm.js now — tmux's `history-limit`
 * is only a defense-in-depth cushion for manual `tmux attach` debugging.
 */

export const SCROLLBACK_MIN = 100;
export const SCROLLBACK_MAX = 10_000;
export const SCROLLBACK_DEFAULT = 10_000;

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
