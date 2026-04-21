/**
 * §4.7 / §4.8 — shared open/close signal for the `<GlobalSearchPanel>`.
 * Kept outside the component so TopRow's button and the Cmd+F binding
 * can both toggle it without prop-drilling.
 */

import { createSignal } from "solid-js";

const [open, setOpen] = createSignal(false);

export const searchPanelOpen = open;
export function openSearchPanel(): void {
  setOpen(true);
}
export function closeSearchPanel(): void {
  setOpen(false);
}
export function toggleSearchPanel(): void {
  setOpen((v) => !v);
}
