/**
 * Shared view-activation helper — the single path every ordinary navigation
 * entry point funnels through (project tab, worktree row / All scopes, pane
 * tab, dock chip, notification).
 *
 * Why it exists: each entry point used to fire its own loose sequence of
 * store writes (`setActiveProjectSlug` here, `setActiveTabId` + `setFocusedPaneId`
 * there, a bare `requestAnimationFrame(focus)` somewhere else). Each write is
 * its own reactive pass, and a late `focus()` from an abandoned navigation
 * could steal the caret back from the view the user actually chose. This
 * module commits the whole intent in ONE Solid `batch` and hangs a monotonic
 * navigation generation off it, so a stale scheduled focus can recognise that
 * it lost the race and bow out.
 *
 * Dependency direction is one-way: this helper imports stores, stores never
 * import it. `crossProjectViewMode` lives here (rather than in `top-row.tsx`,
 * which re-exports it) purely so the activation batch can clear the
 * cross-project spotlight without a component → lib cycle.
 */

import { batch, createSignal, untrack } from "solid-js";
import type { Terminal } from "@xterm/xterm";

import {
  beginNavigation,
  expectVisibleTargets,
  finishNavigation,
  markNavigation,
  markTargetRendered,
  type NavigationKind,
  type NavigationToken,
} from "./navigationDiagnostics";
import { getScopedProjection } from "./scopedProjection";
import { getTerminal } from "./terminalRegistry";
import { activeProjectSlug, projectBySlug, setActiveProjectSlug } from "../stores/projectStore";
import {
  focusedPaneId,
  layoutRev,
  runtimeLayoutStore,
  setActiveTabId,
  setFocusedPaneId,
} from "../stores/runtimeLayoutStore";
import { terminalStore } from "../stores/terminalStore";
import {
  ALL_WORKTREES_SCOPE,
  activeWorktreeStore,
  setActiveWorktree,
  setActiveWorktreeAll,
  type WorktreeScope,
} from "../stores/worktreeStore";

/**
 * Cross-project "spotlight" view. When non-null, raum paints only the panes
 * matching this mode (awaiting / completed / working) across every project.
 * `null` = normal single-project grid. Re-exported from `top-row.tsx`, which
 * is where every existing consumer imports it from.
 */
export type CrossProjectViewMode = "awaiting" | "completed" | "working";

const [crossProjectViewMode, setCrossProjectViewMode] = createSignal<CrossProjectViewMode | null>(
  null,
);
export { crossProjectViewMode, setCrossProjectViewMode };

/** Where the navigation came from. Diagnostics-only today; kept on the target
 *  so the forthcoming navigation recorder has a source to attribute. */
export type ActivationSource = "mouse" | "keyboard" | "dock" | "notification" | "native";

export interface ActivationTarget {
  projectSlug: string;
  /**
   * Omitted = keep whatever scope the project already had (project-tab
   * clicks restore the user's last worktree choice). An explicit
   * `{ mode: "all" }` is a deliberate All-Worktrees selection and is NOT the
   * same as omitting the field.
   */
  scope?: WorktreeScope;
  /** Explicit grid cell to focus. Ignored when it isn't in the target scope. */
  cellId?: string;
  /** Explicit tab within `cellId` to activate. */
  tabId?: string;
  /** Resolve cell + tab from a live session instead (dock / notification). */
  sessionId?: string;
  /**
   * When present, also set the cross-project spotlight inside the same batch
   * (`null` leaves it, which is what a normal project/tab click wants).
   * Omitted leaves the spotlight untouched.
   */
  crossProjectMode?: CrossProjectViewMode | null;
  source: ActivationSource;
}

// ---- navigation generation -------------------------------------------------

let navigationGeneration = 0;

/** Monotonic id of the most recent activation. Scheduled work captured under
 *  an older value has been superseded and must abort. */
export function currentNavigationGeneration(): number {
  return navigationGeneration;
}

// ---- per-scope focus memory ------------------------------------------------
//
// Runtime-only (design: "runtime-only scope focus history is sufficient
// initially"). Keyed on project slug + scope so returning to a view lands on
// the pane the user left it on, per worktree rather than per project.

const lastFocusByScope = new Map<string, string>();

function scopeKey(slug: string, scope: WorktreeScope): string {
  return `${slug}|${scope.mode === "all" ? "*" : scope.path}`;
}

function scopeFor(slug: string): WorktreeScope {
  return activeWorktreeStore.byProject[slug] ?? ALL_WORKTREES_SCOPE;
}

// ---- target resolution -----------------------------------------------------

function ownerOfSession(sessionId: string): { cellId: string; tabId: string } | null {
  for (const pane of Object.values(runtimeLayoutStore.panes)) {
    for (const tab of pane.tabs) {
      if (tab.sessionId === sessionId) return { cellId: pane.id, tabId: tab.id };
    }
  }
  return null;
}

/** Cells visible in `(slug, scope)`, in projected order. Reuses the scoped
 *  projection cache — the existing `(project, scope) → cells` index — so a
 *  repeat activation of an unchanged layout is a map lookup, not a tree walk. */
