/**
 * Ultra-compact relative timestamps for the commit-history column:
 * "now", "5m", "3h", "2d", "3w", "6mo", "2y". `Intl.RelativeTimeFormat` is
 * deliberately not used — its shortest output ("5 min. ago") is still too
 * wide for a 9px trailing column.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** `nowMs` is injectable for deterministic tests. Future timestamps (clock
 *  skew between machines) clamp to "now". */
export function formatRelativeShort(unixSeconds: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d`;
  if (diff < MONTH) return `${Math.floor(diff / WEEK)}w`;
  if (diff < YEAR) {
    // 30-day months: 360–364 days computes as 12 — round that up to a year
    // instead of showing the awkward "12mo".
    const months = Math.floor(diff / MONTH);
    return months >= 12 ? "1y" : `${months}mo`;
  }
  return `${Math.floor(diff / YEAR)}y`;
}
