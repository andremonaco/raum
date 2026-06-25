/**
 * Derived project visibility — auto-suspend + manual shelve.
 *
 * A project tab is shown in the top bar iff:
 *   - it is the selected (active) project, OR
 *   - it has ≥1 live session of ANY kind (agent or plain shell) AND it is not
 *     manually shelved (`hidden`).
 *
 * Auto-suspend falls out for free: a project with zero live sessions that isn't
 * selected simply isn't in `visibleProjects` — no timer, and the currently-open
 * project never vanishes (rule 1). Manual shelve (`hidden`) suppresses a
 * project even when it has live sessions; such projects, and auto-suspended
 * ones, surface in `otherProjects` (the "+" → "Other projects" reopen list),
 * so every session stays ≤1 click away (the session-visibility invariant holds).
 *
 * `idsByProjectSlug` in `terminalStore` is harness-only, so "has any session"
 * is counted from `byId` here to include plain shells — otherwise a lone shell
 * would be orphaned when its project auto-suspended.
 *
 * Lives in its own module to keep `projectStore` and `terminalStore` free of a
 * circular import (neither imports the other today).
 */

import { createEffect, createMemo, createRoot } from "solid-js";

import {
  activeProjectSlug,
  projectStore,
  setProjectHidden,
  type ProjectListItem,
} from "./projectStore";
import {
  harnessCountsForProject,
  terminalsReady,
  terminalStore,
  unreadCompletedForProject,
} from "./terminalStore";

// Rising-edge tracker for auto-resurface. Module-scoped (not inside the
// createRoot closure) so it can be pruned of dead slugs and reset in tests.
const hadAttention = new Set<string>();

const exported = createRoot(() => {
  /** Slugs of projects that currently have at least one live session of any
   *  kind. Counts from `byId` (not the harness-only `idsByProjectSlug`) so a
   *  plain shell keeps its project active. */
  const projectsWithSession = createMemo<ReadonlySet<string>>(() => {
    const out = new Set<string>();
    const byId = terminalStore.byId;
    for (const id in byId) {
      const slug = byId[id]?.project_slug;
      if (slug) out.add(slug);
    }
    return out;
  });

  const visibleProjects = createMemo<ProjectListItem[]>(() => {
    const active = activeProjectSlug();
    const ready = terminalsReady();
    const withSession = projectsWithSession();
    return projectStore.items.filter((p) => {
      if (p.slug === active) return true; // selected tab always shows (rule 1)
      if (p.hidden) return false; // manually shelved
      if (!ready) return true; // pre-snapshot: don't auto-suspend yet
      return withSession.has(p.slug); // auto-suspend when no live session
    });
  });

  const visibleSlugs = createMemo<ReadonlySet<string>>(
    () => new Set(visibleProjects().map((p) => p.slug)),
  );

  /** Everything not currently in the bar: auto-suspended (session-less, not
   *  selected) ∪ manually shelved. Powers the "Other projects" reopen list. */
  const otherProjects = createMemo<ProjectListItem[]>(() => {
    const vis = visibleSlugs();
    return projectStore.items.filter((p) => !vis.has(p.slug));
  });

  // Auto-resurface: a shelved project that *newly* gains a waiting (needs-input)
  // or unread-completed session pops back so it can't be missed. Triggered on
  // the rising edge of attention only — so manually shelving a project that is
  // already waiting sticks (the user's explicit intent), while a fresh
  // needs-input event on an already-shelved project still reveals it. The
  // edge tracker clears when attention subsides, arming the next episode.
  createEffect(() => {
    const live = new Set<string>();
    for (const p of projectStore.items) {
      live.add(p.slug);
      const needsAttention =
        harnessCountsForProject(p.slug).waiting > 0 || unreadCompletedForProject(p.slug) > 0;
      if (needsAttention && !hadAttention.has(p.slug)) {
        hadAttention.add(p.slug);
        if (p.hidden) void setProjectHidden(p.slug, false);
      } else if (!needsAttention && hadAttention.has(p.slug)) {
        hadAttention.delete(p.slug);
      }
    }
    // Prune slugs of removed projects so the Set can't grow unbounded and a
    // removed-then-re-added slug re-arms its rising edge cleanly.
    for (const slug of hadAttention) {
      if (!live.has(slug)) hadAttention.delete(slug);
    }
  });

  return { visibleProjects, otherProjects };
});

export const visibleProjects = exported.visibleProjects;
export const otherProjects = exported.otherProjects;

/** Clear the rising-edge auto-resurface tracker. Tests share one module-global
 *  createRoot, so this prevents resurface state from bleeding across cases. */
export function __resetProjectVisibilityForTests(): void {
  hadAttention.clear();
}
