/**
 * <TerminalGrid> — BSP split-tree terminal grid with persistent panes.
 *
 * Architecture:
 *   - **Pane layer** — a single flat `<For each={cells}>` keyed on pane id.
 *     Each `<LeafFrame>` is positioned absolutely via percentage coords
 *     derived from the tree projection (`x/y/w/h` on a 10 000-unit grid,
 *     divided by 100 for CSS `%`). Because panes stay at the same DOM
 *     position across any layout mutation, xterm instances persist and tmux
 *     sessions keep streaming. Only `top/left/width/height` changes — like
 *     gridstack did, but with arbitrary asymmetric geometry.
 *   - **Divider layer** — `<DividerLayer>` walks the tree and overlays one
 *     draggable divider between every pair of adjacent siblings at every
 *     split. Coordinates also in percentage-of-root, so the browser layout
 *     engine keeps dividers aligned with panes on window resize.
 *   - **DnD layer** — drop zones + drag ghost rendered above both when a
 *     drag is in flight (driven by `dragState()` in `lib/paneDnD.ts`).
 *
 * Gestures (all drag & drop):
 *   - Drag pane header → 5-zone overlay on the hovered target:
 *       • outer 20% rim on each side → split in that direction
 *       • middle 60% → swap pane contents
 *     Drop near the grid's outer edge (within 24 px) → the whole tree gets
 *     wrapped, so the dragged pane becomes a top-level column/row — this is
 *     how you build the `o/u | i` layout.
 *   - Drag divider between siblings → resize adjacent panes with rAF
 *     throttling; double-click divider → reset to 50/50.
 *   - Double-click pane header → maximize/restore.
 *   - Spawn event → splits the focused pane along its longer axis; nothing
 *     else is disturbed.
 *   - Close pane → collapses the tree; the sibling absorbs freed space.
 */

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import { TerminalPane } from "./terminal-pane";
import { DividerLayer } from "./divider-layer";
import {
  addCellTab,
  cycleFocus,
  focusedPaneId,
  focusPaneByIndex,
  LAYOUT_UNIT,
  layoutRev,
  maximizedPaneId,
  minimizedPaneIds,
  movePaneToEdge,
  movePaneToRootEdge,
  nextCellId,
  nextTabId,
  removeCellTab,
  removePane,
  runtimeLayoutStore,
  setActiveTabId,
  setFocusedPaneId,
  setLastSnippet,
  setTabLabel,
  setTabAutoLabel,
  setTabSessionId,
  splitFocusedOrRoot,
  swapPanes,
  toggleMaximize,
  toggleMinimize,
  type CellKind,
  type CellTab,
  type PaneContent,
  type RuntimeCell,
} from "../stores/runtimeLayoutStore";
import { agentStore } from "../stores/agentStore";
import type { AgentState } from "../stores/agentStore";
import { listCrossProjectHarnessSessions, terminalStore } from "../stores/terminalStore";
import {
  activeWorktreeStore,
  ALL_WORKTREES_SCOPE,
  worktreesByProject,
} from "../stores/worktreeStore";
import { kindDisplayLabel, type AgentKind } from "../lib/agentKind";
import { resolveSpawnWorktree } from "../lib/resolveSpawnWorktree";
import { HARNESS_ICONS } from "./icons";
import { activeProjectSlug, projectBySlug, setActiveProjectSlug } from "../stores/projectStore";
import { timeMemoSettle } from "../lib/perf";
import { projectStore } from "../stores/projectStore";
import {
  getScopedProjection as getScopedProjectionCached,
  prewarmProjectionCache,
  setProjectionCacheMaxSize,
  type ScopedProjection,
} from "../lib/scopedProjection";
import {
  getCrossProjectProjection,
  setCrossProjectProjectionCacheMaxSize,
} from "../lib/crossProjectProjection";
import {
  projectTerminalSurfaces,
  type TerminalSurfaceDescriptor,
} from "../lib/terminalSurfaceProjection";
import { listTerminals } from "../lib/terminalRegistry";
import { crossProjectViewMode, setCrossProjectViewMode } from "./top-row";
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from "./ui/tooltip";

function getScopedProjection(
  rev: number,
  slug: string | undefined,
  scope: import("../stores/worktreeStore").WorktreeScope,
  mainPath: string | undefined,
): ScopedProjection {
  // Scale the cache to a reasonable multiple of the project count so a
  // user juggling 10 projects × 2 worktree scopes doesn't thrash.
  setProjectionCacheMaxSize(Math.max(16, projectStore.items.length * 2));
  return getScopedProjectionCached({
    layoutRev: rev,
    tree: runtimeLayoutStore.tree,
    panes: runtimeLayoutStore.panes,
    slug,
    scope,
    mainPath,
  });
}
import { extractSnippet } from "../lib/terminalSnippet";
import { Dock } from "./dock";
import { beginDrag, dragState, ROOT_TARGET, type DropZone } from "../lib/paneDnD";
import {
  projectToRects,
  removeLeaf,
  splitAtLeaf,
  splitAtRoot,
  swapLeaves,
  type Direction,
  type LayoutNode,
  type Rect,
} from "../lib/layoutTree";
import { resolveDisplayedTabLabel, resolveHarnessAutoLabel } from "../lib/terminalTabLabel";
import { useKeymap } from "../lib/keymapContext";

const KIND_LABELS: Record<string, string> = {
  shell: "Shell",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  empty: "Empty",
};

// ---- TerminalGrid ---------------------------------------------------------

