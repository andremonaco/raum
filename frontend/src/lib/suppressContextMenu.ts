/**
 * Global suppressor for the native WebView context menu.
 *
 * A single capture-phase listener on `document` calls `preventDefault()` on
 * every `contextmenu` event. It does NOT stop propagation, so component-level
 * `onContextMenu` handlers still fire and can open their own custom menus —
 * they just inherit "no native menu" for free without needing to remember
 * `preventDefault()` themselves.
 */
export function installGlobalContextMenuSuppressor(): () => void {
  const handler = (e: Event): void => {
    e.preventDefault();
  };
  document.addEventListener("contextmenu", handler, { capture: true });
  return () => document.removeEventListener("contextmenu", handler, { capture: true });
}
