/**
 * §6.6 — Create worktree modal.
 *
 * Inputs: branch name.
 * Previews (live, via Tauri commands):
 *   • prefixed branch name (derived from branchPrefixMode)
 *   • target path (rendered through previewPathPattern)
 *   • hydration manifest (copy + symlink lists)
 *
 * On submit, calls `worktree_create` and clears the `useWorktreeCreate`
 * resource so the caller can refresh its worktree list.
 */

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { cacheWorktreeList, clearWorktreeListCache, type Worktree } from "../stores/worktreeStore";
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
import { TextField, TextFieldInput, TextFieldLabel } from "./ui/text-field";

interface WorktreePathPreview {
  prefixedBranch: string;
  path: string;
  pattern: string;
  branchPrefixMode: "none" | "username" | "custom";
}

interface WorktreeManifestPreview {
  copy: string[];
  symlink: string[];
  fromRaumToml: boolean;
}

interface WorktreeCreated {
  path: string;
  branch: string;
  copied: number;
  symlinked: number;
  skipped: number;
}

export interface CreateWorktreeModalProps {
  projectSlug: string;
  open: boolean;
  onClose: () => void;
  onCreated?: (created: WorktreeCreated) => void;
}

async function previewPath(
  projectSlug: string,
  branch: string,
): Promise<WorktreePathPreview | null> {
  if (!branch.trim()) return null;
  return await invoke<WorktreePathPreview>("worktree_preview_path", {
    projectSlug,
    branch,
  });
}

interface WorktreeBranchList {
  branches: string[];
  current: string | null;
}

async function fetchBranches(projectSlug: string): Promise<WorktreeBranchList> {
  return await invoke<WorktreeBranchList>("worktree_branches", { projectSlug });
}

async function previewManifest(projectSlug: string): Promise<WorktreeManifestPreview> {
  return await invoke<WorktreeManifestPreview>("worktree_preview_manifest", {
    projectSlug,
  });
}

/**
 * Small resource wrapper around `worktree_create`. Returns the last created
 * worktree (if any) and a `create` trigger function.
 */
export function useWorktreeCreate(projectSlug: () => string): {
  create: (branch: string) => Promise<WorktreeCreated>;
  lastCreated: () => WorktreeCreated | undefined;
  error: () => string | undefined;
  pending: () => boolean;
} {
  const [lastCreated, setLastCreated] = createSignal<WorktreeCreated | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [pending, setPending] = createSignal(false);

  async function create(branch: string): Promise<WorktreeCreated> {
    setPending(true);
    setError(undefined);
    try {
      const slug = projectSlug();
      const out = await invoke<WorktreeCreated>("worktree_create", {
        projectSlug: slug,
        branch,
        options: null,
      });
      setLastCreated(out);
      clearWorktreeListCache(slug);
      try {
        const items = await invoke<Worktree[]>("worktree_list", {
          projectSlug: slug,
        });
        cacheWorktreeList(slug, items);
      } catch {
        // Non-fatal — caller can retry.
      }
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      throw e;
    } finally {
      setPending(false);
    }
  }

  return { create, lastCreated, error, pending };
}

