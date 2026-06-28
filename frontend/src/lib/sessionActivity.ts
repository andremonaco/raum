/**
 * Per-session "last interacted" timestamps (epoch ms), kept in a reactive map.
 *
 * The inactivity auto-dock (`stores/terminalAutoDock`) needs a per-tab "used"
 * signal. The backend already gives it two restart-safe floors per session —
 * `lastPrompt.submittedAtMs` (a prompt typed + sent) and `created_unix` (birth
 * time) — but neither captures "the user just focused this shell to type in it".
 * This module supplies that missing piece: the auto-dock driver stamps a
 * session here whenever its tab becomes the focused pane's active tab, so plain
 * shells (which emit no prompt events) still count as used while they're being
 * looked at.
 *
 * Deliberately dependency-free (no store imports) so it can be read by the
 * driver and written from focus sites without an import cycle — the same
 * isolation rationale `stores/projectVisibility` documents. Not persisted:
 * after a restart, harnesses fall back to their backend timestamps and shells
 * to their creation time, which the user accepted as the cost of avoiding new
 * backend activity plumbing.
 */

import { createSignal } from "solid-js";

const [stamps, setStamps] = createSignal<ReadonlyMap<string, number>>(new Map());

/** Record that `sessionId` was just interacted with (now). */
export function markSessionActive(sessionId: string, atMs: number): void {
  if (!sessionId) return;
  const prev = stamps();
  if ((prev.get(sessionId) ?? 0) >= atMs) return;
  const next = new Map(prev);
  next.set(sessionId, atMs);
  setStamps(next);
}

/** The last time `sessionId` was interacted with via this channel, or 0. */
export function sessionLastActiveMs(sessionId: string): number {
  return stamps().get(sessionId) ?? 0;
}

/** Reset the map — keeps the shared signal from bleeding across test cases. */
export function __resetSessionActivityForTests(): void {
  setStamps(new Map());
}
