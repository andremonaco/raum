import { ActivityIcon } from "./activity";
import { AlertCircleIcon } from "./alert-circle";
import { CheckIcon } from "./check";
import { ChevronDownIcon } from "./chevron-down";
import { ChevronRightIcon } from "./chevron-right";
import { ClaudeCodeIcon } from "./claude-code";
import { ClockIcon } from "./clock";
import { CodexIcon } from "./codex";
import { CompactIcon } from "./compact";
import { CopyIcon } from "./copy";
import { FolderIcon } from "./folder";
import { GitBranchIcon } from "./git-branch";
import { GitMergeIcon } from "./git-merge";
import { GridEqualIcon } from "./grid-equal";
import { GridTileIcon } from "./grid-tile";
import { HistoryIcon } from "./history";
import { KeyboardIcon } from "./keyboard";
import { LoaderIcon } from "./loader";
import { OpenCodeIcon } from "./opencode";
import { PlayIcon } from "./play";
import { PlusIcon } from "./plus";
import { RaumLogo } from "./raum-logo";
import { SearchIcon } from "./search";
import { ShellIcon } from "./shell";
import { TriangleAlertIcon } from "./triangle-alert";

export {
  ActivityIcon,
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClaudeCodeIcon,
  ClockIcon,
  CodexIcon,
  CompactIcon,
  CopyIcon,
  FolderIcon,
  GitBranchIcon,
  GitMergeIcon,
  GridEqualIcon,
  GridTileIcon,
  HistoryIcon,
  KeyboardIcon,
  LoaderIcon,
  OpenCodeIcon,
  PlayIcon,
  PlusIcon,
  RaumLogo,
  SearchIcon,
  ShellIcon,
  TriangleAlertIcon,
};

export type HarnessIconKind = "shell" | "claude-code" | "codex" | "opencode";

export const HARNESS_ICONS: Record<HarnessIconKind, typeof ClaudeCodeIcon> = {
  shell: ShellIcon,
  "claude-code": ClaudeCodeIcon,
  codex: CodexIcon,
  opencode: OpenCodeIcon,
};
