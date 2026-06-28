import { Component, Show, createEffect, createResource, createSignal, on } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import { cx } from "~/lib/cva";
import { tildify } from "~/lib/pathDisplay";

import { WORKTREE_PRESETS } from "./constants";
import type { ProjectListItem, WorktreePresetKey } from "./types";
import { detectPreset, renderPathPreview } from "./utils";

const PresetRow: Component<{
  checked: boolean;
  disabled?: boolean;
  title: string;
  description: string;
  pattern: string;
  onSelect: () => void;
}> = (props) => {
  return (
    <button
      type="button"
      onClick={() => !props.disabled && props.onSelect()}
      disabled={props.disabled}
      class={cx(
        "flex items-start gap-2 rounded border px-3 py-2 text-left transition-colors disabled:pointer-events-none disabled:opacity-50",
        props.checked
          ? "border-primary/60 bg-primary/10"
          : "border-border bg-card/30 hover:bg-accent/50",
      )}
    >
      <span
        class={cx(
          "mt-0.5 block size-3 shrink-0 rounded-full border-2",
          props.checked ? "border-primary bg-primary" : "border-muted-foreground/40",
        )}
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1">
        <p class="text-xs text-foreground">{props.title}</p>
        <p class="text-[10px] text-muted-foreground">{props.description}</p>
        <p class="mt-1 truncate font-mono text-[10px] text-muted-foreground/80">{props.pattern}</p>
      </div>
    </button>
  );
};

export const WorktreesSection: Component<{ active: boolean }> = (props) => {
  const [pattern, setPattern] = createSignal<string>(WORKTREE_PRESETS.nested);
  const [customDraft, setCustomDraft] = createSignal<string>(WORKTREE_PRESETS.nested);
  const [preset, setPreset] = createSignal<WorktreePresetKey>("nested");
  const [saving, setSaving] = createSignal(false);
  const [seeded, setSeeded] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | undefined>(undefined);

  // Seed from config when the section mounts (runs once because the modal
  // keeps sections mounted and toggles visibility via `hidden`).
  void (async () => {
    try {
      const cfg = await invoke<{ worktreeConfig?: { pathPattern?: string } }>("config_get");
      const p = cfg.worktreeConfig?.pathPattern?.trim();
      const effective = p && p.length > 0 ? p : WORKTREE_PRESETS.nested;
      setPattern(effective);
      setCustomDraft(effective);
      setPreset(detectPreset(effective));
    } catch {
      // leave defaults — invalid config shouldn't block the UI.
    } finally {
      setSeeded(true);
    }
  })();

  const [projects] = createResource<ProjectListItem[]>(async () => {
    try {
      return await invoke<ProjectListItem[]>("project_list");
    } catch {
      return [];
    }
  });

  const previewProject = () => projects()?.[0];
  const previewRoot = () => tildify(previewProject()?.rootPath) || "~/example-project";
  const previewBranch = "feat/new-darkmode";

  const previewPath = () => renderPathPreview(pattern(), previewRoot(), previewBranch);

  async function persist(next: string) {
    setSaving(true);
    setSaveError(undefined);
    try {
      const stored = await invoke<string>("config_set_worktree_path_pattern", {
        pattern: next,
      });
      // Backend echoes the effective pattern (e.g. empty → built-in default).
      // Re-sync if the stored value differs from what the UI sent.
      if (stored !== next) {
        setPattern(stored);
        setCustomDraft(stored);
        setPreset(detectPreset(stored));
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function selectPreset(next: WorktreePresetKey) {
    setPreset(next);
    if (next === "custom") {
      // Don't persist yet — wait for the user to edit + blur. Seed the draft
      // from the currently-stored pattern so they can tweak rather than start
      // from scratch.
      setCustomDraft(pattern());
      return;
    }
    const p = WORKTREE_PRESETS[next];
    setPattern(p);
    setCustomDraft(p);
    void persist(p);
  }

  function commitCustom() {
    const next = customDraft().trim();
    if (!next) return;
    if (next === pattern()) return;
    setPattern(next);
    void persist(next);
  }

  // Watch the modal becoming active — re-check projects so a project added
  // while the modal was closed still shows up in the preview.
  createEffect(
    on(
      () => props.active,
      (active) => {
        if (active) {
          void invoke<ProjectListItem[]>("project_list")
            .then(() => {
              /* triggers resource refetch next read */
            })
            .catch(() => {});
        }
      },
    ),
  );

  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">
          Worktree location
        </h4>
        <p class="text-[10px] text-muted-foreground">
          Where raum puts new git worktrees. Tokens are substituted at create time.
        </p>
        <div class="flex flex-col gap-1.5">
          <PresetRow
            checked={preset() === "nested"}
            disabled={!seeded() || saving()}
            title="Nested"
            description="Lives under a .raum/ folder at the project root. raum adds .raum/ to .gitignore the first time you use this. This is the default."
            pattern={WORKTREE_PRESETS.nested}
            onSelect={() => selectPreset("nested")}
          />
          <PresetRow
            checked={preset() === "parent"}
            disabled={!seeded() || saving()}
            title="Parent"
            description="Dropped next to the project in a <name>-worktrees/ directory in the parent folder."
            pattern={WORKTREE_PRESETS.parent}
            onSelect={() => selectPreset("parent")}
          />
          <PresetRow
            checked={preset() === "custom"}
            disabled={!seeded() || saving()}
            title="Custom"
            description="Write your own pattern using the tokens below."
            pattern={preset() === "custom" ? customDraft() : "…"}
            onSelect={() => selectPreset("custom")}
          />
        </div>
      </div>

      <Show when={preset() === "custom"}>
        <div class="flex flex-col gap-1.5">
          <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">Custom pattern</h4>
          <input
            type="text"
            class="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground focus:border-ring focus:outline-none disabled:opacity-50"
            placeholder="{repo-root}/.raum/{branch-slug}"
            value={customDraft()}
            onInput={(e) => setCustomDraft(e.currentTarget.value)}
            onBlur={commitCustom}
            disabled={saving()}
          />
          <p class="text-[10px] text-muted-foreground">
            Tokens: <code class="rounded bg-muted px-1 py-px font-mono">{"{repo-root}"}</code>,{" "}
            <code class="rounded bg-muted px-1 py-px font-mono">{"{base-folder}"}</code>,{" "}
            <code class="rounded bg-muted px-1 py-px font-mono">{"{parent-dir}"}</code>,{" "}
            <code class="rounded bg-muted px-1 py-px font-mono">{"{branch-slug}"}</code>,{" "}
            <code class="rounded bg-muted px-1 py-px font-mono">{"{branch-name}"}</code>.
          </p>
        </div>
      </Show>

      <div class="flex flex-col gap-1.5">
        <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">Preview</h4>
        <div class="rounded border border-border bg-card/30 px-3 py-2">
          <p class="text-[10px] text-muted-foreground">
            Example for branch{" "}
            <code class="rounded bg-muted px-1 py-px font-mono">{previewBranch}</code>
            <Show
              when={previewProject()}
              fallback={<> in a hypothetical project (no projects registered yet)</>}
            >
              {" "}
              in {previewProject()?.name}
            </Show>
            :
          </p>
          <p class="mt-1 truncate font-mono text-xs text-foreground" data-testid="worktree-preview">
            {previewPath()}
          </p>
        </div>
      </div>

      <Show when={saveError()}>
        <div class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[10px] text-destructive">
          {saveError()}
        </div>
      </Show>
    </div>
  );
};
