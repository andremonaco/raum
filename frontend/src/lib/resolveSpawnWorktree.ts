import { projectBySlug } from "../stores/projectStore";
import {
  activeWorktreeStore,
  ALL_WORKTREES_SCOPE,
  worktreesByProject,
} from "../stores/worktreeStore";

/** Resolve the worktree path that a new spawn should land in. When the
 *  sidebar is pinned to a specific worktree, use that path; when "All
 *  worktrees" is active (or the scope is unset), fall back to the project's
 *  main worktree path. Returns `undefined` when the worktree list cache is
 *  cold — the backend then defaults to the project root. */
export function resolveSpawnWorktree(projectSlug: string): string | undefined {
  const scope = activeWorktreeStore.byProject[projectSlug] ?? ALL_WORKTREES_SCOPE;
  if (scope.mode === "worktree") return scope.path;
  const project = projectBySlug().get(projectSlug);
  if (project?.rootPath) return project.rootPath;
  const cached = worktreesByProject()[projectSlug];
  return cached?.[0]?.path;
}
