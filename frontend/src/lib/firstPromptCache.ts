/**
 * Lazy cache for the *first* user prompt of a session, used by the
 * cross-harness review snap overlay to show the original task the
 * reviewed harness was assigned.
 *
 * The backend stores every UserPromptSubmit append-only at
 * `~/.config/raum/state/sessions/<id>/prompts.jsonl`; the
 * `session_first_prompt` Tauri command returns the head of that log.
 *
 * Why lazy: the first prompt is only needed during a drag-and-snap
 * gesture, so paying a Tauri call per session at startup would be
 * wasteful. We fetch on first request, cache forever (the *first*
 * prompt of a session is immutable once recorded — it can never
 * change). Sessions with no recorded first prompt cache as `null` so
 * we don't keep retrying.
 *
 * The cache lives outside `terminalStore` because:
 *   1. It's review-feature-specific.
 *   2. Mixing a lazy/maybe-undefined field into the central terminal
 *      record would force every consumer to handle the loading state.
 */

import { createRoot, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

/** `string` = prompt text. `null` = backend confirmed no prompt logged.
 *  Absence from the map = not yet fetched. */
type CachedFirstPrompt = string | null;

const { state, setState } = createRoot(() => {
  const [state, setState] = createSignal<Record<string, CachedFirstPrompt>>({});
  return { state, setState };
});

/** Session ids whose `session_first_prompt` invoke is in flight. Prevents
 *  duplicate fetches when the snap overlay re-renders mid-load. */
const inFlight = new Set<string>();

/**
 * Reactive read. Returns:
 *   - `string` when a first prompt has been loaded.
 *   - `null` when the backend confirmed the log is empty.
 *   - `undefined` when not yet fetched (caller should still show
 *     fallback UI; `ensureFirstPromptLoaded` will populate later).
 */
export function firstPromptForSession(
  sessionId: string | null | undefined,
): string | null | undefined {
  if (!sessionId) return undefined;
  return state()[sessionId];
}

/**
 * Kick off a lazy fetch for `sessionId` if not already cached and not
 * already in flight. Idempotent. The cache populates via the reactive
 * signal so any consumer reading `firstPromptForSession` will re-render
 * once the fetch lands.
 */
export function ensureFirstPromptLoaded(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  if (sessionId in state()) return;
  if (inFlight.has(sessionId)) return;
  inFlight.add(sessionId);
  void invoke<string | null>("session_first_prompt", { args: { sessionId } })
    .then((text) => {
      setState((prev) => ({ ...prev, [sessionId]: text }));
    })
    .catch((e) => {
      console.warn("session_first_prompt failed", e);
      // Mark as null so we don't keep retrying on every snap.
      setState((prev) => ({ ...prev, [sessionId]: null }));
    })
    .finally(() => {
      inFlight.delete(sessionId);
    });
}

/** Test-only reset hook. */
export function __resetFirstPromptCacheForTests(): void {
  setState({});
  inFlight.clear();
}
