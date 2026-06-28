/**
 * Reactive cache of the "auto-dock inactive terminals" preference.
 *
 * Read by `stores/terminalAutoDock` to decide whether to move a harness/terminal
 * that hasn't been used within the threshold into the dock, and written by the
 * Terminals settings section. Loaded lazily from `config_get` on first import —
 * mirrors the `projectsPrefs` pattern so chrome reacts instantly to a change
 * without re-fetching the whole config.
 */

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

interface TerminalsConfigShape {
  terminals?: {
    auto_dock_inactive?: boolean;
    auto_dock_inactive_days?: number;
  };
}

const DEFAULT_DAYS = 1;

const [autoDockInactiveEnabled, setEnabledInternal] = createSignal(false);
const [autoDockInactiveDays, setDaysInternal] = createSignal(DEFAULT_DAYS);

let loaded = false;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const cfg = await invoke<TerminalsConfigShape>("config_get");
    setEnabledInternal(cfg?.terminals?.auto_dock_inactive ?? false);
    const days = cfg?.terminals?.auto_dock_inactive_days;
    setDaysInternal(typeof days === "number" && days >= 1 ? Math.floor(days) : DEFAULT_DAYS);
  } catch (e) {
    console.warn("terminalsPrefs: config_get failed", e);
  }
}

void load();

export { autoDockInactiveEnabled, autoDockInactiveDays };

/** The settings section calls these right after a successful
 *  `config_set_terminals_auto_dock` so `terminalAutoDock` reacts on the next
 *  tick without a re-fetch. */
export function setAutoDockInactiveEnabled(enabled: boolean): void {
  setEnabledInternal(enabled);
}

export function setAutoDockInactiveDays(days: number): void {
  setDaysInternal(Math.max(1, Math.floor(days) || 1));
}

/** Reset to defaults — keeps the shared module signals from bleeding across
 *  test cases (the auto-dock tests drive these directly). */
export function __resetTerminalsPrefsForTests(): void {
  setEnabledInternal(false);
  setDaysInternal(DEFAULT_DAYS);
}
