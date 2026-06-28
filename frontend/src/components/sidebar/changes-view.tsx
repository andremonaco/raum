/**
 * §9.5 — the Changes view of an open worktree tab. A source-control panel
 * that owns:
 *   • a Commit button that opens a harness picker; the chosen agent spawns in
 *     this worktree, pre-loaded with a prompt to review the changes and create
 *     logical, file-whole commits per the project's conventions (no message
 *     box — the agent writes them).
 *   • collapsible, sticky "Staged"/"Changed" groups with count chips, status
 *     letters, per-file +/− counts, click-to-diff, and a context menu; the
 *     group headers carry hover-revealed bulk stage/unstage/discard actions.
 *   • per-file stage, unstage, and discard (with confirmation), plus inline
 *     hover stage/discard affordances on the rows.
 *
 * Single scroll: this view renders a flat `<div>` into the worktree tab's one
 * Scrollable (no inner `max-h-64`); the sticky group headers pin against that
 * viewport.
 *
 * No manual status refreshes: the backend nudges its status service after
 * every successful git mutation and pushes a `worktree-status-changed`
 * event, which lands in `worktreeStore` and re-renders these lists.
 */

import { Component, For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

import { splitChanges } from "../../lib/gitChangeDisplay";
import type { AgentKind } from "../../stores/agentStore";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, LoaderIcon, PlusIcon } from "../icons";
import { CommitHarnessDialog } from "./commit-harness-dialog";
import { DiscardConfirmDialog } from "./discard-confirm-dialog";
import { FileChangeRow } from "./file-change-row";
import { gitDiscard, gitDiscardAll, gitStage, gitUnstage } from "./git-commands";
import { MinusGlyph, TrashGlyph } from "./glyphs";
import { RaumLogo } from "./main-branch-picker";
import type { ChangesViewProps } from "./types";

// Instruction handed to the spawned harness. It inspects the worktree's own
// uncommitted changes and commits them in logical, file-whole commits so each
// commit is self-consistent and safe.
const COMMIT_PROMPT = [
  "Review the uncommitted changes in this git worktree and commit them for me.",
  "",
  "- Inspect the work first: run `git status` and `git diff` (both staged and unstaged) to understand what changed.",
  "- Group the changes into logical commits by feature or fix. If the work spans more than one distinct feature or fix, make multiple commits — one per logical unit.",
  "- NEVER split a single file across commits. Stage whole files only (no `git add -p` / hunk or patch splitting) so every commit is self-consistent and builds.",
  "- Follow this project's commit conventions (check AGENTS.md / CLAUDE.md and recent `git log` for the message style).",
  "- Create the commit(s). Do not push.",
].join("\n");

