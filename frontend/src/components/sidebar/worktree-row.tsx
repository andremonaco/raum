/**
 * §9.1 / §9.2 — expandable worktree row.
 *
 * Owns:
 *   • status polling (every `STATUS_POLL_MS`).
 *   • dirty / ahead-behind / LOC indicators.
 *   • staged + unstaged file groups, click-to-diff and right-click context menu.
 *   • commit-box that spawns a shell pane and runs `git commit -m '…'`.
 *   • lazy-modal spawning (diff viewer, file editor) and per-row delete/merge
 *     buttons whose handlers are owned by the parent project section.
 */

import {
  Component,
  For,
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { FileTypeIcon } from "../../lib/fileTypeIcon";
import {
  EMPTY_WORKTREE_STATUS,
  refreshWorktreeStatus,
  refreshWorktreeStatuses,
  setActiveWorktree,
  worktreeStatusByPath,
  worktreeStatusLoadingPaths,
  type Worktree,
} from "../../stores/worktreeStore";
import { idsByWorktreeId, terminalStore } from "../../stores/terminalStore";
import { CheckIcon, GitMergeIcon, LoaderIcon, PlusIcon } from "../icons";
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from "../ui/tooltip";
import { STATUS_POLL_MS } from "./constants";
import { DiscardConfirmDialog } from "./discard-confirm-dialog";
import {
  buildCommitCommand,
  gitDiscard,
  gitDiscardAll,
  gitStage,
  gitUnstage,
} from "./git-commands";
import { MinusGlyph, TrashGlyph } from "./glyphs";
import { HarnessCounter, countHarnessesForPaths } from "./harness-counter";
import { MainBranchPicker, RaumLogo } from "./main-branch-picker";
import type { WorktreeRowProps } from "./types";

const DiffViewerModal = lazy(() =>
  import("../diff-viewer-modal").then((m) => ({ default: m.DiffViewerModal })),
);
const FileEditorModal = lazy(() =>
  import("../file-editor-modal").then((m) => ({ default: m.FileEditorModal })),
);

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
 * Expanded section: git staging view (stage/unstage per file + bulk).
 */
export const WorktreeRow: Component<WorktreeRowProps> = (rowProps) => {
  const [expanded, setExpanded] = createSignal(false);
  const [diffTarget, setDiffTarget] = createSignal<{ file: string; staged: boolean } | null>(null);
  const status = createMemo(
    () => worktreeStatusByPath()[rowProps.worktree.path] ?? EMPTY_WORKTREE_STATUS,
  );
  const hasStatus = createMemo(() => worktreeStatusByPath()[rowProps.worktree.path] !== undefined);
  const statusLoading = createMemo(() => worktreeStatusLoadingPaths().has(rowProps.worktree.path));
  const initialStatusLoading = createMemo(() => statusLoading() && !hasStatus());

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

  // Main-worktree branch picker state. `null` = closed. Open carries the
  // anchor rect so the popover can align under the badge.
  const [branchPickerAnchor, setBranchPickerAnchor] = createSignal<{
    x: number;
    y: number;
  } | null>(null);

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

  const runPoll = async () => {
    await refreshWorktreeStatus(rowProps.worktree.path);
  };

  // Bypasses the `inFlight` gate so an explicit user action (stage, unstage,
  // discard) always sees its own result even when the 2 s poll happens to be
  // running at the same moment.
  const refreshStatus = async () => {
    await refreshWorktreeStatus(rowProps.worktree.path);
  };

  createEffect(() => {
    const path = rowProps.worktree.path;
    setDiffTarget(null);
    setMenuTarget(null);
    setEditorPath(null);
    void untrack(() => refreshWorktreeStatuses([path], { onlyMissing: true }));
  });

  onMount(() => {
    void runPoll();
    const handle = window.setInterval(() => {
      void runPoll();
    }, STATUS_POLL_MS);
    onCleanup(() => window.clearInterval(handle));
  });

  const dirty = createMemo(() => status().dirty);

  // §8.3 / §9.x — count harnesses attached to *this* worktree. The authoritative
  // wiring lives in terminalStore; `worktree_id` is the worktree's filesystem
  // path (matches `wt.path`).
  const harnessCounts = createMemo(() => countHarnessesForPaths(new Set([rowProps.worktree.path])));

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

  const openFileNative = async (file: string) => {
    try {
      await openPath(absPath(file));
    } catch (e) {
      console.warn("openPath failed", e);
    }
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
          "sidebar-row-active": rowProps.isActive,
        }}
        aria-current={rowProps.isActive ? "true" : undefined}
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
              <Show when={initialStatusLoading()}>
                <LoaderIcon
                  class="size-3 shrink-0 animate-spin text-foreground-dim"
                  aria-label="Loading git status"
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
                absolutely over the row so it doesn't steal space when idle.
                On row hover, fade the badges out so the unlink/delete button
                (same right-edge area) is clearly visible. */}
            <Show when={totalTerminals() > 0}>
              <span class="transition-opacity duration-150 group-hover/wt:opacity-0">
                <HarnessCounter counts={harnessCounts()} compact />
              </span>
            </Show>
          </span>

          {/* Line 2 — branch name + ahead/behind + LOC stats */}
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
              <Show
                when={rowProps.isMain && rowProps.worktree.branch}
                fallback={<span class="truncate">{rowProps.worktree.branch ?? "(detached)"}</span>}
              >
                <button
                  type="button"
                  class="group/branch focus-ring flex min-w-0 items-center gap-0.5 truncate rounded px-1 -mx-1 hover:bg-hover hover:text-foreground"
                  title="Switch branch"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    const r = ev.currentTarget.getBoundingClientRect();
                    setBranchPickerAnchor({ x: r.left, y: r.bottom + 4 });
                  }}
                >
                  <span class="truncate">{rowProps.worktree.branch}</span>
                  <span
                    class="shrink-0 text-foreground-dim opacity-60 transition-opacity group-hover/branch:opacity-100"
                    aria-hidden="true"
                  >
                    ▾
                  </span>
                </button>
              </Show>
            </span>
            <span class="flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
              <Show when={status().ahead > 0 || status().behind > 0}>
                <span class="flex items-center gap-0.5 text-foreground-subtle">
                  <Show when={status().ahead > 0}>
                    <span>↑{status().ahead}</span>
                  </Show>
                  <Show when={status().behind > 0}>
                    <span>↓{status().behind}</span>
                  </Show>
                </span>
              </Show>
              <Show when={status().insertions > 0 || status().deletions > 0}>
                <span class="flex items-center gap-0.5">
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
        </span>
      </button>

      {/* Row-level action cluster (merge + delete/unlink) — hover-revealed,
          top-right. Sits outside the main button so a click doesn't also
          expand the row or set the active worktree. */}
      <div class="absolute right-1 top-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-100 focus-within:opacity-100 group-hover/wt:opacity-100">
        <Show when={!rowProps.isMain && rowProps.onRequestMerge}>
          <Tooltip>
            <TooltipTrigger
              as="button"
              type="button"
              class="flex size-5 items-center justify-center rounded text-foreground-dim transition-all duration-100 hover:bg-hover hover:text-success active:scale-90"
              aria-label="Merge worktree into its base branch"
              onClick={(ev: MouseEvent) => {
                ev.stopPropagation();
                rowProps.onRequestMerge?.();
              }}
            >
              <GitMergeIcon class="size-3.5" />
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent>Merge into base branch</TooltipContent>
            </TooltipPortal>
          </Tooltip>
        </Show>
        <Tooltip>
          <TooltipTrigger
            as="button"
            type="button"
            class="flex size-5 items-center justify-center rounded text-foreground-dim transition-all duration-100 hover:bg-hover hover:text-destructive active:scale-90"
            aria-label={deleteTitle()}
            onClick={(ev: MouseEvent) => {
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
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent>{deleteTitle()}</TooltipContent>
          </TooltipPortal>
        </Tooltip>
      </div>

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
            when={!initialStatusLoading()}
            fallback={
              <div class="flex items-center gap-1.5 px-1 py-1 font-mono text-[10px] text-foreground-dim">
                <LoaderIcon class="size-3 animate-spin" />
                <span>Loading changes...</span>
              </div>
            }
          >
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
                                    <span class="ml-1.5 text-[10px] text-foreground-dim">
                                      {dir}
                                    </span>
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
                                    <span class="ml-1.5 text-[10px] text-foreground-dim">
                                      {dir}
                                    </span>
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
          </Show>
        </div>
      </Show>

      {/* Right-click context menu on a file row. Portalled + fixed-positioned
          so it escapes any sidebar stacking context / overflow clipping;
          closes on mouseleave or after an action. */}
      <Show when={menuTarget()}>
        {(target) => (
          <Portal>
            <div
              class="floating-surface fixed z-[70] w-44 rounded-xl border border-border bg-popover p-1 text-xs"
              role="menu"
              style={{ left: `${target().x}px`, top: `${target().y}px` }}
              onMouseLeave={() => setMenuTarget(null)}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                class="block w-full rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  void openFileNative(target().file);
                  setMenuTarget(null);
                }}
              >
                Open file
              </button>
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  openInEditor(target().file);
                  setMenuTarget(null);
                }}
              >
                <RaumLogo class="size-3.5 shrink-0 text-foreground" />
                <span>Open in raum</span>
              </button>
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
          </Portal>
        )}
      </Show>

      {/* File editor modal — opened from the context menu "Open file" item. */}
      <Show when={editorPath() !== null}>
        <Suspense>
          <FileEditorModal open={true} path={editorPath()} onClose={() => setEditorPath(null)} />
        </Suspense>
      </Show>

      {/* Main-worktree branch picker — click the ⎇ badge on the main row. */}
      <Show when={rowProps.isMain && branchPickerAnchor()}>
        {(anchor) => (
          <MainBranchPicker
            projectSlug={rowProps.projectSlug}
            anchor={anchor()}
            onClose={() => setBranchPickerAnchor(null)}
          />
        )}
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
