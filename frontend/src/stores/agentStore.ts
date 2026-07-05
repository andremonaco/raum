/**
 * §5.5 — Solid store for agent sessions + their state-machine readings.
 *
 * Subscribes to `agent-state-changed` Tauri events (emitted from the
 * state-machine bridge task in `src-tauri/src/commands/agent.rs`) so the
 * top-row filters (§8.3) and the sidebar agent list (§9.3) re-render as
 * soon as a harness transitions between states.
 */

import { type Accessor, batch, createMemo, createRoot, createSignal } from "solid-js";
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
  /**
   * Wall-clock (`Date.now()`) of the most recent *actual* state change for
   * this session. Stamped by {@link updateSessionState} only when `state`
   * differs from the previous reading, so it measures "time blocked in the
   * current state" — the triage signal the attention rail ranks on. Unlike
   * `created_unix` (immutable spawn time) this advances every transition, so
   * a harness that just re-entered `waiting` sorts *after* one that's been
   * stuck waiting for minutes. Absent until the first transition lands.
   */
  enteredStateAt?: number;
  /**
   * Backend-persisted wall-clock (unix ms) the session entered its current
   * state, read from `sessions.toml`'s `last_state_at_unix_ms`. Surfaced on
   * `agent_list` / `agent_snapshot` so a reloaded webview can seed
   * {@link enteredStateAt} with the *true* age instead of fabricating
   * `Date.now()` at hydration (which read hours-old completions as "done
   * 4s"). Omitted (`undefined`/`null`) when the backend has no timestamp.
   */
  state_entered_at_ms?: number | null;
  /**
   * Backend-persisted flag: the user already saw this session's terminal-state
   * notification (mirrors `sessions.toml`'s `last_state_acked`). Seeded into
   * the in-memory acknowledged set at hydration so a reload doesn't re-flood
   * the attention rail with long-acked completions. Reset to `false` by the
   * backend on every fresh transition. Absent (`undefined`) is treated as
   * unacked.
   */
  state_acked?: boolean;
  /**
   * Most recent user-submitted prompt for this session, surfaced on the
   * snapshot so a freshly-launched raum can repopulate the per-tab
   * subtitle without waiting for a fresh `pane:prompt-updated` emit.
   */
  last_prompt?: { text: string; submitted_at_ms: number };
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

/**
 * §11 — sessions whose terminal-state notification ("done": completed/errored)
 * the user has implicitly seen by activating their owning project tab.
 * Excluded from {@link unreadAgentCount} so the dock badge clears on tab
 * activation. Cleared back out by [`updateSessionState`] when the session
 * transitions to a non-terminal state — a fresh completion should re-count
 * as unread.
 *
 * Plain `Set` (not Solid store) so callers can mutate synchronously; the
 * `acknowledgedTick` signal below is the reactive surface that drives memo
 * retracking.
 */
const acknowledgedSessions = new Set<string>();
const [acknowledgedTick, setAcknowledgedTick] = createSignal(0);

/**
 * Restore a persisted acknowledgement without touching the backend: mutate
 * the set + bump the reactive tick, nothing more. Used at hydration
 * ({@link setAdapters}, the reattach path) to re-seed the exact pre-reload
 * rail from `state_acked`, so a webview reload doesn't re-surface completions
 * the user already dismissed. {@link markAcknowledged} builds on this and
 * additionally persists the ack to disk.
 */
export function seedAcknowledged(sessionId: string): void {
  if (!sessionId) return;
  if (acknowledgedSessions.has(sessionId)) return;
  acknowledgedSessions.add(sessionId);
  setAcknowledgedTick((n) => n + 1);
}

export function markAcknowledged(sessionId: string): void {
  if (!sessionId) return;
  if (acknowledgedSessions.has(sessionId)) return;
  seedAcknowledged(sessionId);
  // Best-effort persistence so the ack survives a webview reload / app
  // restart. Fire-and-forget: a failed (or absent) ack write must never break
  // the in-memory acknowledgement or throw. Routing through
  // `Promise.resolve().then(invoke)` also absorbs a synchronous throw and the
  // non-thenable return `invoke` yields under vitest/jsdom (no Tauri runtime).
  void Promise.resolve()
    .then(() => invoke("agent_ack_state", { sessionId }))
    .catch((e) => {
      console.warn("agent_ack_state failed", e);
    });
}

export function unmarkAcknowledged(sessionId: string): void {
  if (!sessionId) return;
  if (!acknowledgedSessions.delete(sessionId)) return;
  setAcknowledgedTick((n) => n + 1);
}

export function isAcknowledged(sessionId: string): boolean {
  return acknowledgedSessions.has(sessionId);
}

