/**
 * §5.5 + §8.3 — Solid store for live terminals.
 *
 * Mirrors the backend `terminal_list` output and is augmented on the
 * frontend with two per-session scalars the top-row filters need:
 *
 *   • `workingState` — `idle` | `working` | `waiting` (fed from the agent
 *     state-machine; shells stay `idle`).
 *   • `lastOutputMs` — `Date.now()` of the last coalesced chunk, used by
 *     the `Active` filter (§8.3) to sort by "recent output".
 *
 * The app-wide harness counters are derived once here from the live session
 * registry: every non-shell harness with a `project_slug` contributes to one
 * project bucket, and global totals are summed from those project buckets.
 */

import { createMemo, createRoot, createSignal, type Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createStore, reconcile } from "solid-js/store";
import { agentStore, type AgentKind, type AgentState } from "./agentStore";

const TERMINAL_PANE_CONTEXT_CHANGED_EVENT = "terminal-pane-context-changed";

export interface TerminalListItem {
  session_id: string;
  project_slug: string | null;
  worktree_id: string | null;
  kind: AgentKind;
  created_unix: number;
}

export type TerminalWorkingState = "idle" | "working" | "waiting";

export interface TerminalPaneContext {
  currentCommand: string;
  currentPath: string;
  paneTitle: string;
  windowName: string;
}

export interface TerminalRecord extends TerminalListItem {
  workingState: TerminalWorkingState;
  lastOutputMs: number;
  paneContext?: TerminalPaneContext;
}

export interface HarnessCounts {
  active: number;
  waiting: number;
  idle: number;
}

interface TerminalStoreState {
  byId: Record<string, TerminalRecord>;
}

const ZERO_COUNTS: Readonly<HarnessCounts> = Object.freeze({
  active: 0,
  waiting: 0,
  idle: 0,
});

const [terminalStore, setTerminalStore] = createStore<TerminalStoreState>({
  byId: {},
});

export { terminalStore };

const [mru, setMru] = createSignal<string[]>([]);
export { mru };

const pendingWorkingStateById: Record<string, TerminalWorkingState> = {};

export function isHarnessKind(kind: AgentKind): boolean {
  return kind !== "shell";
}

function isProjectScopedHarnessTerminal(
  terminal: TerminalRecord,
): terminal is TerminalRecord & { project_slug: string } {
  return isHarnessKind(terminal.kind) && terminal.project_slug !== null;
}

function hydrateTerminalRecord(item: TerminalListItem, existing?: TerminalRecord): TerminalRecord {
  const pending = pendingWorkingStateById[item.session_id];
  const agentState = agentStore.sessions[item.session_id]?.state;
  const sameLifecycle = existing?.created_unix === item.created_unix;
  return {
    ...item,
    workingState: existing?.workingState ?? pending ?? mapAgentState(agentState),
    lastOutputMs: existing?.lastOutputMs ?? 0,
    paneContext: sameLifecycle ? existing?.paneContext : undefined,
  };
}

function mapAgentState(state: AgentState | undefined): TerminalWorkingState {
  if (state === "working") return "working";
  if (state === "waiting") return "waiting";
  return "idle";
}

function bumpHarnessCount(counts: HarnessCounts, state: TerminalWorkingState): void {
  if (state === "working") counts.active += 1;
  else if (state === "waiting") counts.waiting += 1;
  else counts.idle += 1;
}

function emptyCounts(): HarnessCounts {
  return { active: 0, waiting: 0, idle: 0 };
}

/**
 * Promote a session id to the head of the MRU list. Called by the grid
 * on `focus`; also called when an agent transitions to `waiting` so the
 * "Needs input" queue picks it up.
 */
export function touchMru(sessionId: string): void {
  setMru((prev) => {
    const next = prev.filter((id) => id !== sessionId);
    next.unshift(sessionId);
    return next.slice(0, 64);
  });
}

export function setTerminals(items: TerminalListItem[]): void {
  const byId: Record<string, TerminalRecord> = {};
  for (const item of items) {
    byId[item.session_id] = hydrateTerminalRecord(item, terminalStore.byId[item.session_id]);
    delete pendingWorkingStateById[item.session_id];
  }
  setTerminalStore("byId", reconcile(byId));
}

export function upsertTerminal(item: TerminalListItem | TerminalRecord): void {
  const existing = terminalStore.byId[item.session_id];
  const next = "workingState" in item ? item : hydrateTerminalRecord(item, existing);
  setTerminalStore("byId", item.session_id, next);
  delete pendingWorkingStateById[item.session_id];
}

export function removeTerminal(sessionId: string): void {
  const next = { ...terminalStore.byId };
  delete next[sessionId];
  setTerminalStore("byId", reconcile(next));
  setMru((prev) => prev.filter((id) => id !== sessionId));
  delete pendingWorkingStateById[sessionId];
}

