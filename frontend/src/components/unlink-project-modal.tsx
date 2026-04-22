/**
 * Unlink-project confirmation dialog.
 *
 * Intentionally named "Unlink" rather than "Delete" because this action does
 * not touch any project files on disk — raum only removes its own tracking
 * state (per-project settings directory + any running terminals tied to
 * the project).
 */

import { Component, For, Show, createMemo, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectListItem } from "../stores/projectStore";
import { idsByProjectSlug, terminalStore, type TerminalRecord } from "../stores/terminalStore";
import { FolderIcon, GitBranchIcon, HARNESS_ICONS, ShellIcon, type HarnessIconKind } from "./icons";
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

export interface UnlinkProjectModalProps {
  open: boolean;
  project: ProjectListItem;
  /** Called after a successful unlink (caller refreshes its project list). */
  onUnlinked: () => void;
  onClose: () => void;
}

const HARNESS_LABEL: Record<HarnessIconKind, string> = {
  shell: "Shell",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

function groupSessionsByKind(
  sessions: TerminalRecord[],
): { kind: HarnessIconKind; count: number }[] {
  const bucket = new Map<HarnessIconKind, number>();
  for (const t of sessions) {
    const kind = t.kind as HarnessIconKind;
    bucket.set(kind, (bucket.get(kind) ?? 0) + 1);
  }
  const order: HarnessIconKind[] = ["shell", "claude-code", "codex", "opencode"];
  return order.filter((k) => bucket.has(k)).map((k) => ({ kind: k, count: bucket.get(k)! }));
}

export const UnlinkProjectModal: Component<UnlinkProjectModalProps> = (props) => {
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const runningSessions = createMemo<TerminalRecord[]>(() => {
    const ids = idsByProjectSlug().get(props.project.slug);
    if (!ids || ids.size === 0) return [];
    const out: TerminalRecord[] = [];
    for (const id of ids) {
      const t = terminalStore.byId[id];
      if (t) out.push(t);
    }
    return out;
  });
  const runningCount = () => runningSessions().length;
  const runningByKind = createMemo(() => groupSessionsByKind(runningSessions()));

  const submit = async () => {
    if (submitting()) return;
    setSubmitting(true);
    setError(null);
    try {
      // Kill any terminals tied to this project first — the tmux sessions are
      // owned by raum, not by the user's shell, and leaving them running
      // after the project is unlinked would leak tmux state.
      for (const t of runningSessions()) {
        try {
          await invoke<void>("terminal_kill", { sessionId: t.session_id });
        } catch {
          // Best-effort; the unlink itself still runs.
        }
      }

      await invoke<void>("project_remove", { slug: props.project.slug });
      props.onUnlinked();
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
        if (!isOpen) props.onClose();
      }}
    >
      <DialogPortal>
        <DialogContent class="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle class="flex flex-wrap items-baseline gap-1 text-sm">
              <span>Unlink project</span>
              <span class="min-w-0 font-mono text-foreground [word-break:break-all]">
                {props.project.name}
              </span>
              <span>?</span>
            </DialogTitle>
          </DialogHeader>

          <div class="min-w-0 space-y-3 text-xs">
            <p class="text-foreground">
              <span class="font-semibold">Unlinking never deletes files from your disk.</span> raum
              only stops tracking this project and clears its own settings.
            </p>

            <div class="min-w-0 truncate rounded-md border border-border bg-muted/40 px-2 py-2 font-mono text-[11px] text-muted-foreground">
              {props.project.rootPath}
            </div>

            <section>
              <div class="mb-1.5 text-[10px] uppercase tracking-wide text-foreground-subtle">
                What raum will remove
              </div>
              <ul class="space-y-1 text-muted-foreground">
                <li class="flex items-start gap-2">
                  <FolderIcon class="mt-[1px] size-3.5 shrink-0 text-warning/80" />
                  <span class="min-w-0 flex-1 text-foreground">
                    Per-project settings folder{" "}
                    <span class="rounded bg-muted px-1 py-px font-mono text-[11px] [word-break:break-all]">
                      ~/.config/raum/projects/{props.project.slug}/
                    </span>
                  </span>
                </li>
                <li class="flex items-start gap-2">
                  <span class="mt-[5px] inline-block size-1 shrink-0 rounded-full bg-warning/70" />
                  <span class="min-w-0 flex-1">
                    Custom harness settings, layouts and keymaps for this project
                  </span>
                </li>
                <li class="flex items-start gap-2">
                  <span class="mt-[5px] inline-block size-1 shrink-0 rounded-full bg-warning/70" />
                  <span class="min-w-0 flex-1">This project's entry in raum's project list</span>
                </li>
                <Show when={runningCount() > 0}>
                  <li class="flex items-start gap-2">
                    <ShellIcon class="mt-[1px] size-3.5 shrink-0 text-warning/80" />
                    <span class="min-w-0 flex-1">
                      <div class="text-foreground">
                        {runningCount()} running terminal{runningCount() === 1 ? "" : "s"} attached
                        to this project will be closed
                      </div>
                      <ul class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <For each={runningByKind()}>
                          {(group) => {
                            const Icon = HARNESS_ICONS[group.kind];
                            return (
                              <li class="inline-flex items-center gap-1 font-mono text-[11px]">
                                <Icon class="size-3.5" />
                                <span>{HARNESS_LABEL[group.kind]}</span>
                                <span class="text-foreground">×{group.count}</span>
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

            <section>
              <div class="mb-1.5 text-[10px] uppercase tracking-wide text-foreground-subtle">
                What stays on disk
              </div>
              <ul class="space-y-1 text-muted-foreground">
                <li class="flex items-start gap-2">
                  <FolderIcon class="mt-[1px] size-3.5 shrink-0 text-success/70" />
                  <span>Your project files and folders</span>
                </li>
                <li class="flex items-start gap-2">
                  <FolderIcon class="mt-[1px] size-3.5 shrink-0 text-success/70" />
                  <span>All worktree folders and their contents</span>
                </li>
                <li class="flex items-start gap-2">
                  <GitBranchIcon class="mt-[1px] size-3.5 shrink-0 text-success/70" />
                  <span>All git branches, commits and remotes</span>
                </li>
                <li class="flex items-start gap-2">
                  <span class="mt-[5px] inline-block size-1 shrink-0 rounded-full bg-success/70" />
                  <span>
                    The project's own{" "}
                    <span class="rounded bg-muted px-1 py-px font-mono text-[11px] text-foreground">
                      .raum.toml
                    </span>{" "}
                    file (if any)
                  </span>
                </li>
              </ul>
            </section>

            <Show when={error()}>
              <Alert variant="destructive" class="text-xs">
                <AlertDescription>{error()}</AlertDescription>
              </Alert>
            </Show>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => props.onClose()}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={submitting()}
              onClick={() => {
                void submit();
              }}
            >
              {submitting() ? "Unlinking…" : `Unlink ${props.project.name}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
};

export default UnlinkProjectModal;
