/**
 * §9.1 / §9.2 — expandable worktree row.
 *
 * Owns:
 *   • the backend status-stream subscription (retain on mount, release on
 *     cleanup — live updates arrive via `worktree-status-changed` pushes).
 *   • dirty / ahead-behind / LOC indicators on the two header lines.
 *   • the expanded Changes / History / Files panel (`worktree-expanded.tsx`).
 *   • lazy-modal hosting (diff viewer, file editor) and per-row delete/merge
 *     buttons whose handlers are owned by the parent project section.
 */

import {
  Component,
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
} from "solid-js";
import {
  EMPTY_WORKTREE_STATUS,
  releaseWorktreeStatusStream,
  retainWorktreeStatusStream,
  setActiveWorktree,
  worktreeStatusByPath,
  type Worktree,
} from "../../stores/worktreeStore";
import { GitMergeIcon, LoaderIcon } from "../icons";
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from "../ui/tooltip";
import { HarnessCounter, countHarnessesForPaths } from "./harness-counter";
import { MainBranchPicker } from "./main-branch-picker";
import { WorktreeExpanded } from "./worktree-expanded";
import type { DiffTarget, WorktreeRowProps } from "./types";

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
 * Expanded section: Changes / History / Files behind a segmented switcher.
 */
export const WorktreeRow: Component<WorktreeRowProps> = (rowProps) => {
  const [expanded, setExpanded] = createSignal(false);
  const [diffTarget, setDiffTarget] = createSignal<DiffTarget | null>(null);
  const status = createMemo(
    () => worktreeStatusByPath()[rowProps.worktree.path] ?? EMPTY_WORKTREE_STATUS,
  );
  // No status yet = the backend seed push hasn't landed for this path.
  const statusPending = createMemo(
    () => worktreeStatusByPath()[rowProps.worktree.path] === undefined,
  );

  // FileEditorModal target — absolute path of the file to open. Null = closed.
  const [editorPath, setEditorPath] = createSignal<string | null>(null);

  // Main-worktree branch picker state. `null` = closed. Open carries the
  // anchor rect so the popover can align under the badge.
  const [branchPickerAnchor, setBranchPickerAnchor] = createSignal<{
    x: number;
    y: number;
  } | null>(null);

  // Stream live status for this path while the row is mounted (collapsed
  // headers show the dirty dot / ahead-behind / LOC, so visibility — not
  // expansion — is the subscription criterion). `createEffect` + `onCleanup`
  // covers unmount AND path changes in one place; the backend reconciles the
  // declarative set, so a remount can never leak a watch task.
  createEffect(() => {
    const path = rowProps.worktree.path;
    setDiffTarget(null);
    setEditorPath(null);
    retainWorktreeStatusStream(path);
    onCleanup(() => releaseWorktreeStatusStream(path));
  });

  const dirty = createMemo(() => status().dirty);

  // §8.3 / §9.x — count harnesses attached to *this* worktree. The authoritative
  // wiring lives in terminalStore; `worktree_id` is the worktree's filesystem
  // path (matches `wt.path`).
  const harnessCounts = createMemo(() => countHarnessesForPaths(new Set([rowProps.worktree.path])));

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

  const diffSource = (target: DiffTarget) =>
    target.mode === "commit"
      ? ({ kind: "commit", hash: target.hash, shortHash: target.shortHash } as const)
      : ({ kind: "worktree", staged: target.staged } as const);

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
              <Show when={statusPending()}>
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

      <Show when={diffTarget()}>
        {(target) => (
          <Suspense>
            <DiffViewerModal
              open={true}
              worktreePath={rowProps.worktree.path}
              file={target().file}
              source={diffSource(target())}
              onClose={() => setDiffTarget(null)}
            />
          </Suspense>
        )}
      </Show>

      {/* ---- Expanded section: Changes / History / Files ---- */}
      <Show when={expanded()}>
        <div class="ml-5 mt-1 border-l border-border pl-2">
          <WorktreeExpanded
            worktree={rowProps.worktree}
            projectSlug={rowProps.projectSlug}
            status={status()}
            statusPending={statusPending()}
            onOpenDiff={setDiffTarget}
            onOpenEditor={setEditorPath}
          />
        </div>
      </Show>

      {/* File editor modal — opened from the Changes context menu or the
          file browser. */}
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
    </li>
  );
};
