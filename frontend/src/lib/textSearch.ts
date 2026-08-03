/**
 * Plain-text find over an array of rendered lines.
 *
 * The diff viewer renders its own `<pre>` rather than hosting a CodeMirror
 * document, so its find bar can't lean on `@codemirror/search`. Matching and
 * segmenting live here — pure, line-oriented, and unit-testable — while the
 * component only maps segments to spans.
 */

/** Hard ceiling on collected matches; past it the bar shows a bare total. */
export const TEXT_MATCH_CAP = 5000;

/** Wall-clock budget for one scan. The scan runs synchronously on the main
 *  thread on every keystroke; a pathological regexp (catastrophic
 *  backtracking, e.g. `(a+)+$` against a long repeated run) or a huge diff
 *  must degrade to a partial result, not a UI freeze. Checked between lines —
 *  a single `exec` that backtracks forever within ONE line is still unbounded
 *  (that would need a worker), but the common blowup is per-line cost times
 *  thousands of lines, which this cuts off. */
export const TEXT_SCAN_BUDGET_MS = 50;

export interface TextMatch {
  /** Index into the `lines` array the match was found on. */
  line: number;
  /** Start offset within that line, inclusive. */
  start: number;
  /** End offset within that line, exclusive. */
  end: number;
}

export interface TextSearchResult {
  matches: TextMatch[];
  /** True when collection stopped early — at the match cap OR the time
   *  budget. Either way `matches` is a document-order prefix and the count
   *  is a lower bound, which is all the find bar's `n+` display needs. */
  capped: boolean;
  /** True when `regexp` was requested and the pattern didn't compile. */
  invalid: boolean;
}

export interface TextSearchOptions {
  caseSensitive?: boolean;
  regexp?: boolean;
  /** Scan time budget override; see [`TEXT_SCAN_BUDGET_MS`]. */
  budgetMs?: number;
}

const EMPTY_RESULT: TextSearchResult = { matches: [], capped: false, invalid: false };

/** Escape a plain query so it can run through the same RegExp path. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find every occurrence of `query` across `lines`, in document order.
 *
 * Both plain and regexp searches go through `RegExp`, including the
 * case-insensitive path: matching against a `toLowerCase()`d copy of the line
 * would report offsets into that copy, and a handful of characters (U+0130,
 * for one) change length when lowercased — the caller slices the ORIGINAL
 * text, so those offsets have to come from it.
 */
export function findTextMatches(
  lines: readonly string[],
  query: string,
  options: TextSearchOptions = {},
  cap: number = TEXT_MATCH_CAP,
): TextSearchResult {
  if (query.length === 0) return EMPTY_RESULT;

  const caseSensitive = options.caseSensitive ?? false;
  const source = options.regexp ? query : escapeRegExp(query);
  let re: RegExp;
  try {
    re = new RegExp(source, caseSensitive ? "g" : "gi");
  } catch {
    return { matches: [], capped: false, invalid: true };
  }

  const matches: TextMatch[] = [];
  const deadline = performance.now() + (options.budgetMs ?? TEXT_SCAN_BUDGET_MS);
  for (let line = 0; line < lines.length; line++) {
    // Every 64 lines so the clock read itself stays negligible.
    if ((line & 63) === 0 && line > 0 && performance.now() > deadline) {
      return { matches, capped: true, invalid: false };
    }
    const text = lines[line];
    re.lastIndex = 0;
    let hit = re.exec(text);
    while (hit !== null) {
      // Zero-length matches (e.g. `a*`) would spin forever; record nothing
      // and step past them.
      if (hit[0].length === 0) {
        re.lastIndex += 1;
      } else {
        matches.push({ line, start: hit.index, end: hit.index + hit[0].length });
        if (matches.length >= cap) return { matches, capped: true, invalid: false };
      }
      if (re.lastIndex > text.length) break;
      hit = re.exec(text);
    }
  }
  return { matches, capped: false, invalid: false };
}

/** A match narrowed to one line, carrying its index in the global match list
 *  so the renderer can tell the active match from the rest. */
export interface IndexedSpan {
  start: number;
  end: number;
  index: number;
}

/** Group matches by line so a row can look up its own spans in O(1). */
export function matchesByLine(matches: readonly TextMatch[]): Map<number, IndexedSpan[]> {
  const byLine = new Map<number, IndexedSpan[]>();
  matches.forEach((match, index) => {
    const spans = byLine.get(match.line);
    const span: IndexedSpan = { start: match.start, end: match.end, index };
    if (spans) spans.push(span);
    else byLine.set(match.line, [span]);
  });
  return byLine;
}

export interface TextSegment {
  text: string;
  /** Global match index when this segment is a hit, `null` for plain text. */
  matchIndex: number | null;
}

/** Split one line into alternating plain / matched segments. Spans are assumed
 *  sorted and non-overlapping (`findTextMatches` guarantees both). */
export function segmentLine(text: string, spans: readonly IndexedSpan[]): TextSegment[] {
  if (spans.length === 0) return [{ text, matchIndex: null }];

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor)
      segments.push({ text: text.slice(cursor, span.start), matchIndex: null });
    segments.push({ text: text.slice(span.start, span.end), matchIndex: span.index });
    cursor = span.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), matchIndex: null });
  return segments;
}
