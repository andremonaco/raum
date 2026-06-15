/**
 * §9 — thin Tauri-command wrappers for git staging actions, commit history,
 * and the worktree file browser, plus the shell-quoting helpers that turn a
 * multi-line commit draft into a `git commit -m '…'` invocation.
 *
 * `shellQuote` and `buildCommitCommand` are exported for unit tests; the
 * sidebar barrel re-exports them from `./components/sidebar` so the test
 * import path stays unchanged.
 */

import { invoke } from "@tauri-apps/api/core";

import type { DirEntry } from "../../lib/fileTreeModel";
import type { FileChangeKind } from "../../stores/worktreeStore";

// ---- Tauri command wrappers -----------------------------------------------

export async function gitStage(worktreePath: string, files: string[]): Promise<void> {
  await invoke<void>("git_stage", { worktreePath, files });
}

export async function gitUnstage(worktreePath: string, files: string[]): Promise<void> {
  await invoke<void>("git_unstage", { worktreePath, files });
}

export async function gitDiscard(worktreePath: string, files: string[]): Promise<void> {
  await invoke<void>("git_discard", { worktreePath, files });
}

export async function gitDiscardAll(worktreePath: string): Promise<void> {
  await invoke<void>("git_discard_all", { worktreePath });
}

// ---- Commit history (read-only) -------------------------------------------

/** One commit row from `git_log`. */
export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  /** Unix epoch seconds. */
  timestamp: number;
  subject: string;
  /** Reachable from HEAD but not from upstream. Always false without an
   *  upstream. */
  unpushed: boolean;
}

/** One changed file of a commit — like `FileChange` minus `staged`. */
export interface CommitFileChange {
  path: string;
  origPath: string | null;
  kind: FileChangeKind;
  insertions: number | null;
  deletions: number | null;
}

export async function gitLog(
  worktreePath: string,
  skip: number,
  limit: number,
): Promise<CommitInfo[]> {
  return invoke<CommitInfo[]>("git_log", { worktreePath, skip, limit });
}

export async function gitCommitFiles(
  worktreePath: string,
  hash: string,
): Promise<CommitFileChange[]> {
  return invoke<CommitFileChange[]>("git_commit_files", { worktreePath, hash });
}

// ---- File browser ----------------------------------------------------------

/** List one directory level of a worktree (lazy tree expansion). Root is
 *  `relPath: ""`. `.git` and OS noise are filtered backend-side. */
export async function worktreeListDir(worktreePath: string, relPath: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("worktree_list_dir", { worktreePath, relPath });
}

/** Wrap a string in POSIX single quotes, escaping embedded single quotes.
 *  Exported for unit tests. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Turn a multi-line commit draft into a `git commit -m 'subject' [-m 'body'...]`
 *  command. Paragraphs are split on blank lines so `subject\n\nbody` renders
 *  correctly in `git log` (first paragraph = subject, rest = body). Returns an
 *  empty string when the draft has no non-blank paragraphs. Exported for tests. */
export function buildCommitCommand(draft: string): string {
  const paragraphs = draft
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return "";
  return ["git", "commit", ...paragraphs.flatMap((p) => ["-m", shellQuote(p)])].join(" ");
}
