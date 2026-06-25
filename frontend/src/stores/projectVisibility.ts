/**
 * Derived project visibility — auto-suspend + manual shelve + (opt-in) inactivity.
 *
 * A project tab is shown in the top bar iff:
 *   - it is the selected (active) project, OR
 *   - it has ≥1 live session of ANY kind (agent or plain shell), is not manually
 *     shelved (`hidden`), AND — when the "auto-hide inactive projects" setting is
 *     on — it has been used (a harness prompt sent, or a session created) within
 *     the threshold window, OR has a harness needing attention.
 *
 * Auto-suspend falls out for free: a project with zero live sessions that isn't
 * selected simply isn't in `visibleProjects` — no timer, and the currently-open
 * project never vanishes (rule 1). Manual shelve (`hidden`) suppresses a
 * project even when it has live sessions; such projects, auto-suspended ones,
 * and inactivity-hidden ones surface in `otherProjects` (the "+" → "Other
 * projects" reopen list), so every session stays ≤1 click away (the
 * session-visibility invariant holds).
 *
 * Inactivity hide is OPT-IN (off by default, see `projectsPrefs`). "Used" is
 * derived from `lastPrompt.submittedAtMs` (a prompt typed + sent) with the
 * session's creation time as a floor, maxed over the project's live sessions.
 * The active project and any project with a waiting/unread-completed harness are
 * never inactivity-hidden — so nothing important is buried. A coarse clock bumps
 * the check so a project that crosses the threshold while the app idles still
 * collapses.
 *
 * `idsByProjectSlug` in `terminalStore` is harness-only, so "has any session"
 * is counted from `byId` here to include plain shells — otherwise a lone shell
 * would be orphaned when its project auto-suspended.
 *
 * Lives in its own module to keep `projectStore` and `terminalStore` free of a
 * circular import (neither imports the other today).
 */

import { createEffect, createMemo, createRoot, createSignal } from "solid-js";

import { autoHideInactiveDays, autoHideInactiveEnabled } from "../lib/projectsPrefs";
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

const DAY_MS = 86_400_000;
/** How often the inactivity check re-evaluates while the app sits idle. The
 *  threshold is in days, so 5-minute granularity is plenty. */
const CLOCK_TICK_MS = 5 * 60_000;

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

  /** Most-recent "use" time per project (epoch ms): the newest harness-prompt
   *  submission across the project's live sessions, with each session's creation
   *  time as a floor so a freshly-created (never-prompted) harness still counts
   *  as just-used. */
  const projectLastActivityMs = createMemo<ReadonlyMap<string, number>>(() => {
    const out = new Map<string, number>();
    const byId = terminalStore.byId;
    for (const id in byId) {
      const rec = byId[id];
      const slug = rec?.project_slug;
      if (!slug) continue;
      // `created_unix` is seconds; `submittedAtMs` is ms.
      const act = Math.max(rec.lastPrompt?.submittedAtMs ?? 0, (rec.created_unix ?? 0) * 1000);
      if (act > (out.get(slug) ?? 0)) out.set(slug, act);
    }
    return out;
  });

  // Coarse clock so a project that crosses the inactivity threshold while the
  // app sits idle still collapses (without it, the filter only re-runs on
  // session/prompt/selection changes). Test-overridable via `__setNowForTests`.
  const [nowMs, setNowMs] = createSignal(Date.now());
  setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);

  const projectNeedsAttention = (slug: string): boolean =>
    harnessCountsForProject(slug).waiting > 0 || unreadCompletedForProject(slug) > 0;

  const visibleProjects = createMemo<ProjectListItem[]>(() => {
    const active = activeProjectSlug();
    const ready = terminalsReady();
    const withSession = projectsWithSession();
    const autoHide = autoHideInactiveEnabled();
    // Only depend on the clock + activity when the feature is on, so disabled
    // (the default) doesn't trigger a recompute on every clock tick.
    const thresholdMs = autoHide ? Math.max(1, autoHideInactiveDays()) * DAY_MS : 0;
    const lastActivity = autoHide ? projectLastActivityMs() : null;
    const now = autoHide ? nowMs() : 0;
    return projectStore.items.filter((p) => {
      if (p.slug === active) return true; // selected tab always shows (rule 1)
      if (p.hidden) return false; // manually shelved
      if (!ready) return true; // pre-snapshot: don't auto-suspend yet
      if (!withSession.has(p.slug)) return false; // auto-suspend when no live session
      // Live session, not active, not manually shelved. Optionally hide when
      // it hasn't been used within the window — unless a harness needs attention.
      if (lastActivity) {
        const stale = now - (lastActivity.get(p.slug) ?? 0) > thresholdMs;
        if (stale && !projectNeedsAttention(p.slug)) return false;
      }
      return true;
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

  return { visibleProjects, otherProjects, setNowMs };
});

export const visibleProjects = exported.visibleProjects;
export const otherProjects = exported.otherProjects;

/** Override the inactivity clock so tests can place "now" relative to the
 *  prompt timestamps they seed. */
export function __setNowForTests(ms: number): void {
  exported.setNowMs(ms);
}

/** Clear the rising-edge auto-resurface tracker + reset the clock. Tests share
 *  one module-global createRoot, so this prevents state bleeding across cases. */
export function __resetProjectVisibilityForTests(): void {
  hadAttention.clear();
  exported.setNowMs(Date.now());
}
