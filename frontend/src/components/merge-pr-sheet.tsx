/**
 * Merge-pull-request confirmation sheet.
 *
 * Same shape as `MergeWorktreeModal`: load the repo's policy on open, show
 * exactly what will run, and gate the action behind one obvious button. The
 * literal `gh pr merge …` command line is printed so the sheet never does
 * anything the user couldn't have typed.
 *
 * It never deletes a worktree. On success it tells its owner, which offers the
 * existing delete-worktree flow.
 */

import { Component, For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "solid-sonner";

import {
  GITHUB_COMMANDS,
  type MergeMethod,
  type MergeOutcome,
  type MergePolicy,
  type PullRequest,
} from "../lib/githubTypes";
import { LoaderIcon } from "./icons";
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

export interface MergePrSheetProps {
  open: boolean;
  /** Worktree path — `gh` derives owner/repo from its cwd. */
  path: string;
  pr: PullRequest;
  /** Fired after a successful merge, before the sheet closes itself. */
  onMerged: () => void;
  onClose: () => void;
}

/** "3 commits" / "1 commit"; "the commits" when gh gave no count. */
function commitsPhrase(pr: PullRequest): string {
  if (pr.commitCount === 0) return "the commits";
  return `${pr.commitCount} commit${pr.commitCount === 1 ? "" : "s"}`;
}

/**
 * One-line consequence per method, phrased against THIS PR's branches so the
 * user can glimpse what lands on the base without knowing git internals.
 */
const METHODS: ReadonlyArray<{
  id: MergeMethod;
  label: string;
  flag: string;
  hint: (pr: PullRequest) => string;
}> = [
  {
    id: "squash",
    label: "Squash and merge",
    flag: "--squash",
    hint: (pr) =>
      `Combines ${commitsPhrase(pr)} from ${pr.headRefName} into one new commit on ${pr.baseRefName}. ` +
      `${pr.baseRefName} stays linear; the individual commits survive only on ${pr.headRefName}.`,
  },
  {
    id: "rebase",
    label: "Rebase and merge",
    flag: "--rebase",
    hint: (pr) =>
      `Replays ${commitsPhrase(pr)} from ${pr.headRefName} on top of ${pr.baseRefName} with new hashes. ` +
      `${pr.baseRefName} stays linear and keeps every commit; no merge commit.`,
  },
  {
    id: "merge",
    label: "Create a merge commit",
    flag: "--merge",
    hint: (pr) =>
      `Adds one merge commit on ${pr.baseRefName} that joins ${pr.headRefName}. ` +
      `All ${commitsPhrase(pr)} keep their hashes; ${pr.baseRefName} history shows the branch.`,
  },
];

function methodAllowed(policy: MergePolicy | null, method: MergeMethod): boolean {
  if (!policy) return false;
  if (method === "squash") return policy.squash;
  if (method === "rebase") return policy.rebase;
  return policy.mergeCommit;
}

/** "Waiting on lint, test and 2 more" — the pending checks, not all of them. */
function pendingSummary(pr: PullRequest): string {
  const names = pr.checks.filter((c) => c.bucket === "pending").map((c) => c.name);
  if (names.length === 0) return "Waiting on checks";
  if (names.length === 1) return `Waiting on ${names[0]}`;
  if (names.length === 2) return `Waiting on ${names[0]} and ${names[1]}`;
  return `Waiting on ${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

export const MergePrSheet: Component<MergePrSheetProps> = (props) => {
  const [policy, setPolicy] = createSignal<MergePolicy | null>(null);
  const [method, setMethod] = createSignal<MergeMethod>("squash");
  const [deleteBranch, setDeleteBranch] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    if (!props.open) return;
    setPolicy(null);
    setError(null);
    void (async () => {
      try {
        const p = await invoke<MergePolicy>(GITHUB_COMMANDS.mergePolicy, { path: props.path });
        setPolicy(p);
        setMethod(p.defaultMethod);
        setDeleteBranch(p.deleteBranchOnMerge);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  });

  const conflicted = createMemo(() => props.pr.mergeStateStatus === "DIRTY");
  const mergeableNow = createMemo(
    () => props.pr.mergeStateStatus === "CLEAN" || props.pr.mergeStateStatus === "HAS_HOOKS",
  );
  /** Checks still running + the repo allows auto-merge → queue it instead. */
  const auto = createMemo(
    () =>
      !mergeableNow() &&
      props.pr.checksSummary.pending > 0 &&
      (policy()?.autoMergeAllowed ?? false),
  );
  const canMerge = createMemo(() => policy() !== null && (mergeableNow() || auto()));

  // Not `--delete-branch`: that makes gh check out the base branch, pull and
  // delete the local branch in the cwd. Only the remote ref is deleted.
  const commandLine = createMemo(() => {
    const flag = METHODS.find((m) => m.id === method())?.flag ?? "--squash";
    const parts = ["gh", "pr", "merge", String(props.pr.number), flag];
    if (auto()) parts.push("--auto");
    const lines = [parts.join(" ")];
    if (deleteBranch() && !auto()) {
      lines.push(`gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/${props.pr.headRefName}`);
    }
    return lines.join("\n");
  });

  const submit = async () => {
    if (submitting() || !canMerge()) return;
    setSubmitting(true);
    setError(null);
    try {
      const outcome = await invoke<MergeOutcome>(GITHUB_COMMANDS.prMerge, {
        path: props.path,
        number: props.pr.number,
        method: method(),
        headRef: props.pr.headRefName,
        deleteBranch: deleteBranch(),
        auto: auto(),
      });
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      toast.success(outcome.autoMergeEnabled ? "Auto-merge enabled" : "Merged", {
        description: `#${props.pr.number} ${props.pr.title}`,
      });
      props.onMerged();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !submitting()) props.onClose();
      }}
    >
      <DialogPortal>
        <DialogContent class="!gap-6 !p-8 sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle class="flex flex-wrap items-center gap-2 text-sm">
              <span>Merge pull request</span>
              <span class="rounded bg-muted px-2 py-0.5 font-mono text-xs text-foreground">
                #{props.pr.number}
              </span>
            </DialogTitle>
          </DialogHeader>

          <div class="min-w-0 space-y-4 text-xs">
            <Show when={conflicted()}>
              <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-destructive">
                <div class="font-medium">Conflicts with the base branch</div>
                <div class="mt-1 text-xs text-destructive/90">
                  Rebase <span class="font-mono">{props.pr.headRefName}</span> onto{" "}
                  <span class="font-mono">{props.pr.baseRefName}</span> first, then merge.
                </div>
              </div>
            </Show>

            <Show when={!conflicted()}>
              <Show when={auto()}>
                <div class="rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-warning">
                  <div class="font-medium">{pendingSummary(props.pr)}</div>
                  <div class="mt-1 text-xs text-warning/90">
                    GitHub merges this automatically once every required check passes.
                  </div>
                </div>
              </Show>

              <fieldset class="space-y-2.5" aria-label="Merge method">
                <For each={METHODS}>
                  {(m) => {
                    const allowed = () => methodAllowed(policy(), m.id);
                    return (
                      <label
                        class="flex cursor-pointer items-start gap-2.5 text-foreground"
                        classList={{ "cursor-not-allowed opacity-45": !allowed() }}
                      >
                        <input
                          type="radio"
                          name="merge-method"
                          class="mt-0.5 size-3.5 shrink-0 accent-foreground"
                          value={m.id}
                          checked={method() === m.id}
                          disabled={!allowed()}
                          onChange={() => setMethod(m.id)}
                        />
                        <span class="min-w-0 space-y-0.5">
                          <span class="block">
                            {m.label}
                            <Show when={policy() && !allowed()}>
                              <span class="ml-2 text-muted-foreground">
                                Not allowed by repository settings
                              </span>
                            </Show>
                          </span>
                          <span class="block text-[11px] leading-snug text-muted-foreground">
                            {m.hint(props.pr)}
                          </span>
                        </span>
                      </label>
                    );
                  }}
                </For>
              </fieldset>

              <label class="flex cursor-pointer items-center gap-2.5 text-foreground">
                <input
                  type="checkbox"
                  class="size-3.5 shrink-0 cursor-pointer accent-foreground"
                  checked={deleteBranch()}
                  onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
                />
                <span>Delete remote branch</span>
              </label>

              <pre class="overflow-x-auto rounded border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] text-muted-foreground">
                {commandLine()}
              </pre>
            </Show>

            <Show when={error()}>
              {(msg) => (
                <Alert variant="destructive" class="text-xs">
                  <AlertDescription>{msg()}</AlertDescription>
                </Alert>
              )}
            </Show>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={submitting()} onClick={props.onClose}>
              {canMerge() ? "Cancel" : "Close"}
            </Button>
            <Show when={!conflicted()}>
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
                {submitting() ? "Merging…" : auto() ? "Merge when green" : "Merge"}
              </Button>
            </Show>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
};

export default MergePrSheet;