/** Reactive sibling of {@link isAcknowledged}: subscribes the caller to
 *  `acknowledgedTick`, so computations/memos/effects that read this re-run
 *  when the set mutates. Use inside Solid tracking contexts (JSX, memos,
 *  effects); outside of those it behaves the same as `isAcknowledged`. */
export function isAcknowledgedReactive(sessionId: string): boolean {
  acknowledgedTick();
  return acknowledgedSessions.has(sessionId);
}

export function setAdapters(items: AgentListItem[]): void {
  // Adapters have no `session_id`; the full list returned by `agent_list`
  // interleaves adapters (session_id null) with live machines. We split them
  // so the top-row spawn buttons can iterate adapters without re-filtering.
  const adapters = items.filter((a) => a.session_id == null);
  const liveSessions: Record<string, AgentListItem> = {};
  for (const item of items) {
    if (!item.session_id) continue;
    // Seed `enteredStateAt` from the backend's persisted truth. Crucially we
    // do NOT fall back to `Date.now()` when absent — a fabricated timestamp
    // is what made stale completions read "done 4s" after a reload. Leaving
    // it undefined lets the rail's `formatAge` render nothing instead.
    liveSessions[item.session_id] = {
      ...item,
      enteredStateAt: item.state_entered_at_ms ?? undefined,
    };
  }
  // `batch()` so `attentionQueue` / `unreadAgentCount` memos never observe an
  // intermediate frame where the sessions have landed but their acks haven't
  // been re-seeded — that half-applied state is exactly the "flood" we're
  // fixing (every persisted completion momentarily unacked).
  batch(() => {
    setAgentStore("adapters", reconcile(adapters, { key: "harness" }));
    setAgentStore("sessions", reconcile(liveSessions));
    for (const item of items) {
      if (!item.session_id) continue;
      // Restore the pre-reload rail: an already-seen completion/error stays
      // quiet. `waiting` is sticky by design and never acknowledged-away, so
      // we only seed the terminal (`done`-style) states.
      if (item.state_acked === true && (item.state === "completed" || item.state === "errored")) {
        seedAcknowledged(item.session_id);
      }
    }
  });
}

export function updateSessionState(
  sessionId: string,
  harness: AgentKind,
  state: AgentState,
  reliability?: Reliability | null,
  opts?: {
    /**
     * The backend's persisted wall-clock (unix ms) for this transition. Wins
     * over `Date.now()` on an actual state change, so a hydration replay
     * stamps the *true* age instead of "just now".
     */
    enteredStateAtMs?: number;
    /**
     * True when this update replays persisted state (a boot/reattach seed)
     * rather than a live transition. A seeded update with no timestamp and no
     * prior reading leaves `enteredStateAt` undefined — the rail's `formatAge`
     * renders "" for a falsy value, so we show no age rather than a fake one.
     */
    seeded?: boolean;
  },
): void {
  const existing = agentStore.sessions[sessionId];
  // Stamp `enteredStateAt` only when the state actually transitions, so it
  // tracks "blocked-since" rather than "last touched". A redundant
  // same-state update (e.g. a duplicate `waiting` emit) preserves the
  // original timestamp so the rail's age keeps climbing.
  //
  // Timestamp precedence on a real change: explicit `enteredStateAtMs` →
  // `Date.now()`. On a same-state update: preserve the existing stamp, else
  // fall back to `enteredStateAtMs`. A *seeded* creation without either an
  // explicit ms or a prior value must stay `undefined` — we never fabricate
  // `Date.now()` for replayed state (that's the stale "done 4s" bug).
  const stateChanged = existing?.state !== state;
  let enteredStateAt: number | undefined;
  if (stateChanged) {
    enteredStateAt = opts?.enteredStateAtMs ?? (opts?.seeded ? undefined : Date.now());
  } else if (existing?.enteredStateAt != null) {
    enteredStateAt = existing.enteredStateAt;
  } else {
    enteredStateAt = opts?.enteredStateAtMs ?? (opts?.seeded ? undefined : Date.now());
  }
  const next: AgentListItem = existing
    ? {
        ...existing,
        state,
        reliability: reliability ?? existing.reliability ?? null,
        enteredStateAt,
      }
    : {
        session_id: sessionId,
        harness,
        state,
        supports_native_events: false,
        reliability: reliability ?? null,
        enteredStateAt,
      };
  setAgentStore("sessions", sessionId, next);

  // Re-arm: when a previously acknowledged session leaves its terminal
  // state (because the harness started running again or went idle), drop
  // the acknowledgement so the next completion shows as unread.
  if (state === "working" || state === "idle") {
    unmarkAcknowledged(sessionId);
  }
}