/** Feed the terminal store from the agent state-machine. */
export function applyAgentStateToTerminal(sessionId: string, state: AgentState): void {
  const mapped = mapAgentState(state);
  const existing = terminalStore.byId[sessionId];
  if (existing) {
    setTerminalStore("byId", sessionId, "workingState", mapped);
  } else {
    pendingWorkingStateById[sessionId] = mapped;
  }
  if (mapped === "waiting") {
    // Bring the needs-input session to the front of the MRU so keyboard
    // users can jump to the oldest pending pane quickly.
    touchMru(sessionId);
  }
}

/** Mark a session as just having produced output. */
export function markOutput(sessionId: string): void {
  if (!terminalStore.byId[sessionId]) return;
  setTerminalStore("byId", sessionId, "lastOutputMs", Date.now());
}

function samePaneContext(
  left: TerminalPaneContext | undefined,
  right: TerminalPaneContext | undefined,
): boolean {
  return (
    left?.currentCommand === right?.currentCommand &&
    left?.currentPath === right?.currentPath &&
    left?.paneTitle === right?.paneTitle &&
    left?.windowName === right?.windowName
  );
}

function setTerminalPaneContext(sessionId: string, paneContext: TerminalPaneContext): void {
  const existing = terminalStore.byId[sessionId];
  if (!existing) return;
  if (samePaneContext(existing.paneContext, paneContext)) return;
  setTerminalStore("byId", sessionId, "paneContext", paneContext);
}

async function hydrateHarnessPaneContext(item: TerminalListItem): Promise<void> {
  if (!isHarnessKind(item.kind)) return;
  try {
    const paneContext = await invoke<TerminalPaneContext>("terminal_pane_context", {
      sessionId: item.session_id,
    });
    const current = terminalStore.byId[item.session_id];
    if (!current) return;
    if (current.kind !== item.kind) return;
    if (current.created_unix !== item.created_unix) return;
    setTerminalPaneContext(item.session_id, paneContext);
  } catch {
    /* non-fatal: keep fallback label */
  }
}

// ---- derived selectors (§8.3) ---------------------------------------------
//
// Memos are created inside a detached `createRoot` so they have a tracking
// owner (otherwise Solid warns about "computations created outside a
// `createRoot`"). The root lives for the lifetime of the app.

interface Selectors {
  activeTerminals: Accessor<TerminalRecord[]>;
  waitingTerminals: Accessor<TerminalRecord[]>;
  recentTerminals: Accessor<TerminalRecord[]>;
  harnessCountsByProject: Accessor<Record<string, HarnessCounts>>;
  harnessCountsByWorktree: Accessor<Record<string, HarnessCounts>>;
  globalHarnessCounts: Accessor<HarnessCounts>;
  activeCount: Accessor<number>;
  waitingCount: Accessor<number>;
  idleCount: Accessor<number>;
}

const selectors: Selectors = createRoot(() => {
  const projectScopedHarnesses = createMemo(() =>
    Object.values(terminalStore.byId).filter(isProjectScopedHarnessTerminal),
  );
  const active = createMemo(() =>
    projectScopedHarnesses()
      .filter((t) => t.workingState === "working")
      .sort((a, b) => b.lastOutputMs - a.lastOutputMs),
  );
  const waiting = createMemo(() =>
    projectScopedHarnesses()
      .filter((t) => t.workingState === "waiting")
      .sort((a, b) => a.created_unix - b.created_unix),
  );
  const recent = createMemo(() => {
    const ids = mru();
    const out: TerminalRecord[] = [];
    for (const id of ids) {
      const terminal = terminalStore.byId[id];
      if (terminal && isProjectScopedHarnessTerminal(terminal)) out.push(terminal);
    }
    return out;
  });
  const byProject = createMemo<Record<string, HarnessCounts>>(() => {
    const counts: Record<string, HarnessCounts> = {};
    for (const terminal of projectScopedHarnesses()) {
      const projectSlug = terminal.project_slug;
      const bucket = counts[projectSlug] ?? (counts[projectSlug] = emptyCounts());
      bumpHarnessCount(bucket, terminal.workingState);
    }
    return counts;
  });
  const byWorktree = createMemo<Record<string, HarnessCounts>>(() => {
    const counts: Record<string, HarnessCounts> = {};
    for (const terminal of projectScopedHarnesses()) {
      if (!terminal.worktree_id) continue;
      const bucket = counts[terminal.worktree_id] ?? (counts[terminal.worktree_id] = emptyCounts());
      bumpHarnessCount(bucket, terminal.workingState);
    }
    return counts;
  });
  const global = createMemo<HarnessCounts>(() => {
    const totals = emptyCounts();
    for (const counts of Object.values(byProject())) {
      totals.active += counts.active;
      totals.waiting += counts.waiting;
      totals.idle += counts.idle;
    }
    return totals;
  });
  const activeN = createMemo(() => global().active);
  const waitingN = createMemo(() => global().waiting);
  const idleN = createMemo(() => global().idle);
  return {
    activeTerminals: active,
    waitingTerminals: waiting,
    recentTerminals: recent,
    harnessCountsByProject: byProject,
    harnessCountsByWorktree: byWorktree,
    globalHarnessCounts: global,
    activeCount: activeN,
    waitingCount: waitingN,
    idleCount: idleN,
  };
});

