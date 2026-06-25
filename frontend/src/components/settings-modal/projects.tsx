/**
 * Projects settings section — top-bar project-tab behaviour.
 *
 * Auto-hide inactive projects: when on, a project whose harnesses haven't been
 * used (a prompt typed + sent) within N days collapses into the "+" → "Other
 * projects" list. The active project, and any project with a harness waiting on
 * the user, are never hidden. The staleness check itself is derived in
 * `stores/projectVisibility`; this just persists the {enabled, days} preference.
 */

import { Component, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import {
  autoHideInactiveDays,
  autoHideInactiveEnabled,
  setAutoHideInactiveDays,
  setAutoHideInactiveEnabled,
} from "~/lib/projectsPrefs";

import { ToggleRow } from "./shared";

export const ProjectsSection: Component = () => {
  const [saving, setSaving] = createSignal(false);

  async function persist(enabled: boolean, days: number): Promise<void> {
    setSaving(true);
    try {
      await invoke("config_set_projects_auto_hide", { enabled, days });
    } finally {
      setSaving(false);
    }
  }

  const onToggle = async (v: boolean): Promise<void> => {
    const previous = autoHideInactiveEnabled();
    setAutoHideInactiveEnabled(v); // optimistic
    try {
      await persist(v, autoHideInactiveDays());
    } catch (e) {
      console.warn("config_set_projects_auto_hide failed", e);
      setAutoHideInactiveEnabled(previous);
    }
  };

  const onDays = async (raw: number): Promise<void> => {
    const days = Math.max(1, Math.floor(raw) || 1);
    const previous = autoHideInactiveDays();
    setAutoHideInactiveDays(days); // optimistic
    try {
      await persist(autoHideInactiveEnabled(), days);
    } catch (e) {
      console.warn("config_set_projects_auto_hide failed", e);
      setAutoHideInactiveDays(previous);
    }
  };

  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-2">
        <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">Project tabs</h4>
        <ToggleRow
          label="Auto-hide inactive projects"
          description="Collapse a project's tab into 'Other projects' when none of its harnesses have been used (a prompt sent) in a while. The active project, and any project waiting on you, always stay visible. Projects with no live session already auto-suspend regardless of this."
          checked={autoHideInactiveEnabled()}
          onChange={(v) => void onToggle(v)}
          disabled={saving()}
        />
        <label
          class="flex items-center gap-3 rounded border border-border bg-card/30 px-3 py-2"
          classList={{ "opacity-50": !autoHideInactiveEnabled() }}
        >
          <span class="min-w-0 flex-1 text-xs text-foreground">Hide after</span>
          <input
            type="number"
            min="1"
            step="1"
            class="w-16 rounded border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:border-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            value={autoHideInactiveDays()}
            disabled={saving() || !autoHideInactiveEnabled()}
            onChange={(e) => void onDays(Number.parseInt(e.currentTarget.value, 10) || 1)}
          />
          <span class="text-[10px] text-muted-foreground">days of inactivity</span>
        </label>
      </div>
    </div>
  );
};
