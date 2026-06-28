import {
  notificationBundleId,
  notificationDevMode,
  permissionState,
} from "../../lib/notificationCenter";
import type { ScanReport } from "../../stores/harnessStatusStore";

import type { WorktreePresetKey } from "./types";
import { WORKTREE_PRESETS } from "./constants";

export function linuxNotificationServiceUnavailable(): boolean {
  return (
    notificationBundleId() === "org.freedesktop.Notifications" && permissionState() === "denied"
  );
}

export function notificationReadinessLabel(): string {
  if (notificationDevMode()) return "Use bundled app";
  if (linuxNotificationServiceUnavailable()) return "Service unavailable";
  const state = permissionState();
  if (state === "granted") return "Working";
  if (state === "denied") return "OS permission denied";
  return "Permission not set";
}

export function isBadgeMode(value: unknown): value is "off" | "critical" | "all_unread" {
  return value === "off" || value === "critical" || value === "all_unread";
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

/** Mirror of `slug::slugify` just close enough for a live preview. The real
 *  slugging happens in Rust at worktree-create time. */
export function slugifyForPreview(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Pure-frontend mirror of `preview_path_pattern` in
 *  `crates/raum-hydration/src/pattern.rs`. Used so the settings preview stays
 *  responsive while the user types without round-tripping through a Tauri
 *  command that reads the stored pattern. */
export function renderPathPreview(pattern: string, rootPath: string, branch: string): string {
  const norm = rootPath.replace(/\/+$/, "");
  const lastSlash = norm.lastIndexOf("/");
  const parentDir = lastSlash > 0 ? norm.slice(0, lastSlash) : "";
  const baseFolder = lastSlash >= 0 ? norm.slice(lastSlash + 1) : norm || "project";
  const branchSlug = slugifyForPreview(branch);
  return pattern
    .replace(/\{repo-root\}/g, norm)
    .replace(/\{repo-name\}/g, baseFolder)
    .replace(/\{worktree-slug\}/g, branchSlug)
    .replace(/\{parent-dir\}/g, parentDir)
    .replace(/\{base-folder\}/g, baseFolder)
    .replace(/\{branch-slug\}/g, branchSlug)
    .replace(/\{branch-name\}/g, branch)
    .replace(/\{project-slug\}/g, baseFolder);
}

/** Rewrite the older alias tokens raum used to persist (`{repo-name}`,
 *  `{worktree-slug}`) to their canonical equivalents (`{base-folder}`,
 *  `{branch-slug}`) so a pattern saved before the token cleanup still maps onto
 *  its preset instead of falling through to "custom". */
function canonicalizePattern(pattern: string): string {
  return pattern
    .replace(/\{repo-name\}/g, "{base-folder}")
    .replace(/\{worktree-slug\}/g, "{branch-slug}");
}

export function detectPreset(pattern: string): WorktreePresetKey {
  const canon = canonicalizePattern(pattern);
  if (canon === WORKTREE_PRESETS.nested) return "nested";
  if (canon === WORKTREE_PRESETS.parent) return "parent";
  return "custom";
}

export const pathsReady = (scan: ScanReport | null): boolean => {
  if (!scan) return false;
  return scan.raumHooksInstalled;
};
