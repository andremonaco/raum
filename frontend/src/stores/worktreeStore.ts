/**
 * Worktree Solid store. §6.7 "switch worktree" writes to `activeWorktreeStore`.
 * The store is intentionally tiny: it holds the currently active worktree id
 * per project and nothing else.
 */

import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Shape of a worktree as surfaced by `worktree_list`. */
export interface Worktree {
  branch: string | null;
  path: string;
  head: string | null;
  locked: boolean;
  detached: boolean;
  /** Upstream/base branch (e.g. "main", "origin/main"). Null when untracked. */
  upstream: string | null;
  /**
   * Branch this worktree was originally sprouted from, persisted on create.
   * Null for pre-existing or main/root worktrees; the UI falls back to
   * `upstream` (stripped of the `origin/` prefix) in that case.
   */
  baseBranch: string | null;
}

export interface WorktreeStatus {
  dirty: boolean;
  untracked: string[];
  modified: string[];
  staged: string[];
  insertions: number;
  deletions: number;
  upstream: string | null;
  ahead: number;
  behind: number;
  stashCount: number;
}

export const EMPTY_WORKTREE_STATUS: WorktreeStatus = Object.freeze({
  dirty: false,
  untracked: [],
  modified: [],
  staged: [],
  insertions: 0,
  deletions: 0,
  upstream: null,
  ahead: 0,
  behind: 0,
  stashCount: 0,
});

/**
 * Per-project sidebar selection. `all` is the aggregate "show every terminal
 * in this project across every worktree" view; `worktree` pins the view to a
 * single worktree (and narrows spawn cwd to that worktree path).
 */
export type WorktreeScope = { mode: "all" } | { mode: "worktree"; path: string };

export const ALL_WORKTREES_SCOPE: WorktreeScope = { mode: "all" };

interface ActiveWorktreeState {
  /** Map of projectSlug → active scope. Missing entries default to `all`. */
  byProject: Record<string, WorktreeScope | undefined>;
}

const [activeWorktreeStore, setActiveWorktreeStore] = createStore<ActiveWorktreeState>({
  byProject: {},
});

export { activeWorktreeStore };

export function getWorktreeScope(projectSlug: string): WorktreeScope {
  return activeWorktreeStore.byProject[projectSlug] ?? ALL_WORKTREES_SCOPE;
}

/**
 * Pin the sidebar selection to a single worktree. Triggers reactivity in
 * components that read `activeWorktreeStore.byProject[slug]`.
 */
export function setActiveWorktree(projectSlug: string, worktreePath: string | undefined): void {
  if (worktreePath === undefined) {
    setActiveWorktreeStore("byProject", projectSlug, ALL_WORKTREES_SCOPE);
    return;
  }
  setActiveWorktreeStore("byProject", projectSlug, { mode: "worktree", path: worktreePath });
}

/** Switch the sidebar selection to the cross-worktree aggregate view. */
export function setActiveWorktreeAll(projectSlug: string): void {
  setActiveWorktreeStore("byProject", projectSlug, ALL_WORKTREES_SCOPE);
}

/** Legacy reader — returns the pinned worktree path, or `undefined` when "all". */
export function getActiveWorktree(projectSlug: string): string | undefined {
  const scope = activeWorktreeStore.byProject[projectSlug];
  return scope?.mode === "worktree" ? scope.path : undefined;
}

/**
 * Does a pane with `worktreeId` match the current scope? `mainPath` is the
 * project's root/main-worktree path — panes spawned before the worktree-id
 * plumbing landed carry `worktreeId === undefined` and are treated as main
 * so they don't disappear when the user selects the main row.
 */
export function matchesWorktreeScope(
  scope: WorktreeScope,
  paneWorktreeId: string | undefined,
  mainPath: string | undefined,
): boolean {
  if (scope.mode === "all") return true;
  if (paneWorktreeId === scope.path) return true;
  if (paneWorktreeId === undefined && mainPath !== undefined && scope.path === mainPath) {
    return true;
  }
  return false;
}

/**
 * Small cache of worktree lists per project. Exposed as a signal pair so UI
 * code can refresh it after a create/remove command without re-plumbing.
 */
const [worktreesByProject, setWorktreesByProject] = createSignal<
  Record<string, Worktree[] | undefined>
