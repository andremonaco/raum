import { invoke } from "@tauri-apps/api/core";

import { LAYOUT_UNIT, runtimeLayoutStore } from "../../stores/runtimeLayoutStore";
import { clearTerminalClosing, markTerminalClosing } from "../../stores/terminalStore";
import { type Direction, type Rect } from "../../lib/layoutTree";
import { type DropZone } from "../../lib/paneDnD";
import {
  getScopedProjection as getScopedProjectionCached,
  setProjectionCacheMaxSize,
  type ScopedProjection,
} from "../../lib/scopedProjection";
import { projectStore } from "../../stores/projectStore";
import { type WorktreeScope } from "../../stores/worktreeStore";

export function requestTerminalKill(sessionId: string | undefined, context: string): void {
  if (!sessionId) return;
  markTerminalClosing(sessionId);
  void invoke("terminal_kill", { sessionId }).catch((e: unknown) => {
    clearTerminalClosing(sessionId);
    console.warn(`[${context}] terminal_kill failed`, e);
  });
}

export const pathBasename = (path: string): string => {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? path;
};

export function rectStyle(rect: Rect): Record<string, string> {
  const pct = 100 / LAYOUT_UNIT;
  return {
    "--x-pct": `${rect.x * pct}%`,
    "--y-pct": `${rect.y * pct}%`,
    "--w-pct": `${rect.w * pct}%`,
    "--h-pct": `${rect.h * pct}%`,
  };
}

export function zoneToDirection(zone: DropZone): Direction | null {
  if (zone === "top" || zone === "bottom" || zone === "left" || zone === "right") return zone;
  return null;
}

export function getScopedProjection(
  rev: number,
  slug: string | undefined,
  scope: WorktreeScope,
  mainPath: string | undefined,
): ScopedProjection {
  // Scale the cache to a reasonable multiple of the project count so a
  // user juggling 10 projects × 2 worktree scopes doesn't thrash.
  setProjectionCacheMaxSize(Math.max(16, projectStore.items.length * 2));
  return getScopedProjectionCached({
    layoutRev: rev,
    tree: runtimeLayoutStore.tree,
    panes: runtimeLayoutStore.panes,
    slug,
    scope,
    mainPath,
  });
}
