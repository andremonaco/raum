/**
 * Quit-flush protocol — frontend half (Contract 1).
 *
 * Both the active-layout save and the per-pane terminal-snapshot persist are
 * debounced (500 ms / per-snapshot timers). A quit that lands inside one of
 * those quiet windows would otherwise discard the pending write when the OS
 * tears down the webview, losing the last layout mutation (a just-spawned pane
 * vanishes and its still-alive tmux session surfaces as a dock orphan).
 *
 * To close that gap the backend intercepts `WindowEvent::CloseRequested`,
 * calls `api.prevent_close()`, emits `app-will-quit`, and waits (bounded) for
 * the frontend to call `app_quit_flush_done` before running its own final
 * flush and exiting. This module is the page's half: on `app-will-quit`, flush
 * every debounced writer immediately, then ack via `app_quit_flush_done`.
 *
 * Each flush is individually try/caught so one failing writer still lets us
 * ack — a missed ack only means the backend waits out its timeout, but a thrown
 * error before the ack would block the quit until that timeout regardless, so
 * acking unconditionally is strictly better.
 *
 * See `src-tauri/src/lib.rs` (CloseRequested handler) for the backend half.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { flushPendingAcks } from "../stores/agentStore";
import { flushActiveLayoutNow } from "../stores/runtimeLayoutStore";
import { flushAllTerminalSnapshotsNow } from "./terminalSnapshotPersistence";

/** Flush every debounced writer, swallowing per-writer errors so one failure
 *  doesn't skip the others (or the ack). Ordered by importance against the
 *  backend's bounded quit-flush wait: layout first (losing it resurrects
 *  panes as dock orphans), snapshots second, agent-state acks last (losing
 *  one only re-surfaces an already-seen completion). Exposed for tests. */
export async function flushAllForQuit(): Promise<void> {
  try {
    await flushActiveLayoutNow();
  } catch (e) {
    console.warn("flushActiveLayoutNow (quit) failed", e);
  }
  try {
    await flushAllTerminalSnapshotsNow();
  } catch (e) {
    console.warn("flushAllTerminalSnapshotsNow (quit) failed", e);
  }
  try {
    await flushPendingAcks();
  } catch (e) {
    console.warn("flushPendingAcks (quit) failed", e);
  }
}

/**
 * Listen for the backend's `app-will-quit` and, on fire, flush all debounced
 * writers then ack via `app_quit_flush_done`. Returns the unlisten disposer.
 */
export async function installQuitFlush(): Promise<UnlistenFn> {
  const unlisten = await listen("app-will-quit", () => {
    void (async () => {
      await flushAllForQuit();
      try {
        await invoke("app_quit_flush_done");
      } catch (e) {
        console.warn("app_quit_flush_done failed", e);
      }
    })();
  });
  return unlisten;
}
