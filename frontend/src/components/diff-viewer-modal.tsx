/**
 * Read-only git diff viewer.
 *
 * Opened from the sidebar when the user clicks a file in the staged /
 * unstaged lists. Calls the `git_diff` Tauri command and renders the unified
 * diff with line numbers and a toggle between Inline (unified) and Split
 * (side-by-side) layouts. Deliberately separate from `FileEditorModal` so
 * edit/save affordances don't leak into a view meant for inspection.
 */

import {
  Component,
  For,
  Match,
  Show,
  Switch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  useContext,
} from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";

import { Button } from "./ui/button";
import { FindBar, type FindBarHandle } from "./ui/find-bar";
import { Scrollable } from "./ui/scrollable";
import { useKeymap } from "../lib/keymapContext";
import { tildify } from "../lib/pathDisplay";
import {
  TEXT_MATCH_CAP,
  findTextMatches,
  matchesByLine,
  segmentLine,
  type IndexedSpan,
} from "../lib/textSearch";
import { LoaderIcon } from "./icons";

/** Where the diff comes from: the working tree (staged or unstaged side)
 *  or one file's change within a specific commit. */
export type DiffSource =
  | { kind: "worktree"; staged: boolean }
  | { kind: "commit"; hash: string; shortHash: string };

export interface DiffViewerModalProps {
  open: boolean;
  worktreePath: string | null;
  file: string | null;
  source: DiffSource;
  onClose: () => void;
}

type DiffLineKind = "header" | "hunk" | "add" | "del" | "ctx" | "meta";
type ViewMode = "inline" | "split";

interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Position in the parsed line list — the find bar's match coordinate, and
   *  what rows are tagged with so the active match can be scrolled to. */
  idx: number;
  oldNo?: number;
  newNo?: number;
}

interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
  span?: DiffLine;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const VIEW_MODE_STORAGE_KEY = "raum.diff-view-mode";

function classify(line: string): DiffLineKind {
  if (line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  if (line.startsWith("+++") || line.startsWith("---")) return "header";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

function parseDiff(raw: string): DiffLine[] {
  if (!raw) return [];
  const result: DiffLine[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  for (const text of raw.split("\n")) {
    const kind = classify(text);
    const idx = result.length;
    if (kind === "hunk") {
      const m = HUNK_RE.exec(text);
      if (m) {
        oldCursor = Number.parseInt(m[1], 10);
        newCursor = Number.parseInt(m[2], 10);
      }
      result.push({ kind, text, idx });
      continue;
    }
    if (kind === "ctx") {
      result.push({ kind, text, idx, oldNo: oldCursor, newNo: newCursor });
      oldCursor += 1;
      newCursor += 1;
      continue;
    }
    if (kind === "add") {
      result.push({ kind, text, idx, newNo: newCursor });
      newCursor += 1;
      continue;
    }
    if (kind === "del") {
      result.push({ kind, text, idx, oldNo: oldCursor });
      oldCursor += 1;
      continue;
    }
    result.push({ kind, text, idx });
  }
  return result;
}

// Group dels-then-adds within a hunk into paired rows; render context as
// mirrored rows; render hunk / meta / header as full-width span rows so they
// don't break the two-column grid.
function buildSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.kind === "ctx") {
      rows.push({ left: ln, right: ln });
      i += 1;
      continue;
    }
    if (ln.kind === "del" || ln.kind === "add") {
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === "del") {
        dels.push(lines[i]);
        i += 1;
      }
      while (i < lines.length && lines[i].kind === "add") {
        adds.push(lines[i]);
        i += 1;
      }
      const max = Math.max(dels.length, adds.length);
      for (let k = 0; k < max; k++) {
        rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
      }
      continue;
    }
    rows.push({ left: null, right: null, span: ln });
    i += 1;
  }
  return rows;
}

const storedViewMode: ViewMode =
  localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "split" ? "split" : "inline";
const [viewMode, setViewMode] = createSignal<ViewMode>(storedViewMode);
createEffect(() => {
  localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode());
});

// ---------------------------------------------------------------------------
// Find state, shared with the row renderers
// ---------------------------------------------------------------------------

/** Per-modal find state. A context (rather than the module-level signals this
 *  file uses for the view-mode toggle) so two diff modals open in different
 *  worktree tabs keep separate queries. */
