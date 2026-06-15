/**
 * Webview liveness answering side of the focus-gated health check.
 *
 * macOS sometimes kills the WKWebView WebContent process while the screen
 * is locked; the backend cannot observe that directly (wry never surfaces
 * `webViewWebContentProcessDidTerminate:` to Tauri), so on every window
 * focus it emits `raum:ping` and reloads the webview if no pong arrives
 * within 3 s. This module is the page's half of that handshake: echo every
 * ping via `webview_pong`, and announce readiness via `webview_ready` on
 * every page load — including the post-reload boot, which re-arms the
 * backend gate closed by the previous reload.
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
