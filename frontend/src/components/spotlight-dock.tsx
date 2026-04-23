/**
 * Spotlight-style command dock.
 *
 * Triggered by `⌘F` (or `⌘.` for backwards compatibility). Shows recent
 * searches and all project harnesses when the input is empty; as the user
 * types, shows:
 *   - matching harness sessions (click → focus pane) — each row renders
 *     `<harness icon> <tab label> <project sigil> <project name> <state>`,
 *     reusing the tab-strip label so users never see the raw tmux session
 *     id,
 *   - scrollback matches across every live harness on every project — each
 *     row shows `<harness icon> <tab-label> <line-with-highlighted-match>`
 *     and activating one jumps to the owning project, focuses the pane,
 *     and scrolls xterm to the match when the hit came from xterm's own
 *     buffer (tmux-only hits just focus the pane),
 *   - project file matches across all worktrees of the active project
 *     (click → open in FileEditorModal).
 *
 * Keyboard nav: ↑/↓ to select, Enter to activate, Escape to close.
 */

import {
  Component,
  For,
  Match,
  Show,
  Suspense,
  Switch,
  type JSX,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  clearSpotlightPendingQuery,
  closeSpotlight,
  spotlightOpen,
  spotlightPendingQuery,
  spotlightTopBarDriven,
  spotlightTopBarQuery,
  toggleSpotlight,
} from "../lib/spotlightState";
import { addRecentSearch, clearRecentSearch, recentSearches } from "../lib/recentSearchStore";
import { listHarnessSessions } from "../stores/terminalStore";
import { activeProjectSlug, projectBySlug, setActiveProjectSlug } from "../stores/projectStore";
import { resolveSessionTabLabel } from "../lib/harnessTabLabel";
import { useKeymapAction } from "../lib/keymapContext";
import {
  buildPreviewParts,
  runScrollbackSearch,
  type ScrollbackMatch,
} from "../lib/scrollbackSearch";
import { listTerminals, type TerminalBufferKind } from "../lib/terminalRegistry";
const FileEditorModal = lazy(() =>
  import("./file-editor-modal").then((m) => ({ default: m.FileEditorModal })),
);
import { Badge } from "./ui/badge";
import { ClockIcon, SearchIcon, HARNESS_ICONS, type HarnessIconKind } from "./icons";
import { Scrollable } from "./ui/scrollable";
import { FileTypeIcon } from "../lib/fileTypeIcon";
import type { Worktree } from "../stores/worktreeStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileHit {
  path: string;
  relPath: string;
  name: string;
  score: number;
}

interface WorktreeFileHit extends FileHit {
  worktreeBranch: string;
  worktreePath: string;
}

type RecentItem = { type: "recent"; query: string };
type HarnessItem = {
  type: "harness";
  sessionId: string;
  kind: HarnessIconKind;
  workingState: string;
  /** Same label the grid's tab strip shows for this session. */
  tabLabel: string;
  projectSlug: string | null;
  projectName: string | null;
  projectSigil: string | null;
};
type FileItem = { type: "file"; hit: WorktreeFileHit };
type ScrollbackItem = { type: "scrollback"; match: ScrollbackMatch };
type ResultItem = RecentItem | HarnessItem | FileItem | ScrollbackItem;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stateColor(state: string): string {
  if (state === "working") return "bg-success/20 text-success";
  if (state === "waiting") return "bg-warning/20 text-warning";
  return "bg-muted text-muted-foreground";
}

function stateLabel(state: string): string {
  if (state === "working") return "active";
  if (state === "waiting") return "waiting";
  return "idle";
}

// ---------------------------------------------------------------------------
// SpotlightDock
// ---------------------------------------------------------------------------

