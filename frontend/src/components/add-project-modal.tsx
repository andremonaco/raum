/**
 * §5.1 — "Add project" modal.
 *
 * Wiring:
 *   1. Directory picker (tauri-plugin-dialog `open({ directory: true })`).
 *   2. Derive a slug from the base folder name (client-side), pre-fill the
 *      project name as a title-cased version of the base name.
 *   3. On submit call the `project_register(root_path, name)` Tauri command;
 *      the backend applies default color (pseudo-random palette pick),
 *      inherits the path pattern from the user default, sets
 *      `branchPrefixMode = "none"`, and flips `in_repo_settings` on when
 *      `.raum.toml` is already present at the project root.
 *   4. Upsert the returned `ProjectListItem` into `projectStore`.
 */

import { Component, For, Show, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { upsertProject, type ProjectListItem } from "../stores/projectStore";
import { PROJECT_COLOR_PALETTE } from "../lib/projectColors";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
} from "./ui/dialog";

export interface AddProjectModalProps {
  open: boolean;
  onClose: () => void;
  onRegistered?: (project: ProjectListItem) => void;
}

function baseFolder(rootPath: string): string {
  if (!rootPath) return "";
  const normalized = rootPath.replace(/\\+/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * Slug derivation mirrors the `slug::slugify` output we'd get server-side;
 * we compute it here just for preview purposes. The backend re-derives the
 * slug canonically (so the two never drift).
 */
export function slugFromPath(rootPath: string): string {
  const base = baseFolder(rootPath);
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function prettyName(rootPath: string): string {
  return baseFolder(rootPath);
}

export const AddProjectModal: Component<AddProjectModalProps> = (props) => {
  const [rootPath, setRootPath] = createSignal("");
  const [name, setName] = createSignal("");
  const [color, setColor] = createSignal(PROJECT_COLOR_PALETTE[0]!);
  const [hexInput, setHexInput] = createSignal("");
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [busy, setBusy] = createSignal(false);

  async function pickDirectory() {
    setError(undefined);
    try {
      const selection = await openDialog({
        directory: true,
        multiple: false,
        title: "Select project root",
      });
      const picked = typeof selection === "string" ? selection : null;
      if (picked) {
        setRootPath(picked);
        if (!name().trim()) setName(prettyName(picked));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onSubmit(ev: SubmitEvent) {
    ev.preventDefault();
    if (!rootPath()) return;
    setBusy(true);
    setError(undefined);
    try {
      let registered = await invoke<ProjectListItem>("project_register", {
        rootPath: rootPath(),
        name: name().trim() || prettyName(rootPath()),
      });
      // Apply the chosen color (backend picks a random default).
      registered = await invoke<ProjectListItem>("project_update", {
        update: { slug: registered.slug, color: color() },
      });
      upsertProject(registered);
      props.onRegistered?.(registered);
      setRootPath("");
      setName("");
      setColor(PROJECT_COLOR_PALETTE[0]!);
      setHexInput("");
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(isOpen) => {
        if (!isOpen) props.onClose();
      }}
    >
      <DialogPortal>
        <DialogContent class="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Add project</DialogTitle>
          </DialogHeader>

          <form class="space-y-3 text-sm" onSubmit={(e) => void onSubmit(e)}>
            <label class="block">
              <span class="mb-1 block text-xs text-muted-foreground">Root directory</span>
              <div class="flex gap-2">
                <input
                  type="text"
                  class="flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-foreground focus:border-ring focus:outline-none"
                  placeholder="/path/to/repo"
                  value={rootPath()}
                  readOnly
                  required
                  data-testid="add-project-path"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void pickDirectory()}
                >
                  Browse…
                </Button>
              </div>
            </label>

            <label class="block">
              <span class="mb-1 block text-xs text-muted-foreground">Name</span>
              <input
                type="text"
                class="w-full rounded-md border border-input bg-background px-2 py-1 text-foreground focus:border-ring focus:outline-none"
                placeholder="Project name"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
              />
            </label>

            <div class="block">
              <span class="mb-1.5 block text-xs text-muted-foreground">Color</span>
              <div class="flex flex-wrap gap-1.5">
                <For each={PROJECT_COLOR_PALETTE}>
                  {(hex) => (
                    <button
                      type="button"
                      class="h-5 w-5 rounded border-2 transition-colors"
                      classList={{
                        "border-white scale-110": color() === hex,
                        "border-transparent hover:border-border": color() !== hex,
                      }}
                      style={{ background: hex }}
                      onClick={() => setColor(hex)}
                      aria-label={`Color ${hex}`}
                    />
                  )}
                </For>
              </div>
              <label class="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                <span>Hex</span>
                <input
                  type="text"
                  class="flex-1 rounded border border-input bg-background px-1 py-0.5 font-mono text-foreground focus:border-ring focus:outline-none"
                  placeholder="#aabbcc"
                  value={hexInput()}
                  onInput={(e) => setHexInput(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const v = e.currentTarget.value.trim();
                      if (/^#[0-9a-fA-F]{3,8}$/.test(v)) {
                        setColor(v);
                        setHexInput("");
                      }
                    }
                  }}
                />
              </label>
            </div>

            <div class="rounded-md bg-muted p-2 text-xs">
              <div class="text-muted-foreground">Derived slug</div>
              <div class="truncate font-mono text-foreground" data-testid="add-project-slug">
                {slugFromPath(rootPath()) || "—"}
              </div>
            </div>

            <Show when={error()}>
              <div class="rounded-md bg-destructive/15 p-2 text-xs text-destructive">{error()}</div>
            </Show>

            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={() => props.onClose()}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy() || !rootPath()}>
                {busy() ? "Registering…" : "Add project"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
};

export default AddProjectModal;
