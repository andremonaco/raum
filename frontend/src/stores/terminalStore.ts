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
 * Also tracks the MRU focus list (§8.3 `Recent` filter) and the global
 * count of agents in `waiting` (§8.4 badge).
 */

import { createStore, reconcile } from "solid-js/store";
import { createMemo, createRoot, createSignal, type Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { AgentKind, AgentState } from "./agentStore";

export interface TerminalListItem {
  session_id: string;
  project_slug: string | null;
  worktree_id: string | null;
  kind: AgentKind;
  created_unix: number;
}

export type TerminalWorkingState = "idle" | "working" | "waiting";

export interface TerminalRecord extends TerminalListItem {
  workingState: TerminalWorkingState;
  lastOutputMs: number;
}

interface TerminalStoreState {
  byId: Record<string, TerminalRecord>;
}

const [terminalStore, setTerminalStore] = createStore<TerminalStoreState>({
  byId: {},
});

export { terminalStore };

const [mru, setMru] = createSignal<string[]>([]);
export { mru };

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
    const existing = terminalStore.byId[item.session_id];
    byId[item.session_id] = {
      ...item,
      workingState: existing?.workingState ?? "idle",
      lastOutputMs: existing?.lastOutputMs ?? 0,
    };
  }
  setTerminalStore("byId", reconcile(byId));
}

export function upsertTerminal(record: TerminalRecord): void {
  setTerminalStore("byId", record.session_id, record);
}

export function removeTerminal(sessionId: string): void {
  setTerminalStore("byId", (prev) => {
    const next = { ...prev };
    delete next[sessionId];
    return next;
  });
  setMru((prev) => prev.filter((id) => id !== sessionId));
}

/** Feed the terminal store from the agent state-machine. */
export function applyAgentStateToTerminal(sessionId: string, state: AgentState): void {
  const existing = terminalStore.byId[sessionId];
  if (!existing) return;
  const mapped: TerminalWorkingState =
    state === "working" ? "working" : state === "waiting" ? "waiting" : "idle";
  setTerminalStore("byId", sessionId, "workingState", mapped);
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

// ---- derived selectors (§8.3) ---------------------------------------------
//
// Memos are created inside a detached `createRoot` so they have a tracking
// owner (otherwise Solid warns about "computations created outside a
// `createRoot`"). The root lives for the lifetime of the app.

interface Selectors {
  activeTerminals: Accessor<TerminalRecord[]>;
  waitingTerminals: Accessor<TerminalRecord[]>;
  recentTerminals: Accessor<TerminalRecord[]>;
  activeCount: Accessor<number>;
  waitingCount: Accessor<number>;
  idleCount: Accessor<number>;
}

const selectors: Selectors = createRoot(() => {
  const active = createMemo(() =>
    Object.values(terminalStore.byId)
      .filter((t) => t.workingState === "working")
      .sort((a, b) => b.lastOutputMs - a.lastOutputMs),
  );
  const waiting = createMemo(() =>
    Object.values(terminalStore.byId)
      .filter((t) => t.workingState === "waiting")
      .sort((a, b) => a.created_unix - b.created_unix),
  );
  const recent = createMemo(() => {
    const ids = mru();
    const out: TerminalRecord[] = [];
    for (const id of ids) {
      const t = terminalStore.byId[id];
      if (t) out.push(t);
    }
    return out;
  });
  const activeN = createMemo(() => active().length);
  const waitingN = createMemo(() => waiting().length);
  const idleN = createMemo(
    () => Object.values(terminalStore.byId).filter((t) => t.workingState === "idle").length,
  );
  return {
    activeTerminals: active,
    waitingTerminals: waiting,
    recentTerminals: recent,
    activeCount: activeN,
    waitingCount: waitingN,
    idleCount: idleN,
  };
});

/** `Active` filter: working terminals sorted by most recent output. */
export const activeTerminals = selectors.activeTerminals;
/** `Needs input` filter: waiting terminals sorted oldest-first. */
export const waitingTerminals = selectors.waitingTerminals;
/** `Recent` filter: MRU focus list, resolved against the current set. */
export const recentTerminals = selectors.recentTerminals;
/** Count of harnesses currently producing output (state = `working`). */
export const activeCount = selectors.activeCount;
/** §8.4 — count of agents in the `waiting` state, for the badge. */
export const waitingCount = selectors.waitingCount;
/** Count of harnesses at rest (state = `idle`). */
export const idleCount = selectors.idleCount;

/** Fetch the list from the backend. */
export async function refreshTerminals(): Promise<void> {
  try {
    const items = await invoke<TerminalListItem[]>("terminal_list");
    setTerminals(items);
  } catch (e) {
    console.warn("terminal_list failed", e);
  }
}
