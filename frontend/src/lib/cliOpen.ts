/**
 * Terminal-launch bridge (`raum <dir>`).
 *
 * Two backend entry points funnel into one handler here:
 *   - cold start  → `cli_take_pending_open` returns the path on boot;
 *   - already-running → the `cli-open-project` Tauri event carries the path.
 *
 * Both call `openProjectFromCli`, which asks the backend whether the directory
 * is already a registered project (`project_find_by_path`, the canonical
 * path-dedup authority) and either focuses it or opens the Add-Project modal
 * pre-filled with the path — the same flow as adding a repo manually in the UI.
 * Window focus itself is handled in Rust (single-instance / window show).
 */

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import { reopenProject, upsertProject, type ProjectListItem } from "../stores/projectStore";

const [pendingAddProjectPath, setPendingAddProjectPath] = createSignal<string | undefined>(
  undefined,
);

export { pendingAddProjectPath };

/** Request that the Add-Project modal open pre-filled with `path`. Consumed by
 *  the top row, which owns the modal. */
export function requestAddProject(path: string): void {
  setPendingAddProjectPath(path);
}

/** Clear the pending add request once the modal has opened/closed with it. */
export function clearPendingAddProject(): void {
  setPendingAddProjectPath(undefined);
}

/** Outcome of {@link openProjectFromCli}, so the caller can react (e.g. exit a
 *  cross-project view on focus, or toast on error). */
export type CliOpenResult = "focused" | "add-requested" | "error" | "noop";

/** Open a project from a terminal launch. Existing project → upsert + activate
 *  (un-shelving it if hidden); new directory → pre-filled Add-Project modal. */
export async function openProjectFromCli(path: string): Promise<CliOpenResult> {
  if (!path) return "noop";
  try {
    const existing = await invoke<ProjectListItem | null>("project_find_by_path", { path });
    if (existing) {
      upsertProject(existing);
      reopenProject(existing.slug);
      return "focused";
    }
    requestAddProject(path);
    return "add-requested";
  } catch (e) {
    console.warn("openProjectFromCli failed", e);
    return "error";
  }
}
