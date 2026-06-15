/**
 * §9.2 — the Changes tab of an expanded worktree row (extracted from
 * `worktree-row.tsx`). Owns:
 *   • the commit box that spawns a shell pane and runs `git commit -m '…'`.
 *   • staged + unstaged file groups with status letters and per-file
 *     +/− counts; click-to-diff; right-click context menu.
 *   • per-file / bulk stage, unstage, and discard (with confirmation).
 *
 * No manual status refreshes: the backend nudges its status service after
 * every successful git mutation and pushes a `worktree-status-changed`
 * event, which lands in `worktreeStore` and re-renders these lists.
 */

import { Component, For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

import { splitChanges } from "../../lib/gitChangeDisplay";
import { idsByWorktreeId, terminalStore } from "../../stores/terminalStore";
import { CheckIcon, LoaderIcon, PlusIcon } from "../icons";
import { Scrollable } from "../ui/scrollable";
import { DiscardConfirmDialog } from "./discard-confirm-dialog";
import { FileChangeRow } from "./file-change-row";
import {
  buildCommitCommand,
  gitDiscard,
  gitDiscardAll,
  gitStage,
  gitUnstage,
} from "./git-commands";
import { MinusGlyph, TrashGlyph } from "./glyphs";
import { RaumLogo } from "./main-branch-picker";
import type { ChangesViewProps } from "./types";

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

  // Commit box state and in-flight spawn-and-send bookkeeping.
  const [commitDraft, setCommitDraft] = createSignal("");
  const [pendingCommit, setPendingCommit] = createSignal<{
    command: string;
    since: number;
  } | null>(null);

  // Reset transient UI when this view is re-targeted at another worktree.
  createEffect(() => {
    void props.worktree.path;
    setMenuTarget(null);
    setDiscardTarget(null);
    setDiscardError(null);
  });

  const buckets = createMemo(() => splitChanges(props.status.changes));
  const unstaged = createMemo(() => buckets().unstaged);
  const staged = createMemo(() => buckets().staged);
  const canCommit = createMemo(() => commitDraft().trim().length > 0);

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
          projectSlug: props.projectSlug,
          worktreeId: props.worktree.path,
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
    const ids = idsByWorktreeId().get(props.worktree.path);
    const match = ids
      ? [...ids]
          .map((id) => terminalStore.byId[id])
          .find(
            (t) => t !== undefined && t.kind === "shell" && t.created_unix * 1000 >= pending.since,
          )
      : Object.values(terminalStore.byId).find(
          (t) =>
            t.worktree_id === props.worktree.path &&
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

  return (
    <div class="flex flex-col gap-2">
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
        when={!props.statusPending}
        fallback={
          <div class="flex items-center gap-1.5 px-1 py-1 font-mono text-[10px] text-foreground-dim">
            <LoaderIcon class="size-3 animate-spin" />
            <span>Loading changes…</span>
          </div>
        }
      >
        <Show
          when={unstaged().length > 0 || staged().length > 0}
          fallback={
            <div class="px-1 py-1 font-mono text-[10px] italic text-foreground-dim">No changes</div>
          }
        >
          <Scrollable axis="y" class="max-h-64">
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
                          <button
                            type="button"
                            class="flex size-5 shrink-0 items-center justify-center rounded text-success/80 opacity-0 hover:bg-hover hover:text-success focus-visible:opacity-100 group-hover/file:opacity-100"
                            onClick={() => void stageFile(change.path)}
                            title="Stage file"
                            aria-label="Stage file"
                          >
                            <PlusIcon class="size-3" />
                          </button>
                        </FileChangeRow>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
              {/* Staged */}
              <Show when={staged().length > 0}>
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
                </div>
              </Show>
              <Show when={props.status.truncated}>
                <div class="px-1 font-mono text-[10px] italic text-foreground-dim">
                  Showing the first 1000 changes
                </div>
              </Show>
            </div>
          </Scrollable>
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
            </div>
          </Portal>
        )}
      </Show>

      {/* Discard confirmation — single file or worktree-wide. */}
      <DiscardConfirmDialog
        target={discardTarget()}
        worktreeName={props.worktree.path.split("/").pop() ?? props.worktree.path}
        unstagedCount={unstaged().length}
        submitting={discardSubmitting()}
        error={discardError()}
        onConfirm={() => void confirmDiscard()}
        onClose={() => {
          setDiscardTarget(null);
          setDiscardError(null);
        }}
      />
    </div>
  );
};
