/**
 * §9 — Left sidebar.
 *
 * Owned by Wave 3C. Starts from Wave 2B's worktree-list skeleton and layers on
 * the full spec:
 *
 *   §9.1 expandable worktree rows + dirty indicator (polls
 *        `worktree_status` every 2 s per worktree).
 *   §9.2 `Open` / `Staged` file groups, clickable via the Tauri
 *        opener plugin (`openPath` — delegates to `open` on macOS,
 *        `xdg-open` on Linux).
 *   §9.3 active-agents sub-section driven by `agentStore`; clicks emit a
 *        `terminal-focus-requested` event the TerminalGrid listens to.
 *   §9.4 preset chooser that reads `layouts_list` (Wave 3D's command),
 *        pre-selects the worktree's last-used pointer (never auto-applies),
 *        and emits `preset-apply-requested` when the user picks one.
 *   §9.5 resize handle persists width into `config.toml.sidebar.width_px`
 *        via `config_set_sidebar_width`; collapse via the `toggle-sidebar`
 *        action from the keymap (listened through a window custom event so
 *        the future §12.4 keymap provider can dispatch us without this
 *        component importing the provider).
 *
 * Stores imported (from Wave 3B / 3D):
 *   • `projectStore` — project list, active slug, colors.
 *   • `worktreeStore` — the existing active-worktree tracking + cache.
 *   • `agentStore` — live harness sessions per worktree.
 *   • `layoutPresetStore` — preset library (hydrated from `layouts_list`).
 *
 * This file intentionally contains every moving part for §9 to keep the
 * Wave-3C diff surface minimal; any future split would live under
 * `components/sidebar/`.
 */