interface DiffSearchApi {
  /** False while the find bar is closed — rows check this first so a closed
   *  bar leaves them subscribed to one boolean instead of the match set. */
  active: () => boolean;
  spansFor: (line: number) => IndexedSpan[] | undefined;
  activeIndex: () => number;
}

const DiffSearchContext = createContext<DiffSearchApi>();

const EMPTY_SPANS: IndexedSpan[] = [];

/** Span-array equality for the per-row memo below: `spansByLine` returns a
 *  fresh Map per recompute, so without a value comparison every keystroke
 *  would invalidate every row of an un-virtualized diff (segment rebuild +
 *  DOM re-keying for thousands of rows). With it, only rows whose matches
 *  actually changed re-render. */
function sameSpans(a: readonly IndexedSpan[], b: readonly IndexedSpan[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.start !== y.start || x.end !== y.end || x.index !== y.index) return false;
  }
  return true;
}

/** Renders one line's text with its matches marked up. Falls back to plain
 *  text when the find bar is closed or the line has no hits. */
const HighlightedText: Component<{ text: string; line: number }> = (props) => {
  const api = useContext(DiffSearchContext);
  // `active()` is checked first so a closed find bar never pulls the match set
  // (and the query, and the stripped-line array) into every row's dependencies.
  // The memo's custom equality keeps downstream (Show, segmentLine, the For)
  // untouched for the vast majority of rows on each keystroke.
  const spans = createMemo(
    (): IndexedSpan[] => (api?.active() ? (api.spansFor(props.line) ?? EMPTY_SPANS) : EMPTY_SPANS),
    EMPTY_SPANS,
    { equals: sameSpans },
  );

  return (
    <Show when={spans().length > 0} fallback={<>{props.text || " "}</>}>
      <For each={segmentLine(props.text, spans())}>
        {(segment) => (
          <Show when={segment.matchIndex !== null} fallback={<>{segment.text}</>}>
            <span
              class="rounded-[2px]"
              classList={{
                "bg-warning/50 text-foreground": segment.matchIndex === api?.activeIndex(),
                "bg-warning/25": segment.matchIndex !== api?.activeIndex(),
              }}
            >
              {segment.text}
            </span>
          </Show>
        )}
      </For>
    </Show>
  );
};

function stripSign(ln: DiffLine): string {
  if (ln.kind === "add" || ln.kind === "del") {
    return ln.text.length > 0 ? ln.text.slice(1) : ln.text;
  }
  return ln.text;
}

