/**
 * Worktree Solid store. §6.7 "switch worktree" writes to `activeWorktreeStore`.
 * The store is intentionally tiny: it holds the currently active worktree id
 * per project and nothing else.
 */

import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";
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

export function cacheWorktreeList(projectSlug: string, items: Worktree[]): void {
  setWorktreesByProject((prev) => ({ ...prev, [projectSlug]: items }));
}

export function clearWorktreeListCache(projectSlug: string): void {
  setWorktreesByProject((prev) => {
    const next = { ...prev };
    delete next[projectSlug];
    return next;
  });
}

/**
 * Per-slug version counter bumped whenever the backend emits
 * `worktree-branches-changed` (fired by the `.git/HEAD` file watcher in
 * `src-tauri/src/commands/git_watcher.rs`). Components include this in their
 * `createResource` source so Solid refetches `worktree_list` on every branch
 * switch — no polling.
 */
const [branchesVersion, setBranchesVersion] = createSignal<Record<string, number>>({});

export function useBranchesVersion(projectSlug: string): number {
  return branchesVersion()[projectSlug] ?? 0;
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
    setBranchesVersion((prev) => ({ ...prev, [slug]: (prev[slug] ?? 0) + 1 }));
  });
}