>({});

export { worktreesByProject };

const [worktreeStatusByPath, setWorktreeStatusByPath] = createSignal<
  Record<string, WorktreeStatus | undefined>
>({});
const [worktreeStatusLoadingPaths, setWorktreeStatusLoadingPaths] = createSignal<
  ReadonlySet<string>
>(new Set());

export { worktreeStatusByPath, worktreeStatusLoadingPaths };

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => path.length > 0))];
}

function setStatusLoading(paths: readonly string[], loading: boolean): void {
  if (paths.length === 0) return;
  setWorktreeStatusLoadingPaths((prev) => {
    const next = new Set(prev);
    for (const path of paths) {
      if (loading) next.add(path);
      else next.delete(path);
    }
    return next;
  });
}

export function cacheWorktreeList(projectSlug: string, items: Worktree[]): void {
  setWorktreesByProject((prev) => ({ ...prev, [projectSlug]: items }));
}

export async function refreshWorktreeList(projectSlug: string): Promise<Worktree[]> {
  try {
    const items = await invoke<Worktree[]>("worktree_list", { projectSlug });
    cacheWorktreeList(projectSlug, items);
    return items;
  } catch {
    return [];
  }
}

export async function prewarmAllWorktrees(): Promise<void> {
  try {
    const all = await invoke<Record<string, Worktree[]>>("worktree_list_all");
    setWorktreesByProject((prev) => ({ ...prev, ...all }));
    const paths = Object.values(all).flatMap((items) => items.map((item) => item.path));
    globalThis.setTimeout(() => {
      void refreshWorktreeStatuses(paths, { onlyMissing: true });
    }, 250);
  } catch {
    /* Tauri context unavailable in tests, or backend too old. */
  }
}

export function branchForProject(projectSlug: string, rootPath: string): string | null {
  const items = worktreesByProject()[projectSlug];
  if (!items) return null;
  const match = items.find((w) => w.path === rootPath) ?? items[0];
  return match?.branch ?? null;
}

export async function refreshWorktreeStatuses(
  paths: readonly string[],
  options: { onlyMissing?: boolean } = {},
): Promise<Record<string, WorktreeStatus>> {
  const current = worktreeStatusByPath();
  const loading = worktreeStatusLoadingPaths();
  const targets = uniquePaths(paths).filter((path) => {
    if (options.onlyMissing && current[path]) return false;
    return !loading.has(path);
  });
  if (targets.length === 0) return {};

  const initialTargets = targets.filter((path) => current[path] === undefined);
  setStatusLoading(initialTargets, true);
  try {
    let statuses: Record<string, WorktreeStatus>;
    try {
      statuses = await invoke<Record<string, WorktreeStatus>>("worktree_status_batch", {
        paths: targets,
      });
    } catch {
      const entries = await Promise.all(
        targets.map(async (path) => {
          const status = await invoke<WorktreeStatus>("worktree_status", { path });
          return [path, status] as const;
        }),
      );
      statuses = Object.fromEntries(entries);
    }
    setWorktreeStatusByPath((prev) => ({ ...prev, ...statuses }));
    return statuses;
  } catch {
    return {};
  } finally {
    setStatusLoading(initialTargets, false);
  }
}

export async function refreshWorktreeStatus(path: string): Promise<WorktreeStatus> {
  const statuses = await refreshWorktreeStatuses([path]);
  return statuses[path] ?? worktreeStatusByPath()[path] ?? EMPTY_WORKTREE_STATUS;
}

export function clearWorktreeListCache(projectSlug: string): void {
  setWorktreesByProject((prev) => {
    const next = { ...prev };
    delete next[projectSlug];
    return next;
  });
}

/**
 * Subscribe to backend `worktree-branches-changed` events. Mirrors the pattern
 * used by `subscribeProjectEvents` — wrap the `listen` in an async function
 * so the module stays importable under vitest (where the Tauri IPC runtime is
 * not initialised). Callers should invoke this from `onMount` and dispose via
 * the returned unlisten function.
 */
export async function subscribeWorktreeBranchEvents(): Promise<UnlistenFn> {
  return listen<{ slug: string }>("worktree-branches-changed", (ev) => {
    const { slug } = ev.payload;
    void refreshWorktreeList(slug);
  });
}