export const DiffViewerModal: Component<DiffViewerModalProps> = (props) => {
  const [diff, setDiff] = createSignal<string>("");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let requestId = 0;

  createEffect(() => {
    const worktreePath = props.worktreePath;
    const file = props.file;
    if (!worktreePath || !file || !props.open) {
      requestId += 1;
      setLoading(false);
      setDiff("");
      setError(null);
      return;
    }
    const currentRequest = ++requestId;
    setError(null);
    setLoading(true);
    setDiff("");
    const source = props.source;
    const request =
      source.kind === "commit"
        ? invoke<string>("git_diff_commit", { worktreePath, file, hash: source.hash })
        : invoke<string>("git_diff", { worktreePath, file, staged: source.staged });
    request
      .then((text) => {
        if (currentRequest !== requestId) return;
        setDiff(text);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (currentRequest !== requestId) return;
        setError(String(e));
        setLoading(false);
      });
  });

  const lines = createMemo(() => parseDiff(diff()));

  // -------------------------------------------------------------------
  // Find (read-only: no replace)
  // -------------------------------------------------------------------

  const [findOpen, setFindOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [useRegexp, setUseRegexp] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(0);
  let panelRef: HTMLDivElement | undefined;
  let findBar: FindBarHandle | undefined;

  // Matching runs over the same text the rows render (sign stripped), so match
  // offsets line up with what the user sees. Stripping is memoized apart from
  // the query so a keystroke doesn't re-allocate the whole line array.
  const strippedLines = createMemo(() => lines().map(stripSign));
  const searchResult = createMemo(() =>
    findOpen()
      ? findTextMatches(strippedLines(), query(), {
          caseSensitive: caseSensitive(),
          regexp: useRegexp(),
        })
      : { matches: [], capped: false, invalid: false },
  );
  const spansByLine = createMemo(() => matchesByLine(searchResult().matches));

  // A new query (or option) restarts at the first match; without this, editing
  // the query mid-search would resume at the previous ordinal.
  createEffect(on([query, caseSensitive, useRegexp], () => setActiveIndex(0), { defer: true }));

  // Keep the active match inside the (possibly shrunken) result set.
  createEffect(() => {
    const total = searchResult().matches.length;
    if (total === 0) setActiveIndex(0);
    else if (activeIndex() >= total) setActiveIndex(0);
  });

  // Scroll the active match into view. Rows carry `data-line-index`; context
  // lines appear in both split columns, so the first hit is good enough.
  createEffect(() => {
    const match = searchResult().matches[activeIndex()];
    if (!match || !panelRef) return;
    const row = panelRef.querySelector(`[data-line-index="${match.line}"]`);
    row?.scrollIntoView({ block: "center", inline: "nearest" });
  });

  const step = (delta: number): void => {
    const total = searchResult().matches.length;
    if (total === 0) return;
    setActiveIndex((i) => (i + delta + total) % total);
  };

  const openFind = (): void => {
    if (findOpen()) findBar?.focus();
    else setFindOpen(true);
  };

  const closeFind = (): void => {
    setFindOpen(false);
    setActiveIndex(0);
    // The find bar unmounts with focus inside it, dropping activeElement to
    // <body> — which would take the panel's keydown handler (the only
    // Escape-to-close path) out of the event path and leave the modal
    // keyboard-trapped. Mirror file-editor-modal's `editorView?.focus()`.
    panelRef?.focus();
  };

  // ⌘F belongs to whatever is on top; the keymap stack hands it back to the
  // spotlight dock when this modal closes.
  const keymapApi = useKeymap();
  createEffect(() => {
    if (!props.open) return;
    onCleanup(keymapApi.register("global-search", openFind));
  });

  const searchApi: DiffSearchApi = {
    active: findOpen,
    spansFor: (line) => spansByLine().get(line),
    activeIndex: () => {
      const match = searchResult().matches[activeIndex()];
      return match ? activeIndex() : -1;
    },
  };

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      // First Escape closes the find bar, second closes the modal.
      if (findOpen()) {
        e.preventDefault();
        closeFind();
        return;
      }
      e.preventDefault();
      props.onClose();
    }
  }

  const fileName = () => props.file?.split("/").pop() ?? "";
  const dirPath = () => {
    const p = props.file ?? "";
    const last = p.lastIndexOf("/");
    return last >= 0 ? p.slice(0, last) : "";
  };

  return (
    <Show when={props.open && props.file}>
      <Portal>
        <div class="fixed inset-0 z-[60] bg-scrim-strong" onClick={() => props.onClose()} />

        <div
          class="floating-surface animate-in fade-in zoom-in-95 duration-150 fixed inset-x-4 bottom-4 top-[6vh] z-[60] mx-auto flex max-w-7xl flex-col overflow-hidden rounded-2xl border border-border bg-terminal-bg"
          ref={(el) => (panelRef = el)}
          onKeyDown={onKeyDown}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={`Diff ${fileName()}`}
          tabIndex={-1}
        >
          <header class="flex shrink-0 items-center gap-3 border-b border-border-subtle bg-surface-sunken/40 px-5 py-3">
            <DiffIcon class="size-4 shrink-0 text-muted-foreground/70" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate font-mono text-xs text-foreground">{fileName()}</span>
                {/* Commit mode keeps the chip neutral — no color, just the
                    hash (restrained chrome). */}
                <span
                  class="shrink-0 rounded border px-1 py-px font-mono text-[9px] uppercase tracking-wider"
                  classList={{
                    "border-success/40 bg-success/10 text-success":
                      props.source.kind === "worktree" && props.source.staged,
                    "border-warning/40 bg-warning/10 text-warning":
                      props.source.kind === "worktree" && !props.source.staged,
                    "border-border-subtle bg-hover text-foreground-subtle":
                      props.source.kind === "commit",
                  }}
                >
                  {props.source.kind === "commit"
                    ? props.source.shortHash
                    : props.source.staged
                      ? "staged"
                      : "unstaged"}
                </span>
              </div>
              <p class="truncate font-mono text-[10px] text-muted-foreground/50">
                {tildify(dirPath())}
              </p>
            </div>
            <ViewModeToggle />
            <button
              type="button"
              class="focus-ring rounded-md p-1.5 text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
              onClick={() => props.onClose()}
              aria-label="Close diff"
            >
              <XIcon class="size-4" />
            </button>
          </header>

          <div class="relative min-h-0 flex-1">
            <Show when={findOpen()}>
              <FindBar
                ref={(handle) => (findBar = handle)}
                query={query()}
                onQueryChange={setQuery}
                placeholder="Find in diff"
                caseSensitive={caseSensitive()}
                onToggleCaseSensitive={() => setCaseSensitive((v) => !v)}
                regexp={useRegexp()}
                onToggleRegexp={() => setUseRegexp((v) => !v)}
                count={searchResult().matches.length}
                index={searchResult().matches.length > 0 ? activeIndex() : -1}
                capped={searchResult().capped}
                capNote={`Only the first ${TEXT_MATCH_CAP} matches are listed — stepping stops there too.`}
                invalid={searchResult().invalid}
                onNext={() => step(1)}
                onPrev={() => step(-1)}
                onClose={closeFind}
              />
            </Show>
            <Scrollable axis="both" class="h-full">
              <Show when={loading()}>
                <div class="absolute inset-0 flex items-center justify-center bg-terminal-bg">
                  <span class="flex items-center gap-2 text-xs text-muted-foreground/60">
                    <LoaderIcon class="size-4 animate-spin" />
                    <span>Loading...</span>
                  </span>
                </div>
              </Show>
              <Show when={error() && !loading()}>
                <div class="absolute inset-0 flex items-center justify-center bg-terminal-bg">
                  <span class="max-w-xs text-center text-xs text-destructive">{error()}</span>
                </div>
              </Show>
              <Show when={!loading() && !error() && diff().length === 0}>
                <div class="flex h-full items-center justify-center">
                  <span class="text-xs text-muted-foreground/60">No changes.</span>
                </div>
              </Show>
              <Show when={!loading() && !error() && diff().length > 0}>
                <DiffSearchContext.Provider value={searchApi}>
                  <Switch>
                    <Match when={viewMode() === "split"}>
                      <SplitView lines={lines()} />
                    </Match>
                    <Match when={viewMode() === "inline"}>
                      <InlineView lines={lines()} />
                    </Match>
                  </Switch>
                </DiffSearchContext.Provider>
              </Show>
            </Scrollable>
          </div>

          <footer class="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle bg-surface-sunken/40 px-5 py-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={props.onClose}
              class="text-muted-foreground hover:text-foreground"
            >
              Close
            </Button>
          </footer>
        </div>
      </Portal>
    </Show>
  );
};

