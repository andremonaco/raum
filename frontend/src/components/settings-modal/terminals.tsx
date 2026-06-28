/**
 * Terminals settings section — terminal/harness lifecycle behaviour.
 *
 * Auto-dock inactive terminals: when on, any harness or terminal tab that hasn't
 * been used (a prompt sent, the pane focused, or just created) within N days is
 * moved into the dock — per individual tab, so an idle tab is pulled out even
 * when a sibling tab is still active. A harness that is working or waiting on the
 * user, and the focused/maximized pane, are never docked. The staleness check
 * itself is derived in `stores/terminalAutoDock`; this just persists the
 * {enabled, days} preference.
 */

import { Component, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import {
  autoDockInactiveDays,
  autoDockInactiveEnabled,
  setAutoDockInactiveDays,
  setAutoDockInactiveEnabled,
} from "~/lib/terminalsPrefs";

import { ToggleRow } from "./shared";

export const TerminalsSection: Component = () => {
  const [saving, setSaving] = createSignal(false);

  async function persist(enabled: boolean, days: number): Promise<void> {
    setSaving(true);
    try {
      await invoke("config_set_terminals_auto_dock", { enabled, days });
    } finally {
      setSaving(false);
    }
  }

  const onToggle = async (v: boolean): Promise<void> => {
    const previous = autoDockInactiveEnabled();
    setAutoDockInactiveEnabled(v); // optimistic
    try {
      await persist(v, autoDockInactiveDays());
    } catch (e) {
      console.warn("config_set_terminals_auto_dock failed", e);
      setAutoDockInactiveEnabled(previous);
    }
  };

  const onDays = async (raw: number): Promise<void> => {
    const days = Math.max(1, Math.floor(raw) || 1);
    const previous = autoDockInactiveDays();
    setAutoDockInactiveDays(days); // optimistic
    try {
      await persist(autoDockInactiveEnabled(), days);
    } catch (e) {
      console.warn("config_set_terminals_auto_dock failed", e);
      setAutoDockInactiveDays(previous);
    }
  };

  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-2">
        <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">Auto-dock</h4>
        <ToggleRow
          label="Auto-dock inactive terminals"
          description="Move a harness or terminal into the dock when it hasn't been used (a prompt sent, the pane focused, or just created) in a while — per individual tab, so an idle tab is pulled out even when a sibling tab is still active. A harness that is working or waiting on you, and the pane you're currently in, are never docked. Docking keeps the session alive; one click on its dock chip restores it."
          checked={autoDockInactiveEnabled()}
          onChange={(v) => void onToggle(v)}
          disabled={saving()}
        />
        <label
          class="flex items-center gap-3 rounded border border-border bg-card/30 px-3 py-2"
          classList={{ "opacity-50": !autoDockInactiveEnabled() }}
        >
          <span class="min-w-0 flex-1 text-xs text-foreground">Dock after</span>
          <input
            type="number"
            min="1"
            step="1"
            class="w-16 rounded border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:border-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            value={autoDockInactiveDays()}
            disabled={saving() || !autoDockInactiveEnabled()}
            onChange={(e) => void onDays(Number.parseInt(e.currentTarget.value, 10) || 1)}
          />
          <span class="text-[10px] text-muted-foreground">days of inactivity</span>
        </label>
      </div>
    </div>
  );
};
