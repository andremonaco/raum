/**
 * Scrollback search used by the spotlight dock (⌘F).
 *
 * Walks two sources for every live harness session:
 *
 *   1. xterm.js buffers, for panes that are currently mounted (registered
 *      in `terminalRegistry`). Cheap, and the only source that produces
 *      accurate row/col coordinates we can later use to scroll the
 *      viewport when the user activates a match.
 *   2. `terminal_capture_text` tmux captures, grepped in Rust for every
 *      session the frontend knows about — including harnesses belonging to
 *      inactive projects (whose xterm instances aren't mounted). This
 *      also recovers lines that have scrolled out of xterm's buffer but
 *      still live in tmux's `history-limit`. Only matching lines cross IPC;
 *      the captures themselves are 100k lines per pane.
 *
 * Shell kinds are excluded; the dock is intentionally focused on harness
 * history. Results are capped per-session and globally so a noisy harness
 * can't swamp the list.
 */

import { invoke } from "@tauri-apps/api/core";

import type { AgentKind } from "./agentKind";
import { resolveSessionTabLabel } from "./harnessTabLabel";
import { listTerminalBuffers, listTerminals } from "./terminalRegistry";
import type { TerminalBufferKind } from "./terminalRegistry";
import { harnessIds, terminalStore, type TerminalRecord } from "../stores/terminalStore";

export type ScrollbackBuffer = TerminalBufferKind | "tmux-history" | "tmux-live";

export interface ScrollbackMatch {
  sessionId: string;
  kind: AgentKind;
  projectSlug: string | null;
  /** Label shown in the terminal grid tab strip — reused here verbatim so
   * users recognise the row without squinting at kebab-case kinds. */
  tabLabel: string;
  row: number;
  col: number;
  length: number;
  line: string;
  buffer: ScrollbackBuffer;
}

/** Hard cap per harness to avoid any one chatty pane swamping the panel. */
const MAX_MATCHES_PER_SESSION = 8;
/** Hard cap across all panes. Spotlight scrolls but still shouldn't balloon. */
const MAX_MATCHES_TOTAL = 60;
/**
 * How many rows back from the newest line we walk per xterm buffer. Buffers are
 * bounded at 100k lines, and lowercasing every one of them blocks the main
 * thread for hundreds of ms per pane while the user is still typing the query.
 * Recent output is what a ⌘F search is nearly always after, so scan newest-first
 * and stop here.
 */
const MAX_SCAN_ROWS_PER_BUFFER = 10_000;
/** Rows between main-thread yields inside a single buffer walk. */
const SCAN_YIELD_INTERVAL = 2_000;

