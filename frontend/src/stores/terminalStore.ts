/**
 * §5.5 + §8.3 — Solid store for live terminals.
 *
 * Mirrors the backend `terminal_list` output. Every mutation to `byId`
 * routes through `applyTerminalPatch` — the single chokepoint that keeps
 * the auxiliary indices (state buckets, per-project and per-worktree id
 * sets, `harnessIds`) consistent with the record map. Never call
 * `setTerminalStore("byId", …)` directly from anywhere else: the indices
 * would silently desync.
 *
 * `lastOutputMs` used to live on each record and was stamped on every
 * coalesced PTY chunk. That made recency updates invalidate every memo
 * reading `byId`, which cascaded through `harnessCountsByProject`,
 * `globalHarnessCounts`, and the top-row badges dozens of times per
 * second. It now lives in the `lastOutputBySession` side-channel signal,
 * so membership memos never observe recency churn.
 */

import { batch, createMemo, createRoot, createSignal, type Accessor } from "solid-js";
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

// ---- index signals -------------------------------------------------------
//
// Membership indices, maintained incrementally by `applyTerminalPatch`.
// Every write is guarded: setters are only called when the index actually
// changed, so downstream memos observe referential identity stability
// across no-op mutations.

const EMPTY_SET: ReadonlySet<string> = new Set();

const [workingIds, setWorkingIds] = createSignal<ReadonlySet<string>>(EMPTY_SET);
const [waitingIds, setWaitingIds] = createSignal<ReadonlySet<string>>(EMPTY_SET);
const [idleIds, setIdleIds] = createSignal<ReadonlySet<string>>(EMPTY_SET);
const [harnessIds, setHarnessIds] = createSignal<ReadonlySet<string>>(EMPTY_SET);
const [idsByProjectSlug, setIdsByProjectSlug] = createSignal<
  ReadonlyMap<string, ReadonlySet<string>>
>(new Map());
const [idsByWorktreeId, setIdsByWorktreeId] = createSignal<
  ReadonlyMap<string, ReadonlySet<string>>
>(new Map());
const [lastOutputBySession, setLastOutputBySession] = createSignal<ReadonlyMap<string, number>>(
  new Map(),
);

export {
  workingIds,
  waitingIds,
  idleIds,
  harnessIds,
  idsByProjectSlug,
  idsByWorktreeId,
  lastOutputBySession,
};

const pendingWorkingStateById: Record<string, TerminalWorkingState> = {};

export function isHarnessKind(kind: AgentKind): boolean {
  return kind !== "shell";
}

function hydrateTerminalRecord(item: TerminalListItem, existing?: TerminalRecord): TerminalRecord {
  const pending = pendingWorkingStateById[item.session_id];
  const agentState = agentStore.sessions[item.session_id]?.state;
  const sameLifecycle = existing?.created_unix === item.created_unix;
  return {
    ...item,
    workingState: existing?.workingState ?? pending ?? mapAgentState(agentState),
    paneContext: sameLifecycle ? existing?.paneContext : undefined,
  };
}

function mapAgentState(state: AgentState | undefined): TerminalWorkingState {
  if (state === "working") return "working";
  if (state === "waiting") return "waiting";
  return "idle";
}

function emptyCounts(): HarnessCounts {
  return { active: 0, waiting: 0, idle: 0 };
}

function shallowEqualRecord(a: TerminalRecord, b: TerminalRecord): boolean {
  return (
    a.session_id === b.session_id &&
    a.project_slug === b.project_slug &&
    a.worktree_id === b.worktree_id &&
    a.kind === b.kind &&
    a.created_unix === b.created_unix &&
    a.workingState === b.workingState &&
    a.paneContext === b.paneContext
  );
}

// ---- index bookkeeping ---------------------------------------------------

function addToBucketMap(
  current: ReadonlyMap<string, ReadonlySet<string>>,
  key: string,
  id: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  const existing = current.get(key);
  if (existing?.has(id)) return current;
  const nextSet = new Set(existing ?? []);
  nextSet.add(id);
  const next = new Map(current);
  next.set(key, nextSet);
  return next;
}

function removeFromBucketMap(
  current: ReadonlyMap<string, ReadonlySet<string>>,
  key: string,
  id: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  const existing = current.get(key);
  if (!existing?.has(id)) return current;
  const nextSet = new Set(existing);
  nextSet.delete(id);
  const next = new Map(current);
  if (nextSet.size === 0) next.delete(key);
  else next.set(key, nextSet);
  return next;
}

