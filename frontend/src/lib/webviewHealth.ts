/**
 * Webview liveness answering side of the focus-gated health check.
 *
 * macOS sometimes kills the WKWebView WebContent process while the screen
 * is locked. On macOS the backend now observes the kill directly (a
 * swizzled `webViewWebContentProcessDidTerminate:`) and reloads at once;
 * this probe is the fallback for missed callbacks and for Linux: on every
 * window focus the backend emits up to three `raum:ping`s spread over
 * ~6 s, reloading the webview only if every one goes unanswered. A
 * suspended-then-resumed page answers late; a dead one never answers —
 * so any pong, however stale, proves life. This module is the page's half
 * of that handshake: echo every ping via `webview_pong`, and announce
 * readiness via `webview_ready` on every page load — including the
 * post-reload boot, which re-arms the backend gate closed by the previous
 * reload.
 *
 * The pong is deliberately an immediate echo from the listener callback —
 * NOT deferred behind `requestAnimationFrame` or any paint-coupled hook.
 * rAF does not fire on hidden pages and can be starved for seconds on a
 * thrashing post-unlock wake; the probe's question is "does JS run", not
 * "can we paint", and coupling the answer to paint would reintroduce the
 * false-positive reload the probe sequence exists to prevent.
 *
 * See `src-tauri/src/commands/webview_health.rs` for the backend half.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Install the ping listener, then signal readiness. Order matters: the
 * listener must be registered before `webview_ready`, so a ping emitted
 * immediately after the ready signal can never be missed.
 */
export async function installWebviewHealth(): Promise<UnlistenFn> {
  const unlisten = await listen<number>("raum:ping", (ev) => {
    void invoke("webview_pong", { nonce: ev.payload }).catch((e) =>
      console.warn("webview_pong failed", e),
    );
  });
  await invoke("webview_ready").catch((e) => console.warn("webview_ready failed", e));
  return unlisten;
}
