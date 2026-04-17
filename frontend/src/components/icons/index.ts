import { ActivityIcon } from "./activity";
import { AlertCircleIcon } from "./alert-circle";
import { CheckIcon } from "./check";
import { ClaudeCodeIcon } from "./claude-code";
import { ClockIcon } from "./clock";
import { CodexIcon } from "./codex";
import { CopyIcon } from "./copy";
import { GitBranchIcon } from "./git-branch";
import { KeyboardIcon } from "./keyboard";
import { LoaderIcon } from "./loader";
import { OpenCodeIcon } from "./opencode";
import { PlayIcon } from "./play";
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
  CopyIcon,
  GitBranchIcon,
  KeyboardIcon,
  LoaderIcon,
  OpenCodeIcon,
  PlayIcon,
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
