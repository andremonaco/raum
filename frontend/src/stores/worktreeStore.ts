/**
 * Worktree Solid store. §6.7 "switch worktree" writes to `activeWorktreeStore`.
 * The store is intentionally tiny: it holds the currently active worktree id
 * per project and nothing else.
 */

import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { scheduleActiveSave } from "./runtimeLayoutStore";

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

/** Classified status of one changed file (porcelain v2 XY codes). Mirrors
 *  the backend `FileChangeKind` serde camelCase encoding. */
export type FileChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted"
  | "typeChange";

/** One changed file in a worktree. A path with both index and worktree
 *  changes appears twice — once `staged: true`, once `staged: false`. */
export interface FileChange {
  /** Worktree-relative path (the *new* path for renames). */
  path: string;
  /** Original path for renames/copies; null otherwise. */
  origPath: string | null;
  kind: FileChangeKind;
  staged: boolean;
  /** Lines added/removed vs HEAD; null for binary/untracked files. */
  insertions: number | null;
  deletions: number | null;
}

export interface WorktreeStatus {
  dirty: boolean;
  /** Per-file entries, staged and unstaged interleaved (filter on `staged`).
   *  Capped backend-side at 1000 — see `truncated`. */
  changes: FileChange[];
  /** True when `changes` was capped; `dirty` and the totals stay truthful. */
  truncated: boolean;
  insertions: number;
  deletions: number;
  upstream: string | null;
  ahead: number;
  behind: number;
  stashCount: number;
}

export const EMPTY_WORKTREE_STATUS: WorktreeStatus = Object.freeze({
  dirty: false,
  changes: [],
  truncated: false,
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
  } else {
    setActiveWorktreeStore("byProject", projectSlug, { mode: "worktree", path: worktreePath });
  }
  scheduleActiveSave();
}

/** Switch the sidebar selection to the cross-worktree aggregate view. */
export function setActiveWorktreeAll(projectSlug: string): void {
  setActiveWorktreeStore("byProject", projectSlug, ALL_WORKTREES_SCOPE);
  scheduleActiveSave();
}

/** Hydrate the per-project scope map from a saved active-layout snapshot.
 *  Each entry pins the project's sidebar to the named worktree path; absent
 *  entries default to the cross-worktree "all" view. Used at startup so the
 *  view restored on the active project AND every other project (when
 *  switched into) matches what the user last had open. */
export function hydrateActiveWorktreeScopes(scopes: Record<string, string>): void {
  for (const [slug, path] of Object.entries(scopes)) {
    if (typeof path !== "string" || path.length === 0) continue;
    setActiveWorktreeStore("byProject", slug, { mode: "worktree", path });
  }
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

/**
 * Subscribe to backend `worktree-status-changed` pushes — the status
 * service's per-worktree recomputes land here (seed on subscribe, then only
 * actual diffs). One global listener feeds the same `worktreeStatusByPath`
 * signal the one-shot fetches use, so consumers don't care where a status
 * came from.
 */
export async function subscribeWorktreeStatusEvents(): Promise<UnlistenFn> {
  return listen<{ path: string; status: WorktreeStatus }>("worktree-status-changed", (ev) => {
    const { path, status } = ev.payload;
    setWorktreeStatusByPath((prev) => ({ ...prev, [path]: status }));
  });
}

/**
 * Refcounted registry of worktree paths whose status should stream from the
 * backend. Rows retain on mount and release on cleanup; every change pushes
 * the FULL set via `worktree_status_subscribe` (declarative reconciliation —
 * the backend spawns/aborts watch tasks to match, so a missed release can
 * never leak a hidden polling task once the next push corrects the set).
 */
const statusStreamRefs = new Map<string, number>();
let statusSubscribePushPending = false;

function pushStatusSubscriptions(): void {
  if (statusSubscribePushPending) return;
  statusSubscribePushPending = true;
  queueMicrotask(() => {
    statusSubscribePushPending = false;
    const paths = [...statusStreamRefs.keys()];
    void invoke("worktree_status_subscribe", { paths }).catch(() => {
      /* Tauri context unavailable (tests), or backend too old —
         status then degrades to one-shot fetches. */
    });
  });
}

export function retainWorktreeStatusStream(path: string): void {
  if (path.length === 0) return;
  const refs = statusStreamRefs.get(path) ?? 0;
  statusStreamRefs.set(path, refs + 1);
  if (refs === 0) pushStatusSubscriptions();
}

export function releaseWorktreeStatusStream(path: string): void {
  const refs = statusStreamRefs.get(path) ?? 0;
  if (refs > 1) {
    statusStreamRefs.set(path, refs - 1);
    return;
  }
  if (statusStreamRefs.delete(path)) pushStatusSubscriptions();
}

/**
 * Forget a worktree entirely — cache entry, loading flag, and any remaining
 * stream refcount. Called after delete/unlink so the dead path neither
 * lingers in memory nor keeps a backend watch task alive.
 */
export function pruneWorktreeStatus(path: string): void {
  if (statusStreamRefs.delete(path)) pushStatusSubscriptions();
  setStatusLoading([path], false);
  setWorktreeStatusByPath((prev) => {
    if (!(path in prev)) return prev;
    const next = { ...prev };
    delete next[path];
    return next;
  });
}
