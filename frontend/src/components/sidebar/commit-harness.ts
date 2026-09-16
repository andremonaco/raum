/**
 * §9.5 — shared state for the Changes "Commit & push" split button and its
 * Settings › Harnesses preference.
 *
 * The primary button fires without a picker: it spawns the user's preferred
 * harness (config `[commit] harness`, else the first installed one in
 * `COMMIT_HARNESSES` order) at that harness's cheap tier, pre-loaded with a
 * commit+push prompt. Settings writes the preference through
 * `setCommitHarnessPreference`, which updates the module signal so the sidebar
 * button relabels without an event round-trip.
 */

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import type { AgentKind } from "../../lib/agentKind";

/** Harness preference order when the user has not pinned one. */
export const COMMIT_HARNESSES = ["claude-code", "codex", "opencode"] as const;
export type CommitHarness = (typeof COMMIT_HARNESSES)[number];

export interface CommitTier {
  model: string;
  effort?: string;
}

/** Built-in cheap tier per harness for a commit-message task, used when the
 *  user has not pinned a model in Settings › Harnesses. OpenCode has no
 *  portable cheap slug (provider-dependent), so it runs its configured
 *  default. A `--model` in that harness's extra_flags wins over both — see
 *  `harness_launch_command_with_prompt_and_override`. */
export const COMMIT_DEFAULT_TIER: Partial<Record<CommitHarness, CommitTier>> = {
  "claude-code": { model: "haiku", effort: "low" },
  codex: { model: "gpt-5.6-luna", effort: "low" },
};

const COMMIT_RULES = [
  "- Inspect the work first: run `git status` and `git diff` (both staged and unstaged) to understand what changed.",
  "- Group the changes into logical commits by feature or fix. If the work spans more than one distinct feature or fix, make multiple commits — one per logical unit.",
  "- NEVER split a single file across commits. Stage whole files only (no `git add -p` / hunk or patch splitting) so every commit is self-consistent and builds.",
  "- Follow this project's commit conventions (check AGENTS.md / CLAUDE.md and recent `git log` for the message style).",
];

export const COMMIT_PUSH_PROMPT = [
  "Commit and push the uncommitted changes in this git worktree for me.",
  "",
  ...COMMIT_RULES,
  "- Create the commit(s), then `git push` the current branch. If it has no upstream yet, push with `-u origin <branch>`. Do not force-push and do not rebase.",
].join("\n");

export const COMMIT_ONLY_PROMPT = [
  "Review the uncommitted changes in this git worktree and commit them for me.",
  "",
  ...COMMIT_RULES,
  "- Create the commit(s). Do not push.",
].join("\n");

// Probe `harnesses_check` once per session; list the installed commit harnesses
// (falling back to Claude so the list is never empty).
let harnessProbe: Promise<CommitHarness[]> | undefined;
export function availableCommitHarnesses(): Promise<CommitHarness[]> {
  harnessProbe ??= invoke<{ harnesses: { kind: AgentKind; found: boolean }[] }>("harnesses_check")
    .then((report): CommitHarness[] => {
      const found = new Set(report.harnesses.filter((h) => h.found).map((h) => h.kind));
      const list = COMMIT_HARNESSES.filter((k) => found.has(k));
      return list.length > 0 ? [...list] : ["claude-code"];
    })
    .catch((): CommitHarness[] => ["claude-code"]);
  return harnessProbe;
}

/** Mirror of `raum_core::config::CommitConfig`. */
export interface CommitConfig {
  harness: CommitHarness | null;
  "claude-code"?: CommitTier | null;
  codex?: CommitTier | null;
  opencode?: CommitTier | null;
}

// Module-level signal shared by the sidebar button and the settings section.
// `undefined` = not loaded yet.
const [commitConfig, setCommitConfig] = createSignal<CommitConfig | undefined>(undefined);

export { commitConfig };
export const commitHarnessPreference = (): CommitHarness | null | undefined => {
  const cfg = commitConfig();
  return cfg === undefined ? undefined : cfg.harness;
};

/** User-pinned tier for `kind`, else the built-in cheap tier. */
export function commitTier(kind: CommitHarness): CommitTier | undefined {
  return commitConfig()?.[kind] ?? COMMIT_DEFAULT_TIER[kind];
}

export function commitTierLabel(kind: CommitHarness): string {
  const tier = commitTier(kind);
  return tier ? `${tier.model}${tier.effort ? ` · ${tier.effort}` : ""}` : "default model";
}

let configLoad: Promise<void> | undefined;
export function loadCommitHarnessPreference(): Promise<void> {
  configLoad ??= invoke<{ commit?: Partial<CommitConfig> }>("config_get")
    .then((cfg) => {
      setCommitConfig({ ...cfg.commit, harness: cfg.commit?.harness ?? null });
    })
    .catch(() => {
      setCommitConfig({ harness: null });
    });
  return configLoad;
}

export async function setCommitHarnessPreference(kind: CommitHarness | null): Promise<void> {
  await invoke("config_set_commit_harness", { harness: kind });
  setCommitConfig((prev) => ({ ...prev, harness: kind }));
}

/** Pin (or clear with `null`) the model/effort used for `kind`. */
export async function setCommitModel(kind: CommitHarness, tier: CommitTier | null): Promise<void> {
  await invoke("config_set_commit_model", { harness: kind, model: tier });
  setCommitConfig((prev) => ({ harness: null, ...prev, [kind]: tier }));
}

/** Preferred harness if installed, else first installed. */
export function resolveCommitHarness(
  pref: CommitHarness | null | undefined,
  installed: CommitHarness[],
): CommitHarness {
  if (pref && installed.includes(pref)) return pref;
  return installed[0] ?? "claude-code";
}

/** Dispatch the spawn the terminal grid listens for. */
export function spawnCommitHarness(args: {
  kind: CommitHarness;
  projectSlug: string;
  worktreeId: string;
  push: boolean;
}): void {
  window.dispatchEvent(
    new CustomEvent("raum:spawn-requested", {
      detail: {
        kind: args.kind,
        projectSlug: args.projectSlug,
        worktreeId: args.worktreeId,
        initialPrompt: args.push ? COMMIT_PUSH_PROMPT : COMMIT_ONLY_PROMPT,
        modelOverride: commitTier(args.kind),
      },
    }),
  );
}
