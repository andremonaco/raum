/**
 * Deep-link helper for the app Settings modal.
 *
 * The modal's open-state lives in `top-row.tsx`, which listens for the
 * `raum:open-settings` window event and jumps to the requested section (the
 * same channel the update toast's "Install…" action uses). Callers in unrelated
 * component trees — e.g. the sidebar's create-worktree modal — dispatch through
 * here instead of reaching across the tree for that state.
 */

import type { SectionId } from "../components/settings-modal/types";

/** Open the Settings modal focused on `section`. */
export function openSettingsSection(section: SectionId): void {
  window.dispatchEvent(new CustomEvent("raum:open-settings", { detail: { section } }));
}
