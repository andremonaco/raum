/**
 * Inactivity auto-dock — opt-in, per-tab.
 *
 * When the "auto-dock inactive terminals" setting is on, any harness/terminal
 * tab that hasn't been used within the threshold (default 1 day) is moved into
 * the dock — per INDIVIDUAL tab, so an idle tab is pulled out of its pane even
 * when a sibling tab is still active (via `minimizeTab`, which extracts the tab
 * into its own minimized single-tab pane). This is the time/lifecycle analogue
 * of `stores/projectVisibility`, which does the same opt-in, clock-ticked
 * inactivity hiding one level up (whole project tabs), and mirrors its shape:
 * a `createRoot` holding a coarse clock, conditional reactivity so a disabled
 * setting costs nothing, and `__setNowForTests` for deterministic tests.
 *
 * SCOPE: the scan only considers panes in the ACTIVE project + sidebar worktree
 * scope (the same rule as the dock's `scopedMinimizedPanes` / the grid's
 * `pruneTreeByScope`). Without this, a background project's idle panes would be
 * silently docked while the user works elsewhere — they'd never see the chips
 * (the dock is scoped too) and would return to a gutted, non-undoable grid.
 * Scoping the scan to what's on screen also keeps the focus/maximize guards
 * meaningful (those ids are global; they only matter for visible panes).
 *
 * "Used" per tab = max(backend `lastPrompt.submittedAtMs`, `created_unix` floor,
 * focus stamp from `lib/sessionActivity`, last PTY output). The output channel
 * (`lastOutputBySession`) is read via `untrack` so the scan does NOT recompute
 * on every coalesced PTY chunk — it samples the latest value on each clock tick
 * / layout change instead. This makes a still-producing shell (`tail -f`, a dev
 * server) count as used even though it sends no harness prompt.
 *
 * Guards (uphold the session-visibility invariant — never bury active work):
 *   - never dock a `working` or `waiting` harness (it's busy / needs the user);
 *   - never dock the focused or maximized pane (don't yank what the user is in —
 *     its background idle tabs get docked the moment focus moves elsewhere);
 *   - never dock a dead/unknown session (left visible for recovery);
 *   - docking is non-destructive: the session stays alive, one dock-chip click
 *     restores it, and it's skipped without `recordHistory` so a background dock
 *     doesn't pollute the user's manual undo stack.
 */

import { batch, createEffect, createMemo, createRoot, createSignal, untrack } from "solid-js";

import { markSessionActive, sessionLastActiveMs } from "../lib/sessionActivity";
import { autoDockInactiveDays, autoDockInactiveEnabled } from "../lib/terminalsPrefs";
import { activeProjectSlug, projectBySlug } from "./projectStore";
import {
  activeLayoutHydrationSettled,
  focusedPaneId,
  isPaneMinimized,
  maximizedPaneId,
  minimizeTab,
  minimizedPaneIds,
  runtimeLayoutStore,
  type PaneContent,
} from "./runtimeLayoutStore";
import {
  lastOutputBySession,
  terminalStore,
  terminalsReady,
  type TerminalRecord,
} from "./terminalStore";
import { ALL_WORKTREES_SCOPE, activeWorktreeStore, matchesWorktreeScope } from "./worktreeStore";

const DAY_MS = 86_400_000;
/** How often the inactivity check re-evaluates while the app sits idle. The
 *  threshold is in days, so 5-minute granularity is plenty. */
const CLOCK_TICK_MS = 5 * 60_000;

export interface AutoDockTarget {
  paneId: string;
  tabId: string;
  sessionId: string;
  lastUseMs: number;
}

/** Pure staleness scan — every in-scope, non-minimized, non-focused tab whose
 *  session has no activity within `thresholdMs`. Exported so tests can exercise
 *  the guards without driving effects (mirrors `dock.tsx`'s `selectOrphanRecords`). */
export function selectAutoDockTargets(params: {
  now: number;
  thresholdMs: number;
  panes: Readonly<Record<string, PaneContent>>;
  minimized: ReadonlySet<string>;
  focusedPaneId: string | null;
  maximizedPaneId: string | null;
  byId: Readonly<Record<string, TerminalRecord>>;
  lastActiveMs: (sessionId: string) => number;
  /** Last PTY output time (epoch ms) for a session, or 0. */
  lastOutputMs: (sessionId: string) => number;
  /** True when the pane is in the active project + worktree scope (visible). */
  inScope: (pane: PaneContent) => boolean;
}): AutoDockTarget[] {
  const out: AutoDockTarget[] = [];
  for (const pane of Object.values(params.panes)) {
    if (params.minimized.has(pane.id)) continue; // already docked
    if (pane.id === params.focusedPaneId) continue; // don't yank what the user is in
    if (pane.id === params.maximizedPaneId) continue; // nor the maximized pane
    if (!params.inScope(pane)) continue; // only ever dock visible (active-scope) panes
    for (const tab of pane.tabs) {
      const sid = tab.sessionId;
      if (!sid) continue; // empty/placeholder tab
      const rec = params.byId[sid];
      if (!rec || rec.dead) continue; // unknown or dead → leave visible for recovery
      if (rec.workingState === "working" || rec.workingState === "waiting") continue;
      const lastUse = Math.max(
        rec.lastPrompt?.submittedAtMs ?? 0,
        (rec.created_unix ?? 0) * 1000,
        params.lastActiveMs(sid),
        params.lastOutputMs(sid),
      );
      if (params.now - lastUse > params.thresholdMs) {
        out.push({ paneId: pane.id, tabId: tab.id, sessionId: sid, lastUseMs: lastUse });
      }
    }
  }
  return out;
}

