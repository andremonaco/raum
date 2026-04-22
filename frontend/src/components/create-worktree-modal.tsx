/**
 * §6.6 — Create worktree modal.
 *
 * Inputs: branch name, base branch, optional path-strategy override.
 * Previews (live, via Tauri commands):
 *   • prefixed branch name (derived from branchPrefixMode)
 *   • target path (rendered through previewPathPattern with the chosen strategy)
 *   • hydration manifest (copy + symlink lists)
 *
 * On submit, calls `worktree_create` and clears the `useWorktreeCreate`
 * resource so the caller can refresh its worktree list.
 */

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { cacheWorktreeList, clearWorktreeListCache, type Worktree } from "../stores/worktreeStore";
import { projectStore } from "../stores/projectStore";
import { tildify } from "../lib/pathDisplay";
import { GitBranchIcon } from "./icons";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
} from "./ui/dialog";
import { TextField, TextFieldInput, TextFieldLabel } from "./ui/text-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/**
 * Conventional-Commits-style branch prefixes offered by the "+ prefix"
 * dropdown. Clicking one of these rewrites the current branch input so the
 * prefix sits at the front — replacing any existing known prefix.
 */
const PREFIX_PRESETS = [
  "feat/",
  "fix/",
  "chore/",
  "refactor/",
  "perf/",
  "docs/",
  "test/",
  "style/",
  "build/",
  "ci/",
] as const;

type PathStrategy = "sibling-group" | "nested" | "custom";

const STRATEGY_LABEL: Record<PathStrategy, string> = {
  "sibling-group": "Sibling",
  nested: "Nested",
  custom: "Custom",
};

const STRATEGY_OPTIONS: PathStrategy[] = ["sibling-group", "nested", "custom"];

// Example placeholder text used while the user has typed nothing yet — keeps
// the preview cards at a stable height instead of collapsing to "—".
const EXAMPLE_BRANCH = "feat/example";

function applyPrefix(current: string, prefix: string): string {
  const rest = PREFIX_PRESETS.reduce<string>(
    (acc, p) => (acc.startsWith(p) ? acc.slice(p.length) : acc),
    current.trimStart(),
  );
  return `${prefix}${rest}`;
}

/** Rewrite `full` so the resolved parent directory is replaced by the
 *  literal `{parent-dir}` token. Keeps the target-path preview at a fixed,
 *  recipe-sized width regardless of where the project lives on disk. */
function compactPath(full: string | undefined, rootPath: string | undefined): string {
  if (!full) return "";
  if (!rootPath) return tildify(full);
  // dirname() — strip the trailing path segment (with or without a trailing slash).
  const parentDir = rootPath.replace(/\/+[^/]+\/?$/, "") || "/";
  const prefix = parentDir.endsWith("/") ? parentDir : `${parentDir}/`;
  if (full.startsWith(prefix)) {
    return `{parent-dir}/${full.slice(prefix.length)}`;
  }
  return tildify(full);
}

interface WorktreePathPreview {
  prefixedBranch: string;
  path: string;
  pattern: string;
  branchPrefixMode: "none" | "username" | "custom";
  pathStrategy: PathStrategy;
}

interface WorktreeManifestPreview {
  copy: string[];
  symlink: string[];
  fromRaumToml: boolean;
}

interface WorktreeCreated {
  path: string;
  branch: string;
  copied: number;
  symlinked: number;
  skipped: number;
}

export interface CreateWorktreeModalProps {
  projectSlug: string;
  open: boolean;
  onClose: () => void;
  onCreated?: (created: WorktreeCreated) => void;
}

interface PreviewArgs {
  slug: string;
  branch: string;
  strategy: PathStrategy | null;
}

async function previewPath(args: PreviewArgs): Promise<WorktreePathPreview | null> {
  if (!args.branch.trim()) return null;
  return await invoke<WorktreePathPreview>("worktree_preview_path", {
    projectSlug: args.slug,
    branch: args.branch,
    pathStrategy: args.strategy,
    pathPatternOverride: null,
  });
}

interface WorktreeBranchList {
  branches: string[];
  current: string | null;
}

async function fetchBranches(projectSlug: string): Promise<WorktreeBranchList> {
  return await invoke<WorktreeBranchList>("worktree_branches", { projectSlug });
}

