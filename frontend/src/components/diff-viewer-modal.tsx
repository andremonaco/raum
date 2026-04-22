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
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";

import { Button } from "./ui/button";
import { Scrollable } from "./ui/scrollable";
import { tildify } from "../lib/pathDisplay";

export interface DiffViewerModalProps {
  open: boolean;
  worktreePath: string | null;
  file: string | null;
  staged: boolean;
  onClose: () => void;
}

type DiffLineKind = "header" | "hunk" | "add" | "del" | "ctx" | "meta";
type ViewMode = "inline" | "split";

interface DiffLine {
  kind: DiffLineKind;
  text: string;
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
    if (kind === "hunk") {
      const m = HUNK_RE.exec(text);
      if (m) {
        oldCursor = Number.parseInt(m[1], 10);
        newCursor = Number.parseInt(m[2], 10);
      }
      result.push({ kind, text });
      continue;
    }
    if (kind === "ctx") {
      result.push({ kind, text, oldNo: oldCursor, newNo: newCursor });
      oldCursor += 1;
      newCursor += 1;
      continue;
    }
    if (kind === "add") {
      result.push({ kind, text, newNo: newCursor });
      newCursor += 1;
      continue;
    }
    if (kind === "del") {
      result.push({ kind, text, oldNo: oldCursor });
      oldCursor += 1;
      continue;
    }
    result.push({ kind, text });
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

  createEffect(() => {
    const worktreePath = props.worktreePath;
    const file = props.file;
    if (!worktreePath || !file || !props.open) return;
    setError(null);
    setLoading(true);
    setDiff("");
    invoke<string>("git_diff", { worktreePath, file, staged: props.staged })
      .then((text) => {
        setDiff(text);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(String(e));
        setLoading(false);
      });
  });

  const lines = createMemo(() => parseDiff(diff()));

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
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
                <span
                  class="shrink-0 rounded border px-1 py-px font-mono text-[9px] uppercase tracking-wider"
                  classList={{
                    "border-success/40 bg-success/10 text-success": props.staged,
                    "border-warning/40 bg-warning/10 text-warning": !props.staged,
                  }}
                >
                  {props.staged ? "staged" : "unstaged"}
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

          <Scrollable axis="both" class="relative min-h-0 flex-1">
            <Show when={loading()}>
              <div class="absolute inset-0 flex items-center justify-center bg-terminal-bg">
                <span class="text-xs text-muted-foreground/60">Loading…</span>
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
              <Switch>
                <Match when={viewMode() === "split"}>
                  <SplitView lines={lines()} />
                </Match>
                <Match when={viewMode() === "inline"}>
                  <InlineView lines={lines()} />
                </Match>
              </Switch>
            </Show>
          </Scrollable>

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
          classList={{
            "bg-info/10 text-info": p.ln.kind === "hunk",
            "text-muted-foreground/60": p.ln.kind === "meta" || p.ln.kind === "header",
          }}
        >
          {p.ln.text || "\u00a0"}
        </div>
      }
    >
      <div
        class="whitespace-pre"
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
        <span class="pl-1">{content() || "\u00a0"}</span>
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
          classList={{
            "bg-info/10 text-info": span().kind === "hunk",
            "text-muted-foreground/60": span().kind === "meta" || span().kind === "header",
          }}
        >
          {span().text || "\u00a0"}
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
      <div class="min-w-0 flex-1 overflow-x-auto whitespace-pre pl-2 pr-4">
        {content() || "\u00a0"}
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