function moveStateBucket(
  id: string,
  from: TerminalWorkingState | null,
  to: TerminalWorkingState | null,
): void {
  if (from === to) return;
  if (from === "idle" || to === "idle") {
    setIdleIds((prev) => {
      const next = new Set(prev);
      if (to === "idle") next.add(id);
      if (from === "idle") next.delete(id);
      return next;
    });
  }
  if (from === "working" || to === "working") {
    setWorkingIds((prev) => {
      const next = new Set(prev);
      if (to === "working") next.add(id);
      if (from === "working") next.delete(id);
      return next;
    });
  }
  if (from === "waiting" || to === "waiting") {
    setWaitingIds((prev) => {
      const next = new Set(prev);
      if (to === "waiting") next.add(id);
      if (from === "waiting") next.delete(id);
      return next;
    });
  }
}

/**
 * A plain-object snapshot of the index-relevant fields on a record,
 * taken BEFORE a store write lands. Solid's store proxies always reflect
 * the current value at a given path, so reading `record.foo` after
 * `setStore("byId", id, newRecord)` returns the new value even if we
 * captured `record` earlier. The snapshot sidesteps that trap.
 */
interface TerminalSnapshot {
  kind: AgentKind;
  project_slug: string | null;
  worktree_id: string | null;
  workingState: TerminalWorkingState;
}

function snapshotRecord(record: TerminalRecord): TerminalSnapshot {
  return {
    kind: record.kind,
    project_slug: record.project_slug,
    worktree_id: record.worktree_id,
    workingState: record.workingState,
  };
}

function snapshotIsHarness(snapshot: TerminalSnapshot): boolean {
  return snapshot.kind !== "shell" && snapshot.project_slug !== null;
}

