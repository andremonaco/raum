import { Component, For, Show, createSignal, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import { cx } from "~/lib/cva";
import { setShowPromptOverlay, showPromptOverlay } from "~/lib/appearancePrefs";
import {
  DEFAULT_THEME_ID,
  THEME_CATALOG,
  beginThemePreview,
  endThemePreview,
  getCurrentTheme,
  pickCustomThemeFile,
  previewThemeId,
  setCustomThemePath,
  setThemeId,
  subscribeThemeChange,
  type ThemeCatalogEntry,
} from "~/lib/theme/themeController";

import { CheckIcon } from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

import { ToggleRow } from "./shared";

/**
 * Curated VSCode theme picker. Drives `lib/theme/themeController` —
 * persistence + xterm/CodeMirror retheme — while keeping the picker UI
 * pattern identical to the Notifications "Sound" dropdown so the two
 * sibling Appearance pickers feel familiar.
 *
 * Custom themes (BYO) live behind a dedicated "Load custom .json…" item
 * that opens the Tauri dialog plugin, reads the file via `file_read`,
 * normalizes it through the same pipeline as catalog themes, and
 * persists the path to `AppearanceConfig.custom_theme_path` so it
 * survives across launches.
 */
const ThemePickerSection: Component = () => {
  const [selectedId, setSelectedId] = createSignal<string>(
    getCurrentTheme()?.id ?? DEFAULT_THEME_ID,
  );
  const [selectedLabel, setSelectedLabel] = createSignal<string>(
    getCurrentTheme()?.label ?? "raum Default Dark",
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [showAttribution, setShowAttribution] = createSignal(false);

  // The controller fires after every successful theme apply (boot,
  // catalog pick, or custom load). Mirror its state into local signals so
  // the trigger label and the active-row check stay in sync regardless of
  // who initiated the change.
  const unsubscribe = subscribeThemeChange((next) => {
    setSelectedId(next.id);
    setSelectedLabel(next.label);
    setError(null);
  });
  onCleanup(() => unsubscribe());

  const dark: ThemeCatalogEntry[] = THEME_CATALOG.filter((e) => e.type === "dark");
  const light: ThemeCatalogEntry[] = THEME_CATALOG.filter((e) => e.type === "light");

  const isCustom = () => selectedId().startsWith("custom:");

  const pickCurated = async (id: string): Promise<void> => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      // The theme may already be live via the hover preview; `setThemeId`
      // is still the right call — it overrides any preview session and
      // handles the persist. Broadcasting an already-current theme is a
      // cheap no-op in the subscribers.
      await setThemeId(id);
    } catch (e) {
      console.warn("setThemeId failed", e);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickCustom = async (): Promise<void> => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const path = await pickCustomThemeFile();
      if (!path) return;
      await setCustomThemePath(path);
    } catch (e) {
      console.warn("setCustomThemePath failed", e);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Fire a preview for the given theme id. Swallows errors so a broken
   * catalog entry doesn't tear down the picker.
   */
  const hoverPreview = (id: string): void => {
    void previewThemeId(id).catch((e) => console.warn("previewThemeId failed", e));
  };

  /**
   * Called when the dropdown opens/closes. On open we snapshot the current
   * theme (so we can restore it on dismiss); on close we restore unless
   * `pickCurated` already committed (in which case `setThemeId` cleared the
   * preview session and `endThemePreview` is a no-op).
   */
  const onDropdownOpenChange = (open: boolean): void => {
    if (open) {
      beginThemePreview();
    } else {
      endThemePreview(false);
    }
  };

  const triggerLabel = (): string => (isCustom() ? `Custom: ${selectedLabel()}` : selectedLabel());

  return (
    <div class="flex flex-col gap-1.5">
      <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">Theme</h4>
      <div class="flex flex-col gap-2 rounded border border-border bg-card/30 px-3 py-3">
        <p class="text-[10px] text-muted-foreground">
          Built on the VSCode theme JSON format — the same shape used by Dracula, Tokyo Night,
          GitHub, Catppuccin, and friends. Switching retints chrome, terminals, and the file editor
          without remounting anything.
        </p>

        <div class="flex items-center gap-1.5">
          <DropdownMenu onOpenChange={onDropdownOpenChange}>
            <DropdownMenuTrigger
              as="button"
              type="button"
              disabled={busy()}
              class="flex flex-1 items-center justify-between gap-2 rounded border border-border bg-background px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent focus:border-ring focus:outline-none disabled:pointer-events-none disabled:opacity-50"
            >
              <span class="truncate">{triggerLabel()}</span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                class="size-3 shrink-0 text-muted-foreground"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </DropdownMenuTrigger>
            <DropdownMenuPortal>
              <DropdownMenuContent class="max-h-[320px] min-w-[var(--kb-popper-anchor-width)] overflow-y-auto">
                <div class="px-2 py-1 text-[9px] uppercase tracking-wider text-muted-foreground/70">
                  Dark
                </div>
                <For each={dark}>
                  {(entry) => (
                    <DropdownMenuItem
                      class="text-xs"
                      onSelect={() => void pickCurated(entry.id)}
                      onMouseEnter={() => hoverPreview(entry.id)}
                      onFocus={() => hoverPreview(entry.id)}
                    >
                      <CheckIcon
                        class={cx(
                          "size-3",
                          selectedId() === entry.id ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span>{entry.label}</span>
                    </DropdownMenuItem>
                  )}
                </For>
                <DropdownMenuSeparator />
                <div class="px-2 py-1 text-[9px] uppercase tracking-wider text-muted-foreground/70">
                  Light
                </div>
                <For each={light}>
                  {(entry) => (
                    <DropdownMenuItem
                      class="text-xs"
                      onSelect={() => void pickCurated(entry.id)}
                      onMouseEnter={() => hoverPreview(entry.id)}
                      onFocus={() => hoverPreview(entry.id)}
                    >
                      <CheckIcon
                        class={cx(
                          "size-3",
                          selectedId() === entry.id ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span>{entry.label}</span>
                    </DropdownMenuItem>
                  )}
                </For>
                <DropdownMenuSeparator />
                <DropdownMenuItem class="text-xs" onSelect={() => void pickCustom()}>
                  <CheckIcon class={cx("size-3", isCustom() ? "opacity-100" : "opacity-0")} />
                  <span>Load custom .json…</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenu>
        </div>

        <Show when={error()}>
          <p class="text-[10px] text-destructive">{error()}</p>
        </Show>

        <button
          type="button"
          onClick={() => setShowAttribution((v) => !v)}
          class="flex items-center gap-1 self-start text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          <span>{showAttribution() ? "Hide" : "Show"} attributions</span>
        </button>
        <Show when={showAttribution()}>
          <div class="rounded border border-border/70 bg-background/40 px-2 py-1.5 text-[10px] leading-snug text-muted-foreground">
            <p class="mb-1">
              Curated themes are sourced from{" "}
              <code class="font-mono text-muted-foreground/90">tm-themes</code> (Shiki). Each theme
              retains its upstream license — see{" "}
              <code class="font-mono text-muted-foreground/90">
                frontend/src/themes/catalog/LICENSES/
              </code>{" "}
              for full attributions.
            </p>
            <ul class="grid grid-cols-2 gap-x-3 gap-y-0.5">
              <For each={THEME_CATALOG.filter((e) => e.sourceVersion !== "local")}>
                {(e) => (
                  <li class="truncate">
                    {e.label} <span class="text-muted-foreground/60">— MIT</span>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
      </div>
    </div>
  );
};

/**
 * Toggle for the per-pane prompt overlay (the glanceable banner that
 * fades the original task and latest direction over each agent
 * pane). The signal is shared via `appearancePrefs` so live panes
 * re-render the moment the user flips this switch.
 */
const PromptOverlayToggle: Component = () => {
  const [saving, setSaving] = createSignal(false);
  const handleChange = async (v: boolean) => {
    // Update the local signal immediately so every pane reacts on the
    // next tick; only roll back if the backend write fails.
    const previous = showPromptOverlay();
    setShowPromptOverlay(v);
    setSaving(true);
    try {
      await invoke("config_set_appearance_show_prompt_overlay", { enabled: v });
    } catch (e) {
      console.warn("config_set_appearance_show_prompt_overlay failed", e);
      setShowPromptOverlay(previous);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div class="flex flex-col gap-1.5">
      <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">Pane overlay</h4>
      <ToggleRow
        label="Show task overlay on panes"
        description="Fades the first and last prompt over each agent pane. Hides on mouse movement."
        checked={showPromptOverlay()}
        onChange={(v) => void handleChange(v)}
        disabled={saving()}
      />
    </div>
  );
};

export const AppearanceSection: Component = () => {
  return (
    <div class="flex flex-col gap-4">
      <ThemePickerSection />
      <PromptOverlayToggle />
    </div>
  );
};
