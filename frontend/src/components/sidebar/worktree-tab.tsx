/**
 * §2 / §9 — one worktree "vertical tab" in the sidebar accordion.
 *
 * The header IS the worktree's general info (sigil · name · branch · dirty ·
 * ahead/behind · LOC · terminal counts) and doubles as the accordion toggle;
 * the main worktree is pinned first and tagged as the local *base* repo. When
 * the tab is open it expands its own Changes / History / Files detail directly
 * beneath the header — entangled with the worktree, not floating as a general
 * handle — inside ONE focused `Scrollable` (no nested `max-h-64` momentum) that
 * fills the remaining sidebar height.
 *
 * Reconstructed from the retired `worktree-row.tsx` + `worktree-switcher-row.tsx`:
 *   • retains the live `worktree-status-changed` stream while mounted, so even
 *     collapsed headers show fresh dirty / ahead-behind / LOC.
 *   • hosts the per-worktree diff/editor modals and (main only) the branch
 *     picker — only the open tab can trigger them.
 */

import {
  Component,
  Match,
  Show,
  Suspense,
  Switch,
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
  worktreeStatusByPath,
  type Worktree,
} from "../../stores/worktreeStore";
import { createCountUp } from "../../lib/createCountUp";
import {
  AlertCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  GitMergeIcon,
  LoaderIcon,
} from "../icons";
import { Scrollable } from "../ui/scrollable";
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from "../ui/tooltip";
import { countHarnessesForPaths } from "./harness-counter";
import { MainBranchPicker } from "./main-branch-picker";
import { WorktreeDetail } from "./worktree-detail";
import type { DiffTarget, WorktreeTabProps } from "./types";

const DiffViewerModal = lazy(() =>
  import("../diff-viewer-modal").then((m) => ({ default: m.DiffViewerModal })),
);
const FileEditorModal = lazy(() =>
  import("../file-editor-modal").then((m) => ({ default: m.FileEditorModal })),
);

