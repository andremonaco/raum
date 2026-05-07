/**
 * Reactive cache of `AppearanceConfig` values that frontend chrome
 * reads on every render. Populated lazily from `config_get` on first
 * import and updated synchronously by the settings modal whenever the
 * user toggles a value, so live panes reflect changes instantly
 * without each one re-fetching the whole config.
 *
 * Currently scoped to `show_prompt_overlay` — extend by adding more
 * fields here when other appearance toggles need the same broadcast
 * pattern.
 */

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

interface RaumConfigShape {
  appearance?: {
    show_prompt_overlay?: boolean;
  };
}

const [showPromptOverlay, setShowPromptOverlayInternal] = createSignal(true);

let loaded = false;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const cfg = await invoke<RaumConfigShape>("config_get");
    // `?? true` — config files written before this field was added
    // (or any deserialization quirk) should fall back to the
    // documented default.
    setShowPromptOverlayInternal(cfg?.appearance?.show_prompt_overlay ?? true);
  } catch (e) {
    console.warn("appearancePrefs: config_get failed", e);
  }
}

void load();

export { showPromptOverlay };

/** Settings modal calls this after a successful `config_set_*` so all
 *  live readers (every TerminalPane) update on the next tick. */
export function setShowPromptOverlay(enabled: boolean): void {
  setShowPromptOverlayInternal(enabled);
}

/** Test-only reset hook. */
export function __resetAppearancePrefsForTests(): void {
  loaded = false;
  setShowPromptOverlayInternal(true);
}
