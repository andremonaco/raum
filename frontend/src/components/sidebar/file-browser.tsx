/**
 * §9 — per-worktree file browser tab. Lazy directory tree over
 * `worktree_list_dir` (one level per call, modeled on the hydration tree's
 * expand-on-demand pattern but without its selection machinery). Changed
 * files carry the same status letter as the Changes tab, matched from the
 * live `WorktreeStatus.changes` by relative path — so letters update via
 * status pushes even though the tree itself is fetched once per expand.
 *
 * Renders FLAT into the worktree tab's single Scrollable (no inner scroll region
 * of its own). Plain file explorer: crisp chevron carets, a right-click context
 * menu with parity to the Changes tab, restrained status-tinted filenames, and
 * an active-file highlight round out the IDE feel.
 *
 * Editable files open in the CodeMirror editor modal; binary files fall back
 * to the OS opener.
 */

import { Component, For, Show, createMemo, createResource, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

import { sortDirEntries, type DirEntry } from "../../lib/fileTreeModel";
import { isEditableFile } from "../../lib/fileUtils";
import { FileTypeIcon } from "../../lib/fileTypeIcon";
import { STATUS_LETTER, changesByPath } from "../../lib/gitChangeDisplay";
import type { FileChange } from "../../stores/worktreeStore";
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, LoaderIcon } from "../icons";
import { worktreeListDir } from "./git-commands";
import { RaumLogo } from "./main-branch-picker";
import { StatusLetter } from "./status-letter";
import type { FileBrowserProps } from "./types";

/** Shared per-tree expanded-dir registry + toggle, threaded through TreeNode
 *  so collapse-all can reset every level in one shot (re-expand stays instant
 *  because each node keeps its already-fetched children resource cached). */
interface TreeApi {
  expandedDirs: () => Set<string>;
  toggleDir: (relPath: string) => void;
  badges: () => Map<string, FileChange>;
  worktreePath: string;
  activeEditorPath?: string | null;
  onOpenFile: (entry: DirEntry) => void;
  onContextMenu: (e: MouseEvent, entry: DirEntry) => void;
}

interface MenuState {
  entry: DirEntry;
  /** Set when the entry maps to a tracked change (enables "Open diff"). */
  change?: FileChange;
  x: number;
  y: number;
}

export const FileBrowser: Component<FileBrowserProps> = (props) => {
  const badges = createMemo(() => changesByPath(props.status.changes));
  const [root, { refetch }] = createResource(
    () => props.worktree.path,
    (path) => worktreeListDir(path, ""),
  );

  // Shared expanded-dir state, threaded through TreeNode.
  const [expandedDirs, setExpandedDirs] = createSignal<Set<string>>(new Set());
  const toggleDir = (relPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  };

  // Right-click context menu. Coordinates are viewport-relative (clientX/Y);
  // the menu renders Portalled with `position: fixed` to escape the single
  // Scrollable's overflow clipping.
  const [menu, setMenu] = createSignal<MenuState | null>(null);

  const absOf = (relPath: string) => `${props.worktree.path}/${relPath}`;

  const openEntry = (entry: DirEntry) => {
    const abs = absOf(entry.relPath);
    if (isEditableFile(entry.name)) {
      props.onOpenEditor(abs);
    } else {
      void openPath(abs).catch((e: unknown) => console.warn("openPath failed", e));
    }
  };

  const onContextMenu = (e: MouseEvent, entry: DirEntry) => {
    e.preventDefault();
    setMenu({ entry, change: badges().get(entry.relPath), x: e.clientX, y: e.clientY });
  };

  const openFileNative = (relPath: string) => {
    void openPath(absOf(relPath)).catch((e: unknown) => console.warn("openPath failed", e));
  };
  const revealFile = (relPath: string) => {
    void revealItemInDir(absOf(relPath)).catch((e: unknown) =>
      console.warn("revealItemInDir failed", e),
    );
  };
  const copyPath = (relPath: string) => {
    void navigator.clipboard
      .writeText(absOf(relPath))
      .catch((e: unknown) => console.warn("clipboard.writeText failed", e));
  };
  const copyRelativePath = (relPath: string) => {
    void navigator.clipboard
      .writeText(relPath)
      .catch((e: unknown) => console.warn("clipboard.writeText failed", e));
  };

  const api = (): TreeApi => ({
    expandedDirs,
    toggleDir,
    badges,
    worktreePath: props.worktree.path,
    activeEditorPath: props.activeEditorPath,
    onOpenFile: openEntry,
    onContextMenu,
  });

  return (
    <div class="flex flex-col pt-1">
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
                {(entry) => <TreeNode entry={entry} depth={0} api={api} />}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>

      {/* Right-click context menu. Portalled + fixed-positioned so it escapes
          the single Scrollable's overflow; closes on mouseleave or action. */}
      <Show when={menu()}>
        {(target) => (
          <Portal>
            <div
              class="floating-surface fixed z-[70] w-48 rounded-xl border border-border bg-popover p-1 text-xs"
              role="menu"
              style={{ left: `${target().x}px`, top: `${target().y}px` }}
              onMouseLeave={() => setMenu(null)}
              onClick={(e) => e.stopPropagation()}
            >
              <Show when={!target().entry.isDir}>
                <button
                  type="button"
                  class="block w-full rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    openFileNative(target().entry.relPath);
                    setMenu(null);
                  }}
                >
                  Open file
                </button>
                <button
                  type="button"
                  class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    props.onOpenEditor(absOf(target().entry.relPath));
                    setMenu(null);
                  }}
                >
                  <RaumLogo class="size-3.5 shrink-0 text-foreground" />
                  <span>Open in raum</span>
                </button>
              </Show>
              {/* Open diff — only for tracked entries, and only when the host
                  wired the optional onOpenDiff callback. */}
              <Show when={props.onOpenDiff && target().change}>
                {(change) => (
                  <button
                    type="button"
                    class="block w-full rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                    onClick={() => {
                      props.onOpenDiff?.({
                        mode: "worktree",
                        file: target().entry.relPath,
                        staged: change().staged,
                      });
                      setMenu(null);
                    }}
                  >
                    Open diff
                  </button>
                )}
              </Show>
              <button
                type="button"
                class="block w-full rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  revealFile(target().entry.relPath);
                  setMenu(null);
                }}
              >
                Reveal in Finder
              </button>
              <button
                type="button"
                class="block w-full rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  copyPath(target().entry.relPath);
                  setMenu(null);
                }}
              >
                Copy path
              </button>
              <button
                type="button"
                class="block w-full rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  copyRelativePath(target().entry.relPath);
                  setMenu(null);
                }}
              >
                Copy relative path
              </button>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  );
};