export const TerminalGrid: Component = () => {
  const keymap = useKeymap();
  const [rootEl, setRootEl] = createSignal<HTMLDivElement | null>(null);

  // Main-worktree path for the active project. Used by the scope prune as
  // the fallback bucket for panes that carry no `worktreeId` (pre-change
  // terminals — see `pruneTreeByScope`).
  const activeMainPath = createMemo<string | undefined>(
    () => projectBySlug().get(activeProjectSlug() ?? "")?.rootPath,
  );
  const activeScope = createMemo(
    () => activeWorktreeStore.byProject[activeProjectSlug() ?? ""] ?? ALL_WORKTREES_SCOPE,
  );

  createEffect(() => {
    const projects = projectStore.items;
    if (projects.length === 0) return;
    setProjectionCacheMaxSize(Math.max(16, projects.length * 2));
    prewarmProjectionCache({
      layoutRev: layoutRev(),
      tree: runtimeLayoutStore.tree,
      panes: runtimeLayoutStore.panes,
      projects,
      scopesByProject: activeWorktreeStore.byProject,
    });
  });

  // Pruned tree + rect projection for the active project tab. Both drop
  // every leaf whose pane belongs to a different project or worktree.
  // Results are keyed on the layout revision + scope, so repeat tab
  // switches to the same project are a single map lookup.
  const projection = createMemo<ScopedProjection>(() =>
    getScopedProjection(layoutRev(), activeProjectSlug(), activeScope(), activeMainPath()),
  );
  const activeTree = createMemo<LayoutNode | null>(() => projection().tree);
  const activeRectMap = createMemo<ReadonlyMap<string, Rect>>(() => projection().rects);

  // LIVE-PREVIEW TREE.
  //
  // As the user hovers over a drop zone, replay the would-be mutation
  // *locally* using the same pure tree ops that the commit path uses. Panes
  // then render at their projected positions, so the grid reflows under
  // the cursor and the user sees the final layout before releasing. Nothing
  // touches the real store until pointerup — if the user drifts away from
  // the zone, the preview clears and the real layout is untouched.
  //
  // Mutation replay mirrors onDrop exactly (swap vs. split, root vs. pane).
  // Defined here (above `terminalSurfaces`) so the surface projection memo
  // can route preview rects to non-source surfaces without a forward TDZ.
  const previewTree = createMemo<LayoutNode | null>(() => {
    const s = dragState();
    const base = activeTree();
    if (!s || !s.targetId || !s.zone || !base) return null;
    if (s.sourceId === s.targetId) return null;

    if (s.zone === "center") {
      if (s.targetId === ROOT_TARGET) return null;
      return swapLeaves(base, s.sourceId, s.targetId);
    }

    const direction = zoneToDirection(s.zone);
    if (!direction) return null;
    const removed = removeLeaf(base, s.sourceId);
    if (!removed) return null;
    const newLeaf: LayoutNode = { kind: "leaf", id: s.sourceId };
    return s.targetId === ROOT_TARGET
      ? splitAtRoot(removed, direction, newLeaf)
      : splitAtLeaf(removed, s.targetId, direction, newLeaf);
  });

  // Projected cell geometry keyed by pane id. Both `LeafFrame` (chrome) and
  // `terminalSurfaces` (live PTY) consume this so chrome and surfaces reflow
  // in lockstep during a drag.
  const previewCellMap = createMemo<Map<string, Rect> | null>(() => {
    const pt = previewTree();
    if (!pt) return null;
    const rects = projectToRects(pt, LAYOUT_UNIT);
    return new Map(rects.map((r) => [r.id, r]));
  });

  // Cells that belong to the active tree, preserving store identity so xterm
  // instances stay mounted across `activeTree` recomputes.
  const activeCells = createMemo(() => {
    const map = activeRectMap();
    return runtimeLayoutStore.cells.filter((c) => map.has(c.id));
  });
  timeMemoSettle("project-switch:active", activeCells);

  const visibleCells = createMemo(() => {
    const minimized = minimizedPaneIds();
    return activeCells().filter((c) => !minimized.has(c.id));
  });

  // Maximize is global runtime state but must only affect the active project's
  // view. If the maximized pane isn't in the current project's active cells,
  // treat it as "no maximize" for render purposes — without clearing the
  // signal, so switching back to that project restores the maximized state.
  const effectiveMaximizedPaneId = createMemo<string | null>(() => {
    const id = maximizedPaneId();
    if (!id) return null;
    return activeCells().some((c) => c.id === id) ? id : null;
  });
  const crossProjectMode = createMemo(() => crossProjectViewMode());

  const projectedSessionIds = createMemo<string[]>(() => {
    const mode = crossProjectMode();
    if (mode === null) return [];

    return listCrossProjectHarnessSessions(mode)
      .filter((terminal) => terminal.project_slug !== null)
      .map((terminal) => terminal.session_id);
  });
  timeMemoSettle(() => {
    const mode = crossProjectMode();
    return mode ? `filter-click:${mode}` : "filter-click:inactive";
  }, projectedSessionIds);

  const projectedRectMap = createMemo<ReadonlyMap<string, Rect>>(() => {
    const mode = crossProjectMode();
    if (mode === null) return new Map();
    setCrossProjectProjectionCacheMaxSize(Math.max(16, projectStore.items.length * 4));
    return getCrossProjectProjection({
      mode,
      orderedIds: projectedSessionIds(),
    }).rects;
  });

  const terminalSurfaces = createMemo<TerminalSurfaceDescriptor[]>(() =>
    projectTerminalSurfaces({
      cells: runtimeLayoutStore.cells,
      activeRectMap: activeRectMap(),
      minimizedPaneIds: minimizedPaneIds(),
      crossProjectMode: crossProjectMode(),
      projectedSessionIds: projectedSessionIds(),
      projectedRectMap: projectedRectMap(),
      terminalById: terminalStore.byId,
      focusedPaneId: focusedPaneId(),
      maximizedPaneId: effectiveMaximizedPaneId(),
      // Live drag preview: route sibling cells to their projected rects so
      // their terminals reflow in lockstep with the chrome layer's
      // `previewCellMap`. Source cell stays at committed rect; the
      // `surface-dragging-source` class translates it to follow the cursor.
      previewRectMap: previewCellMap(),
      dragSourceId: dragState()?.sourceId ?? null,
    }),
  );

  type SpawnKind = "shell" | "claude-code" | "codex" | "opencode";
  const [availableKinds] = createResource<SpawnKind[]>(async () => {
    try {
      const report = await invoke<{ harnesses: { kind: SpawnKind; found: boolean }[] }>(
        "harnesses_check",
      );
      const found = report.harnesses.filter((h) => h.found).map((h) => h.kind);
      return ["shell", ...found.filter((k) => k !== "shell")];
    } catch {
      return ["shell", "claude-code", "codex", "opencode"];
    }
  });

  const canSpawnKind = (kind: SpawnKind): boolean => kind === "shell" || !!activeProjectSlug();

  // Pane-scoped hotkeys registered via the keymap provider.
  onMount(() => {
    const unregs: Array<() => void> = [];

    for (let i = 1; i <= 9; i++) {
      const n = i;
      unregs.push(keymap.register(`focus-pane-${n}`, () => focusPaneByIndex(n)));
    }
    unregs.push(keymap.register("cycle-focus-forward", () => cycleFocus("forward")));
    unregs.push(keymap.register("cycle-focus-back", () => cycleFocus("back")));
    unregs.push(
      keymap.register("maximize-pane", () => {
        const id = focusedPaneId();
        if (id) toggleMaximize(id);
      }),
    );
    unregs.push(
      keymap.register("reset-harness", () => {
        const paneId = focusedPaneId();
        if (!paneId) return;
        const pane = runtimeLayoutStore.panes[paneId];
        if (!pane || pane.kind === "empty") return;
        const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
        const oldTabId = activeTab?.id;
        const oldSessionId = activeTab?.sessionId;
        addCellTab(paneId, {
          projectSlug: activeTab?.projectSlug ?? pane.projectSlug,
          worktreeId: activeTab?.worktreeId ?? pane.worktreeId,
        });
        if (oldTabId) removeCellTab(paneId, oldTabId);
        if (oldSessionId) {
          invoke("terminal_kill", { sessionId: oldSessionId }).catch((e: unknown) => {
            console.warn("[reset-harness] terminal_kill failed", e);
          });
        }
      }),
    );
    unregs.push(
      keymap.register("new-tab-same-harness", () => {
        const paneId = focusedPaneId();
        if (!paneId) return;
        const pane = runtimeLayoutStore.panes[paneId];
        if (!pane || pane.kind === "empty") return;
        const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
        addCellTab(paneId, {
          projectSlug: activeTab?.projectSlug ?? pane.projectSlug,
          worktreeId: activeTab?.worktreeId ?? pane.worktreeId,
        });
      }),
    );

    onCleanup(() => {
      for (const fn of unregs) fn();
    });
  });

  onMount(() => {
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === "Escape" && crossProjectViewMode() !== null) {
        ev.preventDefault();
        setCrossProjectViewMode(null);
      }
    }
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // New-terminal spawn: split the focused pane along its longer axis, or
  // seed the tree if empty. Never redistributes the existing layout.
  onMount(() => {
    function onSpawn(ev: Event) {
      const detail = (
        ev as CustomEvent<{
          kind: CellKind;
          projectSlug?: string;
          worktreeId?: string;
        }>
      ).detail;
      if (!detail || !detail.kind || detail.kind === "empty") return;
      if (detail.kind !== "shell" && !detail.projectSlug) return;

      const id = nextCellId();
      const tabId = nextTabId();
      const newPane: PaneContent = {
        id,
        kind: detail.kind,
        tabs: [{ id: tabId }],
        activeTabId: tabId,
        projectSlug: detail.projectSlug,
        worktreeId: detail.worktreeId,
      };
      splitFocusedOrRoot(newPane);
      setFocusedPaneId(id);
    }
    window.addEventListener("raum:spawn-requested", onSpawn);
    onCleanup(() => window.removeEventListener("raum:spawn-requested", onSpawn));
  });

  function focusRegisteredSession(sessionId: string): void {
    requestAnimationFrame(() => {
      const registered = listTerminals().find((terminal) => terminal.sessionId === sessionId);
      registered?.focus();
    });
  }

  function findLayoutOwner(
    sessionId: string,
  ): { cellId: string; tabId: string; projectSlug?: string } | null {
    for (const cell of runtimeLayoutStore.cells) {
      for (const tab of cell.tabs) {
        if (tab.sessionId !== sessionId) continue;
        return {
          cellId: cell.id,
          tabId: tab.id,
          projectSlug: tab.projectSlug ?? cell.projectSlug,
        };
      }
    }
    return null;
  }

  onMount(() => {
    function onTerminalFocusRequested(ev: Event): void {
      const sessionId = (ev as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!sessionId) return;

      const owner = findLayoutOwner(sessionId);
      if (owner) {
        if (owner.projectSlug) setActiveProjectSlug(owner.projectSlug);
        setActiveTabId(owner.cellId, owner.tabId);
        if (minimizedPaneIds().has(owner.cellId)) toggleMinimize(owner.cellId);
        setFocusedPaneId(owner.cellId);
        setCrossProjectViewMode(null);
      }

      focusRegisteredSession(sessionId);
    }

    window.addEventListener("terminal-focus-requested", onTerminalFocusRequested);
    onCleanup(() =>
      window.removeEventListener("terminal-focus-requested", onTerminalFocusRequested),
    );
  });

  function onRestoreFromDock(cellId: string): void {
    toggleMinimize(cellId);
    setFocusedPaneId(cellId);
  }

  // Drive --drag-dx / --drag-dy on the grid root from the drag pointer.
  // The source pane's transform reads these via CSS var inheritance so the
  // pane literally follows the cursor 1:1, with zero Solid re-renders on
  // the pane layer — only the root's inline style changes per pointermove.
  createEffect(() => {
    const s = dragState();
    const root = rootEl();
    if (!root) return;
    if (s) {
      root.style.setProperty("--drag-dx", `${s.pointerX - s.startPointerX}px`);
      root.style.setProperty("--drag-dy", `${s.pointerY - s.startPointerY}px`);
    } else {
      root.style.removeProperty("--drag-dx");
      root.style.removeProperty("--drag-dy");
    }
  });

  // Tree passed to DividerLayer — preview while hovering a zone so dividers
  // reflow with the panes (otherwise they'd be stuck at pre-drag positions
  // while panes animate to projected ones). Falls back to the real tree.
  // (`previewTree` and `previewCellMap` are defined above so the surface
  // projection memo can read them.)
  const renderTree = createMemo<LayoutNode | null>(() => previewTree() ?? activeTree());

  return (
    <div class="flex h-full w-full flex-col">
      {/* The grid canvas fills the entire main region with zero outer
        padding — the chrome (top-row, sidebar, dock) is `bg-background`
        and the canvas is `var(--selected)`, so the colour contrast IS the
        visual separation, no padding moat required. This keeps the gap
        between the top-row buttons and the canvas equal to the top-row's
        own internal slack (≈6 px above buttons, 6 px below = canvas top),
        and matches the canvas's left/right/bottom against sidebar/right
        edge/dock with the same hairline contrast on every side. */}
      <div class="flex-1 min-h-0 overflow-hidden bg-background">
        <div
          class="relative h-full w-full overflow-hidden rounded-xl"
          ref={setRootEl}
          data-dnd-root="true"
        >
          <Show when={crossProjectMode() === null && visibleCells().length === 0}>
            <div
              class="absolute inset-0 z-10 grid h-full w-full gap-px bg-border-subtle"
              style={{
                "grid-template-columns": `repeat(${Math.min(availableKinds()?.length ?? 1, 2)}, 1fr)`,
              }}
            >
              <For each={availableKinds() ?? []}>
                {(kind) => {
                  const Icon = HARNESS_ICONS[kind];
                  const disabled = () => !canSpawnKind(kind);
                  return (
                    <button
                      type="button"
                      class="group flex flex-col items-center justify-center gap-3 bg-surface-sunken text-foreground-dim transition-colors duration-[var(--motion-base)] ease-[var(--motion-ease)] hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-surface-sunken disabled:hover:text-foreground-dim"
                      disabled={disabled()}
                      title={disabled() ? "Add a project before spawning a harness" : undefined}
                      onClick={() => {
                        if (disabled()) return;
                        window.dispatchEvent(
                          new CustomEvent("raum:spawn-requested", {
                            detail: { kind, projectSlug: activeProjectSlug() },
                          }),
                        );
                      }}
                    >
                      <Icon class="size-7 transition-transform group-hover:scale-110" />
                      <span class="text-[11px] uppercase tracking-widest">{KIND_LABELS[kind]}</span>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>

          <Show when={crossProjectMode() !== null && projectedSessionIds().length === 0}>
            <div class="absolute inset-0 grid place-items-center text-sm text-foreground-subtle">
              No matching sessions across your projects.
            </div>
          </Show>

          <TerminalSurfaceLayer surfaces={terminalSurfaces()} />

          <Show when={crossProjectMode() === null}>
            <Show when={activeCells().length > 0}>
              <div class="terminal-chrome-layer absolute inset-0">
                <For each={activeCells()}>
                  {(cell) => {
                    const effective = createMemo<RuntimeCell>(() => {
                      if (dragState()?.sourceId === cell.id) return cell;
                      const preview = previewCellMap()?.get(cell.id);
                      if (preview) {
                        return {
                          ...cell,
                          x: preview.x,
                          y: preview.y,
                          w: preview.w,
                          h: preview.h,
                        };
                      }
                      const active = activeRectMap().get(cell.id);
                      if (!active) return cell;
                      return {
                        ...cell,
                        x: active.x,
                        y: active.y,
                        w: active.w,
                        h: active.h,
                      };
                    });
                    return (
                      <LeafFrame cell={effective()} maximizedPaneId={effectiveMaximizedPaneId()} />
                    );
                  }}
                </For>
              </div>
            </Show>

            {/* Hide dividers while a pane is maximized: there's nothing to
                resize when one pane fills the canvas, and the chrome frame
                renders transparent (only the 28 px header is opaque), so
                the small grip pills would otherwise show through the
                maximized terminal. */}
            <Show when={effectiveMaximizedPaneId() === null}>
              <DividerLayer tree={renderTree()} />
            </Show>
          </Show>

          <Show when={crossProjectMode() !== null && projectedSessionIds().length > 0}>
            <div class="terminal-chrome-layer absolute inset-0">
              <For each={projectedSessionIds()}>
                {(sessionId) => {
                  const rect = createMemo(() => projectedRectMap().get(sessionId) ?? null);
                  return <ProjectedSessionFrame sessionId={sessionId} rect={rect()} />;
                }}
              </For>
            </div>
          </Show>

          {/* No drop-zone or landing overlays. The live reflow of the grid
          under the cursor *is* the feedback; extra overlay layers caused
          continuous repaints on the xterm canvases beneath them. */}
        </div>
      </div>
      <Dock onRestore={onRestoreFromDock} />
    </div>
  );
};

export default TerminalGrid;

// ---- AutoLabelBinder: synthesizes the tab autoLabel ------------------------
//
// Harness panes: react to the backend's live tmux pane/window title stream
// and prefer the richest title the inner CLI publishes. When tmux only
// exposes generic names (for example `node` or a bare version), fall back to
// the existing `kind · project/branch` synthesis from raum-side state.
//
// Shell panes: the inner command/cwd IS the interesting signal, so the global
// shell context poller writes paneContext into terminalStore and this binder
// composes `"Shell · <cwd-basename> · <command>"` from the cached value.
//
// Returns null — the effect is the side effect.

const SHELL_IDLE_COMMANDS = new Set(["zsh", "bash", "fish", "sh", "-zsh", "-bash"]);

interface AutoLabelBinderProps {
  cellId: string;
  tabId: string;
  kind: CellKind;
  projectSlug?: string;
  worktreeId?: string;
  sessionId?: string;
}

const AutoLabelBinder: Component<AutoLabelBinderProps> = (props) => {
  const harnessFallbackLabel = createMemo(() => {
    if (props.kind === "empty") return "Empty";
    if (props.kind === "shell") return kindDisplayLabel("shell");
    const kind = props.kind as AgentKind;
    const slug = props.projectSlug;
    const worktreePath = props.worktreeId;
    const kindPart = kindDisplayLabel(kind);

    let label = kindPart;
    if (slug) {
      const worktrees = worktreesByProject()[slug];
      const wt = worktreePath ? worktrees?.find((w) => w.path === worktreePath) : undefined;
      const branch =
        wt?.branch ?? wt?.baseBranch ?? wt?.upstream?.replace(/^origin\//, "") ?? undefined;
      return branch ? `${kindPart} · ${slug}/${branch}` : `${kindPart} · ${slug}`;
    }

    return label;
  });

  const livePaneContext = createMemo(() =>
    props.sessionId ? terminalStore.byId[props.sessionId]?.paneContext : undefined,
  );

  // Harness-pane branch: react to the live tmux pane/window titles, but keep
  // the raum-side project/branch label as a fallback whenever tmux only
  // exposes generic process names.
  createEffect(() => {
    if (props.kind === "shell" || props.kind === "empty") return;
    const sid = props.sessionId;
    const fallback = harnessFallbackLabel();

    if (!sid) {
      setTabAutoLabel(props.cellId, props.tabId, fallback);
      return;
    }
    const ctx = livePaneContext();
    const label = resolveHarnessAutoLabel({
      kind: props.kind as AgentKind,
      paneTitle: ctx?.paneTitle,
      windowName: ctx?.windowName,
      currentCommand: ctx?.currentCommand,
      fallbackLabel: fallback,
    });
    setTabAutoLabel(props.cellId, props.tabId, label);
  });

  // Shell-pane branch: globally-polled tmux context.
  createEffect(() => {
    if (props.kind !== "shell") return;
    const sid = props.sessionId;
    if (!sid) {
      setTabAutoLabel(props.cellId, props.tabId, kindDisplayLabel("shell"));
      return;
    }

    const ctx = livePaneContext();
    if (!ctx) return;
    const basename = ctx.currentPath ? ctx.currentPath.split("/").pop() || "" : "";
    const cmd = ctx.currentCommand.trim();
    const showCmd = cmd && !SHELL_IDLE_COMMANDS.has(cmd);
    const parts = ["Shell"];
    if (basename) parts.push(basename);
    if (showCmd) parts.push(cmd);
    setTabAutoLabel(props.cellId, props.tabId, parts.join(" · "));
  });

  return null;
};

// ---- TerminalSurfaceLayer: one persistent terminal per tab/session ----------

const TerminalSurfaceLayer: Component<{ surfaces: TerminalSurfaceDescriptor[] }> = (props) => {
  const byKey = createMemo(() => new Map(props.surfaces.map((surface) => [surface.key, surface])));
  const keys = createMemo(() => props.surfaces.map((surface) => surface.key));

  return (
    <div class="terminal-surface-layer absolute inset-0">
      <For each={keys()}>
        {(key) => {
          const surface = createMemo(() => byKey().get(key) ?? null);
          return (
            <Show when={surface()}>{(current) => <TerminalSurfaceHost surface={current()} />}</Show>
          );
        }}
      </For>
    </div>
  );
};

const TerminalSurfaceHost: Component<{ surface: TerminalSurfaceDescriptor }> = (props) => {
  const [lastRect, setLastRect] = createSignal<Rect | null>(null);
  createEffect(() => {
    const rect = props.surface.rect;
    if (rect && rect.w > 0 && rect.h > 0) setLastRect(rect);
  });

  const rect = createMemo(() => props.surface.rect ?? lastRect());
  const visible = createMemo(() => props.surface.visible && rect() !== null);
  // True when this surface owns the pane currently being dragged. The
  // `.surface-dragging-source` CSS rule then translates it with the same
  // `--drag-dx`/`--drag-dy` the chrome uses, so the live terminal rides
  // alongside its chrome card while the rest of the grid reflows underneath.
  const isDragSource = createMemo(
    () => !!props.surface.cellId && props.surface.cellId === dragState()?.sourceId,
  );
  const style = createMemo<Record<string, string>>(() => {
    const r = rect() ?? { id: props.surface.key, x: 0, y: 0, w: LAYOUT_UNIT, h: LAYOUT_UNIT };
    return {
      ...rectStyle(r),
      visibility: visible() ? "visible" : "hidden",
      // Ghost surface must pass pointer events through so destination panes
      // remain hit-testable during the drag.
      "pointer-events": visible() && !isDragSource() ? "auto" : "none",
    };
  });

  function claimFocus(): void {
    const { cellId, tabId } = props.surface;
    if (!cellId) return;
    if (tabId && runtimeLayoutStore.panes[cellId]?.activeTabId !== tabId) {
      setActiveTabId(cellId, tabId);
    }
    setFocusedPaneId(cellId);
  }

  function onSurfaceDoubleClick(e: MouseEvent): void {
    const { cellId } = props.surface;
    if (!cellId) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("input")) return;
    e.stopPropagation();
    e.preventDefault();
    toggleMaximize(cellId);
  }

  async function closeSurface(): Promise<void> {
    const { sessionId, cellId, tabId } = props.surface;
    try {
      if (sessionId) await invoke("terminal_kill", { sessionId });
    } catch (e) {
      console.warn("[TerminalSurfaceHost] terminal_kill on exit failed", e);
    }
    if (cellId && tabId) removeCellTab(cellId, tabId);
  }

  return (
    <div
      class="leaf-frame terminal-surface-frame flex min-h-0 min-w-0 flex-col"
      classList={{
        "pane-maximized": props.surface.maximized,
        "surface-dragging-source": isDragSource(),
      }}
      data-surface-key={props.surface.key}
      data-cell-id={props.surface.cellId}
      data-session-id={props.surface.sessionId ?? ""}
      data-dragging={isDragSource() ? "true" : "false"}
      style={style()}
      onFocusIn={claimFocus}
      onClick={claimFocus}
      onDblClick={onSurfaceDoubleClick}
    >
      <Show when={props.surface.cellId && props.surface.tabId}>
        <AutoLabelBinder
          cellId={props.surface.cellId!}
          tabId={props.surface.tabId!}
          kind={props.surface.kind}
          projectSlug={props.surface.projectSlug}
          worktreeId={props.surface.worktreeId}
          sessionId={props.surface.sessionId}
        />
      </Show>
      <div class="terminal-surface-body">
        <TerminalPane
          surfaceKey={props.surface.key}
          kind={props.surface.kind}
          sessionId={props.surface.sessionId}
          projectSlug={props.surface.projectSlug}
          worktreeId={props.surface.worktreeId}
          borderColor="transparent"
          visible={visible()}
          active={props.surface.active}
          onSpawned={(sessionId) => {
            if (props.surface.cellId && props.surface.tabId) {
              setTabSessionId(props.surface.cellId, props.surface.tabId, sessionId);
            }
          }}
          onRequestClose={() => {
            void closeSurface();
          }}
        />
      </div>
    </div>
  );
};

// ---- LeafFrame: absolute-positioned pane ----------------------------------

const LeafFrame: Component<{ cell: RuntimeCell; maximizedPaneId: string | null }> = (props) => {
  const isMinimized = () => minimizedPaneIds().has(props.cell.id);
  const isMaximized = () => props.maximizedPaneId === props.cell.id;
  const anyMaximized = () => props.maximizedPaneId !== null;
  const isFocused = () => focusedPaneId() === props.cell.id;
  // Sample the source id once and memoize so every pointermove doesn't re-run
  // this for every leaf. Only the source leaf toggles its .pane-dragging class.
  const dragSourceId = createMemo(() => dragState()?.sourceId ?? null);
  const isDragSource = () => dragSourceId() === props.cell.id;

  function onFocusCapture(): void {
    setFocusedPaneId(props.cell.id);
  }

  let cellRef: HTMLDivElement | undefined;

  // Capture-phase dblclick so xterm can't swallow the event for word-selection.
  // Covers both the header (empty space only — tabs own dblclick-to-rename)
  // and the xterm body, so double-clicking anywhere on the pane maximizes it.
  onMount(() => {
    const el = cellRef;
    if (!el) return;
    function handleDblClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".pane-header-tab")) return;
      if (target?.closest(".pane-header-chrome-button")) return;
      if (target?.closest("input")) return;
      e.stopPropagation();
      e.preventDefault();
      toggleMaximize(props.cell.id);
    }
    el.addEventListener("dblclick", handleDblClick, true);
    onCleanup(() => el.removeEventListener("dblclick", handleDblClick, true));
  });

  // CSS-variable positioning. The actual left/top/width/height are derived
  // inside styles.css via `calc(var(--x-pct) + var(--inset))` so the same
  // gutter arithmetic runs for panes, placeholders, and drop zones.
  const style = () => {
    const pct = 100 / LAYOUT_UNIT;
    return {
      "--x-pct": `${props.cell.x * pct}%`,
      "--y-pct": `${props.cell.y * pct}%`,
      "--w-pct": `${props.cell.w * pct}%`,
      "--h-pct": `${props.cell.h * pct}%`,
    };
  };

  return (
    <div
      ref={(el) => {
        cellRef = el;
      }}
      data-dnd-target-pane-id={props.cell.id}
      data-cell-id={props.cell.id}
      class="leaf-frame terminal-chrome-frame flex min-h-0 min-w-0 flex-col"
      classList={{
        "pane-selected": isFocused(),
        "pane-dragging": isDragSource(),
        "pane-maximized": isMaximized(),
        hidden: isMinimized() || (anyMaximized() && !isMaximized()),
      }}
      style={style()}
      onFocusIn={onFocusCapture}
      onClick={onFocusCapture}
    >
      <PaneHeader
        cellId={props.cell.id}
        kind={props.cell.kind}
        title={props.cell.title}
        tabs={props.cell.tabs}
        activeTabId={props.cell.activeTabId}
        isMaximized={isMaximized()}
      />
      <div class="terminal-chrome-body relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <Show
          when={props.cell.kind !== "empty"}
          fallback={
            <div class="grid h-full w-full place-items-center text-xs text-foreground-dim">
              empty
            </div>
          }
        >
          <div class="h-full w-full" />
        </Show>
      </div>
    </div>
  );
};