function reindexSession(
  id: string,
  before: TerminalSnapshot | null,
  after: TerminalSnapshot | null,
): void {
  const beforeHarness = before ? snapshotIsHarness(before) : false;
  const afterHarness = after ? snapshotIsHarness(after) : false;
  const beforeSlug = beforeHarness ? before!.project_slug : null;
  const afterSlug = afterHarness ? after!.project_slug : null;
  const beforeWorktree = beforeHarness ? (before!.worktree_id ?? null) : null;
  const afterWorktree = afterHarness ? (after!.worktree_id ?? null) : null;
  const beforeState = before?.workingState ?? null;
  const afterState = after?.workingState ?? null;

  if (beforeHarness !== afterHarness) {
    setHarnessIds((prev) => {
      const next = new Set(prev);
      if (afterHarness) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  if (beforeSlug !== afterSlug) {
    setIdsByProjectSlug((prev) => {
      let next = prev;
      if (beforeSlug) next = removeFromBucketMap(next, beforeSlug, id);
      if (afterSlug) next = addToBucketMap(next, afterSlug, id);
      return next;
    });
  }

  if (beforeWorktree !== afterWorktree) {
    setIdsByWorktreeId((prev) => {
      let next = prev;
      if (beforeWorktree) next = removeFromBucketMap(next, beforeWorktree, id);
      if (afterWorktree) next = addToBucketMap(next, afterWorktree, id);
      return next;
    });
  }

  moveStateBucket(id, beforeState, afterState);
}

// ---- chokepoint ----------------------------------------------------------

type TerminalPatch =
  | { op: "upsert"; record: TerminalRecord }
  | { op: "remove"; sessionId: string }
  | { op: "setWorkingState"; sessionId: string; next: TerminalWorkingState };

/**
 * The one and only gateway for mutating `byId` and its indices. Every
 * public mutator funnels here. TypeScript's exhaustiveness check on the
 * `op` union catches any new patch type that would otherwise slip past
 * index bookkeeping.
 */
function applyTerminalPatch(patch: TerminalPatch): void {
  batch(() => {
    switch (patch.op) {
      case "upsert": {
        const { record } = patch;
        const id = record.session_id;
        const existing = terminalStore.byId[id];
        if (existing && shallowEqualRecord(existing, record)) return;
        const before = existing ? snapshotRecord(existing) : null;
        setTerminalStore("byId", id, record);
        reindexSession(id, before, snapshotRecord(record));
        return;
      }
      case "remove": {
        const { sessionId } = patch;
        const existing = terminalStore.byId[sessionId];
        if (!existing) return;
        const before = snapshotRecord(existing);
        const nextById = { ...terminalStore.byId };
        delete nextById[sessionId];
        setTerminalStore("byId", reconcile(nextById));
        reindexSession(sessionId, before, null);
        setLastOutputBySession((prev) => {
          if (!prev.has(sessionId)) return prev;
          const next = new Map(prev);
          next.delete(sessionId);
          return next;
        });
        return;
      }
      case "setWorkingState": {
        const { sessionId, next } = patch;
        const existing = terminalStore.byId[sessionId];
        if (!existing) return;
        const previousState: TerminalWorkingState = existing.workingState;
        if (previousState === next) return;
        setTerminalStore("byId", sessionId, "workingState", next);
        moveStateBucket(sessionId, previousState, next);
        return;
      }
    }
  });
}

// ---- public mutators -----------------------------------------------------

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
  batch(() => {
    const seen = new Set<string>();
    for (const item of items) seen.add(item.session_id);
    for (const id of Object.keys(terminalStore.byId)) {
      if (!seen.has(id)) applyTerminalPatch({ op: "remove", sessionId: id });
    }
    for (const item of items) {
      const record = hydrateTerminalRecord(item, terminalStore.byId[item.session_id]);
      applyTerminalPatch({ op: "upsert", record });
      delete pendingWorkingStateById[item.session_id];
    }
  });
}

export function upsertTerminal(item: TerminalListItem | TerminalRecord): void {
  const existing = terminalStore.byId[item.session_id];
  const record = "workingState" in item ? item : hydrateTerminalRecord(item, existing);
  applyTerminalPatch({ op: "upsert", record });
  delete pendingWorkingStateById[item.session_id];
}

export function removeTerminal(sessionId: string): void {
  applyTerminalPatch({ op: "remove", sessionId });
  setMru((prev) => (prev.includes(sessionId) ? prev.filter((id) => id !== sessionId) : prev));
  delete pendingWorkingStateById[sessionId];
}

/** Feed the terminal store from the agent state-machine. */
export function applyAgentStateToTerminal(sessionId: string, state: AgentState): void {
  const mapped = mapAgentState(state);
  const existing = terminalStore.byId[sessionId];
  if (existing) {
    applyTerminalPatch({ op: "setWorkingState", sessionId, next: mapped });
  } else {
    pendingWorkingStateById[sessionId] = mapped;
  }
  if (mapped === "waiting") {
    // Bring the needs-input session to the front of the MRU so keyboard
    // users can jump to the oldest pending pane quickly.
    touchMru(sessionId);
  }
}

/** Mark a session as just having produced output. Bypasses `byId` entirely
 *  so high-frequency PTY coalesces don't invalidate membership memos. */
export function markOutput(sessionId: string): void {
  if (!terminalStore.byId[sessionId]) return;
  setLastOutputBySession((prev) => {
    const next = new Map(prev);
    next.set(sessionId, Date.now());
    return next;
  });
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
  // The paneContext field is observational metadata that doesn't affect
  // any index, so it's safe to write past the chokepoint. Keep the write
  // targeted to the specific sub-path.
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

// ---- derived selectors (§8.3) --------------------------------------------
//
// Every selector reads indices first and touches `byId` only for record
// projection. No `Object.values(byId)` root reads. Recency (lastOutputBySession)
// is observed only where a sort or projection needs it — it never feeds
// membership or counts.

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

function resolveHarnessIds(ids: ReadonlySet<string>): TerminalRecord[] {
  const hs = harnessIds();
  const out: TerminalRecord[] = [];
  for (const id of ids) {
    if (!hs.has(id)) continue;
    const record = terminalStore.byId[id];
    if (record) out.push(record);
  }
  return out;
}

const selectors: Selectors = createRoot(() => {
  // Active = working harnesses, sorted by recency. Recency changes on
  // every PTY tick, so we observe `lastOutputBySession` here — but the
  // set that gets sorted is already narrowed to membership-changes-only.
  const active = createMemo<TerminalRecord[]>(() => {
    const records = resolveHarnessIds(workingIds());
    const lo = lastOutputBySession();
    records.sort((a, b) => (lo.get(b.session_id) ?? 0) - (lo.get(a.session_id) ?? 0));
    return records;
  });

  // Waiting sorts by `created_unix`, which is immutable after spawn, so
  // the sort runs once per membership change — no recency dependency.
  const waiting = createMemo<TerminalRecord[]>(() => {
    const records = resolveHarnessIds(waitingIds());
    records.sort((a, b) => a.created_unix - b.created_unix);
    return records;
  });

  const recent = createMemo<TerminalRecord[]>(() => {
    const ids = mru();
    const hs = harnessIds();
    const out: TerminalRecord[] = [];
    for (const id of ids) {
      if (!hs.has(id)) continue;
      const record = terminalStore.byId[id];
      if (record) out.push(record);
    }
    return out;
  });

  const byProject = createMemo<Record<string, HarnessCounts>>(() => {
    const buckets = idsByProjectSlug();
    const working = workingIds();
    const wait = waitingIds();
    const out: Record<string, HarnessCounts> = {};
    for (const [slug, ids] of buckets) {
      const c = emptyCounts();
      for (const id of ids) {
        if (working.has(id)) c.active += 1;
        else if (wait.has(id)) c.waiting += 1;
        else c.idle += 1;
      }
      out[slug] = c;
    }
    return out;
  });

  const byWorktree = createMemo<Record<string, HarnessCounts>>(() => {
    const buckets = idsByWorktreeId();
    const working = workingIds();
    const wait = waitingIds();
    const out: Record<string, HarnessCounts> = {};
    for (const [worktreeId, ids] of buckets) {
      const c = emptyCounts();
      for (const id of ids) {
        if (working.has(id)) c.active += 1;
        else if (wait.has(id)) c.waiting += 1;
        else c.idle += 1;
      }
      out[worktreeId] = c;
    }
    return out;
  });

  // Global totals read indices directly — no fan-in through per-project
  // counts, so a single project's churn never invalidates the top-row
  // badges through this path.
  const global = createMemo<HarnessCounts>(() => {
    const hs = harnessIds();
    const working = workingIds();
    const wait = waitingIds();
    let active = 0;
    let waitN = 0;
    let idle = 0;
    for (const id of hs) {
      if (working.has(id)) active += 1;
      else if (wait.has(id)) waitN += 1;
      else idle += 1;
    }
    return { active, waiting: waitN, idle };
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
/** Global top-right totals, derived from the indices directly. */
export const globalHarnessCounts = selectors.globalHarnessCounts;
/** Count of harnesses currently producing output (state = `working`). */
export const activeCount = selectors.activeCount;
/** §8.4 — count of harnesses in the `waiting` state, for the badge. */
export const waitingCount = selectors.waitingCount;
/** Count of harnesses at rest (state = `idle`). */
export const idleCount = selectors.idleCount;

export type CrossProjectHarnessMode = "awaiting" | "working" | "recent";

export function listCrossProjectHarnessSessions(mode: CrossProjectHarnessMode): TerminalRecord[] {
  if (mode === "awaiting") return waitingTerminals();
  if (mode === "working") return activeTerminals();

  const ids = [...harnessIds()];
  const lo = lastOutputBySession();
  const records: TerminalRecord[] = [];
  for (const id of ids) {
    const record = terminalStore.byId[id];
    if (record) records.push(record);
  }
  records.sort(
    (left, right) =>
      (lo.get(right.session_id) ?? right.created_unix * 1000) -
      (lo.get(left.session_id) ?? left.created_unix * 1000),
  );
  return records;
}

export function harnessCountsForProject(projectSlug: string | null | undefined): HarnessCounts {
  if (!projectSlug) return ZERO_COUNTS;
  return harnessCountsByProject()[projectSlug] ?? ZERO_COUNTS;
}

export function harnessCountsForWorktree(worktreeId: string | null | undefined): HarnessCounts {
  if (!worktreeId) return ZERO_COUNTS;
  return harnessCountsByWorktree()[worktreeId] ?? ZERO_COUNTS;
}

export function listHarnessSessions(projectSlug?: string | null): TerminalRecord[] {
  if (projectSlug) {
    const ids = idsByProjectSlug().get(projectSlug);
    if (!ids) return [];
    const out: TerminalRecord[] = [];
    for (const id of ids) {
      const record = terminalStore.byId[id];
      if (record) out.push(record);
    }
    return out;
  }
  const ids = harnessIds();
  const out: TerminalRecord[] = [];
  for (const id of ids) {
    const record = terminalStore.byId[id];
    if (record) out.push(record);
  }
  return out;
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
  setWorkingIds(EMPTY_SET);
  setWaitingIds(EMPTY_SET);
  setIdleIds(EMPTY_SET);
  setHarnessIds(EMPTY_SET);
  setIdsByProjectSlug(new Map());
  setIdsByWorktreeId(new Map());
  setLastOutputBySession(new Map());
  for (const key of Object.keys(pendingWorkingStateById)) {
    delete pendingWorkingStateById[key];
  }
}
