/**
 * Scrollback search used by the spotlight dock (⌘F).
 *
 * Walks two sources for every live harness session:
 *
 *   1. xterm.js buffers, for panes that are currently mounted (registered
 *      in `terminalRegistry`). Cheap, and the only source that produces
 *      accurate row/col coordinates we can later use to scroll the
 *      viewport when the user activates a match.
 *   2. `terminal_capture_text` tmux captures, fetched for every session
 *      the frontend knows about — including harnesses belonging to
 *      inactive projects (whose xterm instances aren't mounted). This
 *      also recovers lines that have scrolled out of xterm's buffer but
 *      still live in tmux's `history-limit`.
 *
 * Shell kinds are excluded; the dock is intentionally focused on harness
 * history. Results are capped per-session and globally so a noisy harness
 * can't swamp the list.
 */

import { invoke } from "@tauri-apps/api/core";

import type { AgentKind } from "./agentKind";
import { resolveHarnessAutoLabel } from "./terminalTabLabel";
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

interface LineMatch {
  col: number;
  length: number;
}

interface PaneTextHit {
  sessionId: string;
  normal: string;
  alternate: string | null;
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

async function fetchTmuxCaptures(sessionIds: string[]): Promise<Map<string, PaneTextHit>> {
  if (sessionIds.length === 0) return new Map();
  try {
    const hits = await invoke<PaneTextHit[]>("terminal_capture_text", { sessionIds });
    const byId = new Map<string, PaneTextHit>();
    for (const hit of hits) byId.set(hit.sessionId, hit);
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
  const tmuxByIdPromise = fetchTmuxCaptures(sessionIds);

  const registered = new Map(
    listTerminals()
      .filter((r) => r.sessionId)
      .map((r) => [r.sessionId as string, r] as const),
  );

  const out: ScrollbackMatch[] = [];

  for (const term of harnesses) {
    if (cancel.aborted) return [];
    if (out.length >= MAX_MATCHES_TOTAL) break;

    const tabLabel = resolveHarnessAutoLabel({
      kind: term.kind,
      paneTitle: term.paneContext?.paneTitle,
      windowName: term.paneContext?.windowName,
      currentCommand: term.paneContext?.currentCommand,
    });

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
        for (let y = 0; y < buf.length; y++) {
          if (perSession >= MAX_MATCHES_PER_SESSION) break;
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
    //    or history that scrolled past xterm's cap).
    const tmuxById = await tmuxByIdPromise;
    if (cancel.aborted) return [];
    const tmuxHit = tmuxById.get(term.session_id);
    if (!tmuxHit) continue;

    const walk = (text: string, kind: "tmux-history" | "tmux-live"): void => {
      if (perSession >= MAX_MATCHES_PER_SESSION) return;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (perSession >= MAX_MATCHES_PER_SESSION) break;
        const line = lines[i];
        if (!line) continue;
        for (const hit of match(line)) {
          const k = keyOf(hit.col, line);
          if (seen.has(k)) continue;
          seen.add(k);
          if (
            !push({
              sessionId: term.session_id,
              kind: term.kind,
              projectSlug: term.project_slug,
              tabLabel,
              row: i,
              col: hit.col,
              length: hit.length,
              line,
              buffer: kind,
            })
          )
            break;
        }
      }
    };
    walk(tmuxHit.normal, "tmux-history");
    if (tmuxHit.alternate) walk(tmuxHit.alternate, "tmux-live");
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
