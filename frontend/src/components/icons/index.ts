import { ActivityIcon } from "./activity";
import { AlertCircleIcon } from "./alert-circle";
import { CheckIcon } from "./check";
import { ClaudeCodeIcon } from "./claude-code";
import { ClockIcon } from "./clock";
import { CodexIcon } from "./codex";
import { GitBranchIcon } from "./git-branch";
import { LoaderIcon } from "./loader";
import { OpenCodeIcon } from "./opencode";
import { PlusIcon } from "./plus";
import { RaumLogo } from "./raum-logo";
import { SearchIcon } from "./search";
import { ShellIcon } from "./shell";

export {
  ActivityIcon,
  AlertCircleIcon,
  CheckIcon,
  ClaudeCodeIcon,
  ClockIcon,
  CodexIcon,
  GitBranchIcon,
  LoaderIcon,
  OpenCodeIcon,
  PlusIcon,
  RaumLogo,
  SearchIcon,
  ShellIcon,
};

export type HarnessIconKind = "shell" | "claude-code" | "codex" | "opencode";

export const HARNESS_ICONS: Record<HarnessIconKind, typeof ClaudeCodeIcon> = {
  shell: ShellIcon,
  "claude-code": ClaudeCodeIcon,
  codex: CodexIcon,
  opencode: OpenCodeIcon,
};
