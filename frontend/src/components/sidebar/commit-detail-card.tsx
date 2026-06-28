/**
 * §6 — expanded-commit detail body for the History timeline. Renders INSIDE the
 * commit card (which provides the surface-raised background), so it carries no
 * background of its own and deliberately does NOT repeat the subject, author, or
 * hash already shown on the row — only the complementary detail: the absolute
 * timestamp, a diffstat summary ("N files · +X −Y") summed from the fetched
 * `git_commit_files` result, and the changed-file list. Files reuse
 * `FileChangeRow` with click-to-diff in commit mode.
 */

import { Component, For, Show, createMemo } from "solid-js";

import { LoaderIcon } from "../icons";
import { FileChangeRow } from "./file-change-row";
import type { CommitFileChange, CommitInfo } from "./git-commands";
import type { DiffTarget } from "./types";

interface CommitDetailCardProps {
  commit: CommitInfo;
  /** Result of `git_commit_files` for this commit (undefined while pending). */
  files: CommitFileChange[] | undefined;
  loading: boolean;
  error: boolean;
  onOpenDiff: (target: DiffTarget) => void;
}

export const CommitDetailCard: Component<CommitDetailCardProps> = (props) => {
  // Absolute timestamp — full local date + time, complementing the relative
  // form shown on the row.
  const absoluteTime = createMemo(() =>
    new Date(props.commit.timestamp * 1000).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }),
  );

  // Diffstat summed from the fetched file list — no extra backend round-trip.
  const diffstat = createMemo(() => {
    const files = props.files ?? [];
    let insertions = 0;
    let deletions = 0;
    for (const f of files) {
      insertions += f.insertions ?? 0;
      deletions += f.deletions ?? 0;
    }
    return { count: files.length, insertions, deletions };
  });

  return (
    <div class="px-2 pb-1.5">
      {/* Summary line: absolute date + diffstat, separated by a hairline. */}
      <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-border-subtle pt-1.5 font-mono text-[9.5px] text-foreground-dim">
        <span>{absoluteTime()}</span>
        <Show when={!props.loading && !props.error && diffstat().count > 0}>
          <span class="ml-auto tabular-nums">
            {diffstat().count} {diffstat().count === 1 ? "file" : "files"} ·{" "}
            <span class="text-success">+{diffstat().insertions}</span>{" "}
            <span class="text-destructive">−{diffstat().deletions}</span>
          </span>
        </Show>
      </div>

      <Show
        when={!props.loading}
        fallback={
          <div class="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-foreground-dim">
            <LoaderIcon class="size-3 animate-spin" />
            <span>Loading files…</span>
          </div>
        }
      >
        <Show
          when={!props.error}
          fallback={
            <div class="mt-1 font-mono text-[10px] text-destructive/80">
              Failed to load commit files
            </div>
          }
        >
          <ul class="mt-1">
            <For each={props.files ?? []}>
              {(file) => (
                <FileChangeRow
                  path={file.path}
                  origPath={file.origPath}
                  kind={file.kind}
                  insertions={file.insertions}
                  deletions={file.deletions}
                  onOpen={() =>
                    props.onOpenDiff({
                      mode: "commit",
                      file: file.path,
                      hash: props.commit.hash,
                      shortHash: props.commit.shortHash,
                    })
                  }
                />
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  );
};
