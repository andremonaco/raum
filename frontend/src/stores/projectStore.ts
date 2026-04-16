/**
 * §5.5 — Solid store for registered projects.
 *
 * Holds the materialised list returned by the `project_list` Tauri command
 * plus the currently-selected project slug (the top row binds to this).
 *
 * Subscribes to the `project-color-changed` Tauri event (emitted from the
 * color-picker flow in §5.2) so any component reading `projectStore.items`
 * re-renders as soon as a color is persisted.
 */

import { createStore, reconcile } from "solid-js/store";
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ProjectListItem {
  slug: string;
  name: string;
  color: string;
  /** Resolved Greek-letter sigil — always populated by the backend. */
  sigil: string;
  rootPath: string;
  inRepoSettings: boolean;
  hasRaumToml: boolean;
}

interface ProjectState {
  items: ProjectListItem[];
  loaded: boolean;
}

const [projectStore, setProjectStore] = createStore<ProjectState>({
  items: [],
  loaded: false,
});

export { projectStore };

const [activeProjectSlug, setActiveProjectSlug] = createSignal<string | undefined>(undefined);

export { activeProjectSlug, setActiveProjectSlug };

/**
 * Replace the project list. Uses `reconcile` so the store keeps referential
 * identity for unchanged entries (the top-row tab strip re-mounts otherwise).
 */
export function setProjects(items: ProjectListItem[]): void {
  setProjectStore("items", reconcile(items, { key: "slug" }));
  setProjectStore("loaded", true);
  const current = activeProjectSlug();
  if (current && !items.some((p) => p.slug === current)) {
    setActiveProjectSlug(items[0]?.slug);
  } else if (!current && items.length > 0) {
    setActiveProjectSlug(items[0]!.slug);
  }
}

/** Upsert a single project (after `project_register` / `project_update`). */
export function upsertProject(item: ProjectListItem): void {
  const idx = projectStore.items.findIndex((p) => p.slug === item.slug);
  if (idx === -1) {
    setProjectStore("items", (prev) => [...prev, item]);
    if (!activeProjectSlug()) setActiveProjectSlug(item.slug);
  } else {
    setProjectStore("items", idx, item);
  }
}

export function removeProject(slug: string): void {
  setProjectStore("items", (prev) => prev.filter((p) => p.slug !== slug));
  if (activeProjectSlug() === slug) {
    setActiveProjectSlug(projectStore.items[0]?.slug);
  }
}

/** Convenience selector (for the color swatch + the CSS `--project-accent`). */
export function projectColor(slug: string | undefined): string | undefined {
  if (!slug) return undefined;
  return projectStore.items.find((p) => p.slug === slug)?.color;
}

/** Fetch from the backend and hydrate the store. */
export async function refreshProjects(): Promise<ProjectListItem[]> {
  try {
    const items = await invoke<ProjectListItem[]>("project_list");
    setProjects(items);
    return items;
  } catch (e) {
    // Log-only: the UI falls back to an empty list so it still renders.

    console.warn("project_list failed", e);
    setProjects([]);
    return [];
  }
}

/**
 * Subscribe to backend events that mutate the project store.
 *
 * Listens for `project-color-changed` (payload `{ slug, color }`) and
 * `project-sigil-changed` (payload `{ slug, sigil }`), both emitted by
 * `project_update`. Returns a disposer the caller should run on unmount.
 */
export async function subscribeProjectEvents(): Promise<UnlistenFn> {
  const unlistenColor = await listen<{ slug: string; color: string }>(
    "project-color-changed",
    (ev) => {
      const { slug, color } = ev.payload;
      const idx = projectStore.items.findIndex((p) => p.slug === slug);
      if (idx >= 0) {
        setProjectStore("items", idx, "color", color);
      }
    },
  );
  const unlistenSigil = await listen<{ slug: string; sigil: string }>(
    "project-sigil-changed",
    (ev) => {
      const { slug, sigil } = ev.payload;
      const idx = projectStore.items.findIndex((p) => p.slug === slug);
      if (idx >= 0) {
        setProjectStore("items", idx, "sigil", sigil);
      }
    },
  );
  return () => {
    unlistenColor();
    unlistenSigil();
  };
}