export function removeSession(sessionId: string): void {
  const next = { ...agentStore.sessions };
  delete next[sessionId];
  setAgentStore("sessions", reconcile(next));
  unmarkAcknowledged(sessionId);
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
  const unread = createMemo(() => {
    // Touch the tick so the memo retracks when the acknowledged set
    // mutates. Membership lookups themselves are non-reactive (plain Set).
    acknowledgedTick();
    return Object.values(agentStore.sessions).filter((s) => {
      if (s.state !== "waiting" && s.state !== "completed" && s.state !== "errored") {
        return false;
      }
      // `waiting` is sticky by user request: it should keep contributing to
      // the badge until the harness leaves the waiting state, regardless of
      // whether the project tab has been viewed. Only `done`-style states
      // can be acknowledged via tab activation.
      if (s.state === "waiting") return true;
      if (s.session_id && acknowledgedSessions.has(s.session_id)) return false;
      return true;
    }).length;
  });
  return { unreadAgentCount: unread };
});

/**
 * §11.3 — count of agents whose last state transition still demands attention.
 * Drives the "All unread" dock-badge mode.
 */
export const unreadAgentCount = agentSelectors.unreadAgentCount;

// ---- attention ranking (FLEET) -------------------------------------------
//
// Mission-control triage helpers. The attention rail ranks agents needing a
// human in three priority tiers — `waiting` (blocked on input) above
// `errored` above `completed`-but-unread — and within the `waiting` tier the
// *longest-blocked* agent sorts first. These are plain functions (not memos)
// so callers can compose them inside their own tracking contexts; reading
// `agentStore.sessions` / `acknowledgedTick` inside a Solid scope subscribes
// the caller the usual way.

/** Relative priority of an attention state — lower sorts first. States not
 *  demanding attention return `Infinity` so they never enter the queue. */
function attentionRank(state: AgentState): number {
  switch (state) {
    case "waiting":
      return 0;
    case "errored":
      return 1;
    case "completed":
      return 2;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

/**
 * A single attention-queue entry: the session plus the moment it entered its
 * current state, so the UI can render an age ("waiting 8m") without re-reading
 * the store.
 */
export interface AttentionItem {
  session: AgentListItem;
  /** `enteredStateAt`, or `0` when no transition has been recorded yet. */
  blockedSince: number;
}

/**
 * Agents that want a human, in triage order: waiting (oldest-blocked first)
 * then errored then completed-unread. `completed`/`errored` entries the user
 * has implicitly acknowledged (by activating their project tab) are excluded;
 * `waiting` is sticky and never acknowledged-away (mirrors {@link unreadAgentCount}).
 *
 * Reactive: reading inside a Solid scope subscribes to `agentStore.sessions`
 * and the acknowledged tick.
 */
export function attentionQueue(): AttentionItem[] {
  acknowledgedTick();
  const out: AttentionItem[] = [];
  for (const session of Object.values(agentStore.sessions)) {
    const rank = attentionRank(session.state);
    if (!Number.isFinite(rank)) continue;
    // Completed/errored clear on tab-activation; waiting stays sticky.
    if (session.state !== "waiting" && session.session_id) {
      if (acknowledgedSessions.has(session.session_id)) continue;
    }
    out.push({ session, blockedSince: session.enteredStateAt ?? 0 });
  }
  out.sort((a, b) => {
    const ra = attentionRank(a.session.state);
    const rb = attentionRank(b.session.state);
    if (ra !== rb) return ra - rb;
    // Within a tier, the agent blocked longest (smallest timestamp) first.
    return a.blockedSince - b.blockedSince;
  });
  return out;
}

/**
 * The waiting tier on its own, oldest-blocked first — the queue
 * "focus-next-waiting" steps through. Distinct from terminalStore's
 * `waitingTerminals` (which sorts by immutable `created_unix`): this ranks by
 * `enteredStateAt`, so a freshly-re-blocked agent goes to the back.
 */
export function waitingByBlockedLongest(): AgentListItem[] {
  return Object.values(agentStore.sessions)
    .filter((s) => s.state === "waiting")
    .sort((a, b) => (a.enteredStateAt ?? 0) - (b.enteredStateAt ?? 0));
}

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
  /**
   * True when the backend replayed this transition from persisted state at
   * boot/rehydrate rather than emitting it from a live machine change. Lets
   * the store stamp the true persisted age (not `Date.now()`) and lets
   * `notificationCenter` stay silent for stale state. Missing ⇒ `false`.
   */
  seeded?: boolean;
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
    updateSessionState(id, ev.payload.harness, ev.payload.to, ev.payload.reliability ?? null, {
      seeded: ev.payload.seeded,
    });
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
  acknowledgedSessions.clear();
  setAcknowledgedTick(0);
}
