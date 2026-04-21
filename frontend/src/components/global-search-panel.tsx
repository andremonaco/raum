/**
 * §4.7 — `<GlobalSearchPanel>`.
 *
 * Full-height overlay that queries every mounted terminal's xterm.js buffer
 * through the terminal registry. The search walks each pane's buffer line by
 * line (via `IBufferLine.translateToString`) so we can return per-line match
 * coordinates and group results by pane. Clicking a result focuses the pane
 * and scrolls xterm to the match line.
 *
 * Case-sensitive and regex toggles are both honoured. If the total walk time
 * exceeds 100 ms we show a cancelable progress indicator; the search yields
 * between panes via `queueMicrotask` so cancellation stays responsive.
 */

import { Component, For, Show, Suspense, createSignal, lazy, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  listTerminalBuffers,
  listTerminals,
  type RegisteredTerminal,
  type TerminalBufferKind,
} from "../lib/terminalRegistry";
import { activeProjectSlug } from "../stores/projectStore";
import { isEditableFile } from "../lib/fileUtils";
import { tildify } from "../lib/pathDisplay";
const FileEditorModal = lazy(() =>
  import("./file-editor-modal").then((m) => ({ default: m.FileEditorModal })),
);
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { TextField, TextFieldInput, TextFieldLabel } from "./ui/text-field";
import { Scrollable } from "./ui/scrollable";

interface FileHit {
  path: string;
  relPath: string;
  name: string;
  score: number;
}

type MatchBuffer = TerminalBufferKind | "tmux-history" | "tmux-live";

interface Match {
  row: number;
  col: number;
  preview: string;
  buffer: MatchBuffer;
}

interface LineMatch {
  col: number;
  preview: string;
}

interface PaneResult {
  paneId: string;
  sessionId: string | null;
  kind: string;
  matches: Match[];
}

export interface GlobalSearchPanelProps {
  open: boolean;
  onClose: () => void;
}

function matchSourceLabel(buffer: MatchBuffer): string {
  switch (buffer) {
    case "alternate":
      return "live";
    case "normal":
      return "history";
    case "tmux-history":
    case "tmux-live":
      return "tmux";
  }
}

function buildMatcher(
  needle: string,
  opts: { regex: boolean; caseSensitive: boolean },
): ((line: string) => LineMatch[]) | null {
  if (!needle) return null;
  if (opts.regex) {
    try {
      const re = new RegExp(needle, opts.caseSensitive ? "g" : "gi");
      return (line: string) => {
        const matches: LineMatch[] = [];
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          matches.push({ col: m.index, preview: line });
          if (m[0].length === 0) re.lastIndex += 1;
        }
        return matches;
      };
    } catch {
      return null;
    }
  }
  const target = opts.caseSensitive ? needle : needle.toLowerCase();
  return (line: string) => {
    const hay = opts.caseSensitive ? line : line.toLowerCase();
    const matches: LineMatch[] = [];
    let from = 0;
    while (true) {
      const at = hay.indexOf(target, from);
      if (at < 0) break;
      matches.push({ col: at, preview: line });
      from = at + Math.max(target.length, 1);
    }
    return matches;
  };
}

interface PaneTextHit {
  sessionId: string;
  normal: string;
  alternate: string | null;
}

async function fetchTmuxCaptures(sessionIds: string[]): Promise<Map<string, PaneTextHit>> {
  if (sessionIds.length === 0) return new Map();
  try {
    const hits = await invoke<PaneTextHit[]>("terminal_capture_text", { sessionIds });
    const byId = new Map<string, PaneTextHit>();
    for (const hit of hits) byId.set(hit.sessionId, hit);
    return byId;
  } catch {
    // Search must still succeed from xterm buffers alone if the IPC fails.
    return new Map();
  }
}

async function runSearch(
  needle: string,
  opts: { regex: boolean; caseSensitive: boolean },
  cancel: { aborted: boolean },
): Promise<PaneResult[]> {
  const match = buildMatcher(needle, opts);
  if (!match) return [];

  const panes = listTerminals();
  const sessionIds = panes.map((p) => p.sessionId).filter((id): id is string => Boolean(id));
  const tmuxByIdPromise = fetchTmuxCaptures(sessionIds);

  const byPane = new Map<string, PaneResult>();
  for (const reg of panes) {
    if (cancel.aborted) break;
    const pane = collectFromPane(reg, match);
    byPane.set(reg.paneId, pane);
    await new Promise<void>((r) => queueMicrotask(r));
  }
  if (cancel.aborted) return [];

  const tmuxById = await tmuxByIdPromise;
  if (cancel.aborted) return [];
  for (const reg of panes) {
    if (!reg.sessionId) continue;
    const hit = tmuxById.get(reg.sessionId);
    if (!hit) continue;
    const pane =
      byPane.get(reg.paneId) ??
      ({ paneId: reg.paneId, sessionId: reg.sessionId, kind: reg.kind, matches: [] } as PaneResult);
    mergeTmuxMatches(pane, hit, match);
    byPane.set(reg.paneId, pane);
  }

  const out: PaneResult[] = [];
  for (const reg of panes) {
    const pane = byPane.get(reg.paneId);
    if (pane && pane.matches.length > 0) out.push(pane);
  }
  return out;
}

