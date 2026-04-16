/**
 * Shared open/close signal for the `<SpotlightDock>`.
 *
 * Two open modes:
 *
 *   • "modal" (default, ⌘F / ⌘.) — spotlight renders its own input row and
 *     steals focus from whatever was focused before.
 *
 *   • "topBar" — opened from the top-bar inline input. The spotlight renders
 *     WITHOUT its own input row and does NOT steal focus; the top-bar input
 *     remains focused and drives the live query via `setTopBarQuery`.
 */

import { createSignal } from "solid-js";

const [open, setOpen] = createSignal(false);

/** When true the spotlight was opened from the top-bar input. */
const [topBarDriven, setTopBarDriven] = createSignal(false);

/**
 * Live query pushed from the top-bar input while `topBarDriven` is true.
 * SpotlightDock watches this signal to stay in sync.
 */
const [topBarQuery, setTopBarQuerySignal] = createSignal("");

export const spotlightOpen = open;
export const spotlightTopBarDriven = topBarDriven;
export const spotlightTopBarQuery = topBarQuery;

// ---------------------------------------------------------------------------
// Modal-mode helpers (⌘F / ⌘.)
// ---------------------------------------------------------------------------

/** Used by pendingQuery to pre-fill on open; kept for ⌘F modal open. */
const [pendingQuery, setPendingQuery] = createSignal("");
export const spotlightPendingQuery = pendingQuery;

export function openSpotlight(): void {
  setTopBarDriven(false);
  setPendingQuery("");
  setOpen(true);
}

export function openWithQuery(q: string): void {
  setTopBarDriven(false);
  setPendingQuery(q);
  setOpen(true);
}

export function clearSpotlightPendingQuery(): void {
  setPendingQuery("");
}

export function toggleSpotlight(): void {
  if (open()) {
    setTopBarDriven(false);
    setOpen(false);
  } else {
    setTopBarDriven(false);
    setPendingQuery("");
    setOpen(true);
  }
}

// ---------------------------------------------------------------------------
// Top-bar-driven helpers
// ---------------------------------------------------------------------------

/**
 * Called by the top-bar input's `onInput`. Opens (or updates) the spotlight
 * in top-bar mode without stealing focus.
 */
export function setTopBarQuery(q: string): void {
  setTopBarQuerySignal(q);
  if (q.trim()) {
    setTopBarDriven(true);
    setOpen(true);
  } else {
    // Empty query → close the results panel
    setTopBarDriven(false);
    setOpen(false);
  }
}

export function closeSpotlight(): void {
  setTopBarDriven(false);
  setTopBarQuerySignal("");
  setOpen(false);
}
