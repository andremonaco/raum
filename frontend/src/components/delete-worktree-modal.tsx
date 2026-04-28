/**
 * Delete-worktree confirmation dialog.
 *
 * Reads the full git state of the worktree on open (dirty files, upstream
 * ahead/behind, stash entries, merge reachability) and renders a calm
 * icon-led summary + a single "Branch: Delete / Keep" segmented control as
 * the only interactive control.
 */

import { Component, For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "solid-sonner";
import { clearWorktreeListCache, type Worktree } from "../stores/worktreeStore";
import { idsByWorktreeId, terminalStore, type TerminalRecord } from "../stores/terminalStore";
import { createOperationProgress } from "../lib/operationProgress";
import {
  AlertCircleIcon,
  FolderIcon,
  GitBranchIcon,
  HARNESS_ICONS,
  LoaderIcon,
  ShellIcon,
  type HarnessIconKind,
} from "./icons";
import { OperationProgress } from "./operation-progress";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
} from "./ui/dialog";

interface WorktreeStatus {
  dirty: boolean;
  untracked: string[];
  modified: string[];
  staged: string[];
  insertions: number;
  deletions: number;
  upstream: string | null;
  ahead: number;
  behind: number;
  stashCount: number;
}

interface BranchMergeStatus {
  mergedInto: string[];
}

export interface DeleteWorktreeModalProps {
  open: boolean;
  projectSlug: string;
  worktree: Worktree;
  /** Called after a successful delete (caller refreshes its list). */
  onDeleted: () => void;
  onClose: () => void;
}

