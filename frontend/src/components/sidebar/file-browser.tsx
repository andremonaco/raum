/**
 * §9 — per-worktree file browser tab. Lazy directory tree over
 * `worktree_list_dir` (one level per call, modeled on the hydration tree's
 * expand-on-demand pattern but without its selection machinery). Changed
 * files carry the same status letter as the Changes tab, matched from the
 * live `WorktreeStatus.changes` by relative path — so letters update via
 * status pushes even though the tree itself is fetched once per expand.
 *
 * Loaded levels live in one shared cache owned by this component rather than
 * in per-node resources: the ⌘F name filter has to ask "does this directory
 * contain a match?", which a parent can't answer when each child hoards its
 * own resource.
 *
 * Renders FLAT into the worktree tab's single Scrollable (no inner scroll region
 * of its own). Plain file explorer: crisp chevron carets, a right-click context
 * menu with parity to the Changes tab, restrained status-tinted filenames, and
 * an active-file highlight round out the IDE feel.
 *
 * Editable files open in the CodeMirror editor modal; binary files fall back
 * to the OS opener.
 */

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
} from "solid-js";
import { Portal } from "solid-js/web";
import { listen } from "@tauri-apps/api/event";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

import {
  filterTree,
  sortDirEntries,
  type DirEntry,
  type FilterResult,
} from "../../lib/fileTreeModel";
import { isEditableFile } from "../../lib/fileUtils";
import { FileTypeIcon } from "../../lib/fileTypeIcon";
import { STATUS_LETTER, changesByPath } from "../../lib/gitChangeDisplay";
import type { FileChange } from "../../stores/worktreeStore";
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, LoaderIcon, SearchIcon } from "../icons";
import { worktreeListDir } from "./git-commands";
import { RaumLogo } from "./main-branch-picker";
import { StatusLetter } from "./status-letter";
import type { FileBrowserProps } from "./types";

/** One fetched (or in-flight) directory level. */
interface DirState {
  entries?: DirEntry[];
  loading: boolean;
  error?: string;
}

/** Shared per-tree state, threaded through TreeNode so collapse-all can reset
 *  every level in one shot and the filter can be resolved top-down (re-expand
 *  stays instant because fetched levels stay in the cache). */