export const SpotlightDock: Component = () => {
  const [query, setQuery] = createSignal("");
  const [fileHits, setFileHits] = createSignal<WorktreeFileHit[]>([]);
  const [scrollbackHits, setScrollbackHits] = createSignal<ScrollbackMatch[]>([]);
  const [selectedIdx, setSelectedIdx] = createSignal(-1);
  const [editorPath, setEditorPath] = createSignal<string | null>(null);

  let inputRef: HTMLInputElement | undefined;
  let fileSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let fileToken = 0;
  let scrollbackSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollbackCancel: { aborted: boolean } | null = null;

  // ⌘. — backwards-compat shortcut via keymap system
  useKeymapAction("spotlight", toggleSpotlight);

  // ⌘F — primary trigger, captured before the browser can intercept it
  const onGlobalKeydown = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === "f" && !e.shiftKey) {
      e.preventDefault();
      toggleSpotlight();
    }
  };
  window.addEventListener("keydown", onGlobalKeydown, { capture: true });
  onCleanup(() => window.removeEventListener("keydown", onGlobalKeydown, { capture: true }));

  // On open in modal-mode: consume pendingQuery, reset state, steal focus.
  // In top-bar-driven mode: reset state but do NOT steal focus — the top-bar
  // input stays focused and drives the query via the effect below.
  createEffect(() => {
    if (spotlightOpen()) {
      if (spotlightTopBarDriven()) {
        // Query comes from the top-bar; just reset the result lists.
        setFileHits([]);
        setScrollbackHits([]);
        setSelectedIdx(-1);
      } else {
        const initial = spotlightPendingQuery();
        clearSpotlightPendingQuery();
        setQuery(initial);
        setFileHits([]);
        setScrollbackHits([]);
        setSelectedIdx(-1);
        if (initial) scheduleSearch(initial);
        requestAnimationFrame(() => {
          inputRef?.focus();
          if (initial) {
            inputRef?.setSelectionRange(initial.length, initial.length);
          }
        });
      }
    }
  });

  // While top-bar-driven, keep the local query in sync with whatever the
  // top-bar input is typing and re-run the search on each change.
  createEffect(() => {
    if (!spotlightTopBarDriven()) return;
    const q = spotlightTopBarQuery();
    setQuery(q);
    setSelectedIdx(-1);
    scheduleSearch(q);
  });

  // ---------------------------------------------------------------------------
  // Worktree-aware file search
  // ---------------------------------------------------------------------------

  function scheduleSearch(q: string): void {
    if (fileSearchTimer !== null) clearTimeout(fileSearchTimer);
    fileSearchTimer = setTimeout(() => {
      fileSearchTimer = null;
      void runWorktreeFileSearch(q);
    }, 120);

    // Scrollback walk is heavier (tmux IPC + per-line scan), so debounce it
    // a bit longer to avoid thrashing while the user is still typing.
    if (scrollbackSearchTimer !== null) clearTimeout(scrollbackSearchTimer);
    if (scrollbackCancel) scrollbackCancel.aborted = true;
    scrollbackSearchTimer = setTimeout(() => {
      scrollbackSearchTimer = null;
      void runScrollback(q);
    }, 180);
  }

  async function runScrollback(q: string): Promise<void> {
    if (!q.trim()) {
      setScrollbackHits([]);
      return;
    }
    const cancel = { aborted: false };
    scrollbackCancel = cancel;
    try {
      const hits = await runScrollbackSearch({ query: q, cancel });
      if (!cancel.aborted) setScrollbackHits(hits);
    } catch {
      if (!cancel.aborted) setScrollbackHits([]);
    } finally {
      if (scrollbackCancel === cancel) scrollbackCancel = null;
    }
  }

  async function runWorktreeFileSearch(q: string): Promise<void> {
    const slug = activeProjectSlug();
    if (!slug || !q.trim()) {
      setFileHits([]);
      return;
    }
    const token = ++fileToken;
    try {
      const worktrees = await invoke<Worktree[]>("worktree_list", {
        projectSlug: slug,
      });
      if (token !== fileToken) return;

      const perWorktree = await Promise.all(
        worktrees.map(async (wt) => {
          try {
            const hits = await invoke<FileHit[]>("search_files_in_path", {
              path: wt.path,
              query: q,
            });
            const branch =
              wt.branch?.replace(/^refs\/heads\//, "") ?? wt.path.split("/").at(-1) ?? "main";
            return hits.map(
              (h): WorktreeFileHit => ({
                ...h,
                worktreeBranch: branch,
                worktreePath: wt.path,
              }),
            );
          } catch {
            return [] as WorktreeFileHit[];
          }
        }),
      );

      if (token !== fileToken) return;
      const merged = perWorktree
        .flat()
        .sort((a, b) => b.score - a.score)
        .slice(0, 50);
      setFileHits(merged);
    } catch {
      if (token === fileToken) setFileHits([]);
    }
  }

  function handleQueryChange(v: string): void {
    setQuery(v);
    setSelectedIdx(-1);
    scheduleSearch(v);
  }

  // ---------------------------------------------------------------------------
  // Harness results — scoped to active project, show worktree label
  // ---------------------------------------------------------------------------

  const harnessMatches = createMemo<HarnessItem[]>(() => {
    const q = query().toLowerCase().trim();
    const slug = activeProjectSlug();
    const projects = projectBySlug();
    return listHarnessSessions(slug)
      .map((t): HarnessItem => {
        const project = t.project_slug ? (projects.get(t.project_slug) ?? null) : null;
        return {
          type: "harness" as const,
          sessionId: t.session_id,
          kind: t.kind as HarnessIconKind,
          workingState: t.workingState,
          tabLabel: resolveSessionTabLabel(t.session_id),
          projectSlug: t.project_slug,
          projectName: project?.name ?? null,
          projectSigil: project?.sigil ?? null,
        };
      })
      .filter(
        (item) =>
          !q ||
          item.tabLabel.toLowerCase().includes(q) ||
          item.kind.toLowerCase().includes(q) ||
          (item.projectName?.toLowerCase().includes(q) ?? false),
      )
      .slice(0, 8);
  });

  // ---------------------------------------------------------------------------
  // Flat navigation list
  // ---------------------------------------------------------------------------

  const scrollbackItems = createMemo<ScrollbackItem[]>(() =>
    scrollbackHits().map((match): ScrollbackItem => ({ type: "scrollback", match })),
  );

  const allItems = createMemo<ResultItem[]>(() => {
    const q = query().trim();
    if (!q) {
      // Empty query: recent searches first, then all project harnesses
      const recents = recentSearches().map((r): RecentItem => ({ type: "recent", query: r }));
      return [...recents, ...harnessMatches()];
    }
    return [
      ...harnessMatches(),
      ...scrollbackItems(),
      ...fileHits().map((hit): FileItem => ({ type: "file", hit })),
    ];
  });

  function activateItem(item: ResultItem): void {
    if (item.type === "recent") {
      setQuery(item.query);
      setSelectedIdx(-1);
      scheduleSearch(item.query);
      return;
    }
    if (item.type === "harness") {
      window.dispatchEvent(
        new CustomEvent("terminal-focus-requested", {
          detail: { sessionId: item.sessionId },
        }),
      );
      closeSpotlight();
      return;
    }
    if (item.type === "scrollback") {
      addRecentSearch(query());
      activateScrollbackMatch(item.match);
      closeSpotlight();
      return;
    }
    // file
    addRecentSearch(query());
    setEditorPath(item.hit.path);
    closeSpotlight();
  }

  function activateScrollbackMatch(m: ScrollbackMatch): void {
    // Cross-project jump: switching `activeProjectSlug` remounts the grid
    // and the target pane's `<TerminalPane>`, which then reacts to the
    // `terminal-focus-requested` event we dispatch below (same pattern the
    // notification toasts and cross-project overlay use).
    const needsProjectSwitch = Boolean(m.projectSlug && m.projectSlug !== activeProjectSlug());
    if (needsProjectSwitch) setActiveProjectSlug(m.projectSlug!);

    const finish = (): void => {
      const reg = listTerminals().find((t) => t.sessionId === m.sessionId);
      // Tmux-sourced matches live outside xterm.js's scrollback (their row
      // indices don't map 1:1 into xterm's buffer), so we only scroll for
      // xterm-sourced hits — otherwise we'd snap the viewport somewhere
      // misleading.
      if (reg && (m.buffer === "normal" || m.buffer === "alternate")) {
        reg.revealBufferLine(m.buffer as TerminalBufferKind, m.row);
      }
      reg?.focus();
      try {
        window.dispatchEvent(
          new CustomEvent("terminal-focus-requested", {
            detail: { sessionId: m.sessionId },
          }),
        );
      } catch {
        /* non-DOM env (tests / SSR) */
      }
    };

    if (needsProjectSwitch) queueMicrotask(finish);
    else finish();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!spotlightOpen()) return;
    const items = allItems();
    if (e.key === "Escape") {
      e.preventDefault();
      closeSpotlight();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, items.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, -1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = items[selectedIdx()];
      if (item) activateItem(item);
    }
  }

  window.addEventListener("keydown", onKeyDown, { capture: true });
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown, { capture: true });
    if (fileSearchTimer !== null) clearTimeout(fileSearchTimer);
    if (scrollbackSearchTimer !== null) clearTimeout(scrollbackSearchTimer);
    if (scrollbackCancel) scrollbackCancel.aborted = true;
  });

  // ---------------------------------------------------------------------------
  // Section metadata for rendering
  // ---------------------------------------------------------------------------

  const sections = createMemo(() => {
    const items = allItems();
    const q = query().trim();
    const hasRecent = !q && recentSearches().length > 0;
    const hasHarnesses = harnessMatches().length > 0;
    const fileCount = fileHits().length;
    const scrollbackCount = scrollbackHits().length;
    return {
      hasRecent,
      hasHarnesses,
      harnessCount: harnessMatches().length,
      fileCount,
      scrollbackCount,
      items,
    };
  });

  return (
    <>
      <Show when={spotlightOpen()}>
        {/* Backdrop — dims the app without blurring it */}
        <div
          class="fixed inset-0 z-50 flex items-start justify-center pt-[16vh] bg-scrim"
          onClick={closeSpotlight}
        >
          {/* Panel — solid background so the app behind stays crisp */}
          <div
            class="floating-surface animate-in fade-in zoom-in-95 duration-150 w-full max-w-[640px] mx-4 overflow-hidden rounded-2xl border border-border bg-popover"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Search input — hidden when the top-bar input is driving the query */}
            <Show when={!spotlightTopBarDriven()}>
              <div class="flex items-center gap-3 px-4 py-3.5">
                <SearchIcon class="size-4 shrink-0 text-muted-foreground/60" />
                <input
                  ref={(el) => (inputRef = el)}
                  type="text"
                  class="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
                  placeholder="Search files and terminals…"
                  value={query()}
                  onInput={(e) => handleQueryChange(e.currentTarget.value)}
                />
                <Show when={query()}>
                  <button
                    type="button"
                    class="rounded p-0.5 text-muted-foreground/50 hover:text-foreground"
                    onClick={() => {
                      setQuery("");
                      setFileHits([]);
                      setScrollbackHits([]);
                      setSelectedIdx(-1);
                    }}
                    aria-label="Clear"
                  >
                    <XIcon class="size-3.5" />
                  </button>
                </Show>
                <kbd class="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  ⌘F
                </kbd>
              </div>
            </Show>

            {/* Results */}
            <Show
              when={
                sections().items.length > 0 ||
                (query().trim().length > 0 &&
                  sections().harnessCount === 0 &&
                  sections().scrollbackCount === 0 &&
                  sections().fileCount === 0)
              }
            >
              <div class="border-t border-white/5" />
              <Scrollable class="max-h-[480px] pb-1 pt-1">
                {/* No-results message */}
                <Show
                  when={
                    query().trim().length > 0 &&
                    sections().harnessCount === 0 &&
                    sections().scrollbackCount === 0 &&
                    sections().fileCount === 0
                  }
                >
                  <p class="px-4 py-3 text-xs text-muted-foreground/60">
                    No results for <span class="text-foreground/80">"{query()}"</span>
                  </p>
                </Show>

                {/* Section headers */}
                <Show when={sections().hasRecent}>
                  <SectionHeader label="Recent" />
                </Show>
                <Show when={!query().trim() && sections().hasHarnesses}>
                  <SectionHeader label="Terminals" />
                </Show>
                <Show when={query().trim() && sections().harnessCount > 0}>
                  <SectionHeader label="Terminals" />
                </Show>

                <For each={sections().items}>
                  {(item, idx) => {
                    const isFirstFile = createMemo(
                      () =>
                        item.type === "file" &&
                        (idx() === 0 || sections().items[idx() - 1]?.type !== "file"),
                    );
                    const isFirstScrollback = createMemo(
                      () =>
                        item.type === "scrollback" &&
                        (idx() === 0 || sections().items[idx() - 1]?.type !== "scrollback"),
                    );
                    return (
                      <>
                        <Show when={isFirstScrollback()}>
                          <SectionHeader label="Scrollback" count={sections().scrollbackCount} />
                        </Show>
                        <Show when={isFirstFile()}>
                          <SectionHeader label="Files" count={sections().fileCount} />
                        </Show>
                        <ResultRow
                          selected={selectedIdx() === idx()}
                          onRowClick={() => activateItem(item)}
                          onRowMouseEnter={() => setSelectedIdx(idx())}
                        >
                          <ItemContent item={item} onClearRecent={clearRecentSearch} />
                        </ResultRow>
                      </>
                    );
                  }}
                </For>
              </Scrollable>
            </Show>
          </div>
        </div>
      </Show>

      {/* File editor: lazy-loaded so CodeMirror doesn't ship in the initial chunk */}
      <Show when={editorPath() !== null}>
        <Suspense>
          <FileEditorModal open={true} path={editorPath()} onClose={() => setEditorPath(null)} />
        </Suspense>
      </Show>
    </>
  );
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const SectionHeader: Component<{ label: string; count?: number }> = (props) => (
  <div class="flex items-center gap-2 px-4 pb-1 pt-2">
    <span class="text-[10px] uppercase tracking-widest text-muted-foreground/50">
      {props.label}
    </span>
    <Show when={props.count !== undefined && props.count > 0}>
      <span class="text-[10px] text-muted-foreground/40">{props.count}</span>
    </Show>
  </div>
);

