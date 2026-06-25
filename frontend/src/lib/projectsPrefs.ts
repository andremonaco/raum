/**
 * Reactive cache of the top-bar "auto-hide inactive projects" preference.
 *
 * Read by `stores/projectVisibility` to decide whether to collapse a project
 * tab whose harnesses haven't been used (a prompt sent) within the threshold,
 * and written by the Projects settings section. Loaded lazily from `config_get`
 * on first import — mirrors the `appearancePrefs` pattern so chrome reacts
 * instantly to a change without re-fetching the whole config.
 */

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

interface ProjectsConfigShape {
  projects?: {
    auto_hide_inactive?: boolean;
    auto_hide_inactive_days?: number;
  };
}

const DEFAULT_DAYS = 14;

const [autoHideInactiveEnabled, setEnabledInternal] = createSignal(false);
const [autoHideInactiveDays, setDaysInternal] = createSignal(DEFAULT_DAYS);

let loaded = false;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const cfg = await invoke<ProjectsConfigShape>("config_get");
    setEnabledInternal(cfg?.projects?.auto_hide_inactive ?? false);
    const days = cfg?.projects?.auto_hide_inactive_days;
    setDaysInternal(typeof days === "number" && days >= 1 ? Math.floor(days) : DEFAULT_DAYS);
  } catch (e) {
    console.warn("projectsPrefs: config_get failed", e);
  }
}

void load();

export { autoHideInactiveEnabled, autoHideInactiveDays };

/** The settings section calls these right after a successful
 *  `config_set_projects_auto_hide` so `projectVisibility` reacts on the next
 *  tick without a re-fetch. */
export function setAutoHideInactiveEnabled(enabled: boolean): void {
  setEnabledInternal(enabled);
}

export function setAutoHideInactiveDays(days: number): void {
  setDaysInternal(Math.max(1, Math.floor(days) || 1));
}

/** Reset to defaults — keeps the shared module signals from bleeding across
 *  test cases (the visibility tests drive these directly). */
export function __resetProjectsPrefsForTests(): void {
  setEnabledInternal(false);
  setDaysInternal(DEFAULT_DAYS);
}