/** Real macrotask yield — a microtask would keep the render loop blocked. */
function yieldToRenderer(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

interface LineMatch {
  col: number;
  length: number;
}

interface PaneLineMatch {
  row: number;
  col: number;
  length: number;
  line: string;
  buffer: "tmux-history" | "tmux-live";
}

interface PaneTextHit {
  sessionId: string;
  matches: PaneLineMatch[];
}

function buildMatcher(needle: string): ((line: string) => LineMatch[]) | null {
  if (!needle) return null;
  const target = needle.toLowerCase();
  const length = needle.length;
  return (line: string) => {
    const hay = line.toLowerCase();
    const matches: LineMatch[] = [];
    let from = 0;
    while (true) {
      const at = hay.indexOf(target, from);
      if (at < 0) break;
      matches.push({ col: at, length });
      from = at + Math.max(length, 1);
    }
    return matches;
  };
}

/** Server-side grep over the tmux captures — see `commands::search`. */
async function fetchTmuxMatches(
  sessionIds: string[],
  query: string,
): Promise<Map<string, PaneLineMatch[]>> {
  if (sessionIds.length === 0) return new Map();
  try {
    const hits = await invoke<PaneTextHit[]>("terminal_capture_text", { sessionIds, query });
    const byId = new Map<string, PaneLineMatch[]>();
    for (const hit of hits) byId.set(hit.sessionId, hit.matches);
    return byId;
  } catch {
    return new Map();
  }
}

export interface RunScrollbackSearchArgs {
  query: string;
  cancel: { aborted: boolean };
}

export async function runScrollbackSearch(
  args: RunScrollbackSearchArgs,
): Promise<ScrollbackMatch[]> {
  const { query, cancel } = args;
  const match = buildMatcher(query);
  if (!match) return [];

  // Restrict to harness sessions that the frontend knows about. The
  // `harnessIds` index already excludes shells and null-slug sessions, so
  // we skip the `Object.values(byId).filter(...)` scan.
  const harnessSet = harnessIds();
  if (harnessSet.size === 0) return [];
  const harnesses: TerminalRecord[] = [];
  for (const id of harnessSet) {
    const record = terminalStore.byId[id];
    if (record) harnesses.push(record);
  }
  if (harnesses.length === 0) return [];

  const sessionIds = harnesses.map((t) => t.session_id);
  const tmuxByIdPromise = fetchTmuxMatches(sessionIds, query);

  const registered = new Map(
    listTerminals()
      .filter((r) => r.sessionId)
      .map((r) => [r.sessionId as string, r] as const),
  );

  const out: ScrollbackMatch[] = [];

  for (const term of harnesses) {
    if (cancel.aborted) return [];
    if (out.length >= MAX_MATCHES_TOTAL) break;

    const tabLabel = resolveSessionTabLabel(term.session_id);

    let perSession = 0;
    const push = (m: ScrollbackMatch): boolean => {
      if (perSession >= MAX_MATCHES_PER_SESSION) return false;
      if (out.length >= MAX_MATCHES_TOTAL) return false;
      out.push(m);
      perSession += 1;
      return true;
    };

    const seen = new Set<string>();
    const keyOf = (col: number, line: string): string => `${col}\x00${line}`;

    // 1) xterm walk (only if the pane is currently mounted).
    const reg = registered.get(term.session_id);
    if (reg) {
      for (const view of listTerminalBuffers(reg.terminal)) {
        const buf = view.buffer;
        // Newest-first, bounded depth: a 100k-row buffer would otherwise be
        // ~100k `translateToString` + `toLowerCase` calls on the main thread
        // per keystroke-debounced query.
        const stopAt = Math.max(0, buf.length - MAX_SCAN_ROWS_PER_BUFFER);
        let scanned = 0;
        for (let y = buf.length - 1; y >= stopAt; y--) {
          if (perSession >= MAX_MATCHES_PER_SESSION) break;
          scanned += 1;
          if (scanned % SCAN_YIELD_INTERVAL === 0) {
            // Real macrotask yield so the renderer can paint mid-walk.
            await yieldToRenderer();
            if (cancel.aborted) return [];
          }
          const line = buf.getLine(y);
          if (!line) continue;
          const text = line.translateToString(true);
          if (!text) continue;
          for (const hit of match(text)) {
            const k = keyOf(hit.col, text);
            if (seen.has(k)) continue;
            seen.add(k);
            if (
              !push({
                sessionId: term.session_id,
                kind: term.kind,
                projectSlug: term.project_slug,
                tabLabel,
                row: y,
                col: hit.col,
                length: hit.length,
                line: text,
                buffer: view.kind,
              })
            )
              break;
          }
        }
      }
      // Yield between panes so cancellation stays responsive on long queries.
      await new Promise<void>((r) => queueMicrotask(r));
      if (cancel.aborted) return [];
    }

    // 2) Augment with tmux capture lines that xterm never saw (other projects,
    //    or history that scrolled past xterm's cap). Already matched, bounded
    //    and newest-first on the Rust side.
    const tmuxById = await tmuxByIdPromise;
    if (cancel.aborted) return [];
    for (const hit of tmuxById.get(term.session_id) ?? []) {
      if (perSession >= MAX_MATCHES_PER_SESSION) break;
      const k = keyOf(hit.col, hit.line);
      if (seen.has(k)) continue;
      seen.add(k);
      if (
        !push({
          sessionId: term.session_id,
          kind: term.kind,
          projectSlug: term.project_slug,
          tabLabel,
          row: hit.row,
          col: hit.col,
          length: hit.length,
          line: hit.line,
          buffer: hit.buffer,
        })
      )
        break;
    }
  }

  return out;
}

export interface PreviewParts {
  leadingEllipsis: boolean;
  before: string;
  match: string;
  after: string;
  trailingEllipsis: boolean;
}

/** Slice a match's line into {before, match, after} with ~`ctx` chars of
 * surrounding context and ellipses when truncated. */
export function buildPreviewParts(
  line: string,
  col: number,
  length: number,
  ctx = 36,
): PreviewParts {
  const safeCol = Math.max(0, Math.min(col, line.length));
  const safeEnd = Math.max(safeCol, Math.min(col + length, line.length));
  const start = Math.max(0, safeCol - ctx);
  const end = Math.min(line.length, safeEnd + ctx);
  return {
    leadingEllipsis: start > 0,
    before: line.slice(start, safeCol),
    match: line.slice(safeCol, safeEnd),
    after: line.slice(safeEnd, end),
    trailingEllipsis: end < line.length,
  };
}