/** Apply a batch of dock targets against the live store. Re-checks each target
 *  (earlier extractions in the same pass may have emptied or reshaped a pane)
 *  before docking it. `minimizeTab` handles the single-tab case (whole pane). */
function applyTargets(targets: readonly AutoDockTarget[]): void {
  if (targets.length === 0) return;
  batch(() => {
    for (const t of targets) {
      const pane = runtimeLayoutStore.panes[t.paneId];
      if (!pane) continue;
      if (isPaneMinimized(t.paneId)) continue;
      if (!pane.tabs.some((tab) => tab.id === t.tabId)) continue;
      minimizeTab(t.paneId, t.tabId, { recordHistory: false, activityMs: t.lastUseMs });
    }
  });
}

const exported = createRoot(() => {
  // Coarse clock so a tab that crosses the inactivity threshold while the app
  // sits idle still docks (without it the check only re-runs on session/layout
  // changes). Test-overridable via `__setNowForTests`.
  const [nowMs, setNowMs] = createSignal(Date.now());
  let started = false;

  // Focus stamp: keep the focused pane's active-tab session continuously fresh.
  // Depends on the clock so a session that stays focused (e.g. a shell you're
  // reading, which emits no output and no prompt) is re-stamped every tick and
  // never goes stale under you — and so a just-restored / just-focused tab can't
  // immediately re-dock. Always on (cheap) so the focused session is always
  // fresh even while the setting is off (it costs one stamp per clock tick).
  const focusedSessionId = createMemo<string | undefined>(() => {
    const pid = focusedPaneId();
    if (!pid) return undefined;
    const pane = runtimeLayoutStore.panes[pid];
    if (!pane) return undefined;
    return pane.tabs.find((t) => t.id === pane.activeTabId)?.sessionId;
  });
  createEffect(() => {
    nowMs(); // re-stamp on every clock tick while focused
    const sid = focusedSessionId();
    if (sid) markSessionActive(sid, Date.now());
  });

  createEffect(() => {
    // Opt-in: when off, the effect subscribes only to this signal — no clock,
    // layout, or terminal-store churn drives a recompute (mirrors
    // `projectVisibility`'s conditional-subscription trick).
    if (!autoDockInactiveEnabled()) return;
    if (!terminalsReady()) return; // pre-snapshot: `created_unix` not loaded yet
    if (!activeLayoutHydrationSettled()) return; // don't fight layout rehydration
    const thresholdMs = Math.max(1, autoDockInactiveDays()) * DAY_MS;

    // Active project + worktree scope — only panes the user can currently see.
    const slug = activeProjectSlug();
    const scope = activeWorktreeStore.byProject[slug ?? ""] ?? ALL_WORKTREES_SCOPE;
    const mainPath = projectBySlug().get(slug ?? "")?.rootPath;
    const inScope = (pane: PaneContent): boolean =>
      pane.projectSlug === undefined ||
      (pane.projectSlug === slug && matchesWorktreeScope(scope, pane.worktreeId, mainPath));

    // Sample PTY-output recency WITHOUT subscribing: `lastOutputBySession`
    // churns on every coalesced chunk, and subscribing would re-run this scan
    // dozens of times a second. We re-evaluate on the clock tick / layout
    // changes instead, reading the latest value untracked each time.
    const outputs = untrack(lastOutputBySession);

    const targets = selectAutoDockTargets({
      now: nowMs(),
      thresholdMs,
      panes: runtimeLayoutStore.panes,
      minimized: minimizedPaneIds(),
      focusedPaneId: focusedPaneId(),
      maximizedPaneId: maximizedPaneId(),
      byId: terminalStore.byId,
      lastActiveMs: sessionLastActiveMs,
      lastOutputMs: (sid) => outputs.get(sid) ?? 0,
      inScope,
    });
    applyTargets(targets);
  });

  function start(): void {
    if (started) return;
    started = true;
    setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
  }

  return { start, setNowMs };
});

/** Begin the coarse inactivity clock. Call once at app startup (the reactive
 *  effects are already live from module import; this just starts time moving so
 *  an idle app still docks across the threshold). */
export function startTerminalAutoDock(): void {
  exported.start();
}

/** Override the inactivity clock so tests can place "now" relative to the
 *  activity timestamps they seed. */
export function __setNowForTests(ms: number): void {
  exported.setNowMs(ms);
}
