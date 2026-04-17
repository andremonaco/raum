/**
 * Shared signal for fully hiding the left sidebar.
 *
 * Distinct from the sidebar's internal `collapsed` state (which shrinks to the
 * 44 px mini-view driven by `CmdOrCtrl+B` / `toggle-sidebar`). The top-row
 * button uses this signal to remove the sidebar from the layout entirely.
 */

import { createSignal } from "solid-js";

const [hidden, setHidden] = createSignal(false);

export const sidebarHidden = hidden;
export function setSidebarHidden(next: boolean): void {
  setHidden(next);
}
export function toggleSidebarHidden(): void {
  setHidden((v) => !v);
}