/** `Active` filter: working project-scoped harnesses sorted by most recent output. */
export const activeTerminals = selectors.activeTerminals;
/** `Needs input` filter: waiting project-scoped harnesses sorted oldest-first. */
export const waitingTerminals = selectors.waitingTerminals;
/** `Recent` filter: MRU list resolved against live project-scoped harnesses. */
export const recentTerminals = selectors.recentTerminals;
/** Live harness totals keyed by `project_slug`. */
export const harnessCountsByProject = selectors.harnessCountsByProject;
/** Live harness totals keyed by `worktree_id`. */
export const harnessCountsByWorktree = selectors.harnessCountsByWorktree;
/** Global top-right totals, derived by summing project buckets. */
export const globalHarnessCounts = selectors.globalHarnessCounts;
/** Count of harnesses currently producing output (state = `working`). */
export const activeCount = selectors.activeCount;
/** §8.4 — count of harnesses in the `waiting` state, for the badge. */
export const waitingCount = selectors.waitingCount;
/** Count of harnesses at rest (state = `idle`). */
export const idleCount = selectors.idleCount;

export function harnessCountsForProject(projectSlug: string | null | undefined): HarnessCounts {
  if (!projectSlug) return ZERO_COUNTS;
  return harnessCountsByProject()[projectSlug] ?? ZERO_COUNTS;
}

export function harnessCountsForWorktree(worktreeId: string | null | undefined): HarnessCounts {
  if (!worktreeId) return ZERO_COUNTS;
  return harnessCountsByWorktree()[worktreeId] ?? ZERO_COUNTS;
}

export function listHarnessSessions(projectSlug?: string | null): TerminalRecord[] {
  return Object.values(terminalStore.byId)
    .filter(isProjectScopedHarnessTerminal)
    .filter((terminal) => !projectSlug || terminal.project_slug === projectSlug);
}

interface TerminalSessionRemoved {
  session_id: string;
}

interface AgentStateChanged {
  session_id: string | Record<string, unknown>;
  to: AgentState;
}

interface TerminalPaneContextChanged extends TerminalPaneContext {
  sessionId: string;
}

function sessionIdFromPayload(id: AgentStateChanged["session_id"]): string {
  if (typeof id === "string") return id;
  if (id && typeof id === "object") {
    const inner = id["0"];
    if (typeof inner === "string") return inner;
  }
  return "";
}

export async function subscribeTerminalEvents(): Promise<UnlistenFn> {
  const unlistenUpsert = await listen<TerminalListItem>("terminal-session-upserted", (ev) => {
    upsertTerminal(ev.payload);
    void hydrateHarnessPaneContext(ev.payload);
  });
  const unlistenRemoved = await listen<TerminalSessionRemoved>("terminal-session-removed", (ev) => {
    if (!ev.payload.session_id) return;
    removeTerminal(ev.payload.session_id);
  });
  const unlistenPaneContext = await listen<TerminalPaneContextChanged>(
    TERMINAL_PANE_CONTEXT_CHANGED_EVENT,
    (ev) => {
      if (!ev.payload.sessionId) return;
      setTerminalPaneContext(ev.payload.sessionId, {
        currentCommand: ev.payload.currentCommand,
        currentPath: ev.payload.currentPath,
        paneTitle: ev.payload.paneTitle,
        windowName: ev.payload.windowName,
      });
    },
  );
  const unlistenAgentState = await listen<AgentStateChanged>("agent-state-changed", (ev) => {
    const id = sessionIdFromPayload(ev.payload.session_id);
    if (!id) return;
    applyAgentStateToTerminal(id, ev.payload.to);
  });
  return () => {
    unlistenUpsert();
    unlistenRemoved();
    unlistenPaneContext();
    unlistenAgentState();
  };
}

/** Fetch the list from the backend. */
export async function refreshTerminals(): Promise<void> {
  try {
    const items = await invoke<TerminalListItem[]>("terminal_list");
    setTerminals(items);
  } catch (e) {
    console.warn("terminal_list failed", e);
  }
}

export function __resetTerminalStoreForTests(): void {
  setTerminalStore({
    byId: {},
  });
  setMru([]);
  for (const key of Object.keys(pendingWorkingStateById)) {
    delete pendingWorkingStateById[key];
  }
}
