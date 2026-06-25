import type { JSXElement } from "solid-js";
import type { Update } from "@tauri-apps/plugin-updater";

import type { BadgeMode } from "../../lib/notificationCenter";
import type { HarnessIconKind } from "../icons";

export type SectionId =
  | "appearance"
  | "projects"
  | "notifications"
  | "harnesses"
  | "worktrees"
  | "updates";

export interface Section {
  id: SectionId;
  label: string;
  icon: () => JSXElement;
}

export interface SystemSound {
  name: string;
  path: string;
}

export interface NotifConfig {
  notify_on_waiting: boolean;
  notify_on_done: boolean;
  notify_banner_enabled: boolean;
  sound: string | null;
  badge_mode: BadgeMode;
}

export interface NotifOsInfo {
  family: "macos" | "linux" | "other";
}

export interface HarnessEntry {
  id: HarnessIconKind;
  label: string;
  binary: string;
  description: string;
  placeholder: string;
}

export type WorktreePresetKey = "inside" | "sibling" | "custom";

export interface ProjectListItem {
  slug: string;
  name: string;
  rootPath: string;
}

/** How this binary was installed — reported by the Rust `updater_install_flavor`
 *  command. `deb` and `homebrew` must NOT try in-app install: apt owns the
 *  Linux `.deb` file, and Homebrew owns the macOS cask record (replacing the
 *  bundle out of band leaves `brew list` stale and breaks later
 *  `brew upgrade`/`uninstall`). For everything else
 *  `update.downloadAndInstall()` works. */
export type InstallFlavor = "macos" | "homebrew" | "appimage" | "deb" | "unknown";

export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; checkedAt: number }
  | { kind: "available"; update: Update }
  | {
      kind: "downloading";
      update: Update;
      received: number;
      total: number | null;
    }
  | { kind: "installed"; version: string }
  | { kind: "error"; message: string };
