/**
 * §5.5 — Solid store for agent sessions + their state-machine readings.
 *
 * Subscribes to `agent-state-changed` Tauri events (emitted from the
 * state-machine bridge task in `src-tauri/src/commands/agent.rs`) so the
 * top-row filters (§8.3) and the sidebar agent list (§9.3) re-render as
 * soon as a harness transitions between states.
 */

import { type Accessor, createMemo, createRoot } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type AgentKind = "shell" | "claude-code" | "codex" | "opencode";
export type AgentState = "idle" | "working" | "waiting" | "completed" | "errored";
/**
 * How confident the backend is in the state transition. Mirrors
 * `raum_core::harness::Reliability` (serialised as kebab-case).
 *
 * `deterministic` — the harness told us directly (hook / SSE).
 * `event-driven` — structured event stream with a heuristic mapping.
 * `heuristic` — inferred from an indirect signal (e.g. output silence).
 */
export type Reliability = "deterministic" | "event-driven" | "heuristic";

export interface AgentListItem {
  session_id: string | null;
  harness: AgentKind;
  state: AgentState;
  supports_native_events: boolean;
  /** Latest `reliability` seen for this session, or `null` until a transition arrives. */
  reliability?: Reliability | null;
}

interface AgentStoreState {
  adapters: AgentListItem[];
  /** Active agent sessions keyed by `session_id`. */
  sessions: Record<string, AgentListItem>;
}

const [agentStore, setAgentStore] = createStore<AgentStoreState>({
  adapters: [],
  sessions: {},
});

export { agentStore };

export function setAdapters(items: AgentListItem[]): void {
  // Adapters have no `session_id`; the full list returned by `agent_list`
  // interleaves adapters (session_id null) with live machines. We split them
  // so the top-row spawn buttons can iterate adapters without re-filtering.
  const adapters = items.filter((a) => a.session_id == null);
  const liveSessions: Record<string, AgentListItem> = {};
  for (const item of items) {
    if (item.session_id) liveSessions[item.session_id] = item;
  }
  setAgentStore("adapters", reconcile(adapters, { key: "harness" }));
  setAgentStore("sessions", reconcile(liveSessions));
}

export function updateSessionState(
  sessionId: string,
  harness: AgentKind,
  state: AgentState,
  reliability?: Reliability | null,
): void {
  const existing = agentStore.sessions[sessionId];
  const next: AgentListItem = existing
    ? { ...existing, state, reliability: reliability ?? existing.reliability ?? null }
    : {
        session_id: sessionId,
        harness,
        state,
        supports_native_events: false,
        reliability: reliability ?? null,
      };
  setAgentStore("sessions", sessionId, next);
}

export function removeSession(sessionId: string): void {
  const next = { ...agentStore.sessions };
  delete next[sessionId];
  setAgentStore("sessions", reconcile(next));
}

// ---- derived selectors ---------------------------------------------------
//
// Detached `createRoot` so memos have a tracking owner and live for the
// lifetime of the app (matches the pattern in `terminalStore.ts`).

interface AgentSelectors {
  /** Agents in states the user has yet to "read": waiting, completed, or errored. */
  unreadAgentCount: Accessor<number>;
}

const agentSelectors: AgentSelectors = createRoot(() => {
  const unread = createMemo(
    () =>
      Object.values(agentStore.sessions).filter(
        (s) => s.state === "waiting" || s.state === "completed" || s.state === "errored",
      ).length,
  );
  return { unreadAgentCount: unread };
});

/**
 * §11.3 — count of agents whose last state transition still demands attention.
 * Drives the "All unread" dock-badge mode.
 */
export const unreadAgentCount = agentSelectors.unreadAgentCount;

/** Fetch the full adapter + session list from the backend. */
export async function refreshAgents(): Promise<void> {
  try {
    const items = await invoke<AgentListItem[]>("agent_list");
    setAdapters(items);
  } catch (e) {
    console.warn("agent_list failed", e);
  }
}

interface AgentStateChanged {
  session_id: string | Record<string, unknown>;
  harness: AgentKind;
  from: AgentState;
  to: AgentState;
  /** Per-harness notification plan, Phase 1: replaces `via_silence_heuristic`. */
  reliability?: Reliability;
}

interface AgentSessionRemoved {
  session_id: string;
}

function sessionIdFromPayload(id: AgentStateChanged["session_id"]): string {
  if (typeof id === "string") return id;
  // The backend serialises `SessionId(String)` as a newtype tuple-struct,
  // which serde renders as the bare inner string. We still defensively
  // handle a `{ "0": "…" }` shape in case the enum representation changes.
  if (id && typeof id === "object") {
    const inner = (id as Record<string, unknown>)["0"];
    if (typeof inner === "string") return inner;
  }
  return "";
}

/**
 * Listen for `agent-state-changed` events. Returns an unsubscribe function.
 */
export async function subscribeAgentEvents(): Promise<UnlistenFn> {
  const unlistenChanged = await listen<AgentStateChanged>("agent-state-changed", (ev) => {
    const id = sessionIdFromPayload(ev.payload.session_id);
    if (!id) return;
    updateSessionState(id, ev.payload.harness, ev.payload.to, ev.payload.reliability ?? null);
  });
  const unlistenRemoved = await listen<AgentSessionRemoved>("agent-session-removed", (ev) => {
    if (!ev.payload.session_id) return;
    removeSession(ev.payload.session_id);
  });
  return () => {
    unlistenChanged();
    unlistenRemoved();
  };
}

export function __resetAgentStoreForTests(): void {
  setAgentStore({
    adapters: [],
    sessions: {},
  });
}
