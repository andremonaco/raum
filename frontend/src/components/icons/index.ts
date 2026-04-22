import { ActivityIcon } from "./activity";
import { AlertCircleIcon } from "./alert-circle";
import { CheckIcon } from "./check";
import { ChevronDownIcon } from "./chevron-down";
import { ClaudeCodeIcon } from "./claude-code";
import { ClockIcon } from "./clock";
import { CodexIcon } from "./codex";
import { CompactIcon } from "./compact";
import { CopyIcon } from "./copy";
import { FolderIcon } from "./folder";
import { GitBranchIcon } from "./git-branch";
import { GridEqualIcon } from "./grid-equal";
import { GridTileIcon } from "./grid-tile";
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
  ChevronDownIcon,
  ClaudeCodeIcon,
  ClockIcon,
  CodexIcon,
  CompactIcon,
  CopyIcon,
  FolderIcon,
  GitBranchIcon,
  GridEqualIcon,
  GridTileIcon,
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