function mergeTmuxMatches(
  pane: PaneResult,
  hit: PaneTextHit,
  match: (line: string) => LineMatch[],
): void {
  // Dedupe against matches already produced by the xterm walk — for shell
  // panes the tail of tmux's history mirrors xterm's normal buffer, and for
  // harnesses the tmux alt-screen frame mirrors xterm's alternate buffer.
  // Keying on (col, preview) keeps the xterm hit (which has a precise row)
  // whenever a line appears in both sources.
  const seen = new Set<string>();
  for (const m of pane.matches) seen.add(`${m.col}\x00${m.preview}`);

  const walk = (text: string, kind: "tmux-history" | "tmux-live"): void => {
    if (!text) return;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      for (const m of match(line)) {
        const key = `${m.col}\x00${m.preview}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pane.matches.push({ row: i, col: m.col, preview: m.preview, buffer: kind });
      }
    }
  };
  walk(hit.normal, "tmux-history");
  if (hit.alternate) walk(hit.alternate, "tmux-live");
}

function collectFromPane(
  reg: RegisteredTerminal,
  match: (line: string) => LineMatch[],
): PaneResult {
  const matches: Match[] = [];
  for (const view of listTerminalBuffers(reg.terminal)) {
    const buf = view.buffer;
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (!text) continue;
      const lineMatches = match(text);
      for (const m of lineMatches) {
        matches.push({ row: y, col: m.col, preview: text, buffer: view.kind });
      }
    }
  }
  return {
    paneId: reg.paneId,
    sessionId: reg.sessionId,
    kind: reg.kind,
    matches,
  };
}

export const GlobalSearchPanel: Component<GlobalSearchPanelProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [regex, setRegex] = createSignal(false);
  const [results, setResults] = createSignal<PaneResult[]>([]);
  const [fileHits, setFileHits] = createSignal<FileHit[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [showProgress, setShowProgress] = createSignal(false);
  const [editorPath, setEditorPath] = createSignal<string | null>(null);

  let currentCancel: { aborted: boolean } | null = null;
  let progressTimer: number | null = null;
  // Monotonic token so stale file-search responses can't overwrite a newer
  // query's results. Cheaper than wiring an AbortController across IPC.
  let fileToken = 0;

  const cancel = (): void => {
    if (currentCancel) currentCancel.aborted = true;
    if (progressTimer !== null) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
    setBusy(false);
    setShowProgress(false);
  };

  const runFileSearch = async (q: string): Promise<void> => {
    const slug = activeProjectSlug();
    if (!slug || !q.trim()) {
      setFileHits([]);
      return;
    }
    const token = ++fileToken;
    try {
      const hits = await invoke<FileHit[]>("project_find_files", {
        projectSlug: slug,
        query: q,
      });
      if (token !== fileToken) return;
      setFileHits(hits);
    } catch {
      if (token === fileToken) setFileHits([]);
    }
  };

  const execute = async (): Promise<void> => {
    cancel();
    const q = query();
    if (!q) {
      setResults([]);
      setFileHits([]);
      return;
    }
    const localCancel = { aborted: false };
    currentCancel = localCancel;
    setBusy(true);
    setShowProgress(false);
    progressTimer = window.setTimeout(() => {
      if (!localCancel.aborted) setShowProgress(true);
    }, 100);
    try {
      const [scrollback] = await Promise.all([
        runSearch(q, { regex: regex(), caseSensitive: caseSensitive() }, localCancel),
        runFileSearch(q),
      ]);
      if (!localCancel.aborted) setResults(scrollback);
    } finally {
      if (progressTimer !== null) {
        clearTimeout(progressTimer);
        progressTimer = null;
      }
      setBusy(false);
      setShowProgress(false);
      currentCancel = null;
    }
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      props.onClose();
    }
  };

  onMount(() => {
    window.addEventListener("keydown", onKey);
  });
  onCleanup(() => {
    cancel();
    window.removeEventListener("keydown", onKey);
  });

  const onRowClick = (pane: PaneResult, m: Match): void => {
    const reg = listTerminals().find((t) => t.paneId === pane.paneId);
    if (!reg) return;
    // Tmux-sourced matches live outside xterm.js's scrollback (they only
    // exist in the tmux history-limit), so we can't scroll xterm to an
    // exact row. Focus the pane and let the user scroll tmux itself.
    if (m.buffer === "normal" || m.buffer === "alternate") {
      reg.revealBufferLine(m.buffer, m.row);
    }
    reg.focus();
    props.onClose();
  };

  const onFileClick = (hit: FileHit): void => {
    if (!isEditableFile(hit.path)) return;
    setEditorPath(hit.path);
    props.onClose();
  };

  const hasAnyResults = () => results().length > 0 || fileHits().length > 0;

  return (
    <>
      <Show when={props.open}>
        <div
          class="fixed inset-0 z-50 flex flex-col bg-background text-foreground"
          role="dialog"
          aria-label="Global scrollback search"
          data-testid="global-search-panel"
        >
          <header class="flex items-center gap-2 border-b border-border px-3 py-2">
            <TextField
              class="flex-1"
              value={query()}
              onChange={(v) => {
                setQuery(v);
                void execute();
              }}
            >
              <TextFieldLabel class="sr-only">Search scrollback</TextFieldLabel>
              <TextFieldInput
                autofocus
                type="text"
                placeholder="Search all terminal scrollback..."
                class="h-8"
              />
            </TextField>
            <label class="flex items-center gap-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                class="accent-primary"
                checked={caseSensitive()}
                onChange={(e) => {
                  setCaseSensitive(e.currentTarget.checked);
                  void execute();
                }}
              />
              Aa
            </label>
            <label class="flex items-center gap-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                class="accent-primary"
                checked={regex()}
                onChange={(e) => {
                  setRegex(e.currentTarget.checked);
                  void execute();
                }}
              />
              .*
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                cancel();
                props.onClose();
              }}
            >
              Close
            </Button>
          </header>

          <Show when={busy() && showProgress()}>
            <div class="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
              <span>Searching scrollback…</span>
              <Button type="button" variant="outline" size="sm" class="h-6" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </Show>

          <Scrollable class="min-h-0 flex-1 px-3 py-2 text-xs">
            <Show
              when={hasAnyResults()}
              fallback={
                <p class="text-muted-foreground/70">
                  {query()
                    ? busy()
                      ? "Searching..."
                      : "No matches."
                    : "Type to search project files and terminal scrollback."}
                </p>
              }
            >
              <Show when={fileHits().length > 0}>
                <section class="mb-3">
                  <header class="mb-1 flex items-center gap-2 text-muted-foreground">
                    <span class="uppercase tracking-wide text-foreground">Files</span>
                    <Badge variant="secondary" class="ml-auto text-[10px]">
                      {fileHits().length}
                    </Badge>
                  </header>
                  <ul class="space-y-0.5">
                    <For each={fileHits()}>
                      {(hit) => (
                        <li>
                          <button
                            type="button"
                            class="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left font-mono hover:bg-muted"
                            onClick={() => onFileClick(hit)}
                            title={tildify(hit.path)}
                          >
                            <span class="truncate text-foreground">{hit.name}</span>
                            <span class="truncate text-[10px] text-muted-foreground">
                              {hit.relPath}
                            </span>
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>

              <Show when={results().length > 0}>
                <header class="mb-1 flex items-center gap-2 text-muted-foreground">
                  <span class="uppercase tracking-wide text-foreground">Scrollback</span>
                </header>
              </Show>

              <For each={results()}>
                {(pane) => (
                  <section class="mb-3">
                    <header class="mb-1 flex items-center gap-2 text-muted-foreground">
                      <span class="text-foreground">{pane.kind}</span>
                      <span class="truncate text-muted-foreground/70">
                        {pane.sessionId ?? "(unattached)"}
                      </span>
                      <Badge variant="secondary" class="ml-auto text-[10px]">
                        {pane.matches.length}
                      </Badge>
                    </header>
                    <ul class="space-y-0.5">
                      <For each={pane.matches}>
                        {(m) => (
                          <li>
                            <button
                              type="button"
                              class="w-full truncate rounded px-2 py-1 text-left font-mono hover:bg-muted"
                              onClick={() => onRowClick(pane, m)}
                            >
                              <span class="text-muted-foreground">
                                {matchSourceLabel(m.buffer)} {m.row}:{m.col}
                              </span>{" "}
                              <span class="text-foreground">{m.preview}</span>
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                )}
              </For>
            </Show>
          </Scrollable>
        </div>
      </Show>
      <Show when={editorPath() !== null}>
        <Suspense>
          <FileEditorModal open={true} path={editorPath()} onClose={() => setEditorPath(null)} />
        </Suspense>
      </Show>
    </>
  );
};

export default GlobalSearchPanel;
