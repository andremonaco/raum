/**
 * §5.5 — Solid store for registered projects.
 *
 * Holds the materialised list returned by the `project_list` Tauri command
 * plus the currently-selected project slug (the top row binds to this).
 *
 * Subscribes to the `project-color-changed` Tauri event (emitted from the
 * color-picker flow in §5.2) so any component reading `projectStore.items`
 * re-renders as soon as a color is persisted.
 *
 * `projectBySlug` mirrors `projectStore.items` as a `Map<slug, item>` for
 * O(1) lookups. Every mutator that writes to `items` MUST also update the
 * map — the helper `rebuildBySlug` consolidates both writes so the two
 * can't drift.
 */

import { batch, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { scheduleActiveSave } from "./runtimeLayoutStore";

export interface ProjectListItem {
  slug: string;
  name: string;
  color: string;
  /** Resolved Greek-letter sigil — always populated by the backend. */
  sigil: string;
  rootPath: string;
  inRepoSettings: boolean;
  hasRaumToml: boolean;
  /** Manually shelved from the top-bar tab list. Auto-suspend of session-less
   *  projects is derived (see `projectVisibility.ts`) and not stored here. */
  hidden: boolean;
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

const [projectBySlug, setProjectBySlug] = createSignal<ReadonlyMap<string, ProjectListItem>>(
  new Map(),
);

export { projectBySlug };

const [activeProjectSlug, setActiveProjectSlugInternal] = createSignal<string | undefined>(
  undefined,
);

/** Set the currently-active project tab. Persists into the active-layout
 *  snapshot so the same project is reselected on next launch — without this
 *  the rehydrated grid renders empty until the user clicks a project tab. */
function setActiveProjectSlug(slug: string | undefined): void {
  if (activeProjectSlug() === slug) return;
  setActiveProjectSlugInternal(slug);
  scheduleActiveSave();
}

export { activeProjectSlug, setActiveProjectSlug };

function buildBySlug(items: ProjectListItem[]): ReadonlyMap<string, ProjectListItem> {
  const next = new Map<string, ProjectListItem>();
  for (const item of items) next.set(item.slug, item);
  return next;
}

/**
 * Replace the project list. Uses `reconcile` so the store keeps referential
 * identity for unchanged entries (the top-row tab strip re-mounts otherwise).
 */
export function setProjects(items: ProjectListItem[]): void {
  batch(() => {
    setProjectStore("items", reconcile(items, { key: "slug" }));
    setProjectStore("loaded", true);
    setProjectBySlug(buildBySlug(items));
    const current = activeProjectSlug();
    if (current && !items.some((p) => p.slug === current)) {
      setActiveProjectSlug(items[0]?.slug);
    } else if (!current && items.length > 0) {
      setActiveProjectSlug(items[0]!.slug);
    }
  });
}

/** Upsert a single project (after `project_register` / `project_update`). */
export function upsertProject(item: ProjectListItem): void {
  batch(() => {
    const idx = projectStore.items.findIndex((p) => p.slug === item.slug);
    if (idx === -1) {
      setProjectStore("items", (prev) => [...prev, item]);
      if (!activeProjectSlug()) setActiveProjectSlug(item.slug);
    } else {
      setProjectStore("items", idx, item);
    }
    setProjectBySlug((prev) => {
      const next = new Map(prev);
      next.set(item.slug, item);
      return next;
    });
  });
}

export function removeProject(slug: string): void {
  batch(() => {
    setProjectStore("items", (prev) => prev.filter((p) => p.slug !== slug));
    setProjectBySlug((prev) => {
      if (!prev.has(slug)) return prev;
      const next = new Map(prev);
      next.delete(slug);
      return next;
    });
    if (activeProjectSlug() === slug) {
      setActiveProjectSlug(projectStore.items[0]?.slug);
    }
  });
}

/** Convenience selector (for the color swatch + the CSS `--project-accent`). */
export function projectColor(slug: string | undefined): string | undefined {
  if (!slug) return undefined;
  return projectBySlug().get(slug)?.color;
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

function patchProjectField<K extends keyof ProjectListItem>(
  slug: string,
  field: K,
  value: ProjectListItem[K],
): void {
  const idx = projectStore.items.findIndex((p) => p.slug === slug);
  if (idx < 0) return;
  batch(() => {
    setProjectStore("items", idx, field, value);
    const existing = projectBySlug().get(slug);
    if (!existing) return;
    setProjectBySlug((prev) => {
      const next = new Map(prev);
      next.set(slug, { ...existing, [field]: value });
      return next;
    });
  });
}

/** Pick the project to select after the active one leaves the tab strip.
 *  Prefers a non-shelved sibling; falls back to any other project (which, as
 *  the selected tab, is always shown regardless of its `hidden` flag). */
function pickNextActiveSlug(excludeSlug: string): string | undefined {
  const items = projectStore.items;
  const preferred = items.find((p) => p.slug !== excludeSlug && !p.hidden);
  return (preferred ?? items.find((p) => p.slug !== excludeSlug))?.slug;
}

/**
 * Manually shelve (`hidden=true`) or un-shelve (`false`) a project. Optimistic:
 * the store patches immediately so the tab strip updates without waiting on the
 * backend, then rolls back if the persist fails. When shelving the *active*
 * project the selection moves to a sibling first, so the grid never renders a
 * project that just left the bar.
 */
export async function setProjectHidden(slug: string, hidden: boolean): Promise<void> {
  const existing = projectBySlug().get(slug);
  if (!existing || existing.hidden === hidden) return;
  patchProjectField(slug, "hidden", hidden);
  if (hidden && activeProjectSlug() === slug) {
    setActiveProjectSlug(pickNextActiveSlug(slug));
  }
  try {
    await invoke("project_update", { update: { slug, hidden } });
  } catch (e) {
    console.warn("project_update hidden failed", e);
    patchProjectField(slug, "hidden", !hidden);
  }
}

/** Bring a suspended/shelved project back and make it the active tab. Clears
 *  the manual `hidden` flag if set — the active project is never shelved. */
export function reopenProject(slug: string): void {
  const existing = projectBySlug().get(slug);
  if (!existing) return;
  setActiveProjectSlug(slug);
  if (existing.hidden) void setProjectHidden(slug, false);
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
      patchProjectField(ev.payload.slug, "color", ev.payload.color);
    },
  );
  const unlistenSigil = await listen<{ slug: string; sigil: string }>(
    "project-sigil-changed",
    (ev) => {
      patchProjectField(ev.payload.slug, "sigil", ev.payload.sigil);
    },
  );
  const unlistenVisibility = await listen<{ slug: string; hidden: boolean }>(
    "project-visibility-changed",
    (ev) => {
      patchProjectField(ev.payload.slug, "hidden", ev.payload.hidden);
      if (ev.payload.hidden && activeProjectSlug() === ev.payload.slug) {
        setActiveProjectSlug(pickNextActiveSlug(ev.payload.slug));
      }
    },
  );
  return () => {
    unlistenColor();
    unlistenSigil();
    unlistenVisibility();
  };
}

export function __resetProjectStoreForTests(): void {
  setProjectStore({ items: [], loaded: false });
  setProjectBySlug(new Map());
  setActiveProjectSlugInternal(undefined);
}