// ---- PaneHeader: tabs + window chrome + drag source ------------------------

interface PaneHeaderProps {
  cellId: string;
  kind: string;
  title: string | undefined;
  tabs: CellTab[];
  activeTabId: string;
  isMaximized: boolean;
}

const PaneHeader: Component<PaneHeaderProps> = (props) => {
  async function killSession(sessionId: string | undefined) {
    if (!sessionId) return;
    try {
      await invoke("terminal_kill", { sessionId });
    } catch (e) {
      console.warn("[PaneHeader] terminal_kill failed", e);
    }
  }

  async function onCloseTab(ev: MouseEvent, tab: CellTab) {
    ev.stopPropagation();
    await killSession(tab.sessionId);
    removeCellTab(props.cellId, tab.id);
  }

  async function onCloseCell(ev: MouseEvent) {
    ev.stopPropagation();
    for (const tab of props.tabs) await killSession(tab.sessionId);
    removePane(props.cellId);
  }

  function onAddTab(ev: MouseEvent) {
    ev.stopPropagation();
    // Mirror the top-row spawn path: new tabs land in the *current*
    // sidebar-scoped worktree, not the pane's original worktree. Falls back
    // to the pane's stored slug only if no project is active — which
    // shouldn't happen for a visible harness pane.
    const pane = runtimeLayoutStore.panes[props.cellId];
    const slug = activeProjectSlug() ?? pane?.projectSlug;
    const worktreeId = slug ? resolveSpawnWorktree(slug) : pane?.worktreeId;
    addCellTab(props.cellId, { projectSlug: slug, worktreeId });
  }

  function onHeaderPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest(".pane-header-chrome-button")) return;
    if (target?.closest(".pane-header-tab-close")) return;
    if (target?.closest("input")) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const THRESHOLD = 4;

    function onMove(ev: PointerEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (dx * dx + dy * dy < THRESHOLD * THRESHOLD) return;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      const rootEl = document.querySelector<HTMLElement>('[data-dnd-root="true"]');
      if (!rootEl) return;
      // Snapshot the cells so hit-testing uses the stable REAL layout
      // throughout the drag, not the live (animating) DOM bounds. See
      // BeginDragOptions.cells for the rationale — mixing animating rects
      // with the cursor created a target/preview feedback loop. Scope the
      // snapshot to the active project's pruned tree so DnD can't target
      // panes from other tabs that aren't in the DOM.
      const slug = activeProjectSlug();
      const mainPath = projectBySlug().get(slug ?? "")?.rootPath;
      const scope = activeWorktreeStore.byProject[slug ?? ""] ?? ALL_WORKTREES_SCOPE;
      // Reuse the active-projection cache — the pointerdown path reads
      // the same (layoutRev, slug, scope, mainPath) key that the grid's
      // `projection()` memo just populated, so this is a map hit.
      const projected = getScopedProjection(layoutRev(), slug, scope, mainPath);
      const cellsSnapshot = runtimeLayoutStore.cells.flatMap((c) => {
        const r = projected.rects.get(c.id);
        return r ? [{ id: c.id, x: r.x, y: r.y, w: r.w, h: r.h }] : [];
      });
      beginDrag({
        sourceId: props.cellId,
        sourceKind: props.kind,
        sourceLabel: KIND_LABELS[props.kind] ?? props.kind,
        event: ev,
        rootEl,
        cells: cellsSnapshot,
        layoutUnit: LAYOUT_UNIT,
        onDrop: ({ sourceId, targetId, zone }) => {
          if (!targetId || !zone || sourceId === targetId) return;
          if (zone === "center") {
            if (targetId !== ROOT_TARGET) swapPanes(sourceId, targetId);
            return;
          }
          const direction = zoneToDirection(zone);
          if (!direction) return;
          if (targetId === ROOT_TARGET) {
            movePaneToRootEdge(sourceId, direction);
          } else {
            movePaneToEdge(sourceId, targetId, direction);
          }
        },
      });
    }

    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  return (
    <div
      class="pane-drag-handle flex h-8 shrink-0 cursor-grab items-center border-b border-border-subtle active:cursor-grabbing"
      data-testid={`pane-header-${props.cellId}`}
      onPointerDown={onHeaderPointerDown}
    >
      <div class="no-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto pl-1.5">
        <For each={props.tabs}>
          {(tab) => (
            <TabItem
              cellId={props.cellId}
              tab={tab}
              kind={props.kind}
              isActive={tab.id === props.activeTabId}
              showClose={props.tabs.length > 1}
              onClose={(e) => onCloseTab(e, tab)}
            />
          )}
        </For>

        <button
          type="button"
          title="New tab"
          aria-label="New tab"
          class="pane-header-chrome-button ml-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md text-foreground-subtle hover:bg-hover hover:text-foreground"
          onClick={onAddTab}
        >
          <PlusGlyph />
        </button>
      </div>

      <div class="flex shrink-0 items-center gap-1 px-1.5">
        <ChromeButton
          label="Minimize to dock"
          onClick={(e) => {
            e.stopPropagation();
            const activeTab = props.tabs.find((t) => t.id === props.activeTabId);
            const snippet = extractSnippet(activeTab?.sessionId, props.kind as AgentKind);
            setLastSnippet(props.cellId, snippet, Date.now());
            toggleMinimize(props.cellId);
          }}
        >
          <MinusGlyph />
        </ChromeButton>
        <ChromeButton
          label={props.isMaximized ? "Restore" : "Maximize"}
          onClick={(e) => {
            e.stopPropagation();
            toggleMaximize(props.cellId);
          }}
        >
          {props.isMaximized ? <RestoreGlyph /> : <MaximizeGlyph />}
        </ChromeButton>
        <ChromeButton
          label="Close"
          danger
          onClick={(e) => {
            void onCloseCell(e);
          }}
        >
          <CloseGlyph />
        </ChromeButton>
      </div>
    </div>
  );
};