async function previewManifest(projectSlug: string): Promise<WorktreeManifestPreview> {
  return await invoke<WorktreeManifestPreview>("worktree_preview_manifest", {
    projectSlug,
  });
}

interface CreateArgs {
  branch: string;
  baseBranch: string | null;
  strategyOverride: PathStrategy | null;
}

/**
 * Small resource wrapper around `worktree_create`. Returns the last created
 * worktree (if any) and a `create` trigger function.
 */
export function useWorktreeCreate(projectSlug: () => string): {
  create: (args: CreateArgs) => Promise<WorktreeCreated>;
  lastCreated: () => WorktreeCreated | undefined;
  error: () => string | undefined;
  pending: () => boolean;
} {
  const [lastCreated, setLastCreated] = createSignal<WorktreeCreated | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [pending, setPending] = createSignal(false);

  async function create(args: CreateArgs): Promise<WorktreeCreated> {
    setPending(true);
    setError(undefined);
    try {
      const slug = projectSlug();
      const out = await invoke<WorktreeCreated>("worktree_create", {
        projectSlug: slug,
        branch: args.branch,
        options: {
          createBranch: true,
          fromRef: args.baseBranch ?? null,
          baseBranch: args.baseBranch ?? null,
          skipHydration: false,
          pathStrategy: args.strategyOverride,
          pathPatternOverride: null,
        },
      });
      setLastCreated(out);
      clearWorktreeListCache(slug);
      try {
        const items = await invoke<Worktree[]>("worktree_list", {
          projectSlug: slug,
        });
        cacheWorktreeList(slug, items);
      } catch {
        // Non-fatal — caller can retry.
      }
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      throw e;
    } finally {
      setPending(false);
    }
  }

  return { create, lastCreated, error, pending };
}

