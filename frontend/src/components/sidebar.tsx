/**
 * §9 — Left sidebar.
 *
 * Owned by Wave 3C. Starts from Wave 2B's worktree-list skeleton and layers on
 * the full spec:
 *
 *   §9.1 expandable worktree rows + dirty indicator (polls
 *        `worktree_status` every 2 s per worktree).
 *   §9.2 `Open` / `Staged` file groups, clickable via the Tauri
 *        opener plugin (`openPath` — delegates to `open` on macOS,
 *        `xdg-open` on Linux).
 *   §9.3 active-agents sub-section driven by `agentStore`; clicks emit a
 *        `terminal-focus-requested` event the TerminalGrid listens to.
 *   §9.5 resize handle persists width into `config.toml.sidebar.width_px`
 *        via `config_set_sidebar_width`; collapse via the `toggle-sidebar`
 *        action from the keymap (listened through a window custom event so
 *        the future §12.4 keymap provider can dispatch us without this
 *        component importing the provider).
 *
 * Stores imported (from Wave 3B / 3D):
 *   • `projectStore` — project list, active slug, colors.
 *   • `worktreeStore` — the existing active-worktree tracking + cache.
 *   • `agentStore` — live harness sessions per worktree.
 *
 * This file intentionally contains every moving part for §9 to keep the
 * Wave-3C diff surface minimal; any future split would live under
 * `components/sidebar/`.
 */

import {
  Component,
  For,
  Show,
  Suspense,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  lazy,
  onCleanup,
  onMount,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FileTypeIcon } from "../lib/fileTypeIcon";
import {
  activeWorktreeStore,
  ALL_WORKTREES_SCOPE,
  cacheWorktreeList,
  clearWorktreeListCache,
  setActiveWorktree,
  setActiveWorktreeAll,
  useBranchesVersion,
  worktreesByProject,
  type Worktree,
  type WorktreeScope,
} from "../stores/worktreeStore";
import {
  activeProjectSlug,
  projectStore,
  refreshProjects,
  removeProject,
  type ProjectListItem,
} from "../stores/projectStore";
import { agentStore, type AgentListItem } from "../stores/agentStore";
import {
  harnessCountsForProject,
  harnessCountsForWorktree,
  idsByWorktreeId,
  terminalStore,
} from "../stores/terminalStore";
import { ActivityIcon, AlertCircleIcon, CheckIcon, LoaderIcon, PlusIcon } from "./icons";
import { CreateWorktreeModal } from "./create-worktree-modal";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
} from "./ui/dialog";
const DiffViewerModal = lazy(() =>
  import("./diff-viewer-modal").then((m) => ({ default: m.DiffViewerModal })),
);
const FileEditorModal = lazy(() =>
  import("./file-editor-modal").then((m) => ({ default: m.FileEditorModal })),
);
const DeleteWorktreeModal = lazy(() =>
  import("./delete-worktree-modal").then((m) => ({ default: m.DeleteWorktreeModal })),
);
const UnlinkProjectModal = lazy(() =>
  import("./unlink-project-modal").then((m) => ({ default: m.UnlinkProjectModal })),
);
import { useKeymapAction } from "../lib/keymapContext";
import { sidebarHidden } from "../lib/sidebarVisibility";
import { Scrollable } from "./ui/scrollable";

// ---- Tauri command wrappers -----------------------------------------------

interface WorktreeStatus {
  dirty: boolean;
  untracked: string[];
  modified: string[];
  staged: string[];
  insertions: number;
  deletions: number;
}

async function fetchWorktrees(slug: string): Promise<Worktree[]> {
  try {
    const items = await invoke<Worktree[]>("worktree_list", {
      projectSlug: slug,
    });
    cacheWorktreeList(slug, items);
    return items;
  } catch {
    return [];
  }
}

async function fetchStatus(path: string): Promise<WorktreeStatus> {
  try {
    return await invoke<WorktreeStatus>("worktree_status", { path });
  } catch {
    return { dirty: false, untracked: [], modified: [], staged: [], insertions: 0, deletions: 0 };
  }
}

async function gitStage(worktreePath: string, files: string[]): Promise<void> {
  await invoke<void>("git_stage", { worktreePath, files });
}

async function gitUnstage(worktreePath: string, files: string[]): Promise<void> {
  await invoke<void>("git_unstage", { worktreePath, files });
}

async function gitDiscard(worktreePath: string, files: string[]): Promise<void> {
  await invoke<void>("git_discard", { worktreePath, files });
}

async function gitDiscardAll(worktreePath: string): Promise<void> {
  await invoke<void>("git_discard_all", { worktreePath });
}

/** Wrap a string in POSIX single quotes, escaping embedded single quotes.
 *  Exported for unit tests. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Turn a multi-line commit draft into a `git commit -m 'subject' [-m 'body'...]`
 *  command. Paragraphs are split on blank lines so `subject\n\nbody` renders
 *  correctly in `git log` (first paragraph = subject, rest = body). Returns an
 *  empty string when the draft has no non-blank paragraphs. Exported for tests. */
export function buildCommitCommand(draft: string): string {
  const paragraphs = draft
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return "";
  return ["git", "commit", ...paragraphs.flatMap((p) => ["-m", shellQuote(p)])].join(" ");
}

// §9.1 — polling cadence. Debounced per-worktree: each expanded row owns its
// own interval so collapsing a row stops its poll immediately.
const STATUS_POLL_MS = 2_000;

// §9.7 — clamp matches the backend (160..800). Duplicated here so the handle
// snaps predictably during the drag without waiting for the invoke round-trip.
const SIDEBAR_MIN_PX = 160;
const SIDEBAR_MAX_PX = 800;
// Wide enough to hold three size-2.5 icons (10 px each) + two gap-0.5 gaps
// (2 px each) + minimal padding on either side = 34 px content + ~10 px room.
const SIDEBAR_COLLAPSED_PX = 44;

// ---- Inline glyphs ---------------------------------------------------------
// Minus + trash shapes aren't in the project icon barrel yet; kept inline to
// keep this change surgical. Both inherit `currentColor` so parent text
// classes control the tint (success / destructive / dim).

const MinusGlyph: Component<{ class?: string }> = (p) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class={p.class}
    aria-hidden="true"
  >
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const TrashGlyph: Component<{ class?: string }> = (p) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    class={p.class}
    aria-hidden="true"
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
  </svg>
);

// ---- Harness counter -------------------------------------------------------

interface HarnessCounts {
  active: number;
  waiting: number;
  idle: number;
}

