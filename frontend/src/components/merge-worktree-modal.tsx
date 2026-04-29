/**
 * Merge-worktree confirmation dialog.
 *
 * Mirrors `DeleteWorktreeModal`'s shape: load impact data on open
 * (`worktree_merge_preview` — runs `git merge-tree` so nothing is mutated),
 * render an icon-led summary, and gate the destructive action behind a single
 * obvious primary button.
 *
 * "Safe to merge" path: the user can opt to delete the source branch and
 * remove the worktree folder afterwards (both default-on — folding the merge
 * + cleanup into one button matches the delete-modal pattern).
 *
 * "Conflicts" or "Dirty" path: the primary button is disabled and the body
 * shows the conflicting paths / dirty worktree, so the user knows where to
 * fix things manually before retrying.
 */

import { Component, For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "solid-sonner";
import { clearWorktreeListCache, type Worktree } from "../stores/worktreeStore";
import { createOperationProgress } from "../lib/operationProgress";
import {
  AlertCircleIcon,
  CheckIcon,
  FolderIcon,
  GitBranchIcon,
  GitMergeIcon,
  LoaderIcon,
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

interface MergePreview {
  sourceBranch: string | null;
  targetBranch: string | null;
  targetWorktreePath: string | null;
  targetCheckedOut: boolean;
  sourceDirty: boolean;
  targetDirty: boolean;
  ahead: number;
  behind: number;
  canFastForward: boolean;
  conflicts: string[];
  alreadyMerged: boolean;
  error: string | null;
}

export interface MergeWorktreeModalProps {
  open: boolean;
  projectSlug: string;
  worktree: Worktree;
  /** Called after a successful merge (caller refreshes its list). */
  onMerged: () => void;
  onClose: () => void;
}

/**
 * Step list rendered by the merge progress panel. The `id` strings MUST stay
 * in sync with the backend `MERGE_STEP_*` constants in
 * `src-tauri/src/commands/worktree.rs`.
 */
const MERGE_STEPS = [
  { id: "precheck", label: "Checking merge readiness" },
  { id: "kill-terminals", label: "Stopping terminals" },
  { id: "merge", label: "Merging branch" },
  { id: "remove-worktree", label: "Removing worktree folder" },
  { id: "delete-branch", label: "Deleting source branch" },
  { id: "rescan", label: "Refreshing git status" },
] as const;

export const MergeWorktreeModal: Component<MergeWorktreeModalProps> = (props) => {
  const [preview, setPreview] = createSignal<MergePreview | null>(null);
  const [previewError, setPreviewError] = createSignal<string | null>(null);
  const [deleteBranch, setDeleteBranch] = createSignal(true);
  const [removeWorktree, setRemoveWorktree] = createSignal(true);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const sourceBranch = () => preview()?.sourceBranch ?? props.worktree.branch ?? null;
  const targetBranch = () => preview()?.targetBranch ?? null;
  const conflicts = () => preview()?.conflicts ?? [];
  const hasConflicts = () => conflicts().length > 0;
  const sourceDirty = () => preview()?.sourceDirty ?? false;
  const targetDirty = () => preview()?.targetDirty ?? false;
  const alreadyMerged = () => preview()?.alreadyMerged ?? false;
  const ahead = () => preview()?.ahead ?? 0;
  const behind = () => preview()?.behind ?? 0;
  const canFastForward = () => preview()?.canFastForward ?? false;

  const previewBlocker = createMemo(() => {
    const p = preview();
    if (!p) return null;
    if (p.error) return p.error;
    if (!p.sourceBranch) return "Source worktree is detached — nothing to merge.";
    if (!p.targetBranch) return "No base branch configured for this worktree.";
    if (!p.targetCheckedOut) {
      return `Base branch \`${p.targetBranch}\` is not checked out in any worktree.`;
    }
    return null;
  });

  const canMerge = createMemo(() => {
    const p = preview();
    if (!p) return false;
    if (previewBlocker()) return false;
    if (p.alreadyMerged) return false;
    if (p.sourceDirty || p.targetDirty) return false;
    if (p.conflicts.length > 0) return false;
    return true;
  });

  // Load preview whenever the dialog opens.
  createEffect(() => {
    if (!props.open) return;
    setPreview(null);
    setPreviewError(null);
    setError(null);
    setDeleteBranch(true);
    setRemoveWorktree(true);

    const path = props.worktree.path;
    void (async () => {
      try {
        const p = await invoke<MergePreview>("worktree_merge_preview", {
          projectSlug: props.projectSlug,
          path,
        });
        setPreview(p);
      } catch (e) {
        setPreviewError(e instanceof Error ? e.message : String(e));
      }
    })();
  });

  const progress = createOperationProgress(MERGE_STEPS);

  const submit = async () => {
    if (submitting() || !canMerge()) return;
    setSubmitting(true);
    setError(null);

    const channel = progress.start();
    try {
      await invoke<void>("worktree_merge", {
        projectSlug: props.projectSlug,
        path: props.worktree.path,
        deleteBranch: deleteBranch(),
        removeWorktree: removeWorktree(),
        onProgress: channel,
      });

      clearWorktreeListCache(props.projectSlug);
      const sb = sourceBranch();
      const tb = targetBranch();
      toast.success("Merged", {
        description: sb && tb ? `${sb} → ${tb}` : (sb ?? props.worktree.path),
      });
      props.onMerged();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const primaryLabel = () => {
    if (submitting()) return "Merging…";
    const ff = canFastForward();
    const cleanup = removeWorktree() && deleteBranch();
    if (cleanup) return ff ? "Fast-forward & clean up" : "Merge & clean up";
    if (removeWorktree()) return ff ? "Fast-forward & remove worktree" : "Merge & remove worktree";
    if (deleteBranch()) return ff ? "Fast-forward & delete branch" : "Merge & delete branch";
    return ff ? "Fast-forward" : "Merge branch";
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          if (submitting()) return;
          props.onClose();
        }
      }}
    >
      <DialogPortal>
        <DialogContent class="!gap-6 !p-8 sm:max-w-[760px]">
          <DialogHeader>
            <DialogTitle class="flex flex-wrap items-center gap-2 text-sm">
              <span>Merge worktree</span>
              <Show when={sourceBranch()}>
                {(b) => (
                  <span class="inline-flex min-w-0 items-center gap-1.5 rounded bg-muted px-2 py-0.5 font-mono text-xs text-foreground [word-break:break-all]">
                    <GitBranchIcon class="size-3.5 shrink-0" />
                    <span class="min-w-0 [word-break:break-all]">{b()}</span>
                  </span>
                )}
              </Show>
              <Show when={targetBranch()}>
                {(b) => (
                  <>
                    <span class="text-foreground-dim" aria-hidden="true">
                      →
                    </span>
                    <span class="inline-flex min-w-0 items-center gap-1.5 rounded bg-muted px-2 py-0.5 font-mono text-xs text-foreground [word-break:break-all]">
                      <GitBranchIcon class="size-3.5 shrink-0" />
                      <span class="min-w-0 [word-break:break-all]">{b()}</span>
                    </span>
                  </>
                )}
              </Show>
            </DialogTitle>
          </DialogHeader>

          <div class="min-w-0 space-y-5 text-xs">
            {/* Loading skeleton */}
            <Show when={!preview() && !previewError()}>
              <div class="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-3 text-muted-foreground">
                <LoaderIcon class="size-4 animate-spin" />
                <span>Running dry-run merge…</span>
              </div>
            </Show>

            <Show when={previewError()}>
              {(e) => (
                <Alert variant="destructive" class="text-xs">
                  <AlertDescription>{e()}</AlertDescription>
                </Alert>
              )}
            </Show>

            {/* Primary state banner — one at most, most severe first */}
            <Show when={previewBlocker()}>
              {(msg) => (
                <div class="rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-warning">
                  <div class="flex items-center gap-2 font-medium">
                    <AlertCircleIcon class="size-4" />
                    Can't merge yet
                  </div>
                  <div class="mt-1 text-xs text-warning/90">{msg()}</div>
                </div>
              )}
            </Show>

            <Show when={!previewBlocker() && (sourceDirty() || targetDirty())}>
              <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-destructive">
                <div class="flex items-center gap-2 font-medium">
                  <AlertCircleIcon class="size-4" />
                  Uncommitted changes
                </div>
                <div class="mt-1 text-xs text-destructive/90">
                  <Show when={sourceDirty()}>
                    Source worktree (<span class="font-mono">{sourceBranch()}</span>) has
                    uncommitted changes.{" "}
                  </Show>
                  <Show when={targetDirty()}>
                    Target worktree (<span class="font-mono">{targetBranch()}</span>) has
                    uncommitted changes.{" "}
                  </Show>
                  Commit, stash, or discard them, then retry.
                </div>
              </div>
            </Show>

            <Show when={!previewBlocker() && !sourceDirty() && !targetDirty() && hasConflicts()}>
              <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-destructive">
                <div class="flex items-center gap-2 font-medium">
                  <AlertCircleIcon class="size-4" />
                  {conflicts().length} conflicting file
                  {conflicts().length === 1 ? "" : "s"}
                </div>
                <div class="mt-1 text-xs text-destructive/90">
                  Resolve manually in <span class="font-mono">{sourceBranch()}</span>: rebase or
                  merge <span class="font-mono">{targetBranch()}</span> in, fix the conflicts there,
                  then retry.
                </div>
                <ul class="mt-2 max-h-32 space-y-0.5 overflow-y-auto rounded bg-background/40 p-2 font-mono text-[11px]">
                  <For each={conflicts()}>{(p) => <li class="truncate">{p}</li>}</For>
                </ul>
              </div>
            </Show>

            <Show
              when={
                !previewBlocker() &&
                !sourceDirty() &&
                !targetDirty() &&
                !hasConflicts() &&
                alreadyMerged()
              }
            >
              <div class="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-muted-foreground">
                <div class="font-medium text-foreground">Nothing to merge</div>
                <div class="mt-1 text-xs">
                  <span class="font-mono">{sourceBranch()}</span> is already reachable from{" "}
                  <span class="font-mono">{targetBranch()}</span>. You can still delete the branch +
                  worktree from the delete dialog.
                </div>
              </div>
            </Show>

            <Show when={canMerge()}>
              <div class="rounded-md border border-success/40 bg-success/10 px-3 py-2.5 text-success">
                <div class="flex items-center gap-2 font-medium">
                  <CheckIcon class="size-4" />
                  Safe to merge — no conflicts
                </div>
                <div class="mt-1 text-xs text-success/90">
                  {ahead()} commit{ahead() === 1 ? "" : "s"} from{" "}
                  <span class="font-mono">{sourceBranch()}</span> will land in{" "}
                  <span class="font-mono">{targetBranch()}</span>
                  <Show when={canFastForward()}> as a fast-forward</Show>
                  <Show when={!canFastForward()}> as a merge commit</Show>
                  <Show when={behind() > 0}>
                    {" "}
                    ({behind()} commit{behind() === 1 ? "" : "s"} from target will be merged in)
                  </Show>
                  .
                </div>
              </div>
            </Show>

            {/* ---- What will happen ------------------------------------- */}
            <Show when={canMerge()}>
              <section>
                <div class="mb-2 text-[11px] uppercase tracking-wide text-foreground-subtle">
                  What will happen
                </div>
                <ul class="space-y-1.5 text-muted-foreground">
                  <li class="flex items-start gap-2.5">
                    <GitMergeIcon class="mt-[2px] size-4 shrink-0 text-success/80" />
                    <span class="min-w-0 flex-1 text-foreground">
                      Merge{" "}
                      <span class="rounded bg-muted px-1 py-px font-mono text-xs [word-break:break-all]">
                        {sourceBranch()}
                      </span>{" "}
                      into{" "}
                      <span class="rounded bg-muted px-1 py-px font-mono text-xs [word-break:break-all]">
                        {targetBranch()}
                      </span>
                    </span>
                  </li>
                  <Show when={removeWorktree()}>
                    <li class="flex items-start gap-2.5">
                      <FolderIcon class="mt-[2px] size-4 shrink-0 text-destructive/80" />
                      <span class="min-w-0 flex-1 text-foreground">
                        Remove worktree folder{" "}
                        <span class="rounded bg-muted px-1 py-px font-mono text-xs [word-break:break-all]">
                          {props.worktree.path}
                        </span>
                      </span>
                    </li>
                  </Show>
                  <Show when={deleteBranch()}>
                    <li class="flex items-start gap-2.5">
                      <GitBranchIcon class="mt-[2px] size-4 shrink-0 text-destructive/80" />
                      <span class="min-w-0 flex-1 text-foreground">
                        Delete branch{" "}
                        <span class="rounded bg-muted px-1 py-px font-mono text-xs [word-break:break-all]">
                          {sourceBranch()}
                        </span>
                      </span>
                    </li>
                  </Show>
                </ul>
              </section>
            </Show>

            {/* ---- Cleanup toggles -------------------------------------- */}
            <Show when={canMerge()}>
              <div class="space-y-2 rounded-md border border-border bg-panel/40 px-3.5 py-3">
                <label class="flex cursor-pointer items-start gap-2.5 text-foreground">
                  <input
                    type="checkbox"
                    class="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-foreground"
                    checked={removeWorktree()}
                    onChange={(e) => setRemoveWorktree(e.currentTarget.checked)}
                  />
                  <span class="min-w-0">
                    <span class="font-medium">Remove worktree folder afterwards</span>
                    <span class="ml-1 text-muted-foreground">
                      (kills any terminals attached to it)
                    </span>
                  </span>
                </label>
                <label class="flex cursor-pointer items-start gap-2.5 text-foreground">
                  <input
                    type="checkbox"
                    class="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-foreground"
                    checked={deleteBranch()}
                    onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
                  />
                  <span class="min-w-0">
                    <span class="font-medium">Delete source branch</span>
                    <span class="ml-1 text-muted-foreground">
                      (only succeeds when fully merged)
                    </span>
                  </span>
                </label>
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
              {canMerge() ? "Cancel" : "Close"}
            </Button>
            <Show when={canMerge()}>
              <Button
                type="button"
                disabled={submitting() || !canMerge()}
                onClick={() => {
                  void submit();
                }}
              >
                <Show when={submitting()}>
                  <LoaderIcon class="mr-1.5 size-3.5 animate-spin" />
                </Show>
                {primaryLabel()}
              </Button>
            </Show>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
};

export default MergeWorktreeModal;