export const CreateWorktreeModal: Component<CreateWorktreeModalProps> = (props) => {
  const [branch, setBranch] = createSignal("");
  // `null` means "use the project default" (whatever the settings/effective
  // pathStrategy resolves to). Picking a different value here only affects
  // this one creation.
  const [strategyOverride, setStrategyOverride] = createSignal<PathStrategy | null>(null);
  const [baseBranch, setBaseBranch] = createSignal<string | null>(null);
  const projectSlug = createMemo(() => props.projectSlug);

  const rootPath = createMemo(
    () => projectStore.items.find((p) => p.slug === projectSlug())?.rootPath,
  );

  const [branchList] = createResource(
    () => (props.open ? projectSlug() : null),
    async (slug) => {
      if (!slug) return null;
      try {
        return await fetchBranches(slug);
      } catch {
        return null;
      }
    },
  );

  // Default the base branch picker to the project's currently checked-out
  // branch. Runs once the branch list resolves; user picks override it.
  createEffect(() => {
    const list = branchList();
    if (!list) return;
    if (baseBranch() === null && list.current) {
      setBaseBranch(list.current);
    }
  });

  // Fetch a preview to learn the *configured* strategy (used to highlight the
  // segmented control when the user hasn't overridden it). We pass an example
  // branch so this works even before the user has typed anything.
  const [defaultPreview] = createResource(
    () => (props.open ? projectSlug() : null),
    async (slug) => {
      if (!slug) return null;
      try {
        return await previewPath({ slug, branch: EXAMPLE_BRANCH, strategy: null });
      } catch {
        return null;
      }
    },
  );

  const effectiveStrategy = createMemo<PathStrategy>(
    () => strategyOverride() ?? defaultPreview()?.pathStrategy ?? "sibling-group",
  );

  // Live preview that follows the typed branch (or the example placeholder)
  // and the chosen strategy override. We always pass the override so the
  // preview matches what `worktree_create` will actually do.
  const [pathPreview] = createResource(
    () => [props.open, projectSlug(), branch() || EXAMPLE_BRANCH, strategyOverride()] as const,
    async ([open, slug, br, strategy]) => {
      if (!open) return null;
      try {
        return await previewPath({ slug, branch: br, strategy });
      } catch {
        return null;
      }
    },
  );

  const [manifest] = createResource(
    () => (props.open ? projectSlug() : null),
    async (slug) => {
      if (!slug) return null;
      try {
        return await previewManifest(slug);
      } catch {
        return null;
      }
    },
  );

  const creator = useWorktreeCreate(() => projectSlug());

  // True when the user hasn't typed anything yet — drives the "ghost example"
  // styling on the preview cards so they stay the same height as when filled.
  const isPlaceholder = () => !branch().trim();

  async function onSubmit(ev: SubmitEvent) {
    ev.preventDefault();
    if (!branch().trim()) return;
    try {
      const out = await creator.create({
        branch: branch(),
        baseBranch: baseBranch(),
        strategyOverride: strategyOverride(),
      });
      props.onCreated?.(out);
      setBranch("");
      setStrategyOverride(null);
      props.onClose();
    } catch {
      // error() signal already captured the message.
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          setBranch("");
          setStrategyOverride(null);
          setBaseBranch(null);
          props.onClose();
        }
      }}
    >
      <DialogPortal>
        <DialogContent class="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>New worktree</DialogTitle>
          </DialogHeader>

          <form class="space-y-3 text-sm" onSubmit={onSubmit}>
            <TextField value={branch()} onChange={setBranch} required>
              <TextFieldLabel class="text-xs text-muted-foreground">Branch</TextFieldLabel>
              <div class="relative">
                <TextFieldInput type="text" placeholder="feat/my-worktree" autofocus class="pr-8" />
                <DropdownMenu>
                  <DropdownMenuTrigger
                    as="button"
                    type="button"
                    aria-label="Insert branch prefix"
                    title="Insert branch prefix"
                    class="absolute right-1 top-1/2 -translate-y-1/2 flex h-5 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    data-testid="prefix-dropdown"
                  >
                    <svg
                      viewBox="0 0 12 12"
                      class="h-3 w-3"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <polyline points="3,4.5 6,7.5 9,4.5" />
                    </svg>
                  </DropdownMenuTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuContent class="min-w-[140px]">
                      <For each={PREFIX_PRESETS}>
                        {(p) => (
                          <DropdownMenuItem
                            class="font-mono text-xs"
                            onSelect={() => setBranch(applyPrefix(branch(), p))}
                          >
                            {p}
                          </DropdownMenuItem>
                        )}
                      </For>
                    </DropdownMenuContent>
                  </DropdownMenuPortal>
                </DropdownMenu>
              </div>
            </TextField>

            {/* Base branch — defaults to the project's currently checked-out branch */}
            <div class="space-y-1">
              <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
                <GitBranchIcon class="h-3 w-3" />
                <span>Base branch</span>
              </label>
              <DropdownMenu>
                <DropdownMenuTrigger
                  as="button"
                  type="button"
                  class="flex h-8 w-full items-center justify-between rounded-md border border-input bg-background px-2 text-left text-xs font-mono text-foreground transition-colors hover:bg-muted focus:border-ring focus:outline-none"
                  data-testid="base-branch-dropdown"
                >
                  <span class="flex min-w-0 items-center gap-1.5">
                    <GitBranchIcon class="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span class="truncate">{baseBranch() ?? "select branch"}</span>
                  </span>
                  <svg
                    viewBox="0 0 12 12"
                    class="h-3 w-3 shrink-0 text-muted-foreground"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <polyline points="3,4.5 6,7.5 9,4.5" />
                  </svg>
                </DropdownMenuTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuContent class="max-h-64 min-w-[240px] overflow-y-auto">
                    <For each={branchList()?.branches ?? []}>
                      {(b) => (
                        <DropdownMenuItem
                          class="flex items-center gap-1.5 font-mono text-xs"
                          onSelect={() => setBaseBranch(b)}
                        >
                          <GitBranchIcon class="h-3 w-3 text-muted-foreground" />
                          <span class="truncate">{b}</span>
                          <Show when={b === branchList()?.current}>
                            <span class="ml-auto text-[9px] uppercase tracking-wide text-muted-foreground">
                              current
                            </span>
                          </Show>
                        </DropdownMenuItem>
                      )}
                    </For>
                  </DropdownMenuContent>
                </DropdownMenuPortal>
              </DropdownMenu>
              <p class="text-[10px] text-muted-foreground">
                New branch will be created from{" "}
                <span class="inline-flex items-center gap-0.5 font-mono text-foreground">
                  <GitBranchIcon class="h-2.5 w-2.5" />
                  {baseBranch() ?? "—"}
                </span>
                .
              </p>
            </div>

            {/* Path strategy — pre-selected from project settings, override per-creation */}
            <div class="space-y-1">
              <label class="text-xs text-muted-foreground">Path strategy</label>
              <div class="grid grid-cols-3 gap-1" role="radiogroup" aria-label="Path strategy">
                <For each={STRATEGY_OPTIONS}>
                  {(s) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={effectiveStrategy() === s}
                      class="rounded px-2 py-1 text-[11px] transition-colors"
                      classList={{
                        "bg-active text-foreground": effectiveStrategy() === s,
                        "text-muted-foreground hover:bg-active/40": effectiveStrategy() !== s,
                      }}
                      onClick={() => setStrategyOverride(s)}
                      data-testid={`strategy-${s}`}
                    >
                      {STRATEGY_LABEL[s]}
                    </button>
                  )}
                </For>
              </div>
            </div>

            {/* Prefixed branch — fixed height, single line */}
            <div class="min-h-[44px] min-w-0 rounded-md bg-muted p-2 text-xs">
              <div class="text-muted-foreground">Prefixed branch</div>
              <div
                class="min-w-0 truncate font-mono tabular-nums"
                classList={{
                  "text-muted-foreground/60": isPlaceholder(),
                  "text-foreground": !isPlaceholder(),
                }}
                data-testid="preview-branch"
              >
                {pathPreview()?.prefixedBranch ?? branch() ?? EXAMPLE_BRANCH}
              </div>
            </div>

            {/* Target path — fixed height, explainer moved into a (?) tooltip */}
            <div class="min-h-[44px] min-w-0 rounded-md bg-muted p-2 text-xs">
              <div class="mb-1 flex items-center gap-1 text-muted-foreground">
                <span>Target path</span>
                <Show when={pathPreview()?.pattern}>
                  <span
                    class="inline-flex h-3 w-3 cursor-help items-center justify-center rounded-full border border-muted-foreground/40 text-[8px] leading-none text-muted-foreground"
                    title={`Pattern: ${pathPreview()?.pattern}\n\n{parent-dir} = folder containing the project\n{base-folder} = project folder name\n{branch-slug} = your branch name\n\nChange the pattern in Project Settings → Worktree path.`}
                  >
                    ?
                  </span>
                </Show>
              </div>
              <div
                class="min-w-0 truncate font-mono tabular-nums"
                classList={{
                  "text-muted-foreground/60": isPlaceholder(),
                  "text-foreground": !isPlaceholder(),
                }}
                data-testid="preview-path"
              >
                {compactPath(pathPreview()?.path, rootPath()) || "—"}
              </div>
            </div>

            <div class="min-h-[64px] rounded-md bg-muted p-2 text-xs">
              <div class="mb-1 text-muted-foreground">
                <span>Hydration manifest</span>
              </div>
              <Show
                when={(manifest()?.copy?.length ?? 0) + (manifest()?.symlink?.length ?? 0) > 0}
                fallback={
                  <div class="text-muted-foreground/70">No hydration rules configured.</div>
                }
              >
                <Show when={(manifest()?.copy ?? []).length > 0}>
                  <div class="mt-1 text-muted-foreground">Copy:</div>
                  <ul class="ml-4 list-disc font-mono text-foreground">
                    <For each={manifest()?.copy ?? []}>{(entry) => <li>{entry}</li>}</For>
                  </ul>
                </Show>
                <Show when={(manifest()?.symlink ?? []).length > 0}>
                  <div class="mt-1 text-muted-foreground">Symlink:</div>
                  <ul class="ml-4 list-disc font-mono text-foreground">
                    <For each={manifest()?.symlink ?? []}>{(entry) => <li>{entry}</li>}</For>
                  </ul>
                </Show>
              </Show>
            </div>

            <Show when={creator.error()}>
              <Alert variant="destructive" class="text-xs">
                <AlertDescription>{creator.error()}</AlertDescription>
              </Alert>
            </Show>

            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={() => props.onClose()}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={creator.pending() || !branch().trim()}>
                {creator.pending() ? "Creating…" : "Create worktree"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
};

export default CreateWorktreeModal;