interface HarnessCounterProps {
  counts: HarnessCounts;
  /** Compact variant drops the bordered pill — used in dense rows. */
  compact?: boolean;
}

/**
 * Mirrors the top-right harness widget in `top-row.tsx`. Same icons, same
 * colour treatment, scoped to a worktree or aggregated across a project.
 *
 * Animations are deliberately subtle: `animate-spin` on the loader (already
 * built-in) for active work, `animate-pulse` on the alert circle when input
 * is waited on. Idle gets no motion.
 */
const HarnessCounter: Component<HarnessCounterProps> = (counterProps) => {
  const c = () => counterProps.counts;
  const containerClass = () =>
    counterProps.compact
      ? "flex shrink-0 items-center gap-1 font-mono text-[10px]"
      : "flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-card/30 px-1 py-0.5 font-mono text-[10px]";
  const cellClass = "inline-flex items-center gap-0.5 px-0.5";
  return (
    <span class={containerClass()} data-testid="worktree-harness-counts">
      <span
        class={cellClass}
        classList={{
          "text-success": c().active > 0,
          "text-foreground-dim": c().active === 0,
        }}
        title={`${c().active} active`}
      >
        <Show when={c().active > 0} fallback={<ActivityIcon class="size-2.5" />}>
          <LoaderIcon class="size-2.5 animate-spin" />
        </Show>
        {c().active}
      </span>
      <span
        class={cellClass}
        classList={{
          "text-warning": c().waiting > 0,
          "text-foreground-dim": c().waiting === 0,
        }}
        title={`${c().waiting} waiting`}
      >
        <AlertCircleIcon class="size-2.5" classList={{ "animate-pulse": c().waiting > 0 }} />
        {c().waiting}
      </span>
      <span
        class={cellClass}
        classList={{
          "text-muted-foreground": c().idle > 0,
          "text-foreground-dim": c().idle === 0,
        }}
        title={`${c().idle} idle`}
      >
        <CheckIcon class="size-2.5" />
        {c().idle}
      </span>
    </span>
  );
};

/** Sum harness counts across every terminal whose `worktree_id` is in `paths`. */
function countHarnessesForPaths(paths: Set<string>): HarnessCounts {
  let active = 0;
  let waiting = 0;
  let idle = 0;
  for (const path of paths) {
    const counts = harnessCountsForWorktree(path);
    active += counts.active;
    waiting += counts.waiting;
    idle += counts.idle;
  }
  return { active, waiting, idle };
}

// ---- Worktree row ----------------------------------------------------------

interface WorktreeRowProps {
  worktree: Worktree;
  projectSlug: string;
  isActive: boolean;
  projectColor?: string;
  projectSigil?: string;
  /** True when this worktree is the project root (set at project creation). */
  isMain: boolean;
  /**
   * Branch of the project's main worktree — best-effort "sprouted from"
   * fallback for additional worktrees created before raum started persisting
   * `branch.<name>.raumBase` (or whose upstream is unset).
   */
  mainBranchFallback: string | null;
  /** Called when the user clicks the row-level delete icon. */
  onRequestDelete: () => void;
}

/**
 * Resolve what to show on the branch line as the "sprouted from" value.
 * Prefers the explicit baseBranch (persisted on create), then the tracking
 * upstream stripped of its `origin/` prefix, then the project's main-worktree
 * branch as a last-resort inference. Returns null when the resolved base
 * equals the worktree's own branch (no useful arrow to draw).
 */