export const CreateWorktreeModal: Component<CreateWorktreeModalProps> = (props) => {
  const [branch, setBranch] = createSignal("");
  const projectSlug = createMemo(() => props.projectSlug);

  const [branchList] = createResource(
    () => (props.open ? projectSlug() : null),
    async (slug) => {
      if (!slug) return null;
      try {
        return await fetchBranches(slug);
      } catch {
        return null;
      }
    },
  );

  // Pre-fill with the root worktree's current branch when the modal opens.
  createEffect(() => {
    const list = branchList();
    if (list?.current && !branch()) {
      setBranch(list.current);
    }
  });

  const [pathPreview] = createResource(
    () => [props.open, projectSlug(), branch()] as const,
    async ([open, slug, br]) => {
      if (!open) return null;
      try {
        return await previewPath(slug, br);
      } catch {
        return null;
      }
    },
  );

  const [manifest] = createResource(
    () => (props.open ? projectSlug() : null),
    async (slug) => {
      if (!slug) return null;
      try {
        return await previewManifest(slug);
      } catch {
        return null;
      }
    },
  );

  const creator = useWorktreeCreate(() => projectSlug());

  async function onSubmit(ev: SubmitEvent) {
    ev.preventDefault();
    if (!branch().trim()) return;
    try {
      const out = await creator.create(branch());
      props.onCreated?.(out);
      setBranch("");
      props.onClose();
    } catch {
      // error() signal already captured the message.
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          setBranch("");
          props.onClose();
        }
      }}
    >
      <DialogPortal>
        <DialogContent class="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>New worktree</DialogTitle>
          </DialogHeader>

          <form class="space-y-3 text-sm" onSubmit={onSubmit}>
            <TextField value={branch()} onChange={setBranch} required>
              <TextFieldLabel class="text-xs text-muted-foreground">Branch</TextFieldLabel>
              <TextFieldInput type="text" placeholder="feat/my-branch" autofocus />
            </TextField>

            <Show when={(branchList()?.branches?.length ?? 0) > 0}>
              <div class="flex flex-wrap items-center gap-1 text-[10px]">
                <span class="text-muted-foreground">Branches:</span>
                <For each={branchList()?.branches ?? []}>
                  {(b) => (
                    <button
                      type="button"
                      class="rounded-full bg-muted px-1.5 py-0.5 font-mono transition-colors hover:bg-muted/80"
                      classList={{ "ring-1 ring-ring": branch() === b }}
                      onClick={() => setBranch(b)}
                    >
                      {b}
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <div class="rounded-md bg-muted p-2 text-xs">
              <div class="text-muted-foreground">Prefixed branch</div>
              <div class="truncate font-mono text-foreground" data-testid="preview-branch">
                {(pathPreview()?.prefixedBranch ?? branch()) || "—"}
              </div>
            </div>

            <div class="rounded-md bg-muted p-2 text-xs">
              <div class="text-muted-foreground">
                Target path
                <Show when={pathPreview()?.pattern}>
                  {" "}
                  <span class="opacity-70">(pattern: {pathPreview()?.pattern})</span>
                </Show>
              </div>
              <div class="truncate font-mono text-foreground" data-testid="preview-path">
                {pathPreview()?.path ?? "—"}
              </div>
            </div>

            <div class="rounded-md bg-muted p-2 text-xs">
              <div class="mb-1 text-muted-foreground">
                <span>Hydration manifest</span>
              </div>
              <Show
                when={(manifest()?.copy?.length ?? 0) + (manifest()?.symlink?.length ?? 0) > 0}
                fallback={
                  <div class="text-muted-foreground/70">No hydration rules configured.</div>
                }
              >
                <Show when={(manifest()?.copy ?? []).length > 0}>
                  <div class="mt-1 text-muted-foreground">Copy:</div>
                  <ul class="ml-4 list-disc font-mono text-foreground">
                    <For each={manifest()?.copy ?? []}>{(entry) => <li>{entry}</li>}</For>
                  </ul>
                </Show>
                <Show when={(manifest()?.symlink ?? []).length > 0}>
                  <div class="mt-1 text-muted-foreground">Symlink:</div>
                  <ul class="ml-4 list-disc font-mono text-foreground">
                    <For each={manifest()?.symlink ?? []}>{(entry) => <li>{entry}</li>}</For>
                  </ul>
                </Show>
              </Show>
            </div>

            <Show when={creator.error()}>
              <Alert variant="destructive" class="text-xs">
                <AlertDescription>{creator.error()}</AlertDescription>
              </Alert>
            </Show>

            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={() => props.onClose()}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={creator.pending() || !branch().trim()}>
                {creator.pending() ? "Creating…" : "Create worktree"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
};

export default CreateWorktreeModal;