const ViewModeToggle: Component = () => {
  return (
    <div class="flex shrink-0 overflow-hidden rounded-md border border-white/10">
      <button
        type="button"
        class="p-1.5 transition-colors"
        classList={{
          "bg-white/10 text-foreground": viewMode() === "inline",
          "text-muted-foreground/60 hover:text-foreground": viewMode() !== "inline",
        }}
        onClick={() => setViewMode("inline")}
        aria-pressed={viewMode() === "inline"}
        aria-label="Inline view"
        title="Inline view"
      >
        <InlineViewIcon class="size-4" />
      </button>
      <button
        type="button"
        class="border-l border-white/10 p-1.5 transition-colors"
        classList={{
          "bg-white/10 text-foreground": viewMode() === "split",
          "text-muted-foreground/60 hover:text-foreground": viewMode() !== "split",
        }}
        onClick={() => setViewMode("split")}
        aria-pressed={viewMode() === "split"}
        aria-label="Split view"
        title="Split view"
      >
        <SplitViewIcon class="size-4" />
      </button>
    </div>
  );
};

function InlineViewIcon(props: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  );
}

function SplitViewIcon(props: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <rect x="3" y="4" width="8" height="16" rx="1" />
      <rect x="13" y="4" width="8" height="16" rx="1" />
    </svg>
  );
}

const InlineView: Component<{ lines: DiffLine[] }> = (p) => {
  return (
    <pre class="m-0 min-h-full min-w-full font-mono text-[12px] leading-[1.5]">
      <For each={p.lines}>{(ln) => <InlineRow ln={ln} />}</For>
    </pre>
  );
};