function visibleCellIds(slug: string, scope: WorktreeScope): ReadonlyMap<string, unknown> {
  return getScopedProjection({
    layoutRev: layoutRev(),
    tree: runtimeLayoutStore.tree,
    panes: runtimeLayoutStore.panes,
    slug,
    scope,
    mainPath: projectBySlug().get(slug)?.rootPath,
  }).rects;
}

/**
 * Pick the cell to focus: the caller's explicit choice when it is actually in
 * the target scope, else the remembered one for that scope if it still is,
 * else the first eligible cell in projected order — preferring one whose
 * active tab has a live session, so a scope whose remembered pane was closed
 * still lands on a working terminal. Returns `null` for an empty scope, which
 * produces no focus attempt at all.
 */
function resolveCell(
  slug: string,
  scope: WorktreeScope,
  wantCellId: string | undefined,
): string | null {
  const cells = visibleCellIds(slug, scope);
  if (wantCellId && cells.has(wantCellId)) return wantCellId;

  const remembered = lastFocusByScope.get(scopeKey(slug, scope));
  if (remembered && cells.has(remembered)) return remembered;

  let firstEligible: string | null = null;
  for (const id of cells.keys()) {
    const pane = runtimeLayoutStore.panes[id];
    if (!pane || pane.kind === "empty") continue;
    firstEligible ??= id;
    const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
    if (activeTab?.sessionId && terminalStore.byId[activeTab.sessionId]) return id;
  }
  return firstEligible;
}

// ---- DOM focus -------------------------------------------------------------

/** Focus the user deliberately placed in a search field, an editor or a modal
 *  dialog is theirs to keep — navigation must not yank it. xterm's own hidden
 *  textarea is explicitly not protected: moving between terminals is exactly
 *  what activation is for. Mirrors `keymapContext.tsx`'s xterm check. */
function focusIsProtected(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  if (el.classList.contains("xterm-helper-textarea")) return false;
  if (el.closest('[role="dialog"]')) return true;
  return el.isContentEditable || el.matches("input, textarea, select");
}

/** True when keyboard focus already sits inside the target pane (its terminal
 *  or its find box). Both the chrome and the surface frame carry
 *  `data-pane-id={tabId}`. */
function paneOwnsFocus(tabId: string): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.closest("[data-pane-id]")?.getAttribute("data-pane-id") === tabId;
}

function scheduleFrame(cb: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(cb);
  else setTimeout(cb, 0);
}

/** One scheduled callback per activation: the target host has to be shown
 *  (and laid out) before its textarea can take focus. Aborts when a newer
 *  activation has happened — A must never steal focus back after B. */
function scheduleTerminalFocus(generation: number, cellId: string, token: NavigationToken): void {
  scheduleFrame(() => {
    if (generation !== navigationGeneration) return;
    const tabId = runtimeLayoutStore.panes[cellId]?.activeTabId;
    if (!tabId) return settleFocus(generation, token, false);
    if (paneOwnsFocus(tabId)) return settleFocus(generation, token, true);
    if (focusIsProtected()) return settleFocus(generation, token, false);
    getTerminal(tabId)?.focus();
    settleFocus(generation, token, paneOwnsFocus(tabId));
  });
}

// ---- diagnostics -----------------------------------------------------------
//
// One record per user intent, from this handler to the moment every visible
// target has painted. The recorder itself owns the supersede rule; all this
// side has to do is stop awaiting renders it no longer cares about.

interface PendingNavigation {
  token: NavigationToken;
  generation: number;
  /** Surface keys still waiting for their first `onRender`. */
  remaining: Set<string>;
  disposers: (() => void)[];
  /** The scheduled focus callback has run (marked ready or bowed out). */
  focusSettled: boolean;
}

let pendingNavigation: PendingNavigation | null = null;

function disposePendingNavigation(): void {
  if (!pendingNavigation) return;
  for (const dispose of pendingNavigation.disposers) dispose();
  pendingNavigation = null;
}

function finishIfSettled(nav: PendingNavigation): void {
  if (pendingNavigation !== nav || !nav.focusSettled || nav.remaining.size > 0) return;
  disposePendingNavigation();
  finishNavigation(nav.token, "complete");
}

function settleFocus(generation: number, token: NavigationToken, ready: boolean): void {
  if (ready) markNavigation(token, "focus-ready");
  const nav = pendingNavigation;
  if (!nav || nav.generation !== generation) return;
  nav.focusSettled = true;
  finishIfSettled(nav);
}

/**
 * Subscribe to the first paint of every surface this activation expects to
 * show, BEFORE the selection batch commits, so a surface that paints in the
 * very next frame is still observed. A retained, already-painted surface may
 * never fire again — that record expires as `timeout` rather than being
 * forced to repaint just to make the metric look complete.
 */