interface TreeApi {
  dirs: () => ReadonlyMap<string, DirState>;
  loadDir: (relPath: string, force?: boolean) => void;
  expandedDirs: () => Set<string>;
  collapsedDirs: () => Set<string>;
  setDirExpanded: (relPath: string, next: boolean) => void;
  badges: () => Map<string, FileChange>;
  // Accessors (not values) so the api object stays REFERENTIALLY STABLE:
  // reading a reactive prop while building the object would subscribe every
  // `props.api()` call site — i.e. every row's `level()`/`badge()`/`shown()`
  // — to changes only `isActiveFile` cares about.
  worktreePath: () => string;
  activeEditorPath: () => string | null | undefined;
  filtering: () => boolean;
  visible: () => Set<string>;
  autoExpand: () => Set<string>;
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

/** Root directory key used by `worktree_list_dir`. */
const ROOT = "";

/** Payload of `worktree-fs-changed` (see worktree/fs_watcher.rs). */
interface WorktreeFsChanged {
  path: string;
  /** Root-relative dirs whose listings changed; null = refetch all loaded. */
  dirs: string[] | null;
}

export const FileBrowser: Component<FileBrowserProps> = (props) => {
  const badges = createMemo(() => changesByPath(props.status.changes));

  // Shared directory cache: relPath -> level. Replaced (not mutated) on every
  // write so Solid sees the change.
  const [dirs, setDirs] = createSignal<ReadonlyMap<string, DirState>>(new Map());
  const putDir = (relPath: string, state: DirState): void => {
    setDirs((prev) => new Map(prev).set(relPath, state));
  };

  const loadDir = (relPath: string, force = false): void => {
    const current = dirs().get(relPath);
    if (current?.loading || (!force && current?.entries)) return;
    // A silent refresh keeps the old entries on screen (no spinner flash) and,
    // on error, keeps them too — the next status push retries anyway.
    const prevEntries = current?.entries;
    const worktreePath = props.worktree.path;
    // A worktree switch may land while a call is in flight — drop stale results.
    const stale = (): boolean => untrack(() => props.worktree.path) !== worktreePath;
    putDir(relPath, { loading: true, entries: prevEntries });
    void worktreeListDir(worktreePath, relPath)
      .then((entries) => {
        if (stale()) return;
        putDir(relPath, { loading: false, entries: sortDirEntries(entries) });
      })
      .catch((e: unknown) => {
        if (stale()) return;
        if (prevEntries) putDir(relPath, { loading: false, entries: prevEntries });
        else putDir(relPath, { loading: false, error: String(e) });
      });
  };

  const [expandedDirs, setExpandedDirs] = createSignal<Set<string>>(new Set());
  // Directories the user collapsed by hand. Needed because `autoExpand` also
  // forces directories open during a filter: without an explicit override the
  // chevron on an auto-expanded row would be inert.
  const [collapsedDirs, setCollapsedDirs] = createSignal<Set<string>>(new Set());

  const setDirExpanded = (relPath: string, next: boolean): void => {
    const flip = (set: Set<string>, add: boolean): Set<string> => {
      const copy = new Set(set);
      if (add) copy.add(relPath);
      else copy.delete(relPath);
      return copy;
    };
    setExpandedDirs((prev) => flip(prev, next));
    setCollapsedDirs((prev) => flip(prev, !next));
    if (next) loadDir(relPath);
  };

  // Root level — refetched (and everything else dropped) when the worktree changes.
  createEffect(
    on(
      () => props.worktree.path,
      () => {
        setDirs(new Map());
        setExpandedDirs(new Set<string>());
        setCollapsedDirs(new Set<string>());
        loadDir(ROOT, true);
      },
    ),
  );

  // Live refresh: the working-tree watcher (worktree/fs_watcher.rs) emits
  // `worktree-fs-changed` with the dirs whose listings changed — unfiltered
  // except `.git`, so gitignored files (.env, build output) refresh too,
  // Finder-style. Refetch every loaded level named in the payload; `dirs:
  // null` means the burst overflowed the payload cap — refetch all loaded.
  // Refetches are silent (old entries stay up while in flight).
  createEffect(() => {
    const unlisten = listen<WorktreeFsChanged>("worktree-fs-changed", (ev) => {
      if (ev.payload.path !== untrack(() => props.worktree.path)) return;
      const changed = ev.payload.dirs;
      for (const [relPath, state] of untrack(dirs)) {
        if (!state.entries) continue;
        if (changed === null || changed.includes(relPath)) loadDir(relPath, true);
      }
    });
    onCleanup(() => void unlisten.then((f) => f()));
  });

  // ---------------------------------------------------------------------
  // Name filter (⌘F while focus is inside the tree)
  // ---------------------------------------------------------------------

  const [filterOpen, setFilterOpen] = createSignal(false);
  const [filter, setFilter] = createSignal("");
  let filterInput: HTMLInputElement | undefined;
  let rootRef: HTMLDivElement | undefined;

  const filtering = () => filterOpen() && filter().length > 0;

  // `DirState` map → `DirCache` shape, keyed on `dirs()` only — hoisted out of
  // `filtered` so a filter keystroke re-runs the walk but not this conversion
  // (it used to rebuild the Map copy of every loaded level per character).
  const dirCache = createMemo(() => {
    const cache = new Map<string, readonly DirEntry[]>();
    for (const [relPath, state] of dirs()) {
      if (state.entries) cache.set(relPath, state.entries);
    }
    return cache;
  });

  const EMPTY_FILTER: FilterResult = {
    visible: new Set<string>(),
    autoExpand: new Set<string>(),
    fileMatchCount: 0,
  };

  // Entries surviving the filter, the directories to force open, and the
  // name-matched file count — one walk per keystroke. Only fetched levels
  // participate — project-wide search is the spotlight dock's job.
  const filtered = createMemo(() =>
    filtering() ? filterTree(dirCache(), filter()) : EMPTY_FILTER,
  );

  // Files whose NAME matches (see `FilterResult.fileMatchCount`). The count is
  // deliberately collapse-independent: it answers "how many files match the
  // filter", and a subtree the user folded shut still holds its matches.
  const matchCount = () => filtered().fileMatchCount;

  const openFilter = (): void => {
    setFilterOpen(true);
    requestAnimationFrame(() => {
      filterInput?.focus();
      filterInput?.select();
    });
  };
  const closeFilter = (): void => {
    setFilterOpen(false);
    setFilter("");
    // Unmounting the focused input drops `document.activeElement` to <body>,
    // which would make the next ⌘F miss the `.file-browser-root` ancestor
    // check in the spotlight dock and open the global search instead of this
    // tree's filter. Hand focus back to the tree root the user was in.
    rootRef?.focus();
  };

  // A new query means a new auto-expand set; drop the collapses the user made
  // against the previous one so folders don't stay shut for unrelated reasons.
  createEffect(on(filter, () => setCollapsedDirs(new Set<string>()), { defer: true }));

  // The spotlight dock routes ⌘F here when focus sits inside this tree, and
  // dispatches on the matched element so the right worktree tab responds (all
  // of them stay mounted).
  createEffect(() => {
    const el = rootRef;
    if (!el) return;
    const onRequest = (): void => openFilter();
    el.addEventListener("raum:filter-requested", onRequest);
    onCleanup(() => el.removeEventListener("raum:filter-requested", onRequest));
  });

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

  // One stable object for the tree's lifetime — every reactive read lives
  // behind an accessor, so `props.api()` itself never becomes a dependency.
  const treeApi: TreeApi = {
    dirs,
    loadDir,
    expandedDirs,
    collapsedDirs,
    setDirExpanded,
    badges,
    worktreePath: () => props.worktree.path,
    activeEditorPath: () => props.activeEditorPath,
    filtering,
    visible: () => filtered().visible,
    autoExpand: () => filtered().autoExpand,
    onOpenFile: openEntry,
    onContextMenu,
  };
  const api = (): TreeApi => treeApi;

  const root = () => dirs().get(ROOT);
  // No cache entry yet means the first fetch hasn't been dispatched — that's
  // loading, not an empty worktree. (`createResource` reported the same thing
  // synchronously before the cache was hoisted here.)
  const rootLoading = () => {
    const state = root();
    // A silent refresh keeps entries while loading — only spin with nothing to show.
    return state === undefined || (state.loading && !state.entries);
  };

  return (
    <div
      class="file-browser-root flex flex-col pt-1"
      ref={(el) => (rootRef = el)}
      // Focusable so clicking anywhere in the tree (not just a row) counts as
      // "the tree has focus" — that's what routes ⌘F to the filter instead of
      // the spotlight dock.
      tabIndex={-1}
    >
      <Show when={filterOpen()}>
        <div class="mb-1 flex items-center gap-1 rounded border border-border-subtle bg-surface-sunken/50 px-1 py-0.5">
          <SearchIcon class="size-3 shrink-0 text-foreground-dim" />
          <input
            ref={(el) => (filterInput = el)}
            type="text"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeFilter();
              }
            }}
            placeholder="Filter loaded files"
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            aria-label="Filter files"
            class="focus-ring min-w-0 flex-1 rounded-sm bg-transparent px-0.5 py-0.5 font-mono text-[11px] text-foreground placeholder:text-foreground-dim"
          />
          <Show when={filtering()}>
            <span class="select-none px-0.5 font-mono text-[10px] tabular-nums text-foreground-dim">
              {matchCount()}
            </span>
          </Show>
          <button
            type="button"
            class="focus-ring flex size-4 items-center justify-center rounded-sm text-foreground-dim transition-colors hover:bg-hover hover:text-foreground"
            aria-label="Close filter"
            title="Close (Esc)"
            onClick={closeFilter}
          >
            <span aria-hidden="true" class="text-[12px] leading-none">
              &times;
            </span>
          </button>
        </div>
      </Show>

      <Show
        when={!rootLoading()}
        fallback={
          <div class="flex items-center gap-1.5 px-1 py-1 font-mono text-[10px] text-foreground-dim">
            <LoaderIcon class="size-3 animate-spin" />
            <span>Loading files…</span>
          </div>
        }
      >
        <Show
          when={!root()?.error}
          fallback={
            <div class="px-1 py-1 font-mono text-[10px] text-destructive/80">
              <span class="line-clamp-2">{root()?.error}</span>
              <button
                type="button"
                class="mt-0.5 text-foreground-dim hover:text-foreground"
                onClick={() => loadDir(ROOT, true)}
              >
                Retry
              </button>
            </div>
          }
        >
          <Show
            when={(root()?.entries ?? []).length > 0}
            fallback={
              <div class="px-1 py-1 font-mono text-[10px] italic text-foreground-dim">
                Empty directory
              </div>
            }
          >
            <Show
              when={!filtering() || filtered().visible.size > 0}
              fallback={
                <div class="px-1 py-1 font-mono text-[10px] italic text-foreground-dim">
                  No match in loaded folders — expand more, or use ⌘F search.
                </div>
              }
            >
              <ul>
                <For each={root()?.entries ?? []}>
                  {(entry) => <TreeNode entry={entry} depth={0} api={api} />}
                </For>
              </ul>
            </Show>
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
  const level = () => props.api().dirs().get(props.entry.relPath);

  const indent = () => `${props.depth * 12 + 4}px`;
  const badge = () => props.api().badges().get(props.entry.relPath);
  // While filtering, a directory holding a hit opens itself so the hit isn't
  // buried behind a chevron — unless the user has explicitly closed that row,
  // which always wins.
  const expanded = () =>
    props.entry.isDir &&
    !props.api().collapsedDirs().has(props.entry.relPath) &&
    (props.api().expandedDirs().has(props.entry.relPath) ||
      props.api().autoExpand().has(props.entry.relPath));
  const shown = () => !props.api().filtering() || props.api().visible().has(props.entry.relPath);
  const isActiveFile = () => {
    const active = props.api().activeEditorPath();
    return (
      !props.entry.isDir &&
      active != null &&
      `${props.api().worktreePath()}/${props.entry.relPath}` === active
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
    // Toggle against what the row actually SHOWS, not just the user's own
    // expanded set — otherwise clicking an auto-expanded row is a no-op.
    props.api().setDirExpanded(props.entry.relPath, !expanded());
  };

  return (
    <Show when={shown()}>
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
            when={!level()?.loading || level()?.entries}
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
              when={!level()?.error}
              fallback={
                <button
                  type="button"
                  class="py-0.5 font-mono text-[10px] text-destructive/80 hover:text-destructive"
                  style={{ "padding-left": `${(props.depth + 1) * 12 + 4}px` }}
                  onClick={() => props.api().loadDir(props.entry.relPath, true)}
                >
                  Failed to load — retry
                </button>
              }
            >
              <Show
                when={(level()?.entries ?? []).length > 0}
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
                  <For each={level()?.entries ?? []}>
                    {(child) => <TreeNode entry={child} depth={props.depth + 1} api={props.api} />}
                  </For>
                </ul>
              </Show>
            </Show>
          </Show>
        </Show>
      </li>
    </Show>
  );
};