const HARNESS_LABEL: Record<HarnessIconKind, string> = {
  shell: "Shell",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

/** Group this worktree's running terminals by harness kind. */
function groupTerminalsByKind(
  worktreePath: string,
): { kind: HarnessIconKind; sessions: TerminalRecord[] }[] {
  const ids = idsByWorktreeId().get(worktreePath);
  if (!ids || ids.size === 0) return [];
  const bucket = new Map<HarnessIconKind, TerminalRecord[]>();
  for (const id of ids) {
    const t = terminalStore.byId[id];
    if (!t) continue;
    const kind = t.kind as HarnessIconKind;
    const list = bucket.get(kind) ?? [];
    list.push(t);
    bucket.set(kind, list);
  }
  const order: HarnessIconKind[] = ["shell", "claude-code", "codex", "opencode"];
  return order.filter((k) => bucket.has(k)).map((k) => ({ kind: k, sessions: bucket.get(k)! }));
}

/**
 * Step list rendered by the delete-worktree progress panel. The `id`
 * strings MUST stay in sync with the backend `REMOVE_STEP_*` constants in
 * `src-tauri/src/commands/worktree.rs`.
 */
const REMOVE_STEPS = [
  { id: "kill-terminals", label: "Stopping terminals" },
  { id: "drop-stashes", label: "Dropping branch stashes" },
  { id: "git-remove", label: "Removing git worktree" },
  { id: "delete-branch", label: "Deleting local branch" },
  { id: "rescan", label: "Refreshing git status" },
] as const;

function emptyStatus(): WorktreeStatus {
  return {
    dirty: false,
    untracked: [],
    modified: [],
    staged: [],
    insertions: 0,
    deletions: 0,
    upstream: null,
    ahead: 0,
    behind: 0,
    stashCount: 0,
  };
}

export const DeleteWorktreeModal: Component<DeleteWorktreeModalProps> = (props) => {
  const [status, setStatus] = createSignal<WorktreeStatus | null>(null);
  const [mergeStatus, setMergeStatus] = createSignal<BranchMergeStatus | null>(null);
  const [deleteBranch, setDeleteBranch] = createSignal(true);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const branch = () => props.worktree.branch;
  const runningTerminals = createMemo(() => groupTerminalsByKind(props.worktree.path));
  const runningCount = createMemo(() =>
    runningTerminals().reduce((sum, g) => sum + g.sessions.length, 0),
  );

  const hasUncommitted = () => status()?.dirty === true;
  const insertions = () => status()?.insertions ?? 0;
  const deletions = () => status()?.deletions ?? 0;
  const changedFileCount = () => {
    const s = status();
    if (!s) return 0;
    const files = new Set<string>([...s.untracked, ...s.modified, ...s.staged]);
    return files.size;
  };

  const upstream = () => status()?.upstream ?? null;
  const ahead = () => status()?.ahead ?? 0;
  const behind = () => status()?.behind ?? 0;
  const stashCount = () => status()?.stashCount ?? 0;
  const hasUnpushed = () => ahead() > 0;
  const hasStash = () => stashCount() > 0;

  const mergedInto = () => mergeStatus()?.mergedInto ?? [];
  const isMerged = () => mergedInto().length > 0;
  const hasNoUpstream = () => branch() !== null && upstream() === null;

  // "Clean" in the delete-modal sense: nothing will be lost in terms of code.
  const isClean = createMemo(() => {
    if (status() === null) return false;
    if (hasUncommitted() || hasUnpushed() || hasStash()) return false;
    if (branch() === null) return true;
    return isMerged() || upstream() !== null;
  });

  const branchUnsafe = () =>
    branch() !== null && deleteBranch() && mergeStatus() !== null && !isMerged();

  // Load impact data whenever the dialog opens.
  createEffect(() => {
    if (!props.open) return;
    setStatus(null);
    setMergeStatus(null);
    setDeleteBranch(true);
    setError(null);

    const path = props.worktree.path;
    const currentBranch = props.worktree.branch;

    void (async () => {
      try {
        const s = await invoke<WorktreeStatus>("worktree_status", { path });
        setStatus(s);
      } catch {
        setStatus(emptyStatus());
      }
    })();

    if (currentBranch) {
      void (async () => {
        try {
          const ms = await invoke<BranchMergeStatus>("worktree_branch_merged", {
            projectSlug: props.projectSlug,
            branch: currentBranch,
          });
          setMergeStatus(ms);
        } catch {
          setMergeStatus({ mergedInto: [] });
        }
      })();
    } else {
      setMergeStatus({ mergedInto: [] });
    }
  });

  const progress = createOperationProgress(REMOVE_STEPS);

  const submit = async () => {
    if (submitting()) return;
    setSubmitting(true);
    setError(null);

    const channel = progress.start();
    try {
      const shouldDeleteBranch = branch() !== null && deleteBranch();
      // The terminal-kill loop now lives in the backend `worktree_remove`
      // command — it streams per-session progress over the channel and
      // doesn't return until tmux + git + branch cleanup all finish.
      await invoke<void>("worktree_remove", {
        projectSlug: props.projectSlug,
        path: props.worktree.path,
        force: hasUncommitted(),
        deleteBranch: shouldDeleteBranch,
        forceDeleteBranch: shouldDeleteBranch && !isMerged(),
        clearStash: hasStash(),
        onProgress: channel,
      });

      clearWorktreeListCache(props.projectSlug);
      toast.success("Worktree removed", {
        description: branch() ?? props.worktree.path,
      });
      props.onDeleted();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const primaryLabel = () => {
    if (submitting()) return "Deleting…";
    const discarding = hasUncommitted();
    const andBranch = branch() !== null && deleteBranch();
    if (discarding && andBranch) return "Discard & delete both";
    if (discarding) return "Discard & delete worktree";
    if (andBranch) return "Delete worktree & branch";
    return "Delete worktree";
  };

  const worktreeLabel = createMemo(() => {
    const segs = props.worktree.path.split("/");
    return branch() ?? segs[segs.length - 1] ?? props.worktree.path;
  });

  const upstreamLabel = () => (upstream() ?? "").replace(/^origin\//, "origin/");

  return (
    <Dialog
      open={props.open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          // Don't let the user dismiss while a delete is in flight — the
          // progress panel needs to stay mounted until the backend resolves.
          if (submitting()) return;
          props.onClose();
        }
      }}
    >
      <DialogPortal>
        <DialogContent class="!gap-6 !p-8 sm:max-w-[760px]">
          <DialogHeader>
            <DialogTitle class="flex flex-wrap items-center gap-2 text-sm">
              <Show when={branch() !== null} fallback={<>Delete this worktree?</>}>
                <span>Delete worktree</span>
                <span class="inline-flex min-w-0 items-center gap-1.5 rounded bg-muted px-2 py-0.5 font-mono text-xs text-foreground [word-break:break-all]">
                  <GitBranchIcon class="size-3.5 shrink-0" />
                  <span class="min-w-0 [word-break:break-all]">{worktreeLabel()}</span>
                </span>
                <span>?</span>
              </Show>
            </DialogTitle>
          </DialogHeader>

          <div class="min-w-0 space-y-5 text-xs">
            {/* Path chip */}
            <div class="min-w-0 truncate rounded-md border border-border bg-muted/40 px-2.5 py-2 font-mono text-xs text-muted-foreground">
              {props.worktree.path}
            </div>

            {/* Primary state banner — one at most, most severe first */}
            <Show when={hasUncommitted()}>
              <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-destructive">
                <div class="flex items-center gap-2 font-medium">
                  <AlertCircleIcon class="size-4" />
                  {changedFileCount()} uncommitted file{changedFileCount() === 1 ? "" : "s"}
                  <Show when={insertions() > 0 || deletions() > 0}>
                    <span class="font-mono text-xs">
                      <Show when={insertions() > 0}>
                        <span>+{insertions()}</span>
                      </Show>
                      <Show when={deletions() > 0}>
                        <span class="ml-1">−{deletions()}</span>
                      </Show>
                    </span>
                  </Show>
                </div>
                <div class="mt-1 text-xs text-destructive/90">
                  These will be lost and are not recoverable.
                </div>
              </div>
            </Show>

            <Show when={!hasUncommitted() && hasUnpushed()}>
              <div class="rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-warning">
                <div class="font-medium">
                  {ahead()} unpushed commit{ahead() === 1 ? "" : "s"} on{" "}
                  <span class="font-mono">{branch()}</span>
                </div>
                <div class="mt-1 text-xs text-warning/90">
                  Not yet pushed to <span class="font-mono">{upstreamLabel()}</span>. They will be
                  lost unless the branch is reachable from another branch.
                  <Show when={behind() > 0}> (also {behind()} behind upstream)</Show>
                </div>
              </div>
            </Show>

            <Show when={!hasUncommitted() && !hasUnpushed() && isClean() && runningCount() === 0}>
              <div class="rounded-md border border-success/40 bg-success/10 px-3 py-2.5 text-success">
                <div class="font-medium">Nothing will be lost.</div>
                <div class="mt-1 text-xs text-success/90">
                  No uncommitted changes
                  <Show when={branch() !== null}>
                    <>
                      {", branch "}
                      <span class="font-mono">{branch()}</span>{" "}
                      <Show when={isMerged()} fallback={<>tracks its upstream.</>}>
                        is reachable from <span class="font-mono">{mergedInto()[0]}</span>.
                      </Show>
                    </>
                  </Show>
                  <Show when={branch() === null}>.</Show>
                </div>
              </div>
            </Show>

            {/* ---- Will be removed --------------------------------------- */}
            <section>
              <div class="mb-2 text-[11px] uppercase tracking-wide text-foreground-subtle">
                Will be removed
              </div>
              <ul class="space-y-1.5 text-muted-foreground">
                <li class="flex items-start gap-2.5">
                  <FolderIcon class="mt-[2px] size-4 shrink-0 text-destructive/80" />
                  <span class="min-w-0 flex-1 text-foreground">
                    Worktree folder{" "}
                    <span class="rounded bg-muted px-1 py-px font-mono text-xs [word-break:break-all]">
                      {props.worktree.path}
                    </span>
                  </span>
                </li>

                <Show when={branch() !== null && deleteBranch()}>
                  <li class="flex items-start gap-2.5">
                    <GitBranchIcon class="mt-[2px] size-4 shrink-0 text-destructive/80" />
                    <span class="min-w-0 flex-1 text-foreground">
                      Branch{" "}
                      <span class="rounded bg-muted px-1 py-px font-mono text-xs [word-break:break-all]">
                        {branch()}
                      </span>
                    </span>
                  </li>
                </Show>

                <Show when={hasUncommitted()}>
                  <li class="flex items-start gap-2.5">
                    <AlertCircleIcon class="mt-[2px] size-4 shrink-0 text-destructive/80" />
                    <span class="min-w-0 flex-1 text-destructive">
                      {changedFileCount()} uncommitted file
                      {changedFileCount() === 1 ? "" : "s"}
                      <Show when={insertions() > 0 || deletions() > 0}>
                        <span class="ml-1 font-mono text-xs">
                          <Show when={insertions() > 0}>+{insertions()}</Show>
                          <Show when={deletions() > 0}>
                            <span class="ml-1">−{deletions()}</span>
                          </Show>
                        </span>
                      </Show>
                    </span>
                  </li>
                </Show>

                <Show when={hasStash()}>
                  <li class="flex items-start gap-2.5">
                    <GitBranchIcon class="mt-[2px] size-4 shrink-0 text-destructive/80" />
                    <span class="min-w-0 flex-1">
                      {stashCount()} stash entr{stashCount() === 1 ? "y" : "ies"}
                      <Show when={branch() !== null}>
                        <>
                          {" on "}
                          <span class="rounded bg-muted px-1 py-px font-mono text-xs text-foreground [word-break:break-all]">
                            {branch()}
                          </span>
                        </>
                      </Show>
                    </span>
                  </li>
                </Show>

                <Show when={runningCount() > 0}>
                  <li class="flex items-start gap-2.5">
                    <ShellIcon class="mt-[2px] size-4 shrink-0 text-destructive/80" />
                    <span class="min-w-0 flex-1">
                      <div class="text-foreground">
                        {runningCount()} running terminal{runningCount() === 1 ? "" : "s"} will be
                        closed
                      </div>
                      <ul class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <For each={runningTerminals()}>
                          {(group) => {
                            const Icon = HARNESS_ICONS[group.kind];
                            return (
                              <li class="inline-flex items-center gap-1 font-mono text-xs">
                                <Icon class="size-3.5" />
                                <span>{HARNESS_LABEL[group.kind]}</span>
                                <span class="text-foreground">×{group.sessions.length}</span>
                              </li>
                            );
                          }}
                        </For>
                      </ul>
                    </span>
                  </li>
                </Show>
              </ul>
            </section>

            {/* ---- Will stay untouched ----------------------------------- */}
            <section>
              <div class="mb-2 text-[11px] uppercase tracking-wide text-foreground-subtle">
                Will stay untouched
              </div>
              <ul class="space-y-1 text-muted-foreground">
                <li class="flex items-start gap-2.5">
                  <span class="mt-[7px] inline-block size-1 shrink-0 rounded-full bg-success/70" />
                  <span>Other worktrees and the project root</span>
                </li>
                <li class="flex items-start gap-2.5">
                  <span class="mt-[7px] inline-block size-1 shrink-0 rounded-full bg-success/70" />
                  <span>Other git branches, remotes and reflogs</span>
                </li>
                <Show when={isMerged()}>
                  <li class="flex items-start gap-2.5">
                    <span class="mt-[7px] inline-block size-1 shrink-0 rounded-full bg-success/70" />
                    <span>
                      Commits are reachable from{" "}
                      <For each={mergedInto().slice(0, 3)}>
                        {(b, i) => (
                          <>
                            <Show when={i() > 0}>, </Show>
                            <span class="font-mono text-foreground">{b}</span>
                          </>
                        )}
                      </For>
                      <Show when={mergedInto().length > 3}>
                        {" "}
                        and {mergedInto().length - 3} more
                      </Show>
                    </span>
                  </li>
                </Show>
                <Show when={branch() !== null && !deleteBranch()}>
                  <li class="flex items-start gap-2.5">
                    <GitBranchIcon class="mt-[2px] size-4 shrink-0 text-success/70" />
                    <span class="min-w-0">
                      Branch{" "}
                      <span class="rounded bg-muted px-1 py-px font-mono text-xs text-foreground [word-break:break-all]">
                        {branch()}
                      </span>{" "}
                      (kept; only the worktree is removed)
                    </span>
                  </li>
                </Show>
                <Show when={upstream() !== null}>
                  <li class="flex items-start gap-2.5">
                    <span class="mt-[7px] inline-block size-1 shrink-0 rounded-full bg-success/70" />
                    <span>
                      Upstream <span class="font-mono text-foreground">{upstreamLabel()}</span> is
                      not modified
                    </span>
                  </li>
                </Show>
              </ul>
            </section>

            {/* ---- Branch disposition (only interactive control) --------- */}
            <Show when={branch() !== null}>
              <div class="rounded-md border border-border bg-panel/40 px-3.5 py-2.5">
                <div class="flex items-center justify-between gap-3">
                  <div class="flex min-w-0 items-center gap-2 text-foreground">
                    <GitBranchIcon class="size-4 shrink-0 text-muted-foreground" />
                    <span class="min-w-0">
                      Branch{" "}
                      <span class="rounded bg-muted px-1 py-px font-mono text-xs [word-break:break-all]">
                        {branch()}
                      </span>
                    </span>
                  </div>
                  <div
                    role="radiogroup"
                    aria-label="Branch disposition"
                    class="inline-flex items-center rounded-md border border-border bg-background p-0.5"
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={deleteBranch()}
                      onClick={() => setDeleteBranch(true)}
                      class={`h-7 rounded-sm px-2.5 text-xs font-medium transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease)] ${
                        deleteBranch()
                          ? "bg-destructive/15 text-destructive"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={!deleteBranch()}
                      onClick={() => setDeleteBranch(false)}
                      class={`h-7 rounded-sm px-2.5 text-xs font-medium transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease)] ${
                        !deleteBranch()
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Keep
                    </button>
                  </div>
                </div>
                <Show when={branchUnsafe() && (hasNoUpstream() || !isMerged())}>
                  <div class="mt-2 text-xs text-warning">
                    <Show
                      when={hasNoUpstream()}
                      fallback={
                        <>Not merged into any other branch — unreachable commits will be lost.</>
                      }
                    >
                      No upstream and not merged elsewhere — commits on{" "}
                      <span class="font-mono">{branch()}</span> will be lost.
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={submitting() || progress.failure()}>
              <OperationProgress
                steps={progress.steps()}
                counter={progress.counter()}
                failure={progress.failure()}
              />
            </Show>

            <Show when={error() && !progress.failure()}>
              <Alert variant="destructive" class="text-xs">
                <AlertDescription>{error()}</AlertDescription>
              </Alert>
            </Show>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={submitting()}
              onClick={() => props.onClose()}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={submitting()}
              onClick={() => {
                void submit();
              }}
            >
              <Show when={submitting()}>
                <LoaderIcon class="mr-1.5 size-3.5 animate-spin" />
              </Show>
              {primaryLabel()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
};

export default DeleteWorktreeModal;
