/**
 * Cross-harness review feature: client-side index of "this pane is reviewing
 * that pane" relationships.
 *
 * Backend events:
 *   - `review:linked`   — emitted by `record_review_link` after the frontend
 *     reports a successful spawn.
 *   - `review:unlinked` — emitted by `clear_review_link` when a linked
 *     session is closed.
 *
 * The store keeps two derived maps so chrome can answer either direction
 * cheaply:
 *   - `reviewerOf(sessionId)`  → which session this pane is reviewing
 *     (single, since one pane reviews one pane).
 *   - `reviewedBy(sessionId)`  → list of reviewer sessions reviewing this
 *     pane (multiple — a pane can have several reviewers in v1.1, though
 *     today the UI only spawns one).
 *
 * The store doesn't subscribe to `terminal-session-removed` directly because
 * the backend already emits `review:unlinked` from `clear_review_link`; the
 * orchestration is the frontend invoking `clear_review_link` when a tab is
 * closed (see `subscribeReviewCleanup` below).
 */

import { batch, createMemo, createRoot, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ReviewLinkPayload {
  reviewerSessionId: string;
  reviewedSessionId: string;
}

interface State {
  /** reviewerSessionId → reviewedSessionId. */
  reviewerOf: Record<string, string>;
}

const { state, setState } = createRoot(() => {
  const [state, setState] = createSignal<State>({ reviewerOf: {} });
  return { state, setState };
});

/**
 * Inverse memo: reviewedSessionId → reviewerSessionId[]. Recomputed on every
 * link change — link sets are small (typically <10 active reviews) so the
 * O(n) rebuild is cheap.
 */
const reviewedByMemo = createRoot(() =>
  createMemo<Record<string, string[]>>(() => {
    const out: Record<string, string[]> = {};
    for (const [reviewer, reviewed] of Object.entries(state().reviewerOf)) {
      const bucket = out[reviewed] ?? [];
      bucket.push(reviewer);
      out[reviewed] = bucket;
    }
    return out;
  }),
);

/** Session id this pane is currently reviewing, or undefined. */
export function reviewerOf(sessionId: string | null | undefined): string | undefined {
  if (!sessionId) return undefined;
  return state().reviewerOf[sessionId];
}

/** Session ids reviewing this pane. Empty array if none. */
export function reviewedBy(sessionId: string | null | undefined): string[] {
  if (!sessionId) return [];
  return reviewedByMemo()[sessionId] ?? [];
}

/** True when this pane is part of a review pair (either side). */
export function isReviewLinked(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  if (state().reviewerOf[sessionId]) return true;
  return reviewedByMemo()[sessionId] !== undefined;
}

/** Reactive snapshot of every active review link as
 *  `{reviewerSessionId, reviewedSessionId}` pairs. Used by the
 *  `<ReviewBracesLayer>` to find linked panes that are spatially adjacent
 *  and render the connecting brace between them. */
export function allReviewLinks(): Array<{
  reviewerSessionId: string;
  reviewedSessionId: string;
}> {
  return Object.entries(state().reviewerOf).map(([reviewer, reviewed]) => ({
    reviewerSessionId: reviewer,
    reviewedSessionId: reviewed,
  }));
}

/** Local-only helper for the link lifecycle. Exported for tests. */
export function applyReviewLinked(payload: ReviewLinkPayload): void {
  setState((prev) => ({
    reviewerOf: {
      ...prev.reviewerOf,
      [payload.reviewerSessionId]: payload.reviewedSessionId,
    },
  }));
}

/**
 * Drop any link entries touching a session id (reviewer or reviewed).
 * Exported for tests; the production path goes through the Tauri event.
 */
export function applyReviewUnlinked(sessionId: string): void {
  setState((prev) => {
    const next: Record<string, string> = {};
    for (const [reviewer, reviewed] of Object.entries(prev.reviewerOf)) {
      if (reviewer === sessionId || reviewed === sessionId) continue;
      next[reviewer] = reviewed;
    }
    return { reviewerOf: next };
  });
}

interface WireReviewLinked {
  reviewerSessionId: string;
  reviewedSessionId: string;
}

/**
 * Subscribe to the backend link-lifecycle events. Returns an unlisten
 * function that detaches both subscriptions.
 *
 * Idempotent: callers (the app boot path) may invoke once at startup; the
 * function returns a Promise that only resolves once both listeners are
 * registered.
 */
export async function subscribeReviewLinkEvents(): Promise<UnlistenFn> {
  const unlistenLinked = await listen<WireReviewLinked>("review:linked", (ev) => {
    console.info("[review] linked event received", ev.payload);
    applyReviewLinked({
      reviewerSessionId: ev.payload.reviewerSessionId,
      reviewedSessionId: ev.payload.reviewedSessionId,
    });
  });
  const unlistenUnlinked = await listen<WireReviewLinked>("review:unlinked", (ev) => {
    // The backend tells us which pair was dissolved; we drop both endpoints
    // from the local map regardless of which side fired the event.
    console.info("[review] unlinked event received", ev.payload);
    batch(() => {
      applyReviewUnlinked(ev.payload.reviewerSessionId);
      applyReviewUnlinked(ev.payload.reviewedSessionId);
    });
  });
  return () => {
    unlistenLinked();
    unlistenUnlinked();
  };
}

/**
 * Tell the backend to drop any links involving `sessionId`. Called by the
 * tab-closed flow so badges clear immediately when one side of the pair
 * goes away.
 */
export async function clearReviewLinkForSession(sessionId: string): Promise<void> {
  try {
    await invoke("clear_review_link", { args: { sessionId } });
  } catch (e) {
    console.warn("clear_review_link invoke failed", e);
  }
}

/** Test-only reset hook. Wipes the in-memory state. */
export function __resetReviewLinkStoreForTests(): void {
  setState({ reviewerOf: {} });
}
