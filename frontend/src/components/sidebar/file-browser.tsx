/**
 * §9 — per-worktree file browser tab. Lazy directory tree over
 * `worktree_list_dir` (one level per call, modeled on the hydration tree's
 * expand-on-demand pattern but without its selection machinery). Changed
 * files carry the same status letter as the Changes tab, matched from the
 * live `WorktreeStatus.changes` by relative path — so letters update via
 * status pushes even though the tree itself is fetched once per expand.
 *
 * Editable files open in the CodeMirror editor modal; binary files fall back
 * to the OS opener.
 */

import { Component, For, Show, createMemo, createResource, createSignal } from "solid-js";
import { openPath } from "@tauri-apps/plugin-opener";

import { sortDirEntries, type DirEntry } from "../../lib/fileTreeModel";
import { isEditableFile } from "../../lib/fileUtils";
import { FileTypeIcon } from "../../lib/fileTypeIcon";
import { changesByPath } from "../../lib/gitChangeDisplay";
import type { FileChange } from "../../stores/worktreeStore";
import { FolderIcon, LoaderIcon } from "../icons";
import { Scrollable } from "../ui/scrollable";
import { worktreeListDir } from "./git-commands";
import { StatusLetter } from "./status-letter";
import type { FileBrowserProps } from "./types";

export const FileBrowser: Component<FileBrowserProps> = (props) => {
  const badges = createMemo(() => changesByPath(props.status.changes));
  const [root, { refetch }] = createResource(
    () => props.worktree.path,
    (path) => worktreeListDir(path, ""),
  );

  const openEntry = (entry: DirEntry) => {
    const abs = `${props.worktree.path}/${entry.relPath}`;
    if (isEditableFile(entry.name)) {
      props.onOpenEditor(abs);
    } else {
      void openPath(abs).catch((e: unknown) => console.warn("openPath failed", e));
    }
  };

  return (
    <Scrollable axis="y" class="max-h-64">
      <Show
        when={!root.loading}
        fallback={
          <div class="flex items-center gap-1.5 px-1 py-1 font-mono text-[10px] text-foreground-dim">
            <LoaderIcon class="size-3 animate-spin" />
            <span>Loading files…</span>
          </div>
        }
      >
        <Show
          when={!root.error}
          fallback={
            <div class="px-1 py-1 font-mono text-[10px] text-destructive/80">
              <span class="line-clamp-2">{String(root.error)}</span>
              <button
                type="button"
                class="mt-0.5 text-foreground-dim hover:text-foreground"
                onClick={() => void refetch()}
              >
                Retry
              </button>
            </div>
          }
        >
          <Show
            when={(root() ?? []).length > 0}
            fallback={
              <div class="px-1 py-1 font-mono text-[10px] italic text-foreground-dim">
                Empty directory
              </div>
            }
          >
            <ul>
              <For each={sortDirEntries(root() ?? [])}>
                {(entry) => (
                  <TreeNode
                    entry={entry}
                    depth={0}
                    worktreePath={props.worktree.path}
                    badges={badges}
                    onOpenFile={openEntry}
                  />
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>
    </Scrollable>
  );
};

interface TreeNodeProps {
  entry: DirEntry;
  depth: number;
  worktreePath: string;
  badges: () => Map<string, FileChange>;
  onOpenFile: (entry: DirEntry) => void;
}

const TreeNode: Component<TreeNodeProps> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  // Children fetch starts on first expand and is kept afterwards —
  // collapsing/re-expanding doesn't refetch (same once-only semantics as
  // the hydration tree; noted as future work).
  const [loadKey, setLoadKey] = createSignal<string | undefined>(undefined);
  const [children, { refetch }] = createResource(loadKey, (rel) =>
    worktreeListDir(props.worktreePath, rel),
  );

  const indent = () => `${props.depth * 12 + 4}px`;
  const badge = () => props.badges().get(props.entry.relPath);

  const toggle = () => {
    if (!props.entry.isDir) {
      props.onOpenFile(props.entry);
      return;
    }
    const next = !expanded();
    setExpanded(next);
    if (next && loadKey() === undefined) setLoadKey(props.entry.relPath);
  };

  return (
    <li>
      <button
        type="button"
        class="flex w-full items-center gap-1.5 rounded py-0.5 pr-1 text-left hover:bg-hover"
        style={{ "padding-left": indent() }}
        aria-expanded={props.entry.isDir ? expanded() : undefined}
        title={props.entry.relPath}
        onClick={toggle}
      >
        <span class="flex h-4 w-3 shrink-0 items-center justify-center font-mono text-[9px] text-foreground-dim">
          <Show when={props.entry.isDir} fallback={<span aria-hidden> </span>}>
            <span aria-hidden>{expanded() ? "▾" : "▸"}</span>
          </Show>
        </span>
        <Show
          when={props.entry.isDir}
          fallback={<FileTypeIcon name={props.entry.name} class="size-3.5 shrink-0 opacity-75" />}
        >
          <FolderIcon class="size-3.5 shrink-0 text-foreground-dim" />
        </Show>
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {props.entry.name}
        </span>
        <Show when={!props.entry.isDir && badge()}>
          {(change) => <StatusLetter kind={change().kind} />}
        </Show>
      </button>

      <Show when={props.entry.isDir && expanded()}>
        <Show
          when={!children.loading}
          fallback={
            <div
              class="flex items-center gap-1.5 py-0.5 font-mono text-[10px] text-foreground-dim"
              style={{ "padding-left": `${(props.depth + 1) * 12 + 4}px` }}
            >
              <LoaderIcon class="size-3 animate-spin" />
            </div>
          }
        >
          <Show
            when={!children.error}
            fallback={
              <button
                type="button"
                class="py-0.5 font-mono text-[10px] text-destructive/80 hover:text-destructive"
                style={{ "padding-left": `${(props.depth + 1) * 12 + 4}px` }}
                onClick={() => void refetch()}
              >
                Failed to load — retry
              </button>
            }
          >
            <Show
              when={(children() ?? []).length > 0}
              fallback={
                <div
                  class="py-0.5 font-mono text-[10px] italic text-foreground-dim"
                  style={{ "padding-left": `${(props.depth + 1) * 12 + 4}px` }}
                >
                  Empty directory
                </div>
              }
            >
              <ul>
                <For each={sortDirEntries(children() ?? [])}>
                  {(child) => (
                    <TreeNode
                      entry={child}
                      depth={props.depth + 1}
                      worktreePath={props.worktreePath}
                      badges={props.badges}
                      onOpenFile={props.onOpenFile}
                    />
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
      </Show>
    </li>
  );
};
