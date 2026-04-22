/**
 * Keyboard fallback for opening the WebView devtools.
 *
 * We globally suppress the native right-click menu, which also removes the
 * built-in "Inspect Element" path. To keep the inspector reachable on macOS
 * and Linux we listen for the conventional shortcut and invoke a Tauri
 * command that calls `WebviewWindow::open_devtools()` on the Rust side.
 *
 *   macOS:       ⌘ + ⌥ + I
 *   Linux/Win:   Ctrl + Shift + I
 *
 * No-op outside a Tauri host (e.g. browser dev server).
 */

import { invoke } from "@tauri-apps/api/core";

function isMacLike(): boolean {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData?.platform;
  const source = platform ?? navigator.platform ?? "";
  return source.toUpperCase().includes("MAC");
}

export function installDevtoolsShortcut(): () => void {
  const mac = isMacLike();
  const handler = (e: KeyboardEvent): void => {
    // Match on `code` so layout-independent: "KeyI" fires regardless of
    // locale or active keyboard layout.
    if (e.code !== "KeyI") return;
    const matches = mac
      ? e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey
      : e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
    if (!matches) return;
    e.preventDefault();
    void invoke("open_devtools").catch((err) => {
      console.warn("open_devtools invoke failed", err);
    });
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}
