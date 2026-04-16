/**
 * HydrationFileTree — file tree picker for worktree hydration rules.
 *
 * Top-level nodes come from `project_list_gitignored` (git-based, noise-filtered).
 * Expanding any directory lazily calls `project_list_dir` so large gitignored
 * subtrees (node_modules, target, …) are never fully enumerated upfront.
 */

import { Component, For, Show, createResource, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

export interface FileTreeNode {
  name: string;
  /** Project-root-relative path, forward-slashed. */
  path: string;
  isDir: boolean;
  /**
   * Pre-populated children for non-ignored container directories. Empty for
   * gitignored leaf directories — their contents are loaded on first expand.
   */
  children: FileTreeNode[];
}

export type HydrationChoice = "copy" | "symlink" | "none";

// ---- row component ----------------------------------------------------------

interface FileTreeRowProps {
  node: FileTreeNode;
  depth: number;
  slug: string;
  copySet: Set<string>;
  symlinkSet: Set<string>;
  onToggle: (path: string, choice: HydrationChoice) => void;
}

const FileTreeRow: Component<FileTreeRowProps> = (props) => {
  const [expanded, setExpanded] = createSignal(false);

  // Pre-loaded children (non-ignored container dirs already have children).
  // Lazy-loaded children for gitignored dirs that start with children=[].
  const preloaded = props.node.children;

  // `triggerLoad` turns non-null only when the user first expands a dir with
  // no pre-loaded children, which fires the resource fetch exactly once.
  const [triggerLoad, setTriggerLoad] = createSignal<string | null>(null);

  const [lazy] = createResource(triggerLoad, async (relPath) => {
    return await invoke<FileTreeNode[]>("project_list_dir", {
      slug: props.slug,
      relPath,
    });
  });

  // The children to render: pre-loaded takes priority, lazy otherwise.
  const children = (): FileTreeNode[] => {
    if (preloaded.length > 0) return preloaded;
    return lazy() ?? [];
  };

  // Whether there are (or might be) expandable children.
  // Before first load we optimistically show the chevron.
  const hasOrMayHaveChildren = () => {
    if (!props.node.isDir) return false;
    if (preloaded.length > 0) return true;
    if (lazy.loading) return true;
    if (lazy() !== undefined) return (lazy()?.length ?? 0) > 0;
    return true; // not loaded yet — show chevron speculatively
  };

  function toggleExpand() {
    const opening = !expanded();
    setExpanded(opening);
    if (opening && preloaded.length === 0 && triggerLoad() === null) {
      // First expand of a lazy dir — fire the fetch.
      setTriggerLoad(props.node.path);
    }
  }

  const currentChoice = (): HydrationChoice => {
    if (props.copySet.has(props.node.path)) return "copy";
    if (props.symlinkSet.has(props.node.path)) return "symlink";
    return "none";
  };

  function handleToggle(choice: HydrationChoice) {
    props.onToggle(props.node.path, currentChoice() === choice ? "none" : choice);
  }

  const canExpand = () => props.node.isDir && hasOrMayHaveChildren();

  return (
    <>
      <div
        class="group flex select-none items-center gap-1 rounded py-[3px] pr-1 hover:bg-muted/50"
        style={{ "padding-left": `${props.depth * 12 + 4}px` }}
      >
        {/* Clickable left side — chevron, icon, and name all toggle expansion
            for directories. Files fall through to a plain (non-clickable) row. */}
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-1 text-left"
          classList={{
            "cursor-pointer": canExpand(),
            "cursor-default": !canExpand(),
          }}
          onClick={() => {
            if (canExpand()) toggleExpand();
          }}
          disabled={!canExpand()}
          aria-label={
            props.node.isDir
              ? expanded()
                ? `Collapse ${props.node.name}`
                : `Expand ${props.node.name}`
              : props.node.name
          }
        >
          {/* Expand / collapse chevron — shown for all directories */}
          <span
            class="flex h-4 w-4 shrink-0 items-center justify-center text-[10px] text-muted-foreground/80 transition-colors"
            classList={{
              "opacity-0": !hasOrMayHaveChildren(),
              "group-hover:text-foreground": hasOrMayHaveChildren(),
            }}
            aria-hidden="true"
          >
            <Show when={lazy.loading} fallback={expanded() ? "▾" : "▸"}>
              <span class="animate-pulse">·</span>
            </Show>
          </span>

          {/* Icon */}
          <span class="shrink-0 text-muted-foreground" aria-hidden="true">
            <Show
              when={props.node.isDir}
              fallback={
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                >
                  <path d="M9 1H3a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6L9 1Z" />
                  <path d="M9 1v5h5" />
                </svg>
              }
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
              >
                <path d="M1 5a1 1 0 0 1 1-1h4l2 2h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5Z" />
                <Show when={expanded()}>
                  <path d="M1 8h14" />
                </Show>
              </svg>
            </Show>
          </span>

          {/* Name */}
          <span class="min-w-0 flex-1 truncate font-mono text-[11px]">
            {props.node.name}
            <Show when={props.node.isDir}>
              <span class="text-muted-foreground">/</span>
            </Show>
          </span>
        </button>

        {/* Copy / Symlink / — buttons */}
        <div class="flex shrink-0 gap-px">
          <For each={["copy", "symlink", "none"] as HydrationChoice[]}>
            {(choice) => (
              <button
                type="button"
                class="rounded px-1.5 py-0.5 text-[9px] font-medium uppercase transition-colors"
                classList={{
                  "bg-accent text-accent-foreground": currentChoice() === choice,
                  "text-muted-foreground hover:text-foreground": currentChoice() !== choice,
                }}
                onClick={() => handleToggle(choice)}
                aria-label={`${choice} ${props.node.path}`}
              >
                {choice === "none" ? "—" : choice}
              </button>
            )}
          </For>
        </div>
      </div>

      {/* Children (pre-loaded or lazy-loaded) */}
      <Show when={expanded() && (children().length > 0 || lazy.loading)}>
        <Show
          when={!lazy.loading || preloaded.length > 0}
          fallback={
            <div
              class="py-1 text-[10px] text-muted-foreground"
              style={{ "padding-left": `${(props.depth + 1) * 12 + 4}px` }}
            >
              Loading…
            </div>
          }
        >
          <For each={children()}>
            {(child) => (
              <FileTreeRow
                node={child}
                depth={props.depth + 1}
                slug={props.slug}
                copySet={props.copySet}
                symlinkSet={props.symlinkSet}
                onToggle={props.onToggle}
              />
            )}
          </For>
        </Show>
      </Show>
    </>
  );
};

// ---- container component ----------------------------------------------------

export interface HydrationFileTreeProps {
  nodes: FileTreeNode[];
  slug: string;
  copyPaths: string[];
  symlinkPaths: string[];
  onToggle: (path: string, choice: HydrationChoice) => void;
  /** Extra classes forwarded to the container (e.g. "h-full" for sidecar). */
  class?: string;
}

export const HydrationFileTree: Component<HydrationFileTreeProps> = (props) => {
  const copySet = () => new Set(props.copyPaths);
  const symlinkSet = () => new Set(props.symlinkPaths);

  return (
    <div
      class="select-none overflow-y-auto rounded-xl bg-popover py-2 shadow-inner"
      classList={{ "h-full": !!props.class, "max-h-[240px]": !props.class }}
    >
      <Show
        when={props.nodes.length > 0}
        fallback={
          <p class="px-3 py-2 text-[11px] text-muted-foreground">No gitignored files found.</p>
        }
      >
        <For each={props.nodes}>
          {(node) => (
            <FileTreeRow
              node={node}
              depth={0}
              slug={props.slug}
              copySet={copySet()}
              symlinkSet={symlinkSet()}
              onToggle={props.onToggle}
            />
          )}
        </For>
      </Show>
    </div>
  );
};