function zoneToDirection(zone: DropZone): Direction | null {
  if (zone === "top" || zone === "bottom" || zone === "left" || zone === "right") return zone;
  return null;
}

// ---- TabItem (unchanged — rename + context menu) --------------------------

const TabItem: Component<{
  cellId: string;
  tab: CellTab;
  kind: string;
  isActive: boolean;
  showClose: boolean;
  onClose: (e: MouseEvent) => void;
}> = (props) => {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuX, setMenuX] = createSignal(0);
  const [menuY, setMenuY] = createSignal(0);
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const tabLabel = () => resolveDisplayedTabLabel(props.tab);

  const tabState = (): AgentState | null =>
    agentStore.sessions[props.tab.sessionId ?? ""]?.state ?? null;

  const [bumping, setBumping] = createSignal(false);
  let prevTabState: AgentState | null = null;
  createEffect(() => {
    const s = tabState();
    const transitioned =
      (s === "waiting" && prevTabState !== "waiting") ||
      (s === "completed" && prevTabState === "working");
    if (transitioned) {
      setBumping(true);
      setTimeout(() => setBumping(false), 400);
    }
    prevTabState = s;
  });

  const harnessAnimating = () => {
    const s = tabState();
    return s === "working" || s === "waiting";
  };

  const HarnessIcon = () => {
    const Icon = HARNESS_ICONS[props.kind as keyof typeof HARNESS_ICONS];
    if (!Icon) return null;
    return <Icon class="h-3 w-3 shrink-0" classList={{ "harness-pulse": harnessAnimating() }} />;
  };

  const lastPromptText = (): string | undefined => {
    const sid = props.tab.sessionId;
    if (!sid) return undefined;
    const text = terminalStore.byId[sid]?.lastPrompt?.text;
    if (!text) return undefined;
    return text;
  };

  // Subtitles render only the first line of multi-line prompts. The
  // `title=` tooltip carries the full text (newlines preserved) so the
  // user can hover for the rest.
  const lastPromptSubtitle = (): string | undefined => {
    const text = lastPromptText();
    if (!text) return undefined;
    const idx = text.indexOf("\n");
    return idx >= 0 ? text.slice(0, idx) : text;
  };

  function openMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenuX(e.clientX);
    setMenuY(e.clientY);
    setMenuOpen(true);
  }

  function startRename() {
    setDraft(props.tab.label ?? props.tab.autoLabel ?? "");
    setEditing(true);
    setMenuOpen(false);
  }

  function commitRename() {
    if (!editing()) return;
    setTabLabel(props.cellId, props.tab.id, draft());
    setEditing(false);
  }

  function cancelRename() {
    setEditing(false);
  }

  return (
    <Tooltip>
      <TooltipTrigger
        as="div"
        class="pane-header-tab group relative flex min-w-[120px] max-w-[300px] grow basis-[180px] cursor-pointer flex-col justify-center rounded-md px-2 text-[10px] uppercase leading-none tracking-wide transition-colors"
        classList={{
          "h-[26px]": !!lastPromptSubtitle(),
          "h-[18px]": !lastPromptSubtitle(),
          "bg-selected text-foreground": props.isActive && tabState() !== "waiting",
          "bg-selected text-warning": props.isActive && tabState() === "waiting",
          "text-foreground-subtle hover:bg-hover hover:text-foreground":
            !props.isActive && tabState() !== "waiting",
          "bg-warning/15 text-warning hover:bg-warning/25":
            !props.isActive && tabState() === "waiting",
          wiggle: bumping(),
        }}
        onClick={(e: MouseEvent) => {
          if (editing()) return;
          e.stopPropagation();
          setActiveTabId(props.cellId, props.tab.id);
        }}
        onContextMenu={openMenu}
        onDblClick={(e: MouseEvent) => {
          e.stopPropagation();
          startRename();
        }}
      >
        <div class="flex min-w-0 items-center gap-1">
          <HarnessIcon />
          <Show when={editing()}>
            <input
              type="text"
              class="h-4 w-28 rounded-sm border border-border bg-background px-1 text-[10px] uppercase tracking-wide text-foreground outline-none focus:border-ring"
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelRename();
                }
              }}
              onBlur={commitRename}
              ref={(el) => {
                queueMicrotask(() => {
                  el.focus();
                  el.select();
                });
              }}
            />
          </Show>
          <Show when={!editing() && tabLabel()}>
            <span class="min-w-0 flex-1 truncate normal-case">{tabLabel()}</span>
          </Show>
          <Show when={props.showClose && !editing()}>
            <button
              type="button"
              aria-label="Close tab"
              class="pane-header-tab-close ml-0.5 hidden shrink-0 rounded-sm p-0.5 hover:bg-hover hover:text-foreground group-hover:flex"
              onClick={(e) => {
                props.onClose(e);
              }}
            >
              <CloseGlyph />
            </button>
          </Show>
        </div>
        <Show when={lastPromptSubtitle()}>
          <div class="mt-px min-w-0 truncate pl-4 text-[9px] font-normal normal-case tracking-normal opacity-85">
            {lastPromptSubtitle()}
          </div>
        </Show>

        <Show when={menuOpen()}>
          <div
            class="floating-surface fixed z-50 w-40 rounded-xl border border-border bg-popover p-1 text-xs normal-case"
            role="menu"
            style={{ left: `${menuX()}px`, top: `${menuY()}px` }}
            onMouseLeave={() => setMenuOpen(false)}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              class="block w-full rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
              onClick={startRename}
            >
              Rename…
            </button>
          </div>
        </Show>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent class="max-w-md">
          <Show when={tabLabel()}>
            <div class="text-[10px] font-medium uppercase tracking-wide">{tabLabel()}</div>
          </Show>
          <Show when={lastPromptText()}>
            <div
              class="whitespace-pre-wrap text-[11px] leading-snug text-popover-foreground/85"
              classList={{ "mt-1": !!tabLabel() }}
            >
              {lastPromptText()}
            </div>
          </Show>
        </TooltipContent>
      </TooltipPortal>
    </Tooltip>
  );
};