function resolveBaseBranchLabel(wt: Worktree, fallback: string | null): string | null {
  let base: string | null = null;
  if (wt.baseBranch && wt.baseBranch.length > 0) base = wt.baseBranch;
  else if (wt.upstream && wt.upstream.length > 0) base = wt.upstream.replace(/^origin\//, "");
  else if (fallback && fallback.length > 0) base = fallback;
  if (base === null) return null;
  if (wt.branch !== null && base === wt.branch) return null;
  return base;
}

/**
 * Expandable worktree row. Shows git state, LOC stats, terminal counts.
 * Expanded section: git staging view (stage/unstage per file + bulk) and agents.
 */
const WorktreeRow: Component<WorktreeRowProps> = (rowProps) => {
  const [expanded, setExpanded] = createSignal(false);
  const [diffTarget, setDiffTarget] = createSignal<{ file: string; staged: boolean } | null>(null);
  const [status, setStatus] = createSignal<WorktreeStatus>({
    dirty: false,
    untracked: [],
    modified: [],
    staged: [],
    insertions: 0,
    deletions: 0,
  });

  // Right-click context menu on file rows. Coordinates are viewport-relative
  // (clientX/Y); the menu renders with `position: fixed`.
  const [menuTarget, setMenuTarget] = createSignal<{
    file: string;
    staged: boolean;
    x: number;
    y: number;
  } | null>(null);

  // FileEditorModal target — absolute path of the file to open. Null = closed.
  const [editorPath, setEditorPath] = createSignal<string | null>(null);

  // Pending discard confirmation. Either a single file or the bulk sweep.
  const [discardTarget, setDiscardTarget] = createSignal<
    { kind: "file"; file: string } | { kind: "all" } | null
  >(null);
  const [discardError, setDiscardError] = createSignal<string | null>(null);
  const [discardSubmitting, setDiscardSubmitting] = createSignal(false);

  // Commit box state and in-flight spawn-and-send bookkeeping.
  const [commitDraft, setCommitDraft] = createSignal("");
  const [pendingCommit, setPendingCommit] = createSignal<{
    command: string;
    since: number;
  } | null>(null);

  let inFlight = false;
  const runPoll = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const s = await fetchStatus(rowProps.worktree.path);
      setStatus(s);
    } finally {
      inFlight = false;
    }
  };

  // Bypasses the `inFlight` gate so an explicit user action (stage, unstage,
  // discard) always sees its own result even when the 2 s poll happens to be
  // running at the same moment.
  const refreshStatus = async () => {
    const s = await fetchStatus(rowProps.worktree.path);
    setStatus(s);
  };

  onMount(() => {
    void runPoll();
    const handle = window.setInterval(() => {
      void runPoll();
    }, STATUS_POLL_MS);
    onCleanup(() => window.clearInterval(handle));
  });

  const agentsForWorktree = createMemo<AgentListItem[]>(() => {
    // The terminal store owns the authoritative worktree → session
    // mapping via `idsByWorktreeId`; that index is O(1) per row and
    // updates incrementally, so a PTY-output storm doesn't force the
    // sidebar to re-scan every agent session.
    const ids = idsByWorktreeId().get(rowProps.worktree.path);
    if (!ids || ids.size === 0) return [];
    const out: AgentListItem[] = [];
    for (const id of ids) {
      const agent = agentStore.sessions[id];
      if (agent) out.push(agent);
    }
    return out;
  });

  const dirty = createMemo(() => status().dirty);

  // §8.3 / §9.x — count harnesses attached to *this* worktree. The authoritative
  // wiring lives in terminalStore; `worktree_id` is the worktree's filesystem
  // path (matches `wt.path`).
  const harnessCounts = createMemo(() => countHarnessesForPaths(new Set([rowProps.worktree.path])));

  const focusAgent = (sessionId: string | null) => {
    if (!sessionId) return;
    window.dispatchEvent(
      new CustomEvent("terminal-focus-requested", {
        detail: { sessionId },
      }),
    );
  };

  const stageFile = async (file: string) => {
    try {
      await gitStage(rowProps.worktree.path, [file]);
    } catch (e) {
      console.error("git_stage failed", e);
    }
    void refreshStatus();
  };

  const unstageFile = async (file: string) => {
    try {
      await gitUnstage(rowProps.worktree.path, [file]);
    } catch (e) {
      console.error("git_unstage failed", e);
    }
    void refreshStatus();
  };

  const stageAll = async () => {
    try {
      await gitStage(rowProps.worktree.path, ["."]);
    } catch (e) {
      console.error("git_stage (all) failed", e);
    }
    void refreshStatus();
  };

  const unstageAll = async () => {
    try {
      await gitUnstage(rowProps.worktree.path, ["."]);
    } catch (e) {
      console.error("git_unstage (all) failed", e);
    }
    void refreshStatus();
  };

  const openDiff = (file: string, staged: boolean) => {
    setDiffTarget({ file, staged });
  };

  const absPath = (file: string) => `${rowProps.worktree.path}/${file}`;

  const openInEditor = (file: string) => {
    setEditorPath(absPath(file));
  };

  const revealFile = async (file: string) => {
    try {
      await revealItemInDir(absPath(file));
    } catch (e) {
      console.warn("revealItemInDir failed", e);
    }
  };

  const copyPath = async (file: string) => {
    try {
      await navigator.clipboard.writeText(absPath(file));
    } catch (e) {
      console.warn("clipboard.writeText failed", e);
    }
  };

  const confirmDiscard = async () => {
    const target = discardTarget();
    if (!target) return;
    setDiscardSubmitting(true);
    setDiscardError(null);
    try {
      if (target.kind === "file") {
        await gitDiscard(rowProps.worktree.path, [target.file]);
      } else {
        await gitDiscardAll(rowProps.worktree.path);
      }
      setDiscardTarget(null);
      void refreshStatus();
    } catch (e) {
      setDiscardError(String(e));
    } finally {
      setDiscardSubmitting(false);
    }
  };

  const submitCommit = () => {
    const draft = commitDraft();
    if (draft.trim() === "") return;
    const command = buildCommitCommand(draft);
    if (command === "") return;
    setPendingCommit({ command, since: Date.now() });
    window.dispatchEvent(
      new CustomEvent("raum:spawn-requested", {
        detail: {
          kind: "shell",
          projectSlug: rowProps.projectSlug,
          worktreeId: rowProps.worktree.path,
        },
      }),
    );
    setCommitDraft("");
  };

  // When a new shell session for this worktree appears in the terminal store
  // (created after we dispatched `raum:spawn-requested`), give the shell a
  // moment to print its prompt then paste + run the commit command.
  createEffect(() => {
    const pending = pendingCommit();
    if (!pending) return;
    // Scan only the (typically tiny) set of sessions attached to this
    // worktree instead of the whole terminal store.
    const ids = idsByWorktreeId().get(rowProps.worktree.path);
    const match = ids
      ? [...ids]
          .map((id) => terminalStore.byId[id])
          .find(
            (t) => t !== undefined && t.kind === "shell" && t.created_unix * 1000 >= pending.since,
          )
      : Object.values(terminalStore.byId).find(
          (t) =>
            t.worktree_id === rowProps.worktree.path &&
            t.kind === "shell" &&
            t.created_unix * 1000 >= pending.since,
        );
    if (!match) return;
    setPendingCommit(null);
    const sessionId = match.session_id;
    const keys = pending.command + "\n";
    window.setTimeout(() => {
      void invoke<void>("terminal_send_keys", { sessionId, keys }).catch((e) => {
        console.warn("terminal_send_keys failed", e);
      });
    }, 200);
  });

  const unstaged = createMemo(() => [...status().untracked, ...status().modified]);
  const canCommit = createMemo(() => commitDraft().trim().length > 0);

  // Derive a human-readable worktree name from the path (last path component).
  const worktreeName = createMemo(() => {
    const parts = rowProps.worktree.path.split("/");
    return parts[parts.length - 1] ?? rowProps.worktree.path;
  });

  const totalTerminals = createMemo(() => {
    const { active, waiting, idle } = harnessCounts();
    return active + waiting + idle;
  });

  const baseLabel = createMemo(() =>
    rowProps.isMain ? null : resolveBaseBranchLabel(rowProps.worktree, rowProps.mainBranchFallback),
  );
  const deleteTitle = createMemo(() =>
    rowProps.isMain ? "Unlink project from raum" : "Delete worktree",
  );

  return (
    <li class="group/wt relative select-none">
      {/* ---- Row header — single button: click = expand + set active ---- */}
      <button
        type="button"
        class="flex w-full items-start gap-1.5 rounded px-1.5 py-1.5 text-left hover:bg-hover"
        classList={{
          "bg-selected": rowProps.isActive,
        }}
        aria-expanded={expanded()}
        onClick={() => {
          setExpanded((v) => !v);
          setActiveWorktree(rowProps.projectSlug, rowProps.worktree.path);
        }}
      >
        {/* Expand indicator */}
        <span class="mt-0.5 shrink-0 font-mono text-[10px] text-foreground-dim" aria-hidden="true">
          {expanded() ? "▾" : "▸"}
        </span>

        {/* 2-line content */}
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Line 1 — worktree name + terminal state badges */}
          <span class="flex w-full items-center justify-between gap-2">
            <span class="flex min-w-0 items-center gap-1.5">
              <Show when={rowProps.projectColor}>
                {(c) => (
                  <span
                    class="inline-flex w-3 shrink-0 select-none items-center justify-center font-mono text-[11px] leading-none tabular-nums"
                    style={{ color: c() }}
                    aria-hidden="true"
                  >
                    {rowProps.projectSigil ?? "·"}
                  </span>
                )}
              </Show>
              <Show when={dirty()}>
                <span
                  class="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                  title="Dirty working tree"
                />
              </Show>
              <span
                class="truncate font-mono text-xs font-medium"
                classList={{
                  "text-foreground": rowProps.isActive,
                  "text-muted-foreground": !rowProps.isActive,
                }}
              >
                {worktreeName()}
              </span>
            </span>

            {/* Trailing slot — terminal badges; delete button is rendered
                absolutely over the row so it doesn't steal space when idle. */}
            <Show when={totalTerminals() > 0}>
              <HarnessCounter counts={harnessCounts()} compact />
            </Show>
          </span>

          {/* Line 2 — branch name + LOC stats */}
          <span class="flex w-full items-center justify-between gap-2">
            <span class="flex min-w-0 items-center gap-1 font-mono text-[10px] text-foreground-subtle">
              <span class="text-foreground-dim" aria-hidden="true">
                ⎇
              </span>
              <Show when={baseLabel()}>
                {(base) => (
                  <>
                    <span class="truncate text-foreground-dim">{base()}</span>
                    <span class="shrink-0 text-foreground-dim" aria-hidden="true">
                      →
                    </span>
                  </>
                )}
              </Show>
              <span class="truncate">{rowProps.worktree.branch ?? "(detached)"}</span>
            </span>
            <Show when={status().insertions > 0 || status().deletions > 0}>
              <span class="flex shrink-0 items-center gap-0.5 font-mono text-[10px]">
                <Show when={status().insertions > 0}>
                  <span class="text-success">+{status().insertions}</span>
                </Show>
                <Show when={status().deletions > 0}>
                  <span class="text-destructive">-{status().deletions}</span>
                </Show>
              </span>
            </Show>
          </span>
        </span>
      </button>

      {/* Row-level delete/unlink button — hover-revealed, top-right.
          Sits outside the main button so the click doesn't also expand
          the row or set the active worktree. */}
      <button
        type="button"
        class="absolute right-1 top-1 flex size-5 items-center justify-center rounded text-foreground-dim opacity-0 transition-opacity hover:bg-hover hover:text-destructive focus-visible:opacity-100 group-hover/wt:opacity-100"
        title={deleteTitle()}
        aria-label={deleteTitle()}
        onClick={(ev) => {
          ev.stopPropagation();
          rowProps.onRequestDelete();
        }}
      >
        <Show
          when={rowProps.isMain}
          fallback={
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="size-3.5"
              aria-hidden="true"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
              <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
            </svg>
          }
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="size-3.5"
            aria-hidden="true"
          >
            <path d="M18.84 12.25 11 20.09a5.5 5.5 0 0 1-7.78-7.78l1.41-1.41" />
            <path d="m5.16 11.75 7.84-7.84a5.5 5.5 0 0 1 7.78 7.78l-1.41 1.41" />
            <line x1="2" y1="2" x2="22" y2="22" />
          </svg>
        </Show>
      </button>

      <Show when={diffTarget() !== null}>
        <Suspense>
          <DiffViewerModal
            open={true}
            worktreePath={rowProps.worktree.path}
            file={diffTarget()?.file ?? null}
            staged={diffTarget()?.staged ?? false}
            onClose={() => setDiffTarget(null)}
          />
        </Suspense>
      </Show>

      {/* ---- Expanded section ---- */}
      <Show when={expanded()}>
        <div class="ml-5 mt-1 space-y-2 border-l border-border pl-2">
          {/* Commit box — always-visible, spawns a shell pane and runs
              `git commit -m '<subject>'` so the user sees it execute in-terminal.
              Styled to mirror the sidebar's "Filter worktrees" input. */}
          <div class="flex items-center gap-1">
            <input
              type="text"
              class="h-7 min-w-0 flex-1 rounded bg-selected px-2 text-[11px] text-foreground placeholder:text-foreground-dim focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Commit message…"
              value={commitDraft()}
              onInput={(e) => setCommitDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitCommit();
                }
              }}
              aria-label="Commit message"
            />
            <button
              type="button"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-selected text-muted-foreground hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title="Commit (opens a shell pane and runs git commit)"
              aria-label="Commit"
              disabled={!canCommit()}
              onClick={submitCommit}
            >
              <CheckIcon class="size-3.5" />
            </button>
          </div>

          {/* Git staging view */}
          <Show
            when={unstaged().length > 0 || status().staged.length > 0}
            fallback={
              <div class="px-1 py-1 font-mono text-[10px] italic text-foreground-dim">
                No changes
              </div>
            }
          >
            <div class="space-y-1.5">
              {/* Unstaged */}
              <Show when={unstaged().length > 0}>
                <div>
                  <div class="mb-0.5 flex items-center justify-between">
                    <span class="text-[10px] uppercase tracking-wide text-foreground-subtle">
                      Unstaged
                    </span>
                    <div class="flex items-center gap-0.5">
                      <button
                        type="button"
                        class="flex size-6 cursor-pointer items-center justify-center rounded text-foreground-subtle hover:bg-hover hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDiscardTarget({ kind: "all" });
                        }}
                        title="Discard all unstaged changes"
                        aria-label="Discard all unstaged changes"
                      >
                        <TrashGlyph class="size-3.5" />
                      </button>
                      <button
                        type="button"
                        class="flex size-6 cursor-pointer items-center justify-center rounded text-foreground-subtle hover:bg-hover hover:text-success"
                        onClick={(e) => {
                          e.stopPropagation();
                          void stageAll();
                        }}
                        title="Stage all"
                        aria-label="Stage all"
                      >
                        <PlusIcon class="size-3.5" />
                      </button>
                    </div>
                  </div>
                  <ul>
                    <For each={unstaged()}>
                      {(file) => {
                        const lastSlash = file.lastIndexOf("/");
                        const dir = lastSlash >= 0 ? file.slice(0, lastSlash) : "";
                        const name = lastSlash >= 0 ? file.slice(lastSlash + 1) : file;
                        return (
                          <li class="flex items-center justify-between gap-1 rounded px-1 py-0.5 hover:bg-hover">
                            <button
                              type="button"
                              class="flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-[11px] text-muted-foreground hover:text-foreground"
                              title={`View diff: ${file}`}
                              onClick={() => openDiff(file, false)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                setMenuTarget({
                                  file,
                                  staged: false,
                                  x: e.clientX,
                                  y: e.clientY,
                                });
                              }}
                            >
                              <FileTypeIcon name={file} class="size-3.5 shrink-0 opacity-75" />
                              <span class="min-w-0 flex-1 truncate">
                                <span>{name}</span>
                                <Show when={dir !== ""}>
                                  <span class="ml-1.5 text-[10px] text-foreground-dim">{dir}</span>
                                </Show>
                              </span>
                            </button>
                            <button
                              type="button"
                              class="flex size-5 shrink-0 items-center justify-center rounded text-success/80 hover:bg-hover hover:text-success"
                              onClick={() => void stageFile(file)}
                              title="Stage file"
                              aria-label="Stage file"
                            >
                              <PlusIcon class="size-3" />
                            </button>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </div>
              </Show>
              {/* Staged */}
              <Show when={status().staged.length > 0}>
                <div>
                  <div class="mb-0.5 flex items-center justify-between">
                    <span class="text-[10px] uppercase tracking-wide text-foreground-subtle">
                      Staged
                    </span>
                    <button
                      type="button"
                      class="flex size-6 cursor-pointer items-center justify-center rounded text-foreground-subtle hover:bg-hover hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        void unstageAll();
                      }}
                      title="Unstage all"
                      aria-label="Unstage all"
                    >
                      <MinusGlyph class="size-3.5" />
                    </button>
                  </div>
                  <ul>
                    <For each={status().staged}>
                      {(file) => {
                        const lastSlash = file.lastIndexOf("/");
                        const dir = lastSlash >= 0 ? file.slice(0, lastSlash) : "";
                        const name = lastSlash >= 0 ? file.slice(lastSlash + 1) : file;
                        return (
                          <li class="flex items-center justify-between gap-1 rounded px-1 py-0.5 hover:bg-hover">
                            <button
                              type="button"
                              class="flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-[11px] text-foreground hover:text-foreground"
                              title={`View diff: ${file}`}
                              onClick={() => openDiff(file, true)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                setMenuTarget({
                                  file,
                                  staged: true,
                                  x: e.clientX,
                                  y: e.clientY,
                                });
                              }}
                            >
                              <FileTypeIcon name={file} class="size-3.5 shrink-0 opacity-75" />
                              <span class="min-w-0 flex-1 truncate">
                                <span>{name}</span>
                                <Show when={dir !== ""}>
                                  <span class="ml-1.5 text-[10px] text-foreground-dim">{dir}</span>
                                </Show>
                              </span>
                            </button>
                            <button
                              type="button"
                              class="flex size-5 shrink-0 items-center justify-center rounded text-destructive/80 hover:bg-hover hover:text-destructive"
                              onClick={() => void unstageFile(file)}
                              title="Unstage file"
                              aria-label="Unstage file"
                            >
                              <MinusGlyph class="size-3" />
                            </button>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </div>
              </Show>
            </div>
          </Show>

          {/* Agents */}
          <AgentList items={agentsForWorktree()} onFocus={focusAgent} />
        </div>
      </Show>

      {/* Right-click context menu on a file row. Fixed positioning escapes any
          sidebar overflow clipping; closes on mouseleave or after an action. */}
      <Show when={menuTarget()}>
        {(target) => (
          <div
            class="floating-surface fixed z-50 w-44 rounded-xl border border-border bg-popover p-1 text-xs"
            role="menu"
            style={{ left: `${target().x}px`, top: `${target().y}px` }}
            onMouseLeave={() => setMenuTarget(null)}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              class="block w-full rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                openDiff(target().file, target().staged);
                setMenuTarget(null);
              }}
            >
              Open diff
            </button>
            <button
              type="button"
              class="block w-full rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                openInEditor(target().file);
                setMenuTarget(null);
              }}
            >
              Open file
            </button>
            <Show
              when={target().staged}
              fallback={
                <>
                  <button
                    type="button"
                    class="block w-full rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                    onClick={() => {
                      void stageFile(target().file);
                      setMenuTarget(null);
                    }}
                  >
                    Stage changes
                  </button>
                  <button
                    type="button"
                    class="block w-full rounded px-2 py-1 text-left text-destructive hover:bg-destructive/10"
                    onClick={() => {
                      setDiscardTarget({ kind: "file", file: target().file });
                      setMenuTarget(null);
                    }}
                  >
                    Discard changes
                  </button>
                </>
              }
            >
              <button
                type="button"
                class="block w-full rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  void unstageFile(target().file);
                  setMenuTarget(null);
                }}
              >
                Unstage changes
              </button>
            </Show>
            <button
              type="button"
              class="block w-full rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                void revealFile(target().file);
                setMenuTarget(null);
              }}
            >
              Reveal in Finder
            </button>
            <button
              type="button"
              class="block w-full rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                void copyPath(target().file);
                setMenuTarget(null);
              }}
            >
              Copy path
            </button>
          </div>
        )}
      </Show>

      {/* File editor modal — opened from the context menu "Open file" item. */}
      <Show when={editorPath() !== null}>
        <Suspense>
          <FileEditorModal open={true} path={editorPath()} onClose={() => setEditorPath(null)} />
        </Suspense>
      </Show>

      {/* Discard confirmation — single file or worktree-wide. */}
      <DiscardConfirmDialog
        target={discardTarget()}
        worktreeName={worktreeName()}
        unstagedCount={unstaged().length}
        submitting={discardSubmitting()}
        error={discardError()}
        onConfirm={() => void confirmDiscard()}
        onClose={() => {
          setDiscardTarget(null);
          setDiscardError(null);
        }}
      />
    </li>
  );
};

