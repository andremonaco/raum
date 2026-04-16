/**
 * §6.8 — In-app editor for worktree + hydration TOML fragments.
 *
 * Always writes to the user-level `~/.config/raum/projects/<slug>/project.toml`.
 * The backend command writes the provided text verbatim via `atomic_write`.
 */

import { Component, Show, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "./ui/button";
import { Alert, AlertDescription } from "./ui/alert";
import { TextField, TextFieldLabel, TextFieldTextArea } from "./ui/text-field";

export interface WorktreeConfigEditorProps {
  projectSlug: string;
  /** Initial TOML body shown in the textarea. */
  initialContent?: string;
  /** Called after a successful save. */
  onSaved?: () => void;
}

export const WorktreeConfigEditor: Component<WorktreeConfigEditorProps> = (props) => {
  const [content, setContent] = createSignal(props.initialContent ?? "");
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [saving, setSaving] = createSignal(false);
  const [savedAt, setSavedAt] = createSignal<number | undefined>(undefined);

  async function onSave() {
    setSaving(true);
    setError(undefined);
    try {
      await invoke<void>("worktree_config_write", {
        projectSlug: props.projectSlug,
        inRepo: false,
        tomlFragment: content(),
      });
      setSavedAt(Date.now());
      props.onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section class="flex h-full flex-col gap-2 p-3 text-xs text-foreground">
      <header class="flex items-center justify-between">
        <h3 class="text-xs font-medium">Worktree &amp; hydration config</h3>
        <span class="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
          writes to projects/{props.projectSlug}/project.toml
        </span>
      </header>

      <TextField class="flex-1" value={content()} onChange={setContent}>
        <TextFieldLabel class="sr-only">TOML fragment</TextFieldLabel>
        <TextFieldTextArea class="min-h-[240px] flex-1 font-mono text-xs" spellcheck={false} />
      </TextField>

      <Show when={error()}>
        <Alert variant="destructive" class="text-xs">
          <AlertDescription>{error()}</AlertDescription>
        </Alert>
      </Show>

      <div class="flex items-center justify-end gap-2">
        <Show when={savedAt()}>
          <span class="text-[10px] text-muted-foreground">Saved</span>
        </Show>
        <Button type="button" size="sm" onClick={() => void onSave()} disabled={saving()}>
          {saving() ? "Saving…" : "Save"}
        </Button>
      </div>
    </section>
  );
};

export default WorktreeConfigEditor;
