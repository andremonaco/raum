import type { BadgeMode } from "../../lib/notificationCenter";
import type { HarnessIconKind } from "../icons";

import type { HarnessEntry } from "./types";

// Sentinel for the "Custom path…" entry in the sound dropdown. Empty string
// means "no sound".
export const CUSTOM_SOUND_VALUE = "__custom__";

export const BADGE_MODE_OPTIONS: {
  value: BadgeMode;
  label: string;
  description: string;
}[] = [
  {
    value: "off",
    label: "Off",
    description: "Never show a dock or taskbar badge.",
  },
  {
    value: "critical",
    label: "Critical only",
    description: "Count only open permission requests.",
  },
  {
    value: "all_unread",
    label: "All unread",
    description: "Count every agent currently waiting, completed, or errored.",
  },
];

export const HARNESS_ENTRIES: HarnessEntry[] = [
  {
    id: "shell",
    label: "Shell",
    binary: "sh",
    description: "Standard POSIX shell",
    placeholder: "--login -x",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    binary: "claude",
    description: "Anthropic AI coding assistant",
    placeholder: "--verbose --model claude-opus-4-5",
  },
  {
    id: "codex",
    label: "Codex",
    binary: "codex",
    description: "OpenAI terminal agent",
    placeholder: "--approval-mode full-auto",
  },
  {
    id: "opencode",
    label: "OpenCode",
    binary: "opencode",
    description: "Open-source AI terminal",
    placeholder: "--model anthropic/claude-opus-4-5",
  },
];

// One-line install command per harness. Mirrors the onboarding wizard's
// suggestions so users see the same story in both places.
export const INSTALL_COMMANDS: Partial<Record<HarnessIconKind, string>> = {
  "claude-code": "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  opencode: "npm install -g opencode-ai",
};

// Canonical preset patterns. Tokens match the backend constants exactly
// (`{base-folder}` / `{branch-slug}`) so `detectPreset` here and
// `PathStrategy::infer_from_pattern` in Rust classify them identically.
//   nested → NESTED_PATH_PATTERN, parent → SIBLING_GROUP/DEFAULT_PATH_PATTERN.
export const WORKTREE_PRESETS = {
  nested: "{repo-root}/.raum/{branch-slug}",
  parent: "{parent-dir}/{base-folder}-worktrees/{branch-slug}",
} as const;

/** Command surfaced for Homebrew-cask installs; copied to the clipboard so
 *  users can paste it into a terminal. The cask is published from the
 *  release workflow's `bump-homebrew` job. */
export const BREW_UPGRADE_COMMAND = "brew upgrade --cask raum";

/** GitHub release page for a given raum version, used as the fallback
 *  "open in browser" target for `.deb` installs. Matches the repo owner +
 *  tag convention baked into `release.yml`. */
export const releasePageUrl = (version: string): string =>
  `https://github.com/andremonaco/raum/releases/tag/v${version}`;

/** GitHub's "latest release" redirector. Fallback target for the in-app
 *  updater error state — older bundled clients can hit reqwest-level
 *  TLS/proxy/cert failures we can't recover from inside the binary, so
 *  the user always has a working route to grab signed DMG/.deb/AppImage. */
export const LATEST_RELEASE_URL = "https://github.com/andremonaco/raum/releases/latest";