interface TreeNodeProps {
  entry: DirEntry;
  depth: number;
  api: () => TreeApi;
}

const TreeNode: Component<TreeNodeProps> = (props) => {
  // Children fetch starts on first expand and is kept afterwards —
  // collapsing/re-expanding doesn't refetch (same once-only semantics as
  // the hydration tree). Visibility is driven by the shared expanded-dir set
  // so collapse-all can reset every level without touching this resource.
  const [loadKey, setLoadKey] = createSignal<string | undefined>(undefined);
  const [children, { refetch }] = createResource(loadKey, (rel) =>
    worktreeListDir(props.api().worktreePath, rel),
  );

  const indent = () => `${props.depth * 12 + 4}px`;
  const badge = () => props.api().badges().get(props.entry.relPath);
  const expanded = () => props.entry.isDir && props.api().expandedDirs().has(props.entry.relPath);
  const isActiveFile = () => {
    const active = props.api().activeEditorPath;
    return (
      !props.entry.isDir &&
      active != null &&
      `${props.api().worktreePath}/${props.entry.relPath}` === active
    );
  };

  // Restrained status tint on the filename — the muted semantic token only
  // (success/warning/destructive/info), matching the Changes tab's quiet text
  // differentiation. Untracked files keep the neutral muted-foreground.
  const nameClass = () => {
    const change = badge();
    return change ? STATUS_LETTER[change.kind].colorClass : "text-muted-foreground";
  };

  const toggle = () => {
    if (!props.entry.isDir) {
      props.api().onOpenFile(props.entry);
      return;
    }
    const willExpand = !props.api().expandedDirs().has(props.entry.relPath);
    props.api().toggleDir(props.entry.relPath);
    if (willExpand && loadKey() === undefined) setLoadKey(props.entry.relPath);
  };

  return (
    <li>
      <button
        type="button"
        class="flex w-full items-center gap-1.5 rounded py-0.5 pr-1 text-left hover:bg-hover"
        classList={{ "sidebar-row-active": isActiveFile() }}
        style={{ "padding-left": indent() }}
        aria-expanded={props.entry.isDir ? expanded() : undefined}
        title={props.entry.relPath}
        onClick={toggle}
        onContextMenu={(e) => props.api().onContextMenu(e, props.entry)}
      >
        <span class="flex h-4 w-3 shrink-0 items-center justify-center text-foreground-dim">
          <Show when={props.entry.isDir} fallback={<span aria-hidden> </span>}>
            <Show
              when={expanded()}
              fallback={<ChevronRightIcon class="size-3" aria-hidden="true" />}
            >
              <ChevronDownIcon class="size-3" aria-hidden="true" />
            </Show>
          </Show>
        </span>
        <Show
          when={props.entry.isDir}
          fallback={<FileTypeIcon name={props.entry.name} class="size-3.5 shrink-0 opacity-75" />}
        >
          <FolderIcon class="size-3.5 shrink-0 text-foreground-dim" />
        </Show>
        <span class={`min-w-0 flex-1 truncate font-mono text-[11px] ${nameClass()}`}>
          {props.entry.name}
        </span>
        <Show when={!props.entry.isDir && badge()}>
          {(change) => <StatusLetter kind={change().kind} />}
        </Show>
      </button>

      <Show when={expanded()}>
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
                  {(child) => <TreeNode entry={child} depth={props.depth + 1} api={props.api} />}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
      </Show>
    </li>
  );
};