const InlineRow: Component<{ ln: DiffLine }> = (p) => {
  const isCode = () => p.ln.kind === "ctx" || p.ln.kind === "add" || p.ln.kind === "del";
  const sign = () => (p.ln.kind === "add" ? "+" : p.ln.kind === "del" ? "-" : " ");
  const content = () => stripSign(p.ln);

  return (
    <Show
      when={isCode()}
      fallback={
        <div
          class="whitespace-pre px-4"
          data-line-index={p.ln.idx}
          classList={{
            "bg-info/10 text-info": p.ln.kind === "hunk",
            "text-muted-foreground/60": p.ln.kind === "meta" || p.ln.kind === "header",
          }}
        >
          <HighlightedText text={p.ln.text} line={p.ln.idx} />
        </div>
      }
    >
      <div
        class="whitespace-pre"
        data-line-index={p.ln.idx}
        classList={{
          "bg-success/10 text-success": p.ln.kind === "add",
          "bg-destructive/10 text-destructive": p.ln.kind === "del",
          "text-foreground/80": p.ln.kind === "ctx",
        }}
      >
        <span class="inline-block w-10 select-none border-r border-white/5 pr-2 text-right align-top text-muted-foreground/40">
          {p.ln.oldNo ?? ""}
        </span>
        <span class="inline-block w-10 select-none border-r border-white/5 px-2 text-right align-top text-muted-foreground/40">
          {p.ln.newNo ?? ""}
        </span>
        <span class="inline-block w-4 select-none px-1 text-center align-top opacity-60">
          {sign()}
        </span>
        <span class="pl-1">
          <HighlightedText text={content()} line={p.ln.idx} />
        </span>
      </div>
    </Show>
  );
};

const SplitView: Component<{ lines: DiffLine[] }> = (p) => {
  const rows = createMemo(() => buildSplitRows(p.lines));
  return (
    <div class="min-h-full w-full font-mono text-[12px] leading-[1.5]">
      <For each={rows()}>{(r) => <SplitRowView row={r} />}</For>
    </div>
  );
};

const SplitRowView: Component<{ row: SplitRow }> = (p) => {
  return (
    <Show
      when={p.row.span}
      fallback={
        <div class="grid w-full grid-cols-2">
          <SplitCell ln={p.row.left} side="left" />
          <SplitCell ln={p.row.right} side="right" />
        </div>
      }
    >
      {(span) => (
        <div
          class="w-full overflow-x-auto whitespace-pre px-4"
          data-line-index={span().idx}
          classList={{
            "bg-info/10 text-info": span().kind === "hunk",
            "text-muted-foreground/60": span().kind === "meta" || span().kind === "header",
          }}
        >
          <HighlightedText text={span().text} line={span().idx} />
        </div>
      )}
    </Show>
  );
};

const SplitCell: Component<{ ln: DiffLine | null; side: "left" | "right" }> = (p) => {
  const lineNo = () => (p.side === "left" ? p.ln?.oldNo : p.ln?.newNo);
  const content = () => (p.ln ? stripSign(p.ln) : "");

  return (
    <div
      class="flex min-w-0"
      classList={{
        "border-r border-white/5": p.side === "left",
        "bg-success/10 text-success": p.ln?.kind === "add",
        "bg-destructive/10 text-destructive": p.ln?.kind === "del",
        "text-foreground/80": p.ln?.kind === "ctx",
        "bg-white/[0.02]": p.ln === null,
      }}
    >
      <span class="w-10 shrink-0 select-none border-r border-white/5 pr-2 text-right align-top text-muted-foreground/40">
        {lineNo() ?? ""}
      </span>
      <div
        class="min-w-0 flex-1 overflow-x-auto whitespace-pre pl-2 pr-4"
        data-line-index={p.ln?.idx}
      >
        <HighlightedText text={content()} line={p.ln?.idx ?? -1} />
      </div>
    </div>
  );
};

function DiffIcon(props: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M8 3 L8 21" />
      <path d="M16 3 L16 21" />
      <path d="M4 7 L12 7" />
      <path d="M12 17 L20 17" />
    </svg>
  );
}

function XIcon(props: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export default DiffViewerModal;
