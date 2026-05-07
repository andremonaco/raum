/**
 * §9 — discard confirmation dialog.
 *
 * Confirmation dialog for destructive discards. Covers both per-file and
 * worktree-wide ("Discard all") cases — the props tell which message to show.
 */

import { Component, Show } from "solid-js";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
} from "../ui/dialog";
import type { DiscardConfirmDialogProps } from "./types";

export const DiscardConfirmDialog: Component<DiscardConfirmDialogProps> = (props) => {
  const isAll = () => props.target?.kind === "all";
  const fileName = () => (props.target?.kind === "file" ? props.target.file : "");
  return (
    <Dialog
      open={props.target !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) props.onClose();
      }}
    >
      <DialogPortal>
        <DialogContent class="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle class="text-sm">
              <Show when={isAll()} fallback={<>Discard changes to this file?</>}>
                Discard all unstaged changes?
              </Show>
            </DialogTitle>
          </DialogHeader>

          <div class="space-y-2 text-xs">
            <Show when={isAll()}>
              <p class="text-muted-foreground">
                This will revert every unstaged change in{" "}
                <span class="font-mono text-foreground">{props.worktreeName}</span> and remove
                untracked files. Staged changes are left alone. This cannot be undone.
              </p>
              <div class="rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                {props.unstagedCount} unstaged file
                {props.unstagedCount === 1 ? "" : "s"}
              </div>
            </Show>
            <Show when={!isAll()}>
              <p class="text-muted-foreground">
                Revert worktree changes to{" "}
                <span class="font-mono text-foreground">{fileName()}</span>. Untracked files are
                deleted. This cannot be undone.
              </p>
            </Show>
            <Show when={props.error}>
              <p class="text-destructive">{props.error}</p>
            </Show>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => props.onClose()}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={props.submitting}
              onClick={() => props.onConfirm()}
            >
              {props.submitting ? "Discarding…" : "Discard"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
};
