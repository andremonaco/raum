/**
 * §9.5 — the Changes view of an open worktree tab. A source-control panel
 * that owns:
 *   • a "Commit & push" split button: the primary hit spawns the user's
 *     preferred harness at its cheap tier (haiku low / gpt-5.6-luna low) in
 *     this worktree, pre-loaded with a prompt to review the changes, create
 *     logical, file-whole commits and push. The chevron offers the other
 *     installed harnesses and a commit-only variant.
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
import { Dynamic, Portal } from "solid-js/web";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

import { splitChanges } from "../../lib/gitChangeDisplay";
import { kindDisplayLabel } from "../../lib/agentKind";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  HARNESS_ICONS,
  LoaderIcon,
  PlusIcon,
} from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  availableCommitHarnesses,
  commitHarnessPreference,
  commitTierLabel,
  loadCommitHarnessPreference,
  resolveCommitHarness,
  spawnCommitHarness,
  type CommitHarness,
} from "./commit-harness";
import { DiscardConfirmDialog } from "./discard-confirm-dialog";
import { FileChangeRow } from "./file-change-row";
import { gitDiscard, gitDiscardAll, gitStage, gitUnstage } from "./git-commands";
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

  // Commit & push: the primary button spawns the preferred (or first
  // installed) harness at its cheap tier with the commit+push prompt. The
  // chevron menu lists every installed harness plus a commit-only variant.
  const [installed, setInstalled] = createSignal<CommitHarness[]>([]);
  void loadCommitHarnessPreference();
  void availableCommitHarnesses().then(setInstalled);
  const commitHarness = () => resolveCommitHarness(commitHarnessPreference(), installed());
  const commitWith = (kind: CommitHarness, push: boolean) =>
    spawnCommitHarness({
      kind,
      projectSlug: props.projectSlug,
      worktreeId: props.worktree.path,
      push,
    });

  return (
    <div class="flex flex-col gap-2 pt-2">
      {/* Commit & push split button. */}
      <div class="flex h-8 w-full items-stretch">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-l-md bg-selected text-[11px] font-medium text-foreground transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-foreground-dim"
          title={`Commit & push with ${kindDisplayLabel(commitHarness())} (${commitTierLabel(commitHarness())}) — logical, file-whole commits, then push`}
          aria-label="Commit and push changes with an agent"
          disabled={!hasChanges() || installed().length === 0}
          onClick={() => commitWith(commitHarness(), true)}
        >
          <Dynamic component={HARNESS_ICONS[commitHarness()]} class="size-3.5 shrink-0" />
          <span class="truncate">Commit & push</span>
        </button>
        <DropdownMenu placement="bottom-end">
          <DropdownMenuTrigger
            as="button"
            type="button"
            class="flex w-6 shrink-0 items-center justify-center rounded-r-md border-l border-border/50 bg-selected text-foreground transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-foreground-dim"
            aria-label="More commit options"
            disabled={!hasChanges() || installed().length === 0}
          >
            <ChevronDownIcon class="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent class="min-w-56">
              <For each={installed()}>
                {(kind) => (
                  <DropdownMenuItem class="text-xs" onSelect={() => commitWith(kind, true)}>
                    <Dynamic component={HARNESS_ICONS[kind]} class="size-3.5 shrink-0" />
                    <span class="flex-1">Commit & push with {kindDisplayLabel(kind)}</span>
                    <span class="text-[10px] text-muted-foreground">{commitTierLabel(kind)}</span>
                  </DropdownMenuItem>
                )}
              </For>
              <DropdownMenuSeparator />
              <DropdownMenuItem class="text-xs" onSelect={() => commitWith(commitHarness(), false)}>
                <CheckIcon class="size-3.5 shrink-0" />
                <span class="flex-1">Commit only (no push)</span>
                <span class="text-[10px] text-muted-foreground">
                  {kindDisplayLabel(commitHarness())}
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenu>
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
    </div>
  );
};