import {
  Component,
  For,
  Show,
  Suspense,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  lazy,
  onCleanup,
  onMount,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { FileTypeIcon } from "../lib/fileTypeIcon";
import {
  activeWorktreeStore,
  setActiveWorktree,
  cacheWorktreeList,
  useBranchesVersion,
  worktreesByProject,
  type Worktree,
} from "../stores/worktreeStore";
import {
  activeProjectSlug,
  projectStore,
  refreshProjects,
  type ProjectListItem,
} from "../stores/projectStore";
import { agentStore, type AgentListItem } from "../stores/agentStore";
import { terminalStore } from "../stores/terminalStore";
import { AlertCircleIcon, CheckIcon, LoaderIcon } from "./icons";
import { CreateWorktreeModal } from "./create-worktree-modal";
const DiffViewerModal = lazy(() =>
  import("./diff-viewer-modal").then((m) => ({ default: m.DiffViewerModal })),
);
import { useKeymapAction } from "../lib/keymapContext";
import { sidebarHidden } from "../lib/sidebarVisibility";

// ---- Tauri command wrappers -----------------------------------------------

interface WorktreeStatus {
  dirty: boolean;
  untracked: string[];
  modified: string[];
  staged: string[];
  insertions: number;
  deletions: number;
}

async function fetchWorktrees(slug: string): Promise<Worktree[]> {
  try {
    const items = await invoke<Worktree[]>("worktree_list", {
      projectSlug: slug,
    });
    cacheWorktreeList(slug, items);
    return items;
  } catch {
    return [];
  }
}

async function fetchStatus(path: string): Promise<WorktreeStatus> {
  try {
    return await invoke<WorktreeStatus>("worktree_status", { path });
  } catch {
    return { dirty: false, untracked: [], modified: [], staged: [], insertions: 0, deletions: 0 };
  }
}

async function gitStage(worktreePath: string, files: string[]): Promise<void> {
  await invoke<void>("git_stage", { worktreePath, files });
}

async function gitUnstage(worktreePath: string, files: string[]): Promise<void> {
  await invoke<void>("git_unstage", { worktreePath, files });
}

// §9.1 — polling cadence. Debounced per-worktree: each expanded row owns its
// own interval so collapsing a row stops its poll immediately.
const STATUS_POLL_MS = 2_000;

// §9.7 — clamp matches the backend (160..800). Duplicated here so the handle
// snaps predictably during the drag without waiting for the invoke round-trip.
const SIDEBAR_MIN_PX = 160;
const SIDEBAR_MAX_PX = 800;
// Wide enough to hold three size-2.5 icons (10 px each) + two gap-0.5 gaps
// (2 px each) + minimal padding on either side = 34 px content + ~10 px room.
const SIDEBAR_COLLAPSED_PX = 44;

// ---- Worktree row ----------------------------------------------------------

interface WorktreeRowProps {
  worktree: Worktree;
  projectSlug: string;
  isActive: boolean;
  projectColor?: string;
  projectSigil?: string;
  /** True when this worktree is the project root (set at project creation). */
  isMain: boolean;
}

/**
 * Expandable worktree row. Shows git state, LOC stats, terminal counts.
 * Expanded section: git staging view (stage/unstage per file + bulk) and agents.
 */
const WorktreeRow: Component<WorktreeRowProps> = (rowProps) => {
  const [expanded, setExpanded] = createSignal(false);
  const [diffTarget, setDiffTarget] = createSignal<{ file: string; staged: boolean } | null>(null);
  const [status, setStatus] = createSignal<WorktreeStatus>({
    dirty: false,
    untracked: [],
    modified: [],
    staged: [],
    insertions: 0,
    deletions: 0,
  });

  let inFlight = false;
  const runPoll = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const s = await fetchStatus(rowProps.worktree.path);
      setStatus(s);
    } finally {
      inFlight = false;
    }
  };

  onMount(() => {
    void runPoll();
    const handle = window.setInterval(() => {
      void runPoll();
    }, STATUS_POLL_MS);
    onCleanup(() => window.clearInterval(handle));
  });

  const agentsForWorktree = createMemo<AgentListItem[]>(() => {
    const path = rowProps.worktree.path;
    return Object.values(agentStore.sessions).filter((a) => {
      // `session_id` carries the originating worktree in raum's naming
      // convention (`raum-<slug>-<worktree-id>-<harness>`), but the
      // authoritative mapping is the terminal store. We fall back to a
      // cheap substring match here because the sidebar only needs a
      // best-effort grouping; the TerminalGrid owns the canonical wiring.
      return a.session_id?.includes(path) === true;
    });
  });

  const dirty = createMemo(() => status().dirty);

  // §8.3 / §9.x — count harnesses attached to *this* worktree. The authoritative
  // wiring lives in terminalStore; `worktree_id` is the worktree's filesystem
  // path (matches `wt.path`).
  const harnessCounts = createMemo(() => {
    const path = rowProps.worktree.path;
    let active = 0;
    let waiting = 0;
    let idle = 0;
    for (const t of Object.values(terminalStore.byId)) {
      if (t.worktree_id !== path) continue;
      if (t.workingState === "working") active++;
      else if (t.workingState === "waiting") waiting++;
      else idle++;
    }
    return { active, waiting, idle };
  });

  const focusAgent = (sessionId: string | null) => {
    if (!sessionId) return;
    window.dispatchEvent(
      new CustomEvent("terminal-focus-requested", {
        detail: { sessionId },
      }),
    );
  };

  const stageFile = async (file: string) => {
    await gitStage(rowProps.worktree.path, [file]);
    void runPoll();
  };

  const unstageFile = async (file: string) => {
    await gitUnstage(rowProps.worktree.path, [file]);
    void runPoll();
  };

  const stageAll = async () => {
    await gitStage(rowProps.worktree.path, ["."]);
    void runPoll();
  };

  const unstageAll = async () => {
    await gitUnstage(rowProps.worktree.path, ["."]);
    void runPoll();
  };

  const openDiff = (file: string, staged: boolean) => {
    setDiffTarget({ file, staged });
  };

  const unstaged = createMemo(() => [...status().untracked, ...status().modified]);

  // Derive a human-readable worktree name from the path (last path component).
  const worktreeName = createMemo(() => {
    const parts = rowProps.worktree.path.split("/");
    return parts[parts.length - 1] ?? rowProps.worktree.path;
  });

  const totalTerminals = createMemo(() => {
    const { active, waiting, idle } = harnessCounts();
    return active + waiting + idle;
  });

  return (
    <li class="select-none">
      {/* ---- Row header — single button: click = expand + set active ---- */}
      <button
        type="button"
        class="flex w-full items-start gap-1.5 rounded px-1.5 py-1.5 text-left hover:bg-zinc-900/80"
        classList={{
          "bg-zinc-900": rowProps.isActive,
        }}
        aria-expanded={expanded()}
        onClick={() => {
          setExpanded((v) => !v);
          setActiveWorktree(rowProps.projectSlug, rowProps.worktree.path);
        }}
      >
        {/* Expand indicator */}
        <span class="mt-0.5 shrink-0 font-mono text-[10px] text-zinc-600" aria-hidden="true">
          {expanded() ? "▾" : "▸"}
        </span>

        {/* 2-line content */}
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Line 1 — worktree name + terminal state badges */}
          <span class="flex w-full items-center justify-between gap-2">
            <span class="flex min-w-0 items-center gap-1.5">
              <Show when={rowProps.projectColor}>
                {(c) => (
                  <span
                    class="inline-flex w-3 shrink-0 select-none items-center justify-center font-mono text-[11px] leading-none tabular-nums"
                    style={{ color: c() }}
                    aria-hidden="true"
                  >
                    {rowProps.projectSigil ?? "·"}
                  </span>
                )}
              </Show>
              <Show when={dirty()}>
                <span
                  class="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                  title="Dirty working tree"
                />
              </Show>
              <span
                class="truncate font-mono text-xs font-medium"
                classList={{
                  "text-zinc-100": rowProps.isActive,
                  "text-zinc-300": !rowProps.isActive,
                }}
              >
                {worktreeName()}
              </span>
              {/* root / wt type badge */}
              <span
                class="shrink-0 rounded border px-1 py-px font-mono text-[9px] uppercase tracking-wider"
                classList={{
                  "border-zinc-600/60 bg-zinc-800/60 text-zinc-400": rowProps.isMain,
                  "border-zinc-700/30 bg-transparent text-zinc-600": !rowProps.isMain,
                }}
              >
                {rowProps.isMain ? "root" : "wt"}
              </span>
            </span>

            {/* Terminal badges — all 3 shown whenever any terminals exist */}
            <Show when={totalTerminals() > 0}>
              <span
                class="flex shrink-0 items-center gap-1 font-mono text-[10px]"
                data-testid="worktree-harness-counts"
              >
                <span
                  class="inline-flex items-center gap-0.5"
                  classList={{
                    "text-emerald-400": harnessCounts().active > 0,
                    "text-zinc-700": harnessCounts().active === 0,
                  }}
                  title={`${harnessCounts().active} active`}
                >
                  <LoaderIcon
                    class="size-2.5"
                    classList={{ "animate-spin": harnessCounts().active > 0 }}
                  />
                  {harnessCounts().active}
                </span>
                <span
                  class="inline-flex items-center gap-0.5"
                  classList={{
                    "text-amber-400": harnessCounts().waiting > 0,
                    "text-zinc-700": harnessCounts().waiting === 0,
                  }}
                  title={`${harnessCounts().waiting} waiting`}
                >
                  <AlertCircleIcon class="size-2.5" />
                  {harnessCounts().waiting}
                </span>
                <span
                  class="inline-flex items-center gap-0.5"
                  classList={{
                    "text-zinc-400": harnessCounts().idle > 0,
                    "text-zinc-700": harnessCounts().idle === 0,
                  }}
                  title={`${harnessCounts().idle} idle`}
                >
                  <CheckIcon class="size-2.5" />
                  {harnessCounts().idle}
                </span>
              </span>
            </Show>
          </span>

          {/* Line 2 — branch name + LOC stats */}
          <span class="flex w-full items-center justify-between gap-2">
            <span class="flex min-w-0 items-center gap-1 font-mono text-[10px] text-zinc-500">
              <span class="text-zinc-600" aria-hidden="true">
                ⎇
              </span>
              <span class="truncate">{rowProps.worktree.branch ?? "(detached)"}</span>
            </span>
            <Show when={status().insertions > 0 || status().deletions > 0}>
              <span class="flex shrink-0 items-center gap-0.5 font-mono text-[10px]">
                <Show when={status().insertions > 0}>
                  <span class="text-emerald-500">+{status().insertions}</span>
                </Show>
                <Show when={status().deletions > 0}>
                  <span class="text-rose-500">-{status().deletions}</span>
                </Show>
              </span>
            </Show>
          </span>
        </span>
      </button>

      <Show when={diffTarget() !== null}>
        <Suspense>
          <DiffViewerModal
            open={true}
            worktreePath={rowProps.worktree.path}
            file={diffTarget()?.file ?? null}
            staged={diffTarget()?.staged ?? false}
            onClose={() => setDiffTarget(null)}
          />
        </Suspense>
      </Show>

      {/* ---- Expanded section ---- */}
      <Show when={expanded()}>
        <div class="ml-5 mt-1 space-y-2 border-l border-zinc-800 pl-2">
          {/* Git staging view */}
          <Show when={unstaged().length > 0 || status().staged.length > 0}>
            <div class="space-y-1.5">
              {/* Unstaged */}
              <Show when={unstaged().length > 0}>
                <div>
                  <div class="mb-0.5 flex items-center justify-between">
                    <span class="text-[10px] uppercase tracking-wide text-zinc-500">Unstaged</span>
                    <button
                      type="button"
                      class="rounded px-1 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                      onClick={() => void stageAll()}
                      title="Stage all"
                    >
                      Stage all
                    </button>
                  </div>
                  <ul>
                    <For each={unstaged()}>
                      {(file) => {
                        const lastSlash = file.lastIndexOf("/");
                        const dir = lastSlash >= 0 ? file.slice(0, lastSlash) : "";
                        const name = lastSlash >= 0 ? file.slice(lastSlash + 1) : file;
                        return (
                          <li class="flex items-center justify-between gap-1 rounded px-1 py-0.5 hover:bg-zinc-900">
                            <button
                              type="button"
                              class="flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-[11px] text-zinc-400 hover:text-zinc-100"
                              title={`View diff: ${file}`}
                              onClick={() => openDiff(file, false)}
                            >
                              <FileTypeIcon name={file} class="size-3.5 shrink-0 opacity-75" />
                              <span class="min-w-0 flex-1 truncate">
                                <span>{name}</span>
                                <Show when={dir !== ""}>
                                  <span class="ml-1.5 text-[10px] text-zinc-600">{dir}</span>
                                </Show>
                              </span>
                            </button>
                            <button
                              type="button"
                              class="shrink-0 rounded px-1 text-[10px] text-emerald-500 hover:bg-zinc-800"
                              onClick={() => void stageFile(file)}
                              title="Stage file"
                            >
                              +
                            </button>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </div>
              </Show>
              {/* Staged */}
              <Show when={status().staged.length > 0}>
                <div>
                  <div class="mb-0.5 flex items-center justify-between">
                    <span class="text-[10px] uppercase tracking-wide text-zinc-500">Staged</span>
                    <button
                      type="button"
                      class="rounded px-1 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                      onClick={() => void unstageAll()}
                      title="Unstage all"
                    >
                      Unstage all
                    </button>
                  </div>
                  <ul>
                    <For each={status().staged}>
                      {(file) => {
                        const lastSlash = file.lastIndexOf("/");
                        const dir = lastSlash >= 0 ? file.slice(0, lastSlash) : "";
                        const name = lastSlash >= 0 ? file.slice(lastSlash + 1) : file;
                        return (
                          <li class="flex items-center justify-between gap-1 rounded px-1 py-0.5 hover:bg-zinc-900">
                            <button
                              type="button"
                              class="flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-[11px] text-zinc-300 hover:text-zinc-100"
                              title={`View diff: ${file}`}
                              onClick={() => openDiff(file, true)}
                            >
                              <FileTypeIcon name={file} class="size-3.5 shrink-0 opacity-75" />
                              <span class="min-w-0 flex-1 truncate">
                                <span>{name}</span>
                                <Show when={dir !== ""}>
                                  <span class="ml-1.5 text-[10px] text-zinc-600">{dir}</span>
                                </Show>
                              </span>
                            </button>
                            <button
                              type="button"
                              class="shrink-0 rounded px-1 text-[10px] text-rose-400 hover:bg-zinc-800"
                              onClick={() => void unstageFile(file)}
                              title="Unstage file"
                            >
                              −
                            </button>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </div>
              </Show>
            </div>
          </Show>
          {/* Agents */}
          <AgentList items={agentsForWorktree()} onFocus={focusAgent} />
        </div>
      </Show>
    </li>
  );
};

interface AgentListProps {
  items: AgentListItem[];
  onFocus: (sessionId: string | null) => void;
}

const AgentList: Component<AgentListProps> = (listProps) => {
  return (
    <Show when={listProps.items.length > 0}>
      <div>
        <div class="text-[10px] uppercase tracking-wide text-zinc-500">Agents</div>
        <ul>
          <For each={listProps.items}>
            {(agent) => (
              <li>
                <button
                  type="button"
                  class="flex w-full items-center justify-between rounded px-1 py-0.5 text-left text-[11px] hover:bg-zinc-900"
                  onClick={() => listProps.onFocus(agent.session_id)}
                >
                  <span class="truncate">{agent.harness}</span>
                  {/* Same icons as the top-right harness counter */}
                  <Show when={agent.state === "working"}>
                    <span class="ml-2 flex shrink-0 items-center text-emerald-400" title="working">
                      <LoaderIcon class="size-3 animate-spin" />
                    </span>
                  </Show>
                  <Show when={agent.state === "waiting"}>
                    <span class="ml-2 flex shrink-0 items-center text-amber-400" title="waiting">
                      <AlertCircleIcon class="size-3" />
                    </span>
                  </Show>
                  <Show when={agent.state === "idle"}>
                    <span class="ml-2 flex shrink-0 items-center text-zinc-500" title="idle">
                      <CheckIcon class="size-3" />
                    </span>
                  </Show>
                  <Show when={agent.state === "completed"}>
                    <span class="ml-2 flex shrink-0 items-center text-sky-400" title="completed">
                      <CheckIcon class="size-3" />
                    </span>
                  </Show>
                  <Show when={agent.state === "errored"}>
                    <span class="ml-2 flex shrink-0 items-center text-red-400" title="errored">
                      <AlertCircleIcon class="size-3" />
                    </span>
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
};

// ---- Project section -------------------------------------------------------

interface ProjectSectionProps {
  project: ProjectListItem;
  worktreeFilter: string;
  /** When true, this section should open the create-worktree modal. */
  createOpen: boolean;
  /** Called when the modal closes or a worktree is created. */
  onCreateClose: () => void;
}

const ProjectSection: Component<ProjectSectionProps> = (sectionProps) => {
  const slug = createMemo(() => sectionProps.project.slug);
  const [worktrees, { refetch }] = createResource(
    () => ({ slug: slug(), v: useBranchesVersion(slug()) }),
    ({ slug: s }) => fetchWorktrees(s),
  );

  const items = createMemo(() => {
    const cached = worktreesByProject()[slug()];
    if (cached) return cached;
    return worktrees() ?? [];
  });

  const filteredItems = createMemo<Worktree[]>(() => {
    const q = sectionProps.worktreeFilter.toLowerCase().trim();
    if (!q) return items();
    return items().filter(
      (wt) =>
        (wt.branch ?? "").toLowerCase().includes(q) ||
        wt.path.split("/").pop()?.toLowerCase().includes(q),
    );
  });

  const activePath = createMemo(() => activeWorktreeStore.byProject[slug()]);

  // Split filtered items into the main worktree (path === project rootPath)
  // and all added worktrees. Main is always rendered first.
  const mainWorktree = createMemo(
    () => filteredItems().find((wt) => wt.path === sectionProps.project.rootPath) ?? null,
  );
  const additionalWorktrees = createMemo(() =>
    filteredItems().filter((wt) => wt.path !== sectionProps.project.rootPath),
  );

  return (
    <section class="mb-2">
      <Show
        when={filteredItems().length > 0}
        fallback={
          <p class="px-2 py-1 text-[11px] text-zinc-600">
            {items().length === 0 ? "No worktrees yet." : "No matching worktrees."}
          </p>
        }
      >
        {/* Card container — groups main + worktrees visually */}
        <div class="overflow-hidden rounded-md border border-zinc-800/60">
          {/* Main worktree — slightly elevated background */}
          <Show when={mainWorktree()}>
            {(main) => (
              <div class="bg-zinc-900/30">
                <ul>
                  <WorktreeRow
                    worktree={main()}
                    projectSlug={slug()}
                    isActive={activePath() === main().path}
                    projectColor={sectionProps.project.color}
                    projectSigil={sectionProps.project.sigil}
                    isMain={true}
                  />
                </ul>
              </div>
            )}
          </Show>

          {/* Divider between main and added worktrees */}
          <Show when={mainWorktree() !== null && additionalWorktrees().length > 0}>
            <div class="h-px bg-zinc-800/60" aria-hidden="true" />
          </Show>

          {/* Added worktrees */}
          <Show when={additionalWorktrees().length > 0}>
            <ul class="space-y-0.5 py-0.5">
              <For each={additionalWorktrees()}>
                {(wt) => (
                  <WorktreeRow
                    worktree={wt}
                    projectSlug={slug()}
                    isActive={activePath() === wt.path}
                    projectColor={sectionProps.project.color}
                    projectSigil={sectionProps.project.sigil}
                    isMain={false}
                  />
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
      <CreateWorktreeModal
        projectSlug={slug()}
        open={sectionProps.createOpen}
        onClose={sectionProps.onCreateClose}
        onCreated={() => {
          sectionProps.onCreateClose();
          void refetch();
        }}
      />
    </section>
  );
};

// ---- Resize handle (§9.7) --------------------------------------------------

interface ResizeHandleProps {
  onChange: (width: number) => void;
  onCommit: (width: number) => void;
  onDragChange: (active: boolean) => void;
  getWidth: () => number;
}

/**
 * Drag the right edge to resize. Pointer-move samples are coalesced via
 * `requestAnimationFrame` so we only push one width into the Solid signal per
 * frame, and the backend `config_set_sidebar_width` invoke is fired exactly
 * once on drag-end (via `onCommit`).
 */
const ResizeHandle: Component<ResizeHandleProps> = (handleProps) => {
  const onPointerDown = (ev: PointerEvent) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = handleProps.getWidth();
    let pending = startWidth;
    let rafId: number | null = null;

    const flush = () => {
      rafId = null;
      handleProps.onChange(pending);
    };

    const onMove = (move: PointerEvent) => {
      pending = Math.max(
        SIDEBAR_MIN_PX,
        Math.min(SIDEBAR_MAX_PX, startWidth + (move.clientX - startX)),
      );
      if (rafId === null) rafId = requestAnimationFrame(flush);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      handleProps.onChange(pending);
      handleProps.onDragChange(false);
      handleProps.onCommit(pending);
    };
    handleProps.onDragChange(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      class="absolute inset-y-0 -right-1 w-2 cursor-col-resize hover:bg-zinc-700/40"
      onPointerDown={onPointerDown}
    />
  );
};

// ---- Sidebar root ----------------------------------------------------------

export const Sidebar: Component = () => {
  const [width, setWidth] = createSignal(280);
  const [collapsed, setCollapsed] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [worktreeFilter, setWorktreeFilter] = createSignal("");
  // Tracks which project slug has its create-worktree modal open (null = closed).
  const [createModalSlug, setCreateModalSlug] = createSignal<string | null>(null);
  // Track the last value we persisted so the drag-end commit doesn't echo
  // the value we just loaded from disk back through `config_set_sidebar_width`.
  // Initialised to `undefined` so the first persisted width always gets
  // skipped (we never write on hydrate, only on user-driven changes).
  let lastPersisted: number | undefined;

  // Hydrate the persisted width + collapsed flag from `config.toml`. Falls
  // back to defaults when Tauri is absent (unit tests).
  onMount(() => {
    void (async () => {
      try {
        const cfg = await invoke<{
          sidebar: { widthPx?: number; width_px?: number; collapsed?: boolean };
        }>("config_get");
        const raw = cfg.sidebar?.widthPx ?? cfg.sidebar?.width_px;
        if (typeof raw === "number" && raw > 0) {
          lastPersisted = raw;
          setWidth(raw);
        } else {
          lastPersisted = width();
        }
        if (cfg.sidebar?.collapsed === true) setCollapsed(true);
      } catch {
        // Tauri unavailable — defaults are fine, seed `lastPersisted` from
        // the default signal so the first drag still triggers a write.
        lastPersisted = width();
      }
    })();
    // Hydrate projects on first mount.
    void refreshProjects();
  });

  // §9.7 — register the `toggle-sidebar` keymap action. `useKeymapAction`
  // plugs into the Wave-3F provider (§12.4), which normalises the accelerator
  // from `~/.config/raum/keybindings.toml` and dispatches us on match.
  // Rendered outside the provider (e.g. in unit tests), `useKeymap` returns
  // a no-op API so this is a safe call.
  useKeymapAction("toggle-sidebar", () => setCollapsed((v) => !v));

  // Persist width back to `config.toml` exactly once per drag (on pointer-up
  // via `ResizeHandle.onCommit`). Skip any write that would echo the value we
  // just hydrated from disk, or repeat the last-persisted value.
  const commitWidth = (px: number) => {
    if (lastPersisted === undefined || lastPersisted === px) return;
    lastPersisted = px;
    void invoke<number>("config_set_sidebar_width", { width: px }).catch(() => {
      /* log-only */
    });
  };

  // Fetch worktrees for all projects when collapsed so the mini-view has data.
  // When expanded, each ProjectSection mounts and fetches its own worktrees.
  // When collapsed, ProjectSection is not mounted, so we do it here.
  createEffect(() => {
    if (!collapsed()) return;
    for (const p of projectStore.items) {
      void fetchWorktrees(p.slug);
    }
  });

  const renderedWidth = createMemo(() => (collapsed() ? SIDEBAR_COLLAPSED_PX : width()));

  return (
    <Show when={!sidebarHidden()}>
      <aside
        class={`relative flex shrink-0 flex-col overflow-hidden border-r border-zinc-800 text-xs text-zinc-400${
          dragging() ? "" : " transition-[width] duration-100"
        }`}
        style={{ width: `${renderedWidth()}px` }}
      >
        {/* ---- Collapsed mini-view ------------------------------------------------ */}
        {/* Shows the same three-icon status counter as the top-right harness     */}
        {/* widget, scoped per worktree. Icons are coloured when count > 0 and    */}
        {/* dimmed to zinc-700 when 0 — identical semantics to the global widget  */}
        {/* so users build one visual vocabulary across the whole UI.             */}
        <Show when={collapsed()}>
          <div class="flex flex-col overflow-y-auto py-1">
            <For each={projectStore.items}>
              {(project, projectIdx) => {
                const wts = createMemo(() => worktreesByProject()[project.slug] ?? []);
                return (
                  <>
                    <Show when={projectIdx() > 0 && wts().length > 0}>
                      {/* Thin project separator line in the project's colour */}
                      <div
                        class="mx-auto my-1 h-px w-6 rounded-full opacity-30"
                        style={{ background: project.color }}
                        aria-hidden="true"
                      />
                    </Show>
                    <For each={wts()}>
                      {(wt) => {
                        const counts = createMemo(() => {
                          let active = 0;
                          let waiting = 0;
                          let idle = 0;
                          for (const t of Object.values(terminalStore.byId)) {
                            if (t.worktree_id !== wt.path) continue;
                            if (t.workingState === "working") active++;
                            else if (t.workingState === "waiting") waiting++;
                            else idle++;
                          }
                          return { active, waiting, idle };
                        });

                        const isActiveWt = createMemo(
                          () => activeWorktreeStore.byProject[project.slug] === wt.path,
                        );

                        const wtName = createMemo(() => {
                          const parts = wt.path.split("/");
                          return parts[parts.length - 1] ?? wt.path;
                        });

                        return (
                          <button
                            type="button"
                            class="flex w-full items-center justify-center gap-0.5 rounded px-0.5 py-1.5 hover:bg-zinc-800"
                            classList={{ "bg-zinc-900": isActiveWt() }}
                            title={`${wtName()} — ${counts().active} active · ${counts().waiting} waiting · ${counts().idle} idle`}
                            onClick={() => setActiveWorktree(project.slug, wt.path)}
                          >
                            {/* Active — spinning loader, emerald when > 0 */}
                            <span
                              class="flex items-center"
                              classList={{
                                "text-emerald-400": counts().active > 0,
                                "text-zinc-700": counts().active === 0,
                              }}
                            >
                              <LoaderIcon
                                class="size-2.5"
                                classList={{ "animate-spin": counts().active > 0 }}
                              />
                            </span>
                            {/* Waiting — alert circle, amber when > 0 */}
                            <span
                              class="flex items-center"
                              classList={{
                                "text-amber-400": counts().waiting > 0,
                                "text-zinc-700": counts().waiting === 0,
                              }}
                            >
                              <AlertCircleIcon class="size-2.5" />
                            </span>
                            {/* Idle — check, zinc when > 0 */}
                            <span
                              class="flex items-center"
                              classList={{
                                "text-zinc-400": counts().idle > 0,
                                "text-zinc-700": counts().idle === 0,
                              }}
                            >
                              <CheckIcon class="size-2.5" />
                            </span>
                          </button>
                        );
                      }}
                    </For>
                  </>
                );
              }}
            </For>
          </div>
        </Show>

        <Show when={!collapsed()}>
          {/* Search + add row */}
          <div class="flex shrink-0 items-center gap-1 border-b border-zinc-800 px-2 py-2">
            <input
              type="search"
              class="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-100 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
              placeholder="Filter worktrees…"
              value={worktreeFilter()}
              onInput={(e) => setWorktreeFilter(e.currentTarget.value)}
              aria-label="Filter worktrees"
            />
            <button
              type="button"
              class="shrink-0 rounded px-1.5 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
              title={activeProjectSlug() ? "New worktree" : "Select a project first"}
              disabled={!activeProjectSlug()}
              onClick={() => setCreateModalSlug(activeProjectSlug() ?? null)}
            >
              +
            </button>
          </div>
          <div class="flex-1 overflow-y-auto p-2">
            <Show
              when={projectStore.items.length > 0}
              fallback={<p class="px-2 text-zinc-600">No projects registered yet.</p>}
            >
              <For each={projectStore.items}>
                {(project) => (
                  <ProjectSection
                    project={project}
                    worktreeFilter={worktreeFilter()}
                    createOpen={createModalSlug() === project.slug}
                    onCreateClose={() => setCreateModalSlug(null)}
                  />
                )}
              </For>
            </Show>
          </div>
          <ResizeHandle
            getWidth={() => width()}
            onChange={(next) => setWidth(next)}
            onCommit={commitWidth}
            onDragChange={setDragging}
          />
        </Show>
      </aside>
    </Show>
  );
};

export default Sidebar;
