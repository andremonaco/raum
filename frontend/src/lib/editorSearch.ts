/**
 * Match statistics for the CodeMirror find bar.
 *
 * `@codemirror/search` drives navigation and replacement, but it deliberately
 * exposes no match count — the built-in panel doesn't show one. The find bar
 * does, so we walk the query's own cursor here. Kept free of DOM and of
 * `EditorView` so it stays unit-testable against a bare `EditorState`.
 */

import type { EditorState } from "@codemirror/state";
import type { SearchQuery } from "@codemirror/search";

/** Stop counting past this many matches. A full walk of a huge file on every
 *  keystroke is the one way this can get expensive; beyond the cap the bar
 *  shows the bare total instead of `n/m` (same convention the terminal's
 *  find box uses when xterm exceeds its highlight threshold). */
export const MATCH_COUNT_CAP = 5000;

/** Wall-clock budget for one counting walk. The cap above bounds matches
 *  *collected*, not text *scanned* — a sparse query over a huge document (or
 *  a slow regexp) walks everything between hits. Checked between cursor
 *  steps; a single regexp step that backtracks catastrophically inside
 *  `@codemirror/search` is still unbounded (that would need a worker), but
 *  the common cost is many cheap steps, which this cuts off. On timeout the
 *  stats degrade to `capped` — the same "count is a lower bound" contract. */
export const MATCH_SCAN_BUDGET_MS = 50;

export interface SearchStats {
  /** Number of matches found, clamped to the cap. */
  count: number;
  /** 0-based index of the match the selection currently sits on, or -1. */
  index: number;
  /** True when counting stopped at the cap, so `count` is a lower bound. */
  capped: boolean;
}

export const EMPTY_SEARCH_STATS: SearchStats = { count: 0, index: -1, capped: false };

/** Count matches of `query` in `state` and locate the selected one. */
export function searchStats(
  state: EditorState,
  query: SearchQuery,
  cap: number = MATCH_COUNT_CAP,
  budgetMs: number = MATCH_SCAN_BUDGET_MS,
): SearchStats {
  if (!query.valid) return EMPTY_SEARCH_STATS;

  const { from, to } = state.selection.main;
  const cursor = query.getCursor(state);
  const deadline = performance.now() + budgetMs;
  let count = 0;
  let index = -1;
  let capped = false;

  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    const match = step.value;
    if (index < 0 && match.from === from && match.to === to) index = count;
    count += 1;
    if (count >= cap || ((count & 63) === 0 && performance.now() > deadline)) {
      capped = true;
      break;
    }
  }

  return { count, index, capped };
}

/**
 * Ordinal of the match the selection sits on, or -1.
 *
 * Cheaper than `searchStats` for a selection-only change: the total can't have
 * moved, and only the prefix before the selection has to be walked rather than
 * the whole document.
 */
export function matchIndexAt(
  state: EditorState,
  query: SearchQuery,
  cap: number = MATCH_COUNT_CAP,
): number {
  if (!selectionIsMatch(state, query)) return -1;
  const { from } = state.selection.main;
  const cursor = query.getCursor(state, 0, from);
  let index = 0;
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    if (step.value.from >= from) break;
    index += 1;
    // Past the cap the count itself is a lower bound, so an ordinal would lie.
    if (index >= cap) return -1;
  }
  return index;
}

/** Whether the main selection exactly covers a match — `replaceNext` only
 *  replaces in that case, otherwise it just steps to the next match. Callers
 *  use this to run a find first so the Replace button always replaces. */
export function selectionIsMatch(state: EditorState, query: SearchQuery): boolean {
  if (!query.valid) return false;
  const { from, to } = state.selection.main;
  if (from === to) return false;
  const step = query.getCursor(state, from, to).next();
  return !step.done && step.value.from === from && step.value.to === to;
}