// ---- ChromeButton + glyphs ------------------------------------------------

function ChromeButton(props: {
  label: string;
  onClick: (e: MouseEvent) => void;
  children: import("solid-js").JSX.Element;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      class="pane-header-chrome-button flex h-4 w-4 items-center justify-center rounded-sm text-foreground-subtle transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease)]"
      classList={{
        "hover:bg-destructive/15 hover:text-destructive": props.danger === true,
        "hover:bg-hover hover:text-foreground": props.danger !== true,
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function PlusGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      class="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    >
      <line x1="6" y1="2" x2="6" y2="10" />
      <line x1="2" y1="6" x2="10" y2="6" />
    </svg>
  );
}

function MinusGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      class="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    >
      <line x1="2" y1="6" x2="10" y2="6" />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      class="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
    >
      <rect x="2" y="2" width="8" height="8" rx="1" />
    </svg>
  );
}

function RestoreGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      class="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
    >
      <rect x="4" y="2" width="6" height="6" rx="1" />
      <rect x="2" y="4" width="6" height="6" rx="1" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      class="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    >
      <line x1="3" y1="3" x2="9" y2="9" />
      <line x1="9" y1="3" x2="3" y2="9" />
    </svg>
  );
}

// ---- Cross-project projected panes ----------------------------------------