interface DiscardConfirmDialogProps {
  target: { kind: "file"; file: string } | { kind: "all" } | null;
  worktreeName: string;
  unstagedCount: number;
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

/** Confirmation dialog for destructive discards. Covers both per-file and
 *  worktree-wide ("Discard all") cases — the props tell which message to show. */
const DiscardConfirmDialog: Component<DiscardConfirmDialogProps> = (props) => {
  const isAll = () => props.target?.kind === "all";
  const fileName = () => (props.target?.kind === "file" ? props.target.file : "");
  return (
    <Dialog
      open={props.target !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) props.onClose();
      }}
    >
      <DialogPortal>
        <DialogContent class="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle class="text-sm">
              <Show when={isAll()} fallback={<>Discard changes to this file?</>}>
                Discard all unstaged changes?
              </Show>
            </DialogTitle>
          </DialogHeader>

          <div class="space-y-2 text-xs">
            <Show when={isAll()}>
              <p class="text-muted-foreground">
                This will revert every unstaged change in{" "}
                <span class="font-mono text-foreground">{props.worktreeName}</span> and remove
                untracked files. Staged changes are left alone. This cannot be undone.
              </p>
              <div class="rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                {props.unstagedCount} unstaged file
                {props.unstagedCount === 1 ? "" : "s"}
              </div>
            </Show>
            <Show when={!isAll()}>
              <p class="text-muted-foreground">
                Revert worktree changes to{" "}
                <span class="font-mono text-foreground">{fileName()}</span>. Untracked files are
                deleted. This cannot be undone.
              </p>
            </Show>
            <Show when={props.error}>
              <p class="text-destructive">{props.error}</p>
            </Show>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => props.onClose()}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={props.submitting}
              onClick={() => props.onConfirm()}
            >
              {props.submitting ? "Discarding…" : "Discard"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
};

