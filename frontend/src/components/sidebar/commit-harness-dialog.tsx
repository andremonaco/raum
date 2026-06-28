/**
 * §9.5 — harness picker for the Changes "Commit" action.
 *
 * The Commit button opens this dialog instead of auto-picking a harness: the
 * user chooses which installed agent (Claude / Codex / OpenCode) spawns in the
 * worktree to review the changes and write the commits. Available harnesses are
 * probed once via `harnesses_check` and cached for the session.
 */

import { Component, For, Show, createResource } from "solid-js";
import { Dynamic } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";

import { kindDisplayLabel, type AgentKind } from "../../lib/agentKind";
import { HARNESS_ICONS, LoaderIcon } from "../icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogPortal,
  DialogTitle,
} from "../ui/dialog";

// Harness preference order for the commit agent.
const COMMIT_HARNESSES = ["claude-code", "codex", "opencode"] as const;

// Probe `harnesses_check` once per session; list the installed commit harnesses
// (falling back to Claude so the picker is never empty).
let harnessProbe: Promise<AgentKind[]> | undefined;
function availableCommitHarnesses(): Promise<AgentKind[]> {
  if (!harnessProbe) {
    harnessProbe = invoke<{ harnesses: { kind: AgentKind; found: boolean }[] }>("harnesses_check")
      .then((report) => {
        const found = new Set(report.harnesses.filter((h) => h.found).map((h) => h.kind));
        const list = COMMIT_HARNESSES.filter((k) => found.has(k));
        return list.length > 0 ? [...list] : (["claude-code"] as AgentKind[]);
      })
      .catch(() => ["claude-code"] as AgentKind[]);
  }
  return harnessProbe;
}

interface CommitHarnessDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen harness kind; the caller spawns it and closes. */
  onPick: (kind: AgentKind) => void;
}

export const CommitHarnessDialog: Component<CommitHarnessDialogProps> = (props) => {
  const [harnesses] = createResource(availableCommitHarnesses);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(isOpen) => {
        if (!isOpen) props.onClose();
      }}
    >
      <DialogPortal>
        <DialogContent class="sm:max-w-[360px]">
          <DialogHeader>
            <DialogTitle class="text-sm">Commit with…</DialogTitle>
            <DialogDescription>
              Spawns the chosen agent in this worktree to review the changes and create logical,
              file-whole commits per the project's conventions.
            </DialogDescription>
          </DialogHeader>

          <Show
            when={!harnesses.loading}
            fallback={
              <div class="flex items-center gap-1.5 px-1 py-2 text-[11px] text-foreground-dim">
                <LoaderIcon class="size-3 animate-spin" />
                <span>Checking installed harnesses…</span>
              </div>
            }
          >
            <div class="flex flex-col gap-1">
              <For each={harnesses() ?? []}>
                {(kind) => (
                  <button
                    type="button"
                    class="focus-ring flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-hover"
                    onClick={() => props.onPick(kind)}
                  >
                    <Dynamic component={HARNESS_ICONS[kind]} class="size-4 shrink-0" />
                    <span class="font-medium">{kindDisplayLabel(kind)}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
};
