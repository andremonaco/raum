/**
 * Worktree Solid store. §6.7 "switch worktree" writes to `activeWorktreeStore`
 * without auto-applying any preset. The store is intentionally tiny: it holds
 * the currently active worktree id per project and nothing else. Preset
 * pointers are fetched lazily through the Tauri command `worktree_preset_get`.
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
}

interface ActiveWorktreeState {
  /** Map of projectSlug → active worktree path ("id"). */
  byProject: Record<string, string | undefined>;
}

const [activeWorktreeStore, setActiveWorktreeStore] = createStore<ActiveWorktreeState>({
  byProject: {},
});

export { activeWorktreeStore };

/**
 * Set the active worktree for a project. Triggers reactivity in components
 * that read `activeWorktreeStore.byProject[slug]`. Does not auto-apply any
 * preset (§6.7 requires explicit user action for that).
 */
export function setActiveWorktree(projectSlug: string, worktreePath: string | undefined): void {
  setActiveWorktreeStore("byProject", projectSlug, worktreePath);
}

export function getActiveWorktree(projectSlug: string): string | undefined {
  return activeWorktreeStore.byProject[projectSlug];
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