interface AgentListProps {
  items: AgentListItem[];
  onFocus: (sessionId: string | null) => void;
}

const AgentList: Component<AgentListProps> = (listProps) => {
  return (
    <Show when={listProps.items.length > 0}>
      <div>
        <div class="text-[10px] uppercase tracking-wide text-foreground-subtle">Agents</div>
        <ul>
          <For each={listProps.items}>
            {(agent) => (
              <li>
                <button
                  type="button"
                  class="flex w-full items-center justify-between rounded px-1 py-0.5 text-left text-[11px] hover:bg-hover"
                  onClick={() => listProps.onFocus(agent.session_id)}
                >
                  <span class="truncate">{agent.harness}</span>
                  {/* Same icons as the top-right harness counter */}
                  <Show when={agent.state === "working"}>
                    <span class="ml-2 flex shrink-0 items-center text-success" title="working">
                      <LoaderIcon class="size-3 animate-spin" />
                    </span>
                  </Show>
                  <Show when={agent.state === "waiting"}>
                    <span class="ml-2 flex shrink-0 items-center text-warning" title="waiting">
                      <AlertCircleIcon class="size-3" />
                    </span>
                  </Show>
                  <Show when={agent.state === "idle"}>
                    <span
                      class="ml-2 flex shrink-0 items-center text-foreground-subtle"
                      title="idle"
                    >
                      <CheckIcon class="size-3" />
                    </span>
                  </Show>
                  <Show when={agent.state === "completed"}>
                    <span class="ml-2 flex shrink-0 items-center text-info" title="completed">
                      <CheckIcon class="size-3" />
                    </span>
                  </Show>
                  <Show when={agent.state === "errored"}>
                    <span class="ml-2 flex shrink-0 items-center text-destructive" title="errored">
                      <AlertCircleIcon class="size-3" />
                    </span>
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
};

// ---- All-terminals row -----------------------------------------------------

interface AllTerminalsRowProps {
  projectSlug: string;
  isActive: boolean;
  counts: HarnessCounts;
}

/**
 * Aggregate row at the top of a project's worktree list that represents
 * "every terminal for this project across every worktree". Clicking switches
 * the sidebar scope back to `all`, which drops the worktree-level prune in
 * the terminal grid.
 */
const AllTerminalsRow: Component<AllTerminalsRowProps> = (rowProps) => {
  const total = createMemo(() => {
    const c = rowProps.counts;
    return c.active + c.waiting + c.idle;
  });
  return (
    <li class="relative select-none">
      <button
        type="button"
        class="flex w-full items-center gap-1.5 rounded px-1.5 py-1.5 text-left hover:bg-hover"
        classList={{ "bg-selected": rowProps.isActive }}
        onClick={() => setActiveWorktreeAll(rowProps.projectSlug)}
        title="Show terminals across all worktrees; new spawns land in the project root"
      >
        <span class="mt-0.5 shrink-0 font-mono text-[10px] text-foreground-dim" aria-hidden="true">
          ∗
        </span>
        <span
          class="flex-1 truncate font-mono text-xs"
          classList={{
            "text-foreground": rowProps.isActive,
            "text-muted-foreground": !rowProps.isActive,
          }}
        >
          All terminals
        </span>
        <Show when={total() > 0}>
          <HarnessCounter counts={rowProps.counts} compact />
        </Show>
      </button>
    </li>
  );
};

// ---- Project section -------------------------------------------------------

interface ProjectSectionProps {
  project: ProjectListItem;
  worktreeFilter: string;
  /** When true, this section should open the create-worktree modal. */
  createOpen: boolean;
  /** Called when the modal closes or a worktree is created. */
  onCreateClose: () => void;
}

const ProjectSection: Component<ProjectSectionProps> = (sectionProps) => {
  const slug = createMemo(() => sectionProps.project.slug);
  const [worktrees, { refetch }] = createResource(
    () => ({ slug: slug(), v: useBranchesVersion(slug()) }),
    ({ slug: s }) => fetchWorktrees(s),
  );

  // Delete/unlink target — `null` means closed. `{ kind: "wt", wt }` opens
  // the worktree-delete modal; `{ kind: "project" }` opens the unlink modal
  // for this section's project root.
  const [deleteTarget, setDeleteTarget] = createSignal<
    { kind: "wt"; wt: Worktree } | { kind: "project" } | null
  >(null);
  const closeDeleteTarget = () => setDeleteTarget(null);

  const items = createMemo(() => {
    const cached = worktreesByProject()[slug()];
    if (cached) return cached;
    return worktrees() ?? [];
  });

  const filteredItems = createMemo<Worktree[]>(() => {
    const q = sectionProps.worktreeFilter.toLowerCase().trim();
    if (!q) return items();
    return items().filter(
      (wt) =>
        (wt.branch ?? "").toLowerCase().includes(q) ||
        wt.path.split("/").pop()?.toLowerCase().includes(q),
    );
  });

  const scope = createMemo<WorktreeScope>(
    () => activeWorktreeStore.byProject[slug()] ?? ALL_WORKTREES_SCOPE,
  );
  const activePath = createMemo(() => {
    const s = scope();
    return s.mode === "worktree" ? s.path : undefined;
  });
  const isAllActive = createMemo(() => scope().mode === "all");
  const projectHarnessCounts = createMemo(() => harnessCountsForProject(slug()));

  // Split filtered items into the main worktree (path === project rootPath)
  // and all added worktrees. Main is always rendered first.
  const mainWorktree = createMemo(
    () => filteredItems().find((wt) => wt.path === sectionProps.project.rootPath) ?? null,
  );
  const additionalWorktrees = createMemo(() =>
    filteredItems().filter((wt) => wt.path !== sectionProps.project.rootPath),
  );

  return (
    <section class="mb-2">
      <Show
        when={filteredItems().length > 0}
        fallback={
          <p class="px-2 py-1 text-[11px] text-foreground-dim">
            {items().length === 0 ? "No worktrees yet." : "No matching worktrees."}
          </p>
        }
      >
        {/* Card container — groups main + worktrees visually. The project
            identity (color, sigil, name) lives in the top-bar tab, so this
            section shows only the active project's root + worktrees. */}
        <div class="overflow-hidden rounded-md">
          {/* Aggregate "All terminals" row — same card chrome as main */}
          <div class="bg-card/30">
            <ul>
              <AllTerminalsRow
                projectSlug={slug()}
                isActive={isAllActive()}
                counts={projectHarnessCounts()}
              />
            </ul>
          </div>

          {/* Main worktree — slightly elevated background */}
          <Show when={mainWorktree()}>
            {(main) => (
              <div class="bg-card/30">
                <ul>
                  <WorktreeRow
                    worktree={main()}
                    projectSlug={slug()}
                    isActive={activePath() === main().path}
                    projectColor={sectionProps.project.color}
                    projectSigil={sectionProps.project.sigil}
                    isMain={true}
                    mainBranchFallback={main().branch}
                    onRequestDelete={() => setDeleteTarget({ kind: "project" })}
                  />
                </ul>
              </div>
            )}
          </Show>

          {/* Added worktrees */}
          <Show when={additionalWorktrees().length > 0}>
            <ul class="space-y-0.5 py-0.5">
              <For each={additionalWorktrees()}>
                {(wt) => (
                  <WorktreeRow
                    worktree={wt}
                    projectSlug={slug()}
                    isActive={activePath() === wt.path}
                    projectColor={sectionProps.project.color}
                    projectSigil={sectionProps.project.sigil}
                    isMain={false}
                    mainBranchFallback={mainWorktree()?.branch ?? null}
                    onRequestDelete={() => setDeleteTarget({ kind: "wt", wt })}
                  />
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
      <CreateWorktreeModal
        projectSlug={slug()}
        open={sectionProps.createOpen}
        onClose={sectionProps.onCreateClose}
        onCreated={() => {
          sectionProps.onCreateClose();
          void refetch();
        }}
      />

      {(() => {
        const target = deleteTarget();
        if (target === null) return null;
        if (target.kind === "wt") {
          return (
            <Suspense>
              <DeleteWorktreeModal
                open={true}
                projectSlug={slug()}
                worktree={target.wt}
                onClose={closeDeleteTarget}
                onDeleted={() => {
                  clearWorktreeListCache(slug());
                  void refetch();
                }}
              />
            </Suspense>
          );
        }
        return (
          <Suspense>
            <UnlinkProjectModal
              open={true}
              project={sectionProps.project}
              onClose={closeDeleteTarget}
              onUnlinked={() => {
                removeProject(slug());
                clearWorktreeListCache(slug());
              }}
            />
          </Suspense>
        );
      })()}
    </section>
  );
};

// ---- Resize handle (§9.7) --------------------------------------------------

interface ResizeHandleProps {
  onChange: (width: number) => void;
  onCommit: (width: number) => void;
  onDragChange: (active: boolean) => void;
  getWidth: () => number;
}

/**
 * Drag the right edge to resize. Pointer-move samples are coalesced via
 * `requestAnimationFrame` so we only push one width into the Solid signal per
 * frame, and the backend `config_set_sidebar_width` invoke is fired exactly
 * once on drag-end (via `onCommit`).
 */
const ResizeHandle: Component<ResizeHandleProps> = (handleProps) => {
  const [isDragging, setIsDragging] = createSignal(false);

  const onPointerDown = (ev: PointerEvent) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = handleProps.getWidth();
    let pending = startWidth;
    let rafId: number | null = null;

    const flush = () => {
      rafId = null;
      handleProps.onChange(pending);
    };

    const onMove = (move: PointerEvent) => {
      pending = Math.max(
        SIDEBAR_MIN_PX,
        Math.min(SIDEBAR_MAX_PX, startWidth + (move.clientX - startX)),
      );
      if (rafId === null) rafId = requestAnimationFrame(flush);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      handleProps.onChange(pending);
      handleProps.onDragChange(false);
      setIsDragging(false);
      handleProps.onCommit(pending);
    };
    handleProps.onDragChange(true);
    setIsDragging(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      class="sidebar-resize-handle"
      classList={{ "is-resizing": isDragging() }}
      onPointerDown={onPointerDown}
    />
  );
};

// ---- Sidebar root ----------------------------------------------------------

export const Sidebar: Component = () => {
  const [width, setWidth] = createSignal(280);
  const [collapsed, setCollapsed] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [worktreeFilter, setWorktreeFilter] = createSignal("");
  // Tracks which project slug has its create-worktree modal open (null = closed).
  const [createModalSlug, setCreateModalSlug] = createSignal<string | null>(null);
  // Track the last value we persisted so the drag-end commit doesn't echo
  // the value we just loaded from disk back through `config_set_sidebar_width`.
  // Initialised to `undefined` so the first persisted width always gets
  // skipped (we never write on hydrate, only on user-driven changes).
  let lastPersisted: number | undefined;

  // Hydrate the persisted width + collapsed flag from `config.toml`. Falls
  // back to defaults when Tauri is absent (unit tests).
  onMount(() => {
    void (async () => {
      try {
        const cfg = await invoke<{
          sidebar: { widthPx?: number; width_px?: number; collapsed?: boolean };
        }>("config_get");
        const raw = cfg.sidebar?.widthPx ?? cfg.sidebar?.width_px;
        if (typeof raw === "number" && raw > 0) {
          lastPersisted = raw;
          setWidth(raw);
        } else {
          lastPersisted = width();
        }
        if (cfg.sidebar?.collapsed === true) setCollapsed(true);
      } catch {
        // Tauri unavailable — defaults are fine, seed `lastPersisted` from
        // the default signal so the first drag still triggers a write.
        lastPersisted = width();
      }
    })();
    // Hydrate projects on first mount.
    void refreshProjects();
  });

  // §9.7 — register the `toggle-sidebar` keymap action. `useKeymapAction`
  // plugs into the Wave-3F provider (§12.4), which normalises the accelerator
  // from `~/.config/raum/keybindings.toml` and dispatches us on match.
  // Rendered outside the provider (e.g. in unit tests), `useKeymap` returns
  // a no-op API so this is a safe call.
  useKeymapAction("toggle-sidebar", () => setCollapsed((v) => !v));

  // Persist width back to `config.toml` exactly once per drag (on pointer-up
  // via `ResizeHandle.onCommit`). Skip any write that would echo the value we
  // just hydrated from disk, or repeat the last-persisted value.
  const commitWidth = (px: number) => {
    if (lastPersisted === undefined || lastPersisted === px) return;
    lastPersisted = px;
    void invoke<number>("config_set_sidebar_width", { width: px }).catch(() => {
      /* log-only */
    });
  };

  // Active project resolved from the top-bar tab. Both expanded and
  // collapsed views scope to this — the project-card chrome is gone from
  // the sidebar, so the tab at the top is the sole project identifier.
  const activeProject = createMemo(() =>
    projectStore.items.find((p) => p.slug === activeProjectSlug()),
  );

  // Fetch worktrees for the active project when collapsed so the mini-view
  // has data. When expanded, ProjectSection mounts its own resource.
  createEffect(() => {
    if (!collapsed()) return;
    const p = activeProject();
    if (p) void fetchWorktrees(p.slug);
  });

  const renderedWidth = createMemo(() => (collapsed() ? SIDEBAR_COLLAPSED_PX : width()));

  return (
    <Show when={!sidebarHidden()}>
      <aside
        class={`relative flex shrink-0 flex-col overflow-hidden bg-background text-xs text-muted-foreground${
          dragging() ? "" : " transition-[width] duration-100"
        }`}
        style={{ width: `${renderedWidth()}px` }}
      >
        {/* ---- Collapsed mini-view ------------------------------------------------ */}
        {/* Shows the same three-icon status counter as the top-right harness     */}
        {/* widget, scoped per worktree. Icons are coloured when count > 0 and    */}
        {/* dimmed to foreground-dim when 0 — identical semantics to the global widget */}
        {/* so users build one visual vocabulary across the whole UI.             */}
        <Show when={collapsed()}>
          <Scrollable class="flex flex-col py-1">
            <Show when={activeProject()}>
              {(project) => {
                const wts = createMemo(() => worktreesByProject()[project().slug] ?? []);
                const allCounts = createMemo(() => harnessCountsForProject(project().slug));
                const isAllActiveMini = createMemo(
                  () =>
                    (activeWorktreeStore.byProject[project().slug] ?? ALL_WORKTREES_SCOPE).mode ===
                    "all",
                );
                return (
                  <>
                    <button
                      type="button"
                      class="flex w-full items-center justify-center gap-0.5 rounded px-0.5 py-1.5 hover:bg-hover"
                      classList={{ "bg-selected": isAllActiveMini() }}
                      title={`All terminals — ${allCounts().active} active · ${allCounts().waiting} waiting · ${allCounts().idle} idle`}
                      onClick={() => setActiveWorktreeAll(project().slug)}
                    >
                      <span
                        class="font-mono text-[10px] leading-none"
                        classList={{
                          "text-foreground": isAllActiveMini(),
                          "text-foreground-dim": !isAllActiveMini(),
                        }}
                        aria-hidden="true"
                      >
                        ∗
                      </span>
                    </button>
                    <For each={wts()}>
                      {(wt) => {
                        const counts = createMemo(() => harnessCountsForWorktree(wt.path));

                        const isActiveWt = createMemo(() => {
                          const s =
                            activeWorktreeStore.byProject[project().slug] ?? ALL_WORKTREES_SCOPE;
                          return s.mode === "worktree" && s.path === wt.path;
                        });

                        const wtName = createMemo(() => {
                          const parts = wt.path.split("/");
                          return parts[parts.length - 1] ?? wt.path;
                        });

                        return (
                          <button
                            type="button"
                            class="flex w-full items-center justify-center gap-0.5 rounded px-0.5 py-1.5 hover:bg-hover"
                            classList={{ "bg-selected": isActiveWt() }}
                            title={`${wtName()} — ${counts().active} active · ${counts().waiting} waiting · ${counts().idle} idle`}
                            onClick={() => setActiveWorktree(project().slug, wt.path)}
                          >
                            {/* Active — spinning loader, emerald when > 0 */}
                            <span
                              class="flex items-center"
                              classList={{
                                "text-success": counts().active > 0,
                                "text-foreground-dim": counts().active === 0,
                              }}
                            >
                              <LoaderIcon
                                class="size-2.5"
                                classList={{ "animate-spin": counts().active > 0 }}
                              />
                            </span>
                            {/* Waiting — alert circle, amber when > 0 */}
                            <span
                              class="flex items-center"
                              classList={{
                                "text-warning": counts().waiting > 0,
                                "text-foreground-dim": counts().waiting === 0,
                              }}
                            >
                              <AlertCircleIcon class="size-2.5" />
                            </span>
                            {/* Idle — check, zinc when > 0 */}
                            <span
                              class="flex items-center"
                              classList={{
                                "text-muted-foreground": counts().idle > 0,
                                "text-foreground-dim": counts().idle === 0,
                              }}
                            >
                              <CheckIcon class="size-2.5" />
                            </span>
                          </button>
                        );
                      }}
                    </For>
                  </>
                );
              }}
            </Show>
          </Scrollable>
        </Show>

        <Show when={!collapsed()}>
          {/* Search + add row */}
          <div class="flex shrink-0 items-center gap-1 px-2 py-2">
            <input
              type="search"
              class="h-7 min-w-0 flex-1 rounded bg-selected px-2 text-[11px] text-foreground placeholder:text-foreground-dim focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Filter worktrees…"
              value={worktreeFilter()}
              onInput={(e) => setWorktreeFilter(e.currentTarget.value)}
              aria-label="Filter worktrees"
            />
            <button
              type="button"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-selected text-base leading-none text-muted-foreground hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title={activeProjectSlug() ? "New worktree" : "Select a project first"}
              disabled={!activeProjectSlug()}
              onClick={() => setCreateModalSlug(activeProjectSlug() ?? null)}
            >
              +
            </button>
          </div>
          <Scrollable class="min-h-0 flex-1 p-2">
            <Show
              when={activeProject()}
              fallback={<p class="px-2 text-foreground-dim">No projects registered yet.</p>}
            >
              {(project) => (
                <ProjectSection
                  project={project()}
                  worktreeFilter={worktreeFilter()}
                  createOpen={createModalSlug() === project().slug}
                  onCreateClose={() => setCreateModalSlug(null)}
                />
              )}
            </Show>
          </Scrollable>
          <ResizeHandle
            getWidth={() => width()}
            onChange={(next) => setWidth(next)}
            onCommit={commitWidth}
            onDragChange={setDragging}
          />
        </Show>
      </aside>
    </Show>
  );
};

export default Sidebar;