function rectStyle(rect: Rect): Record<string, string> {
  const pct = 100 / LAYOUT_UNIT;
  return {
    "--x-pct": `${rect.x * pct}%`,
    "--y-pct": `${rect.y * pct}%`,
    "--w-pct": `${rect.w * pct}%`,
    "--h-pct": `${rect.h * pct}%`,
  };
}

const ProjectedSessionFrame: Component<{ sessionId: string; rect: Rect | null }> = (props) => {
  const terminal = createMemo(() => terminalStore.byId[props.sessionId]);
  const project = createMemo(() => {
    const slug = terminal()?.project_slug;
    return slug ? projectBySlug().get(slug) : undefined;
  });
  const state = () => agentStore.sessions[props.sessionId]?.state ?? null;
  const HarnessIcon = () => {
    const kind = terminal()?.kind;
    if (!kind) return null;
    const I = HARNESS_ICONS[kind as keyof typeof HARNESS_ICONS];
    if (!I) return null;
    const animating = () => {
      const s = state();
      return s === "working" || s === "waiting";
    };
    return <I class="size-3.5 shrink-0" classList={{ "harness-pulse": animating() }} />;
  };
  const label = createMemo(() => {
    const current = terminal();
    const ctx = current?.paneContext;
    const kind = current?.kind;
    if (!kind || kind === "shell") return kind ? kindDisplayLabel(kind) : "";
    return resolveHarnessAutoLabel({
      kind,
      paneTitle: ctx?.paneTitle,
      windowName: ctx?.windowName,
      currentCommand: ctx?.currentCommand,
      fallbackLabel: kindDisplayLabel(kind),
    });
  });
  const headerStyle = () =>
    ({
      "box-shadow": `inset 0 1px 0 color-mix(in oklab, ${project()?.color ?? "#6b7280"} 26%, transparent)`,
      "background-image": `linear-gradient(180deg, color-mix(in oklab, ${project()?.color ?? "#6b7280"} 7%, transparent) 0%, transparent 100%)`,
    }) as Record<string, string>;
  const projectedSubtitle = (): string | undefined => {
    const text = terminal()?.lastPrompt?.text;
    if (!text) return undefined;
    const idx = text.indexOf("\n");
    return idx >= 0 ? text.slice(0, idx) : text;
  };

  return (
    <Show when={terminal()}>
      {(currentTerminal) => (
        <Show when={props.rect}>
          {(rect) => (
            <div
              class="leaf-frame terminal-chrome-frame flex min-h-0 min-w-0 flex-col"
              data-session-id={props.sessionId}
              data-testid={`projected-session-${props.sessionId}`}
              style={rectStyle(rect())}
              title={currentTerminal().project_slug ?? ""}
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("terminal-focus-requested", {
                    detail: { sessionId: props.sessionId },
                  }),
                );
              }}
            >
              <div
                class="flex h-8 shrink-0 items-center border-b border-border-subtle"
                style={headerStyle()}
              >
                <div class="no-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto pl-1.5">
                  <Tooltip>
                    <TooltipTrigger
                      as="div"
                      class="pane-header-tab relative flex min-w-[120px] max-w-[300px] grow basis-[180px] flex-col justify-center rounded-md px-2 text-[10px] uppercase leading-none tracking-wide text-foreground"
                      classList={{
                        "h-[26px]": !!projectedSubtitle(),
                        "h-[18px]": !projectedSubtitle(),
                      }}
                    >
                      <div class="flex min-w-0 items-center gap-1">
                        <HarnessIcon />
                        <span class="min-w-0 flex-1 truncate normal-case">{label()}</span>
                      </div>
                      <Show when={projectedSubtitle()}>
                        <div class="mt-px min-w-0 truncate pl-[18px] text-[9px] font-normal normal-case tracking-normal opacity-85">
                          {projectedSubtitle()}
                        </div>
                      </Show>
                    </TooltipTrigger>
                    <TooltipPortal>
                      <TooltipContent class="max-w-md">
                        <Show when={label()}>
                          <div class="text-[10px] font-medium uppercase tracking-wide">
                            {label()}
                          </div>
                        </Show>
                        <Show when={terminal()?.lastPrompt?.text}>
                          <div
                            class="whitespace-pre-wrap text-[11px] leading-snug text-popover-foreground/85"
                            classList={{ "mt-1": !!label() }}
                          >
                            {terminal()?.lastPrompt?.text}
                          </div>
                        </Show>
                      </TooltipContent>
                    </TooltipPortal>
                  </Tooltip>
                </div>
              </div>
              <div class="terminal-chrome-body relative min-h-0 min-w-0 flex-1 overflow-hidden" />
            </div>
          )}
        </Show>
      )}
    </Show>
  );
};