/**
 * Resolve the "sprouted from" base label for additional worktrees. Prefers the
 * explicit baseBranch, then the tracking upstream (stripped of `origin/`), then
 * the project's main branch. Returns null when it equals the worktree's own
 * branch (no useful arrow to draw).
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

export const WorktreeTab: Component<WorktreeTabProps> = (props) => {
  const [diffTarget, setDiffTarget] = createSignal<DiffTarget | null>(null);
  const [editorPath, setEditorPath] = createSignal<string | null>(null);
  // Abs path of the file most recently opened in the editor (Files active-file
  // highlight); local to this tab so each worktree tracks its own.
  const [activeEditorPath, setActiveEditorPath] = createSignal<string | null>(null);
  const [branchPickerAnchor, setBranchPickerAnchor] = createSignal<{ x: number; y: number } | null>(
    null,
  );

  const status = createMemo(
    () => worktreeStatusByPath()[props.worktree.path] ?? EMPTY_WORKTREE_STATUS,
  );
  const statusPending = createMemo(() => worktreeStatusByPath()[props.worktree.path] === undefined);

  // Tween the live diffstat so its +N / -M count up/down as files change in
  // this worktree, instead of snapping. The stream is already live (the retain
  // below), so these animate on every backend status push. Memo per field so an
  // unrelated status change (ahead/behind/dirty/stash) doesn't restart an
  // in-flight count — createMemo's `===` drops same-value notifications.
  const insertions = createMemo(() => status().insertions);
  const deletions = createMemo(() => status().deletions);
  const displayIns = createCountUp(insertions);
  const displayDel = createCountUp(deletions);

  // Live status while this tab is mounted (collapsed headers stay fresh).
  // `createEffect` + `onCleanup` covers unmount AND path changes in one place;
  // the backend reconciles the declarative set, so a remount never leaks a watch.
  createEffect(() => {
    const path = props.worktree.path;
    setDiffTarget(null);
    setEditorPath(null);
    retainWorktreeStatusStream(path);
    onCleanup(() => releaseWorktreeStatusStream(path));
  });

  const harnessCounts = createMemo(() => countHarnessesForPaths(new Set([props.worktree.path])));

  // The monogram tile doubles as the worktree's live harness indicator. A
  // *waiting* harness (needs you) outranks a *running* one, which outranks the
  // initial git-status load; with none of those it shows the project sigil.
  type TileState = "await" | "running" | "loading" | "idle";
  const tileState = createMemo<TileState>(() => {
    const { active, waiting } = harnessCounts();
    if (waiting > 0) return "await";
    if (active > 0) return "running";
    if (statusPending()) return "loading";
    return "idle";
  });
  const tileStyle = createMemo(() => {
    switch (tileState()) {
      case "await":
        return {
          "background-color": "color-mix(in oklab, var(--warning) 18%, var(--surface-sunken))",
          color: "var(--warning)",
        };
      case "running":
        return {
          "background-color": "color-mix(in oklab, var(--success) 18%, var(--surface-sunken))",
          color: "var(--success)",
        };
      default:
        return {
          "background-color": props.projectColor
            ? `color-mix(in oklab, ${props.projectColor} 16%, var(--surface-sunken))`
            : "var(--surface-sunken)",
          color: props.projectColor ?? "var(--foreground-subtle)",
        };
    }
  });

  const worktreeName = createMemo(() => {
    const parts = props.worktree.path.split("/");
    return parts[parts.length - 1] ?? props.worktree.path;
  });

  const baseLabel = createMemo(() =>
    props.isMain ? null : resolveBaseBranchLabel(props.worktree, props.mainBranchFallback),
  );
  const deleteTitle = createMemo(() =>
    props.isMain ? "Unlink project from raum" : "Delete worktree",
  );

  const openEditor = (absPath: string) => {
    setEditorPath(absPath);
    setActiveEditorPath(absPath);
  };

  const diffSource = (target: DiffTarget) =>
    target.mode === "commit"
      ? ({ kind: "commit", hash: target.hash, shortHash: target.shortHash } as const)
      : ({ kind: "worktree", staged: target.staged } as const);

  const openBranchPicker = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setBranchPickerAnchor({ x: r.left, y: r.bottom + 4 });
  };

  return (
    <li
      class="group/wt relative flex select-none flex-col"
      classList={{ "min-h-0 flex-1": props.isOpen, "shrink-0": !props.isOpen }}
    >
      {/* ---- Header — accordion toggle + worktree identity/state ---- */}
      <button
        type="button"
        class="flex w-full shrink-0 items-center gap-1.5 rounded px-1.5 py-1.5 text-left transition-[background-color,box-shadow] duration-150 hover:bg-hover"
        classList={{
          "bg-surface-raised shadow-[0_6px_18px_-8px_rgba(0,0,0,0.7)]": props.isActive,
          "bg-card/40": props.isMain && !props.isActive,
        }}
        aria-current={props.isActive ? "true" : undefined}
        aria-expanded={props.isOpen}
        onClick={() => props.onToggle()}
      >
        {/* Disclosure caret */}
        <span class="flex size-3 shrink-0 items-center justify-center text-foreground-dim">
          <Show when={props.isOpen} fallback={<ChevronRightIcon class="size-3" />}>
            <ChevronDownIcon class="size-3" />
          </Show>
        </span>

        {/* Monogram tile — the project sigil as a solid anchor, and the
            worktree's live harness indicator: it swaps the sigil for a running
            spinner (active) or a pulsing await glyph (waiting) and tints to
            match. Uncommitted changes are conveyed by the +/- diff column. */}
        <span
          class="relative flex size-7 shrink-0 items-center justify-center rounded-lg font-mono text-sm font-semibold leading-none"
          style={tileStyle()}
          aria-hidden="true"
        >
          <Switch fallback={props.projectSigil ?? "·"}>
            <Match when={tileState() === "await"}>
              <AlertCircleIcon class="size-4 animate-pulse text-warning" />
            </Match>
            <Match when={tileState() === "running"}>
              <LoaderIcon class="size-4 animate-spin text-success" />
            </Match>
            <Match when={tileState() === "loading"}>
              <LoaderIcon class="size-3.5 animate-spin text-foreground-dim" />
            </Match>
          </Switch>
        </span>

        {/* 2-line content */}
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Line 1 — name (+ base tag) */}
          <span class="flex w-full items-center gap-1.5">
            <span
              class="truncate font-mono text-xs font-medium"
              classList={{
                "text-foreground": props.isActive || props.isOpen,
                "text-muted-foreground": !props.isActive && !props.isOpen,
              }}
            >
              {worktreeName()}
            </span>
            <Show when={props.isMain}>
              <span
                class="shrink-0 rounded bg-surface-sunken px-1 py-px font-mono text-[8px] uppercase tracking-wide text-foreground-dim"
                title="The project's main repo — your local base branch"
              >
                base
              </span>
            </Show>
          </span>

          {/* Line 2 — branch (+ base→) + ahead/behind + LOC */}
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
                when={props.isMain && props.worktree.branch}
                fallback={<span class="truncate">{props.worktree.branch ?? "(detached)"}</span>}
              >
                {/* Main-worktree branch is a switch affordance. A `role=button`
                    span (not a nested <button>) keeps the markup valid inside the
                    header button while still opening the picker. */}
                <span
                  role="button"
                  tabindex="0"
                  class="group/branch focus-ring flex min-w-0 cursor-pointer items-center gap-0.5 truncate rounded px-1 -mx-1 hover:bg-hover hover:text-foreground"
                  title="Switch branch"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    openBranchPicker(ev.currentTarget);
                  }}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      ev.stopPropagation();
                      openBranchPicker(ev.currentTarget);
                    }
                  }}
                >
                  <span class="truncate">{props.worktree.branch}</span>
                  <span
                    class="shrink-0 text-foreground-dim opacity-60 transition-opacity group-hover/branch:opacity-100"
                    aria-hidden="true"
                  >
                    ▾
                  </span>
                </span>
              </Show>
            </span>
            <Show when={status().ahead > 0 || status().behind > 0}>
              <span class="flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-foreground-subtle">
                <Show when={status().ahead > 0}>
                  <span>↑{status().ahead}</span>
                </Show>
                <Show when={status().behind > 0}>
                  <span>↓{status().behind}</span>
                </Show>
              </span>
            </Show>
          </span>
        </span>

        {/* Right meta — net churn as a prominent stacked column, vertically
            centered against the whole card. Gate on the *displayed* (animating)
            value so a count-down to zero stays visible until the tween lands.
            Fades on hover so the merge / delete actions take the corner. */}
        <Show when={displayIns() > 0 || displayDel() > 0}>
          <span class="flex shrink-0 flex-col items-end gap-px font-mono text-[13px] leading-none tabular-nums transition-opacity duration-150 group-hover/wt:opacity-0">
            <Show when={displayIns() > 0}>
              <span class="text-success">+{displayIns()}</span>
            </Show>
            <Show when={displayDel() > 0}>
              <span class="text-destructive">-{displayDel()}</span>
            </Show>
          </span>
        </Show>
      </button>

      {/* Row-level action cluster (merge + delete/unlink) — hover-revealed,
          top-right. Outside the header button so a click doesn't toggle the tab. */}
      <div class="absolute right-1 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-100 focus-within:opacity-100 group-hover/wt:opacity-100">
        <Show when={!props.isMain && props.onRequestMerge}>
          <Tooltip>
            <TooltipTrigger
              as="button"
              type="button"
              class="flex size-5 items-center justify-center rounded text-foreground-dim transition-all duration-100 hover:bg-hover hover:text-success active:scale-90"
              aria-label="Merge worktree into its base branch"
              onClick={(ev: MouseEvent) => {
                ev.stopPropagation();
                props.onRequestMerge?.();
              }}
            >
              <GitMergeIcon class="size-3" />
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
              props.onRequestDelete();
            }}
          >
            <Show
              when={props.isMain}
              fallback={
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="size-3"
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
                class="size-3"
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

      {/* ---- Expanded detail — Changes / History / Files in ONE focused scroll ---- */}
      <Show when={props.isOpen}>
        <div class="mt-0.5 flex min-h-0 flex-1 flex-col">
          <Scrollable axis="y" class="min-h-0 flex-1">
            <WorktreeDetail
              worktree={props.worktree}
              projectSlug={props.projectSlug}
              status={status()}
              statusPending={statusPending()}
              onOpenDiff={setDiffTarget}
              onOpenEditor={openEditor}
              activeEditorPath={activeEditorPath()}
            />
          </Scrollable>
        </div>
      </Show>

      {/* Diff viewer — opened from Changes / History / Files rows. */}
      <Show when={diffTarget()}>
        {(target) => (
          <Suspense>
            <DiffViewerModal
              open={true}
              worktreePath={props.worktree.path}
              file={target().file}
              source={diffSource(target())}
              onClose={() => setDiffTarget(null)}
            />
          </Suspense>
        )}
      </Show>

      {/* File editor — opened from the Changes context menu or the Files tree. */}
      <Show when={editorPath() !== null}>
        <Suspense>
          <FileEditorModal open={true} path={editorPath()} onClose={() => setEditorPath(null)} />
        </Suspense>
      </Show>

      {/* Main-worktree branch picker — click the branch badge on line 2. */}
      <Show when={props.isMain && branchPickerAnchor()}>
        {(anchor) => (
          <MainBranchPicker
            projectSlug={props.projectSlug}
            anchor={anchor()}
            onClose={() => setBranchPickerAnchor(null)}
          />
        )}
      </Show>
    </li>
  );
};
