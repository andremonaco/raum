import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { markBoot } from "./bootTiming";
import { type TerminalListItem, upsertTerminal } from "../stores/terminalStore";

/**
 * One shared rehydrate gate for every pane (Contract 2). A pane with a
 * persisted session must not reattach/spawn before the backend has had a
 * chance to register (or mark recoverable) its row. Previously each pane ran
 * its own `terminal_rehydrate_ready` poll and `rehydrate:complete` listener;
 * this module runs one of each and additionally releases a pane the moment
 * its OWN row lands (`terminal-session-upserted`), so the first pane doesn't
 * wait for the whole plan.
 */
const GATE_TIMEOUT_MS = 4000;
const POLL_MS = 100;

let latched = false;
const ready = new Set<string>();
const waiters = new Map<string, Array<() => void>>();
let started = false;

function release(sessionId: string): void {
  ready.add(sessionId);
  const list = waiters.get(sessionId);
  if (!list) return;
  waiters.delete(sessionId);
  for (const w of list) w();
}

function latch(): void {
  if (latched) return;
  latched = true;
  markBoot("gate-released");
  for (const list of waiters.values()) for (const w of list) w();
  waiters.clear();
}

function start(): void {
  if (started) return;
  started = true;
  // Rows registered before this listener attached: one `terminal_list`. Each
  // row is pushed into terminalStore first so a pane released here already
  // sees its `recoverable_after_reboot` flag (idempotent with the store's own
  // event listener / reconcile refresh).
  void invoke<TerminalListItem[]>("terminal_list")
    .then((rows) => {
      for (const r of rows) {
        if (!r.session_id) continue;
        upsertTerminal(r);
        release(r.session_id);
      }
    })
    .catch(() => {});
  void listen<TerminalListItem>("terminal-session-upserted", (ev) => {
    if (!ev.payload.session_id) return;
    upsertTerminal(ev.payload);
    release(ev.payload.session_id);
  }).catch(() => {});
  void listen("rehydrate:complete", latch).catch(() => {});
  const poll = (): void => {
    if (latched) return;
    void invoke<boolean>("terminal_rehydrate_ready")
      .then((isReady) => {
        if (isReady) latch();
        else if (!latched) setTimeout(poll, POLL_MS);
      })
      // Older backend without the command (or no IPC in tests): don't gate.
      .catch(latch);
  };
  poll();
  setTimeout(latch, GATE_TIMEOUT_MS);
}

/** Resolves once `sessionId`'s row is known to the backend OR the whole
 *  rehydrate has latched (ready, event, or hard timeout). Never rejects. */
export function awaitSessionReady(sessionId: string): Promise<void> {
  if (latched || ready.has(sessionId)) return Promise.resolve();
  start();
  return new Promise((resolve) => {
    const list = waiters.get(sessionId) ?? [];
    list.push(resolve);
    waiters.set(sessionId, list);
  });
}

export function __resetRehydrateGateForTests(): void {
  latched = false;
  started = false;
  ready.clear();
  waiters.clear();
}