const ResultRow: Component<{
  selected: boolean;
  onRowClick: () => void;
  onRowMouseEnter: () => void;
  children: JSX.Element;
}> = (props) => (
  <button
    type="button"
    class="group flex w-full items-center gap-2.5 px-4 py-2 text-left text-xs transition-colors duration-75"
    classList={{
      "bg-white/8 text-foreground": props.selected,
      "text-foreground hover:bg-white/5": !props.selected,
    }}
    onClick={() => props.onRowClick()}
    onMouseEnter={() => props.onRowMouseEnter()}
  >
    {props.children}
  </button>
);

const ItemContent: Component<{
  item: ResultItem;
  onClearRecent: (q: string) => void;
}> = (props) => (
  <Switch>
    <Match when={props.item.type === "recent" && (props.item as RecentItem)}>
      {(recent) => (
        <>
          <ClockIcon class="size-3.5 shrink-0 text-muted-foreground/60" />
          <span class="flex-1 truncate text-foreground/90">{recent().query}</span>
          <button
            type="button"
            class="ml-1 rounded p-0.5 text-muted-foreground/40 opacity-0 hover:text-foreground group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              props.onClearRecent(recent().query);
            }}
            aria-label={`Remove "${recent().query}" from recent`}
          >
            <XIconSmall />
          </button>
        </>
      )}
    </Match>
    <Match when={props.item.type === "harness" && (props.item as HarnessItem)}>
      {(harness) => {
        const Icon = HARNESS_ICONS[harness().kind] ?? HARNESS_ICONS["shell" as HarnessIconKind];
        return (
          <>
            <Icon class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="flex-1 truncate text-foreground/90">{harness().tabLabel}</span>
            <Show when={harness().projectName}>
              <span class="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/70">
                <Show when={harness().projectSigil}>
                  <span class="font-mono text-muted-foreground/60">{harness().projectSigil}</span>
                </Show>
                <span class="truncate">{harness().projectName}</span>
              </span>
            </Show>
            <Badge
              class={`ml-1 shrink-0 px-1.5 py-0.5 text-[9px] font-medium ${stateColor(harness().workingState)}`}
            >
              {stateLabel(harness().workingState)}
            </Badge>
          </>
        );
      }}
    </Match>
    <Match when={props.item.type === "file" && (props.item as FileItem)}>
      {(file) => (
        <>
          <FileTypeIcon name={file().hit.name} class="size-3.5 shrink-0 text-muted-foreground/60" />
          <span class="truncate text-sm text-foreground/90">{file().hit.name}</span>
          <span class="ml-1 min-w-0 flex-1 truncate text-[10px] text-muted-foreground/50">
            {file().hit.relPath}
          </span>
          <Badge class="shrink-0 bg-white/5 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground/70">
            {file().hit.worktreeBranch}
          </Badge>
        </>
      )}
    </Match>
    <Match when={props.item.type === "scrollback" && (props.item as ScrollbackItem)}>
      {(sb) => {
        const Icon =
          HARNESS_ICONS[sb().match.kind as HarnessIconKind] ??
          HARNESS_ICONS["shell" as HarnessIconKind];
        const parts = createMemo(() =>
          buildPreviewParts(sb().match.line, sb().match.col, sb().match.length),
        );
        return (
          <>
            <Icon class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="shrink-0 max-w-[30%] truncate text-foreground/90">
              {sb().match.tabLabel}
            </span>
            <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/80">
              <Show when={parts().leadingEllipsis}>
                <span class="text-muted-foreground/40">…</span>
              </Show>
              {parts().before}
              <mark class="rounded-sm bg-yellow-300/30 px-0.5 text-foreground">
                {parts().match}
              </mark>
              {parts().after}
              <Show when={parts().trailingEllipsis}>
                <span class="text-muted-foreground/40">…</span>
              </Show>
            </span>
          </>
        );
      }}
    </Match>
  </Switch>
);

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

function XIconSmall() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="size-3"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export default SpotlightDock;