function watchRenders(
  token: NavigationToken,
  generation: number,
  surfaceKeys: string[],
  focusedKey: string | undefined,
): void {
  disposePendingNavigation();
  const live: { key: string; terminal: Terminal }[] = [];
  for (const key of surfaceKeys) {
    const terminal = getTerminal(key)?.terminal;
    if (typeof terminal?.onRender === "function") live.push({ key, terminal });
  }
  const nav: PendingNavigation = {
    token,
    generation,
    remaining: new Set(live.map((entry) => entry.key)),
    disposers: [],
    focusSettled: false,
  };
  pendingNavigation = nav;
  expectVisibleTargets(
    token,
    live.map((entry) => entry.key),
    focusedKey,
  );
  for (const { key, terminal } of live) {
    const sub = terminal.onRender(() => {
      sub.dispose();
      if (pendingNavigation !== nav) return;
      nav.remaining.delete(key);
      markTargetRendered(token, key);
      finishIfSettled(nav);
    });
    nav.disposers.push(() => sub.dispose());
  }
}

/** Surfaces (tab ids) the target view will show. The projection cache makes a
 *  repeat activation of an unchanged layout a map lookup, not a tree walk. */
function visibleSurfaceKeys(
  slug: string,
  scope: WorktreeScope,
  cellId: string | null,
  tabId: string | undefined,
): string[] {
  const keys: string[] = [];
  for (const id of visibleCellIds(slug, scope).keys()) {
    const key = (id === cellId ? tabId : undefined) ?? activeTabIdOf(id);
    if (key) keys.push(key);
  }
  return keys;
}

/** Which axis of the view the user actually moved. */
function navigationKind(
  slug: string,
  scope: WorktreeScope,
  cellId: string | null,
  tabId: string | undefined,
): NavigationKind {
  if (slug !== activeProjectSlug()) return "project";
  if (scopeKey(slug, scope) !== scopeKey(slug, scopeFor(slug))) return "worktree";
  if (cellId && (cellId !== focusedPaneId() || (tabId && tabId !== activeTabIdOf(cellId)))) {
    return "tab";
  }
  return "pane-focus";
}

function activeTabIdOf(cellId: string): string | undefined {
  return runtimeLayoutStore.panes[cellId]?.activeTabId;
}

// ---- activation ------------------------------------------------------------

/**
 * Commit one navigation intent. Returns the navigation generation it claimed
 * so callers can correlate diagnostics with the scheduled focus.
 */
export function activateView(target: ActivationTarget): number {
  return untrack(() => {
    const generation = ++navigationGeneration;

    // Remember where focus sat in the OUTGOING view before we leave it. Doing
    // it here rather than subscribing to `focusedPaneId` catches focus moves
    // that never went through this helper (keyboard cycling, directional
    // focus) without a single extra reactive consumer.
    rememberCurrentFocus();

    const slug = target.projectSlug;
    const scope = target.scope ?? scopeFor(slug);

    const owner = target.sessionId ? ownerOfSession(target.sessionId) : null;
    const wantCellId = target.cellId ?? owner?.cellId;
    const cellId = resolveCell(slug, scope, wantCellId);
    const wantTabId = target.tabId ?? (owner && owner.cellId === cellId ? owner.tabId : undefined);
    const tabId = cellId === wantCellId ? wantTabId : undefined;

    const token = beginNavigation(navigationKind(slug, scope, cellId, tabId), target.source, {
      projectSlug: slug,
      // Mode only: a worktree path is a filesystem path, and diagnostics
      // payloads carry opaque ids, never paths or names.
      scopeKey: scope.mode === "all" ? "*" : "worktree",
      cellId: cellId ?? undefined,
      tabId,
      sessionId: target.sessionId,
    });
    markNavigation(token, "handler");
    // Subscribe BEFORE the batch so a surface that paints in the next frame is
    // still observed. The cross-project spotlight paints a different set than
    // the scoped projection, so there we only await the target itself.
    const targetKey = tabId ?? (cellId ? activeTabIdOf(cellId) : undefined);
    watchRenders(
      token,
      generation,
      target.crossProjectMode
        ? targetKey
          ? [targetKey]
          : []
        : visibleSurfaceKeys(slug, scope, cellId, tabId),
      targetKey,
    );

    batch(() => {
      setActiveProjectSlug(slug);
      if (target.scope) {
        if (target.scope.mode === "all") setActiveWorktreeAll(slug);
        else setActiveWorktree(slug, target.scope.path);
      }
      if (target.crossProjectMode !== undefined) setCrossProjectViewMode(target.crossProjectMode);
      if (cellId) {
        if (tabId) setActiveTabId(cellId, tabId);
        setFocusedPaneId(cellId);
        lastFocusByScope.set(scopeKey(slug, scope), cellId);
      }
    });
    markNavigation(token, "selection-committed");

    // An empty scope schedules no focus at all, so settle that stage here or
    // the record would sit in flight until it expired.
    if (cellId) scheduleTerminalFocus(generation, cellId, token);
    else settleFocus(generation, token, false);
    return generation;
  });
}

function rememberCurrentFocus(): void {
  const slug = activeProjectSlug();
  const cellId = focusedPaneId();
  if (!slug || !cellId) return;
  lastFocusByScope.set(scopeKey(slug, scopeFor(slug)), cellId);
}

export function __resetViewActivationForTests(): void {
  navigationGeneration = 0;
  lastFocusByScope.clear();
  disposePendingNavigation();
  setCrossProjectViewMode(null);
}
