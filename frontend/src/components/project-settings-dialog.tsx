/**
 * Project settings dialog — color + hydration rules editor.
 *
 * Opens from the top-row project tab (click an active tab). Left column is the
 * color picker; right column explains hydration and hosts the gitignored file
 * tree where users tag each path as copy / symlink / skip.
 */

import { Component, For, Show, createEffect, createResource, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { upsertProject, type ProjectListItem } from "../stores/projectStore";
import { PROJECT_COLOR_PALETTE } from "../lib/projectColors";
import { PROJECT_SIGIL_PALETTE, SIGIL_RESET, deriveSigilFromSlug } from "../lib/projectSigils";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogPortal, DialogTitle } from "./ui/dialog";
import { Scrollable } from "./ui/scrollable";
import {
  HydrationFileTree,
  HYDRATION_CHOICE_META,
  type FileTreeNode,
  type HydrationChoice,
} from "./hydration-file-tree";
import { Dynamic } from "solid-js/web";

interface WorktreeHooksDto {
  preCreate: string | null;
  postCreate: string | null;
  timeoutSecs: number;
}

type PathStrategy = "sibling-group" | "nested" | "custom";

interface EffectiveProjectDto {
  slug: string;
  name: string;
  color: string;
  sigil: string;
  rootPath: string;
  inRepoSettings: boolean;
  hasRaumToml: boolean;
  hydration: { copy: string[]; symlink: string[] };
  worktree: {
    pathStrategy: PathStrategy;
    pathPattern: string;
    branchPrefixMode: "none" | "username" | "custom";
    branchPrefixCustom: string | null;
    hooks: WorktreeHooksDto;
  };
}

const DEFAULT_HOOK_TIMEOUT_SECS = 300;

export interface ProjectSettingsDialogProps {
  project: ProjectListItem;
  open: boolean;
  onClose: () => void;
}

// ---- Hydration legend ------------------------------------------------------

interface LegendCard {
  choice: HydrationChoice;
  tagline: string;
  example: string;
}

const HYDRATION_LEGEND: LegendCard[] = [
  { choice: "copy", tagline: "Duplicate per worktree", example: ".env" },
  { choice: "symlink", tagline: "Shared across worktrees", example: "node_modules" },
  { choice: "none", tagline: "Not present", example: "—" },
];

const HydrationLegend: Component = () => (
  <div class="grid shrink-0 grid-cols-3 gap-2">
    <For each={HYDRATION_LEGEND}>
      {(card) => {
        const meta = HYDRATION_CHOICE_META[card.choice];
        return (
          <div class="flex flex-col gap-1 rounded-lg bg-background px-3 py-2 ring-1 ring-white/5">
            <span class="flex items-center gap-1.5 text-foreground">
              <Dynamic component={meta.icon} class="h-4 w-4" />
              <span class="text-[10px] font-semibold uppercase tracking-wide">{meta.label}</span>
            </span>
            <span class="text-[11px] leading-snug text-muted-foreground">{card.tagline}</span>
            <code class="truncate font-mono text-[10px] text-muted-foreground/70">
              {card.example}
            </code>
          </div>
        );
      }}
    </For>
  </div>
);

// ---- Dialog ----------------------------------------------------------------

