import { kindDisplayLabel, type AgentKind } from "./agentKind";

export interface TabLabelState {
  label?: string;
  autoLabel?: string;
}

export interface ResolveHarnessAutoLabelArgs {
  kind: AgentKind;
  paneTitle?: string | null;
  windowName?: string | null;
  currentCommand?: string | null;
  fallbackLabel?: string | null;
}

const GENERIC_PROCESS_NAMES = new Set([
  "bash",
  "bun",
  "claude",
  "claude code",
  "claude-code",
  "codex",
  "fish",
  "node",
  "npm",
  "npx",
  "opencode",
  "open code",
  "python",
  "python3",
  "sh",
  "zsh",
]);

const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:[-+][0-9a-z][0-9a-z.+-]*)?$/i;

function normalizeLabel(value: string | null | undefined): string | undefined {
  const cleaned = value?.replace(/[\r\n\t]+/g, " ").trim();
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}

function normalizeToken(value: string | null | undefined): string | undefined {
  return normalizeLabel(value)?.toLowerCase();
}

function isGenericHarnessTitle(
  value: string | null | undefined,
  currentCommand: string | null | undefined,
  kind: AgentKind,
): boolean {
  const normalized = normalizeToken(value);
  if (!normalized) return true;
  const current = normalizeToken(currentCommand);
  if (current && normalized === current) return true;
  if (GENERIC_PROCESS_NAMES.has(normalized)) return true;
  if (SEMVER_RE.test(normalized)) return true;

  switch (kind) {
    case "claude-code":
      return (
        normalized === "claude code" || normalized === "claude-code" || normalized === "claude"
      );
    case "codex":
      return normalized === "codex";
    case "opencode":
      return normalized === "opencode" || normalized === "open code";
    case "shell":
      return normalized === "shell";
  }
}

export function resolveDisplayedTabLabel(tab: TabLabelState): string | undefined {
  return normalizeLabel(tab.label) ?? normalizeLabel(tab.autoLabel);
}

export function resolveHarnessAutoLabel(args: ResolveHarnessAutoLabelArgs): string {
  const fallback = normalizeLabel(args.fallbackLabel) ?? kindDisplayLabel(args.kind);
  const paneTitle = normalizeLabel(args.paneTitle);
  if (!isGenericHarnessTitle(paneTitle, args.currentCommand, args.kind)) {
    return paneTitle!;
  }

  const windowName = normalizeLabel(args.windowName);
  if (!isGenericHarnessTitle(windowName, args.currentCommand, args.kind)) {
    return windowName!;
  }

  return fallback;
}
