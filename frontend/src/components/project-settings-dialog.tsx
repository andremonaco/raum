/**
 * Project settings dialog — color + hydration rules editor.
 *
 * Opens from the top-row project tab (click an active tab). Left column is the
 * color picker; right column explains hydration and hosts the gitignored file
 * tree where users tag each path as copy / symlink / skip.
 */

import { Component, For, Show, createEffect, createResource, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { upsertProject, type ProjectListItem } from "../stores/projectStore";
import { PROJECT_COLOR_PALETTE } from "../lib/projectColors";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogPortal, DialogTitle } from "./ui/dialog";
import { HydrationFileTree, type FileTreeNode, type HydrationChoice } from "./hydration-file-tree";

interface EffectiveProjectDto {
  slug: string;
  name: string;
  color: string;
  rootPath: string;
  inRepoSettings: boolean;
  hasRaumToml: boolean;
  hydration: { copy: string[]; symlink: string[] };
  worktree: {
    pathPattern: string;
    branchPrefixMode: "none" | "username" | "custom";
    branchPrefixCustom: string | null;
  };
}

export interface ProjectSettingsDialogProps {
  project: ProjectListItem;
  open: boolean;
  onClose: () => void;
}

// ---- Hydration legend ------------------------------------------------------

interface LegendCard {
  label: string;
  tagline: string;
  example: string;
}

const HYDRATION_LEGEND: LegendCard[] = [
  { label: "Copy", tagline: "Duplicate per worktree", example: ".env" },
  { label: "Symlink", tagline: "Shared across worktrees", example: "node_modules" },
  { label: "Skip", tagline: "Not present", example: "—" },
];

const HydrationLegend: Component = () => (
  <div class="grid shrink-0 grid-cols-3 gap-2">
    <For each={HYDRATION_LEGEND}>
      {(card) => (
        <div class="flex flex-col gap-0.5 rounded-lg bg-muted/30 px-3 py-2">
          <span class="text-[10px] font-semibold uppercase tracking-wide text-foreground">
            {card.label}
          </span>
          <span class="text-[11px] leading-snug text-muted-foreground">{card.tagline}</span>
          <code class="truncate font-mono text-[10px] text-muted-foreground/70">
            {card.example}
          </code>
        </div>
      )}
    </For>
  </div>
);

// ---- Dialog ----------------------------------------------------------------

export const ProjectSettingsDialog: Component<ProjectSettingsDialogProps> = (props) => {
  const [color, setColor] = createSignal(props.project.color);
  const [hexInput, setHexInput] = createSignal("");
  const [copyPaths, setCopyPaths] = createSignal<string[]>([]);
  const [symlinkPaths, setSymlinkPaths] = createSignal<string[]>([]);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>(undefined);

  const [effective] = createResource(
    () => (props.open ? props.project.slug : null),
    async (slug) => {
      if (!slug) return null;
      return await invoke<EffectiveProjectDto | null>("project_config_effective", { slug });
    },
  );

  const [gitignoreTree] = createResource(
    () => (props.open ? props.project.slug : null),
    async (slug) => {
      if (!slug) return [];
      return await invoke<FileTreeNode[]>("project_list_gitignored", { slug });
    },
  );

  createEffect(() => {
    const eff = effective();
    if (eff) {
      setColor(eff.color);
      setCopyPaths([...eff.hydration.copy]);
      setSymlinkPaths([...eff.hydration.symlink]);
    }
  });

  function handleHydrationToggle(path: string, choice: HydrationChoice) {
    if (choice === "copy") {
      setCopyPaths((prev) => [...new Set([...prev, path])]);
      setSymlinkPaths((prev) => prev.filter((p) => p !== path));
    } else if (choice === "symlink") {
      setSymlinkPaths((prev) => [...new Set([...prev, path])]);
      setCopyPaths((prev) => prev.filter((p) => p !== path));
    } else {
      setCopyPaths((prev) => prev.filter((p) => p !== path));
      setSymlinkPaths((prev) => prev.filter((p) => p !== path));
    }
  }

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      const updated = await invoke<ProjectListItem>("project_update", {
        update: {
          slug: props.project.slug,
          color: color(),
          hydration: { copy: copyPaths(), symlink: symlinkPaths() },
        },
      });
      upsertProject(updated);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
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
        {/*
         * Sidecar layout: left column = color, right column = hydration.
         * !flex !flex-col overrides Kobalte's base `grid` + `p-6 gap-4`.
         */}
        <DialogContent
          class="!flex !flex-col !gap-0 !p-0 h-[560px] overflow-hidden !rounded-2xl !border-0 !bg-popover sm:max-w-[880px]"
          style={{
            "box-shadow": "0 24px 64px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)",
          }}
        >
          {/* ── Header ──────────────────────────────────────────────── */}
          <DialogHeader class="shrink-0 border-b border-white/5 px-6 py-4">
            <DialogTitle class="flex items-center gap-2">
              <span
                class="inline-block h-3 w-3 shrink-0 rounded-full ring-1 ring-white/20"
                style={{ background: color() }}
              />
              {props.project.name || props.project.slug} — settings
            </DialogTitle>
          </DialogHeader>

          {/* ── Two-column body ─────────────────────────────────────── */}
          <div class="flex min-h-0 flex-1 overflow-hidden">
            {/* LEFT — project color picker */}
            <div class="flex w-[272px] shrink-0 flex-col gap-5 overflow-y-auto p-5 text-sm">
              <section class="flex flex-col gap-1.5">
                <h4 class="text-xs font-medium text-muted-foreground">Color</h4>
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
                <label class="flex items-center gap-1 text-[10px] text-muted-foreground">
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
              </section>
            </div>

            {/* Vertical divider */}
            <div class="w-px shrink-0 bg-white/5" />

            {/* RIGHT — hydration */}
            <div class="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden p-5">
              <div class="shrink-0">
                <h4 class="text-xs font-medium text-foreground">Hydration</h4>
                <p class="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  New worktrees only get tracked files. Tag gitignored paths below so essentials
                  follow along.
                </p>
              </div>

              <HydrationLegend />

              {/* Tree fills remaining height */}
              <div class="min-h-0 flex-1">
                <Show
                  when={!gitignoreTree.loading}
                  fallback={<p class="py-2 text-[11px] text-muted-foreground">Loading…</p>}
                >
                  <HydrationFileTree
                    nodes={gitignoreTree() ?? []}
                    slug={props.project.slug}
                    copyPaths={copyPaths()}
                    symlinkPaths={symlinkPaths()}
                    onToggle={handleHydrationToggle}
                    class="h-full"
                  />
                </Show>
              </div>
            </div>
          </div>

          {/* ── Footer ──────────────────────────────────────────────── */}
          <div class="shrink-0 border-t border-white/5 px-6 py-4">
            <Show when={error()}>
              <div class="mb-3 rounded-md bg-destructive/15 p-2 text-xs text-destructive">
                {error()}
              </div>
            </Show>
            <div class="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => props.onClose()}>
                Cancel
              </Button>
              <Button type="button" size="sm" disabled={saving()} onClick={() => void save()}>
                {saving() ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
};