export const ChangesView: Component<ChangesViewProps> = (props) => {
  // Right-click context menu on file rows. Coordinates are viewport-relative
  // (clientX/Y); the menu renders with `position: fixed`.
  const [menuTarget, setMenuTarget] = createSignal<{
    file: string;
    staged: boolean;
    x: number;
    y: number;
  } | null>(null);

  // Pending discard confirmation. Either a single file or the bulk sweep.
  const [discardTarget, setDiscardTarget] = createSignal<
    { kind: "file"; file: string } | { kind: "all" } | null
  >(null);
  const [discardError, setDiscardError] = createSignal<string | null>(null);
  const [discardSubmitting, setDiscardSubmitting] = createSignal(false);

  // Per-group collapse state.
  const [stagedCollapsed, setStagedCollapsed] = createSignal(false);
  const [unstagedCollapsed, setUnstagedCollapsed] = createSignal(false);

  // Reset transient UI when this view is re-targeted at another worktree.
  createEffect(() => {
    void props.worktree.path;
    setMenuTarget(null);
    setDiscardTarget(null);
    setDiscardError(null);
    setStagedCollapsed(false);
    setUnstagedCollapsed(false);
  });

  const buckets = createMemo(() => splitChanges(props.status.changes));
  const unstaged = createMemo(() => buckets().unstaged);
  const staged = createMemo(() => buckets().staged);
  const hasChanges = createMemo(() => buckets().unstaged.length > 0 || buckets().staged.length > 0);

  const stageFile = async (file: string) => {
    try {
      await gitStage(props.worktree.path, [file]);
    } catch (e) {
      console.error("git_stage failed", e);
    }
  };

  const unstageFile = async (file: string) => {
    try {
      await gitUnstage(props.worktree.path, [file]);
    } catch (e) {
      console.error("git_unstage failed", e);
    }
  };

  const stageAll = async () => {
    try {
      await gitStage(props.worktree.path, ["."]);
    } catch (e) {
      console.error("git_stage (all) failed", e);
    }
  };

  const unstageAll = async () => {
    try {
      await gitUnstage(props.worktree.path, ["."]);
    } catch (e) {
      console.error("git_unstage (all) failed", e);
    }
  };

  const absPath = (file: string) => `${props.worktree.path}/${file}`;

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

  // `file` is already worktree-relative — copy it verbatim.
  const copyRelativePath = async (file: string) => {
    try {
      await navigator.clipboard.writeText(file);
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
        await gitDiscard(props.worktree.path, [target.file]);
      } else {
        await gitDiscardAll(props.worktree.path);
      }
      setDiscardTarget(null);
    } catch (e) {
      setDiscardError(String(e));
    } finally {
      setDiscardSubmitting(false);
    }
  };

  // Commit opens a harness picker; choosing a harness spawns it in this worktree
  // pre-loaded with the commit prompt. The agent reviews the changes and writes
  // the commits itself (logical, file-whole) — there is no message box.
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const commitWith = (kind: AgentKind) => {
    setPickerOpen(false);
    window.dispatchEvent(
      new CustomEvent("raum:spawn-requested", {
        detail: {
          kind,
          projectSlug: props.projectSlug,
          worktreeId: props.worktree.path,
          initialPrompt: COMMIT_PROMPT,
        },
      }),
    );
  };

  return (
    <div class="flex flex-col gap-2 pt-2">
      {/* Commit — opens a harness picker; the chosen agent reviews the changes
          and writes logical, file-whole commits. No message box. */}
      <button
        type="button"
        class="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-selected text-[11px] font-medium text-foreground transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-foreground-dim"
        title="Commit — pick an agent to review the changes and commit them in logical, file-whole commits"
        aria-label="Commit changes with an agent"
        disabled={!hasChanges()}
        onClick={() => setPickerOpen(true)}
      >
        <CheckIcon class="size-3.5" />
        <span>Commit</span>
      </button>

      {/* Git staging view */}
      <Show
        when={!props.statusPending}
        fallback={
          <div class="flex items-center gap-1.5 px-1 py-1 font-mono text-[10px] text-foreground-dim">
            <LoaderIcon class="size-3 animate-spin" />
            <span>Loading changes…</span>
          </div>
        }
      >
        <Show
          when={buckets().unstaged.length > 0 || buckets().staged.length > 0}
          fallback={
            <div class="px-1 py-1 font-mono text-[10px] italic text-foreground-dim">No changes</div>
          }
        >
          <div class="flex flex-col gap-1.5">
            {/* Staged group — sticky, collapsible; bulk action on hover. */}
            <Show when={staged().length > 0}>
              <div class="flex flex-col">
                <div class="group/sg sticky top-8 z-10 flex items-center bg-background pr-1">
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-1 px-1 py-1 text-left"
                    aria-expanded={!stagedCollapsed()}
                    onClick={() => setStagedCollapsed((v) => !v)}
                  >
                    <Show
                      when={stagedCollapsed()}
                      fallback={<ChevronDownIcon class="size-3 shrink-0 text-foreground-dim" />}
                    >
                      <ChevronRightIcon class="size-3 shrink-0 text-foreground-dim" />
                    </Show>
                    <span class="text-[11px] font-medium text-foreground-subtle">Staged</span>
                    <span class="text-[11px] tabular-nums text-foreground-dim">
                      {staged().length}
                    </span>
                  </button>
                  {/* Unstage all — hover-revealed. */}
                  <button
                    type="button"
                    class="flex size-5 shrink-0 items-center justify-center rounded text-foreground-dim opacity-0 transition hover:bg-hover hover:text-foreground focus-visible:opacity-100 group-hover/sg:opacity-100"
                    title="Unstage all"
                    aria-label="Unstage all files"
                    onClick={() => void unstageAll()}
                  >
                    <MinusGlyph class="size-3" />
                  </button>
                </div>
                <Show when={!stagedCollapsed()}>
                  <ul>
                    <For each={staged()}>
                      {(change) => (
                        <FileChangeRow
                          path={change.path}
                          origPath={change.origPath}
                          kind={change.kind}
                          insertions={change.insertions}
                          deletions={change.deletions}
                          emphasized
                          onOpen={() =>
                            props.onOpenDiff({ mode: "worktree", file: change.path, staged: true })
                          }
                          onContextMenu={(e) =>
                            setMenuTarget({
                              file: change.path,
                              staged: true,
                              x: e.clientX,
                              y: e.clientY,
                            })
                          }
                        >
                          <button
                            type="button"
                            class="flex size-5 shrink-0 items-center justify-center rounded text-destructive/80 opacity-0 hover:bg-hover hover:text-destructive focus-visible:opacity-100 group-hover/file:opacity-100"
                            onClick={() => void unstageFile(change.path)}
                            title="Unstage file"
                            aria-label="Unstage file"
                          >
                            <MinusGlyph class="size-3" />
                          </button>
                        </FileChangeRow>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
            </Show>

            {/* Changed (unstaged) group — sticky, collapsible; bulk actions on hover. */}
            <Show when={unstaged().length > 0}>
              <div class="flex flex-col">
                <div class="group/cg sticky top-8 z-10 flex items-center bg-background pr-1">
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-1 px-1 py-1 text-left"
                    aria-expanded={!unstagedCollapsed()}
                    onClick={() => setUnstagedCollapsed((v) => !v)}
                  >
                    <Show
                      when={unstagedCollapsed()}
                      fallback={<ChevronDownIcon class="size-3 shrink-0 text-foreground-dim" />}
                    >
                      <ChevronRightIcon class="size-3 shrink-0 text-foreground-dim" />
                    </Show>
                    <span class="text-[11px] font-medium text-foreground-subtle">Changed</span>
                    <span class="text-[11px] tabular-nums text-foreground-dim">
                      {unstaged().length}
                    </span>
                  </button>
                  {/* Stage all + Discard all — hover-revealed. */}
                  <button
                    type="button"
                    class="flex size-5 shrink-0 items-center justify-center rounded text-foreground-dim opacity-0 transition hover:bg-hover hover:text-success focus-visible:opacity-100 group-hover/cg:opacity-100"
                    title="Stage all"
                    aria-label="Stage all files"
                    onClick={() => void stageAll()}
                  >
                    <PlusIcon class="size-3" />
                  </button>
                  <button
                    type="button"
                    class="flex size-5 shrink-0 items-center justify-center rounded text-foreground-dim opacity-0 transition hover:bg-hover hover:text-destructive focus-visible:opacity-100 group-hover/cg:opacity-100"
                    title="Discard all changes"
                    aria-label="Discard all changes"
                    onClick={() => setDiscardTarget({ kind: "all" })}
                  >
                    <TrashGlyph class="size-3" />
                  </button>
                </div>
                <Show when={!unstagedCollapsed()}>
                  <ul>
                    <For each={unstaged()}>
                      {(change) => (
                        <FileChangeRow
                          path={change.path}
                          origPath={change.origPath}
                          kind={change.kind}
                          insertions={change.insertions}
                          deletions={change.deletions}
                          onOpen={() =>
                            props.onOpenDiff({ mode: "worktree", file: change.path, staged: false })
                          }
                          onContextMenu={(e) =>
                            setMenuTarget({
                              file: change.path,
                              staged: false,
                              x: e.clientX,
                              y: e.clientY,
                            })
                          }
                        >
                          {/* Inline stage (+) — so staging is one click from the row. */}
                          <button
                            type="button"
                            class="flex size-5 shrink-0 items-center justify-center rounded text-success/80 opacity-0 hover:bg-hover hover:text-success focus-visible:opacity-100 group-hover/file:opacity-100"
                            onClick={() => void stageFile(change.path)}
                            title="Stage file"
                            aria-label="Stage file"
                          >
                            <PlusIcon class="size-3" />
                          </button>
                          {/* Inline discard (trash) — not context-menu-only. */}
                          <button
                            type="button"
                            class="flex size-5 shrink-0 items-center justify-center rounded text-destructive/80 opacity-0 hover:bg-hover hover:text-destructive focus-visible:opacity-100 group-hover/file:opacity-100"
                            onClick={() => setDiscardTarget({ kind: "file", file: change.path })}
                            title="Discard changes"
                            aria-label="Discard changes"
                          >
                            <TrashGlyph class="size-3" />
                          </button>
                        </FileChangeRow>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
            </Show>

            <Show when={props.status.truncated}>
              <div class="px-1 font-mono text-[10px] italic text-foreground-dim">
                Showing the first 1000 changes
              </div>
            </Show>
          </div>
        </Show>
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
                  props.onOpenEditor(absPath(target().file));
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
                  props.onOpenDiff({
                    mode: "worktree",
                    file: target().file,
                    staged: target().staged,
                  });
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
              <button
                type="button"
                class="block w-full rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  void copyRelativePath(target().file);
                  setMenuTarget(null);
                }}
              >
                Copy relative path
              </button>
            </div>
          </Portal>
        )}
      </Show>

      {/* Discard confirmation — single file or worktree-wide. */}
      <DiscardConfirmDialog
        target={discardTarget()}
        worktreeName={props.worktree.path.split("/").pop() ?? props.worktree.path}
        unstagedCount={buckets().unstaged.length}
        submitting={discardSubmitting()}
        error={discardError()}
        onConfirm={() => void confirmDiscard()}
        onClose={() => {
          setDiscardTarget(null);
          setDiscardError(null);
        }}
      />

      {/* Harness picker for the Commit action. */}
      <CommitHarnessDialog
        open={pickerOpen()}
        onClose={() => setPickerOpen(false)}
        onPick={commitWith}
      />
    </div>
  );
};