export const ProjectSettingsDialog: Component<ProjectSettingsDialogProps> = (props) => {
  const [color, setColor] = createSignal(props.project.color);
  const [hexInput, setHexInput] = createSignal("");
  const [sigil, setSigil] = createSignal(props.project.sigil);
  // `""` means "reset to slug-derived"; any glyph pins that sigil.
  const [sigilOverride, setSigilOverride] = createSignal<string | null>(null);
  const [copyPaths, setCopyPaths] = createSignal<string[]>([]);
  const [symlinkPaths, setSymlinkPaths] = createSignal<string[]>([]);
  const [preCreateHook, setPreCreateHook] = createSignal("");
  const [postCreateHook, setPostCreateHook] = createSignal("");
  const [hookTimeoutSecs, setHookTimeoutSecs] = createSignal(DEFAULT_HOOK_TIMEOUT_SECS);
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
      setSigil(eff.sigil);
      setSigilOverride(null);
      setCopyPaths([...eff.hydration.copy]);
      setSymlinkPaths([...eff.hydration.symlink]);
      setPreCreateHook(eff.worktree.hooks.preCreate ?? "");
      setPostCreateHook(eff.worktree.hooks.postCreate ?? "");
      setHookTimeoutSecs(eff.worktree.hooks.timeoutSecs);
    }
  });

  async function pickHookScript(setter: (v: string) => void) {
    try {
      const selection = await openDialog({
        multiple: false,
        directory: false,
        title: "Select hook script",
      });
      if (typeof selection === "string") setter(selection);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function pickSigil(glyph: string) {
    if (glyph === SIGIL_RESET) {
      setSigil(deriveSigilFromSlug(props.project.slug));
    } else {
      setSigil(glyph);
    }
    setSigilOverride(glyph);
  }

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
      const override = sigilOverride();
      const eff = effective();
      // Preserve the effective worktree block so we don't inadvertently reset
      // path_pattern / branch_prefix when the user only edited hooks. `project_update`
      // performs a whole-struct replace for `worktree`.
      const worktreePayload = eff
        ? {
            pathStrategy: eff.worktree.pathStrategy,
            pathPattern: eff.worktree.pathPattern,
            branchPrefixMode: eff.worktree.branchPrefixMode,
            branchPrefixCustom: eff.worktree.branchPrefixCustom,
            hooks: {
              preCreate: preCreateHook().trim() ? preCreateHook().trim() : null,
              postCreate: postCreateHook().trim() ? postCreateHook().trim() : null,
              timeoutSecs: Math.max(0, Math.floor(hookTimeoutSecs())),
            },
          }
        : undefined;
      const updated = await invoke<ProjectListItem>("project_update", {
        update: {
          slug: props.project.slug,
          color: color(),
          ...(override !== null ? { sigil: override } : {}),
          hydration: { copy: copyPaths(), symlink: symlinkPaths() },
          ...(worktreePayload ? { worktree: worktreePayload } : {}),
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
         * Sidecar layout: left column = color / sigil / hooks, right column =
         * hydration file tree (full height). !flex !flex-col overrides
         * Kobalte's base `grid` + `gap-4`; !p-0 lets the header / body /
         * footer manage their own padding.
         */}
        <DialogContent class="!flex !flex-col !gap-0 !p-0 h-[min(780px,calc(100vh-2rem))] max-h-[780px] w-[min(1000px,calc(100vw-2rem))] max-w-[1000px] sm:max-w-[1000px]">
          {/* ── Header ──────────────────────────────────────────────── */}
          <DialogHeader class="shrink-0 border-b border-white/5 px-6 py-4">
            <DialogTitle class="flex items-center gap-2">
              <span
                class="inline-flex h-4 w-4 shrink-0 select-none items-center justify-center font-mono text-[15px] leading-none tabular-nums"
                style={{ color: color() }}
                aria-hidden="true"
              >
                {sigil()}
              </span>
              {props.project.name || props.project.slug} — settings
            </DialogTitle>
          </DialogHeader>

          {/* ── Two-column body ─────────────────────────────────────── */}
          <div class="flex min-h-0 flex-1 overflow-hidden">
            {/* LEFT — color, sigil, setup hooks */}
            <Scrollable class="w-[360px] shrink-0 text-sm">
              <div class="flex flex-col gap-7 p-6">
                <section class="flex flex-col gap-2.5">
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

                <section class="flex flex-col gap-2.5">
                  <h4 class="text-xs font-medium text-muted-foreground">Sigil</h4>
                  <div class="grid grid-cols-8 gap-px">
                    <For each={PROJECT_SIGIL_PALETTE}>
                      {(g) => (
                        <button
                          type="button"
                          class="inline-flex h-5 w-5 items-center justify-center rounded font-mono text-xs leading-none hover:bg-muted"
                          classList={{
                            "bg-muted ring-1 ring-border": g === sigil(),
                          }}
                          style={{ color: color() }}
                          onClick={() => pickSigil(g)}
                          aria-label={`Pick sigil ${g}`}
                        >
                          {g}
                        </button>
                      )}
                    </For>
                  </div>
                  <button
                    type="button"
                    class="self-start text-[10px] text-muted-foreground hover:text-foreground"
                    onClick={() => pickSigil(SIGIL_RESET)}
                  >
                    ↻ Reset to derived ({deriveSigilFromSlug(props.project.slug)})
                  </button>
                </section>

                {/* Setup hooks — executable scripts run around worktree creation */}
                <section class="flex flex-col gap-3">
                  <h4 class="text-xs font-medium text-muted-foreground">Setup hooks</h4>
                  <p class="text-[11px] leading-relaxed text-muted-foreground">
                    Executables run with your user's permissions. Relative paths resolve against the
                    project root. Scripts receive{" "}
                    <code class="font-mono text-[10px]">$RAUM_PHASE</code>,{" "}
                    <code class="font-mono text-[10px]">$RAUM_WORKTREE_PATH</code>,{" "}
                    <code class="font-mono text-[10px]">$RAUM_BRANCH</code>, and project vars.
                  </p>

                  <label class="flex flex-col gap-1 text-[10px] text-muted-foreground">
                    <span>Pre-create</span>
                    <div class="flex items-center gap-1">
                      <input
                        type="text"
                        class="flex-1 min-w-0 rounded border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:border-ring focus:outline-none"
                        placeholder="scripts/pre-worktree.sh"
                        value={preCreateHook()}
                        onInput={(e) => setPreCreateHook(e.currentTarget.value)}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => void pickHookScript(setPreCreateHook)}
                      >
                        …
                      </Button>
                    </div>
                  </label>

                  <label class="flex flex-col gap-1 text-[10px] text-muted-foreground">
                    <span>Post-create</span>
                    <div class="flex items-center gap-1">
                      <input
                        type="text"
                        class="flex-1 min-w-0 rounded border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:border-ring focus:outline-none"
                        placeholder="scripts/post-worktree.sh"
                        value={postCreateHook()}
                        onInput={(e) => setPostCreateHook(e.currentTarget.value)}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => void pickHookScript(setPostCreateHook)}
                      >
                        …
                      </Button>
                    </div>
                  </label>

                  <label class="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span class="w-[72px] shrink-0">Timeout</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      class="w-20 rounded border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:border-ring focus:outline-none"
                      value={hookTimeoutSecs()}
                      onInput={(e) =>
                        setHookTimeoutSecs(Number.parseInt(e.currentTarget.value, 10) || 0)
                      }
                    />
                    <span>sec (0 = none)</span>
                  </label>
                </section>
              </div>
            </Scrollable>

            {/* Vertical divider */}
            <div class="w-px shrink-0 bg-white/5" />

            {/* RIGHT — hydration (full height) */}
            <div class="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden p-5">
              <div class="shrink-0">
                <h4 class="text-xs font-medium text-foreground">Hydration</h4>
                <p class="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  New worktrees only get tracked files. Tag gitignored paths below so essentials
                  follow along.
                </p>
              </div>

              <HydrationLegend />

              {/* Tree fills the remaining column height */}
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
