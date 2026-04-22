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
  createDeferred,
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
import {
  harnessIds,
  lastOutputBySession,
  terminalStore,
  waitingIds,
  workingIds,
} from "../stores/terminalStore";
import {
  activeWorktreeStore,
  ALL_WORKTREES_SCOPE,
  worktreesByProject,
} from "../stores/worktreeStore";
import { kindDisplayLabel, type AgentKind } from "../lib/agentKind";
import { resolveSpawnWorktree } from "../lib/resolveSpawnWorktree";
import { AlertCircleIcon, CheckIcon, ClockIcon, HARNESS_ICONS, LoaderIcon } from "./icons";
import { activeProjectSlug, projectBySlug, setActiveProjectSlug } from "../stores/projectStore";
import { timeMemoSettle } from "../lib/perf";
import { projectStore } from "../stores/projectStore";
import {
  getScopedProjection as getScopedProjectionCached,
  setProjectionCacheMaxSize,
  type ScopedProjection,
} from "../lib/scopedProjection";

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
import { crossProjectViewMode, setCrossProjectViewMode } from "./top-row";
import type { CrossProjectViewMode } from "./top-row";
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

const KIND_LABELS: Record<string, string> = {
  shell: "Shell",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  empty: "Empty",
};

// ---- TerminalGrid ---------------------------------------------------------

export const TerminalGrid: Component = () => {
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

  // Pruned tree + rect projection for the active project tab. Both drop
  // every leaf whose pane belongs to a different project or worktree.
  // Results are keyed on the layout revision + scope, so repeat tab
  // switches to the same project are a single map lookup.
  const projection = createMemo<ScopedProjection>(() =>
    getScopedProjection(layoutRev(), activeProjectSlug(), activeScope(), activeMainPath()),
  );
  const activeTree = createMemo<LayoutNode | null>(() => projection().tree);
  const activeRectMap = createMemo<ReadonlyMap<string, Rect>>(() => projection().rects);

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

  // Focus / cycle / maximize hotkeys dispatched by the keymap provider.
  onMount(() => {
    function onAction(ev: Event) {
      const action = (ev as CustomEvent<string>).detail;
      if (typeof action !== "string") return;
      if (action.startsWith("focus-pane-")) {
        const n = Number.parseInt(action.slice("focus-pane-".length), 10);
        if (Number.isFinite(n) && n >= 1 && n <= 9) focusPaneByIndex(n);
      } else if (action === "cycle-focus-forward") {
        cycleFocus("forward");
      } else if (action === "cycle-focus-back") {
        cycleFocus("back");
      } else if (action === "maximize-pane") {
        const id = focusedPaneId();
        if (id) toggleMaximize(id);
      }
    }
    window.addEventListener("raum-action", onAction);
    onCleanup(() => window.removeEventListener("raum-action", onAction));
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

  // Projected cell geometry keyed by pane id. Each LeafFrame looks up its
  // own id and renders at that position while preview is active.
  const previewCellMap = createMemo<Map<string, Rect> | null>(() => {
    const pt = previewTree();
    if (!pt) return null;
    const rects = projectToRects(pt, LAYOUT_UNIT);
    return new Map(rects.map((r) => [r.id, r]));
  });

  // Tree passed to DividerLayer — preview while hovering a zone so dividers
  // reflow with the panes (otherwise they'd be stuck at pre-drag positions
  // while panes animate to projected ones). Falls back to the real tree.
  const renderTree = createMemo<LayoutNode | null>(() => previewTree() ?? activeTree());

  return (
    <div class="flex h-full w-full flex-col">
      {/* Views are filters over the global terminal store. `crossProjectViewMode`
          non-null => render a flat cross-project grid (awaiting/recent/working)
          instead of the per-project BSP layout. Each session has a single live
          TerminalPane mounted in exactly one view at a time, so there's never
          a double attach to the same tmux session. */}
      <Show
        when={crossProjectViewMode() === null}
        fallback={<CrossProjectView mode={crossProjectViewMode()!} />}
      >
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
            {/* Empty-state spawn button grid. */}
            <Show when={visibleCells().length === 0}>
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
                        <span class="text-[11px] uppercase tracking-widest">
                          {KIND_LABELS[kind]}
                        </span>
                      </button>
                    );
                  }}
                </For>
              </div>
            </Show>

            {/* PANE LAYER: flat absolute-positioned leaves keyed by id. Only
            position/size changes on layout mutations; the xterm inside each
            stays mounted. While a drag is hovering a valid drop zone, every
            non-dragging pane renders at its PREVIEW position; the dragging
            pane stays anchored at its original slot so the cursor-follow
            transform (translate by pointer-delta) stays coherent. */}
            <Show when={activeCells().length > 0}>
              <For each={activeCells()}>
                {(cell) => {
                  const effective = createMemo<RuntimeCell>(() => {
                    // The dragging pane floats at the cursor — keep its CSS
                    // base at its original slot so translate(pointer-delta)
                    // positions it correctly. Other panes follow the preview
                    // during drag, or the active-tree projection otherwise.
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
            </Show>

            {/* DIVIDER LAYER: overlay that reads the tree separately. During
            drag we feed it the preview tree so dividers reflow with the
            panes instead of being left behind at pre-drag positions. */}
            <DividerLayer tree={renderTree()} />

            {/* No drop-zone or landing overlays. The live reflow of the grid
            under the cursor *is* the feedback; extra overlay layers caused
            continuous repaints on the xterm canvases beneath them. */}
          </div>
        </div>
      </Show>
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
// Shell panes: the inner command/cwd IS the interesting signal, so this does
// poll `terminal_pane_context` every 2 s and composes
// `"Shell · <cwd-basename> · <command>"` (dropping the command when it equals
// the login shell).
//
// Returns null — the effect is the side effect.

const AUTO_LABEL_POLL_MS = 2000;
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

  // Shell-pane branch: tmux-polled context.
  createEffect(() => {
    if (props.kind !== "shell") return;
    const sid = props.sessionId;
    if (!sid) {
      setTabAutoLabel(props.cellId, props.tabId, kindDisplayLabel("shell"));
      return;
    }

    let cancelled = false;
    const tick = async () => {
      try {
        const ctx = await invoke<{ currentCommand: string; currentPath: string }>(
          "terminal_pane_context",
          { sessionId: sid },
        );
        if (cancelled) return;
        const basename = ctx.currentPath ? ctx.currentPath.split("/").pop() || "" : "";
        const cmd = ctx.currentCommand.trim();
        const showCmd = cmd && !SHELL_IDLE_COMMANDS.has(cmd);
        const parts = ["Shell"];
        if (basename) parts.push(basename);
        if (showCmd) parts.push(cmd);
        setTabAutoLabel(props.cellId, props.tabId, parts.join(" · "));
      } catch {
        /* non-fatal: keep the previous label */
      }
    };

    void tick();
    const timer = setInterval(tick, AUTO_LABEL_POLL_MS);
    onCleanup(() => {
      cancelled = true;
      clearInterval(timer);
    });
  });

  return null;
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
      ref={cellRef}
      data-dnd-target-pane-id={props.cell.id}
      data-cell-id={props.cell.id}
      class="leaf-frame flex min-h-0 min-w-0 flex-col"
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
      <div class="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <Show
          when={props.cell.kind !== "empty"}
          fallback={
            <div class="grid h-full w-full place-items-center text-xs text-foreground-dim">
              empty
            </div>
          }
        >
          <For each={props.cell.tabs}>
            {(tab) => (
              <div
                class="absolute inset-0"
                style={{
                  visibility: tab.id === props.cell.activeTabId ? "visible" : "hidden",
                }}
              >
                <AutoLabelBinder
                  cellId={props.cell.id}
                  tabId={tab.id}
                  kind={props.cell.kind}
                  projectSlug={tab.projectSlug ?? props.cell.projectSlug}
                  worktreeId={tab.worktreeId ?? props.cell.worktreeId}
                  sessionId={tab.sessionId}
                />
                <TerminalPane
                  kind={props.cell.kind as Parameters<typeof TerminalPane>[0]["kind"]}
                  sessionId={tab.sessionId}
                  projectSlug={tab.projectSlug ?? props.cell.projectSlug}
                  worktreeId={tab.worktreeId ?? props.cell.worktreeId}
                  borderColor="transparent"
                  onSpawned={(sid) => setTabSessionId(props.cell.id, tab.id, sid)}
                  onRequestClose={async () => {
                    try {
                      if (tab.sessionId) {
                        await invoke("terminal_kill", { sessionId: tab.sessionId });
                      }
                    } catch (e) {
                      console.warn("[LeafFrame] terminal_kill on exit failed", e);
                    }
                    removeCellTab(props.cell.id, tab.id);
                  }}
                />
              </div>
            )}
          </For>
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
      class="pane-drag-handle flex h-7 shrink-0 cursor-grab items-center border-b border-border-subtle active:cursor-grabbing"
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

  const HarnessIcon = () => {
    const Icon = HARNESS_ICONS[props.kind as keyof typeof HARNESS_ICONS];
    if (!Icon) return null;
    return <Icon class="h-3 w-3 shrink-0" />;
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
    <div
      class="pane-header-tab group relative flex h-[18px] shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[10px] uppercase tracking-wide transition-colors"
      classList={{
        "bg-selected text-foreground": props.isActive,
        "text-foreground-subtle hover:bg-hover hover:text-foreground": !props.isActive,
      }}
      title={tabLabel()}
      onClick={(e) => {
        if (editing()) return;
        e.stopPropagation();
        setActiveTabId(props.cellId, props.tab.id);
      }}
      onContextMenu={openMenu}
      onDblClick={(e) => {
        e.stopPropagation();
        startRename();
      }}
    >
      <HarnessIcon />
      <StateIndicator state={tabState()} />
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
        <span class="max-w-[14ch] truncate normal-case">{tabLabel()}</span>
      </Show>
      <Show when={props.showClose && !editing()}>
        <button
          type="button"
          title="Close tab"
          aria-label="Close tab"
          class="pane-header-tab-close ml-0.5 hidden rounded-sm p-0.5 hover:bg-hover hover:text-foreground group-hover:flex"
          onClick={(e) => {
            props.onClose(e);
          }}
        >
          <CloseGlyph />
        </button>
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
    </div>
  );
};

// ---- StateIndicator + ChromeButton + glyphs -------------------------------

function StateIndicator(props: { state: AgentState | null }) {
  const title = () => props.state ?? "unknown";
  return (
    <span class="flex items-center" title={title()}>
      <Show when={props.state === "working"}>
        <LoaderIcon class="h-3 w-3 animate-spin text-success" />
      </Show>
      <Show when={props.state === "waiting"}>
        <AlertCircleIcon class="h-3 w-3 text-warning" />
      </Show>
      <Show when={props.state === "idle" || props.state === null}>
        <CheckIcon class="h-3 w-3 text-foreground-subtle" />
      </Show>
      <Show when={props.state === "completed"}>
        <CheckIcon class="h-3 w-3 text-info" />
      </Show>
      <Show when={props.state === "errored"}>
        <AlertCircleIcon class="h-3 w-3 text-destructive" />
      </Show>
    </span>
  );
}

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

// ---- CrossProjectView: flat filter over the global terminal store ----------
//
// When `crossProjectViewMode()` is non-null, the grid renders this view in
// place of the BSP per-project layout. It's a pure filter+sort over
// `terminalStore.byId`: "awaiting" shows all sessions whose agent state is
// `waiting`, "working" shows all `working`, and "recent" shows the 9 most
// recent sessions regardless of state, sorted by `lastOutputMs` desc.
//
// Each tile hosts a full live `TerminalPane` — the tile IS the terminal.
// Project color frames the tile and accents the slim header strip. Clicking
// the header switches `activeProjectSlug` and clears the mode so the BSP view
// reopens on the corresponding pane; Escape clears the mode without switching
// projects.

const RECENT_CAP = 9;

interface MatchedSession {
  sessionId: string;
  kind: AgentKind;
  projectSlug: string;
  worktreeId: string | null;
  projectName: string;
  projectColor: string;
  state: AgentState | null;
  lastActivity: number;
}

function stateChip(state: AgentState | null): { label: string; tone: string } {
  if (state === "working") return { label: "Working", tone: "bg-success/15 text-success" };
  if (state === "waiting") return { label: "Waiting", tone: "bg-warning/15 text-warning" };
  if (state === "errored") return { label: "Errored", tone: "bg-danger/15 text-danger" };
  if (state === "completed")
    return { label: "Completed", tone: "bg-muted/30 text-foreground-subtle" };
  return { label: "Idle", tone: "bg-muted/30 text-foreground-subtle" };
}

function relativeAgo(ms: number): string {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

function headerLabel(mode: CrossProjectViewMode): string {
  if (mode === "awaiting") return "Awaiting across projects";
  if (mode === "working") return "Working across projects";
  return "Recent across projects";
}

function headerIcon(mode: CrossProjectViewMode): typeof AlertCircleIcon {
  if (mode === "awaiting") return AlertCircleIcon;
  if (mode === "working") return LoaderIcon;
  return ClockIcon;
}

interface CrossProjectViewProps {
  mode: CrossProjectViewMode;
}

const CrossProjectView: Component<CrossProjectViewProps> = (props) => {
  // Membership: the set of session ids that satisfy the filter mode.
  // Depends on the index signals (membership) and agentStore.sessions,
  // but NOT on `lastOutputBySession` — so a PTY-output storm doesn't
  // invalidate this memo.
  const matchedIds = createMemo<string[]>(() => {
    const hs = harnessIds();
    const pickBucket = (bucket: ReadonlySet<string>): string[] => {
      const out: string[] = [];
      for (const id of bucket) if (hs.has(id)) out.push(id);
      return out;
    };
    if (props.mode === "awaiting") return pickBucket(waitingIds());
    if (props.mode === "working") return pickBucket(workingIds());
    // Recent: any project-scoped harness.
    return [...hs];
  });

  // Projection: shape each id into a tile. `lastOutputBySession` enters
  // here (for the sort key) and `projectBySlug` is an O(1) map lookup.
  // Wrapped in `createDeferred` so rapid PTY updates let the browser
  // paint between re-sorts — the membership is already stable by the
  // time this settles.
  const rawMatched = createMemo<MatchedSession[]>(() => {
    const ids = matchedIds();
    const lo = lastOutputBySession();
    const pm = projectBySlug();
    const sessions = agentStore.sessions;
    const out: MatchedSession[] = [];
    for (const id of ids) {
      const terminal = terminalStore.byId[id];
      if (!terminal || !terminal.project_slug) continue;
      const proj = pm.get(terminal.project_slug);
      out.push({
        sessionId: id,
        kind: terminal.kind,
        projectSlug: terminal.project_slug,
        worktreeId: terminal.worktree_id,
        projectName: proj?.name ?? terminal.project_slug,
        projectColor: proj?.color ?? "#6b7280",
        state: sessions[id]?.state ?? null,
        lastActivity: lo.get(id) ?? terminal.created_unix * 1000,
      });
    }
    out.sort((a, b) => b.lastActivity - a.lastActivity);
    if (props.mode === "recent") return out.slice(0, RECENT_CAP);
    return out;
  });
  const matched = createDeferred(rawMatched, { timeoutMs: 200 });
  timeMemoSettle(() => `filter-click:${props.mode}`, matched);

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

  const Icon = () => {
    const I = headerIcon(props.mode);
    return <I class="size-3.5 text-foreground" />;
  };

  return (
    <div class="flex flex-1 min-h-0 flex-col bg-background">
      <div class="flex items-center justify-between border-b border-border-subtle px-4 py-1.5">
        <div class="flex items-center gap-2">
          <Icon />
          <h2 class="text-xs font-medium text-foreground">{headerLabel(props.mode)}</h2>
          <span class="text-[11px] text-foreground-subtle">
            {matched().length} {matched().length === 1 ? "session" : "sessions"}
          </span>
        </div>
        <button
          type="button"
          class="rounded px-2 py-0.5 text-[11px] text-foreground-subtle hover:bg-hover hover:text-foreground"
          onClick={() => setCrossProjectViewMode(null)}
        >
          Close (Esc)
        </button>
      </div>

      <Show
        when={matched().length > 0}
        fallback={
          <div class="flex flex-1 items-center justify-center text-sm text-foreground-subtle">
            No matching sessions across your projects.
          </div>
        }
      >
        <div class="flex-1 overflow-auto p-3">
          <div class="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-3">
            <For each={matched()}>{(entry) => <CrossProjectTile entry={entry} />}</For>
          </div>
        </div>
      </Show>
    </div>
  );
};

const CrossProjectTile: Component<{ entry: MatchedSession }> = (props) => {
  const HarnessIcon = () => {
    const I = HARNESS_ICONS[props.entry.kind as keyof typeof HARNESS_ICONS];
    return I ? <I class="size-3.5 shrink-0" /> : null;
  };
  const chip = () => stateChip(props.entry.state);

  // Soft project-colored wash over the header strip. Border uses the saturated
  // color so the frame reads as "this terminal belongs to <project>".
  const headerStyle = () => {
    const c = props.entry.projectColor;
    return {
      "background-image": `linear-gradient(180deg, ${c}40 0%, ${c}14 60%, transparent 100%)`,
      "box-shadow": `inset 0 1px 0 ${c}66, inset 0 -1px 0 ${c}1f`,
    } as Record<string, string>;
  };

  function jumpToProject(): void {
    const slug = props.entry.projectSlug;
    const sessionId = props.entry.sessionId;
    if (activeProjectSlug() !== slug) setActiveProjectSlug(slug);
    setCrossProjectViewMode(null);
    queueMicrotask(() => {
      try {
        window.dispatchEvent(
          new CustomEvent("terminal-focus-requested", {
            detail: { sessionId },
          }),
        );
      } catch {
        /* non-DOM env (tests) */
      }
    });
  }

  return (
    <div
      class="flex flex-col overflow-hidden rounded-md border-2 bg-background"
      style={{ "border-color": props.entry.projectColor }}
    >
      <button
        type="button"
        class="flex items-center gap-2 px-3 py-1.5 text-left hover:bg-hover/50"
        style={headerStyle()}
        onClick={jumpToProject}
        title="Jump to this terminal in its project"
      >
        <span
          class="inline-block size-2 shrink-0 rounded-full"
          style={{ "background-color": props.entry.projectColor }}
        />
        <span class="truncate text-xs font-medium text-foreground">{props.entry.projectName}</span>
        <HarnessIcon />
        <span class="truncate text-[11px] text-foreground-subtle">
          {kindDisplayLabel(props.entry.kind)}
        </span>
        <span class={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium ${chip().tone}`}>
          {chip().label}
        </span>
        <span class="shrink-0 text-[10px] text-foreground-subtle">
          {relativeAgo(props.entry.lastActivity)}
        </span>
      </button>
      <div class="relative aspect-[16/10] min-h-0 flex-1">
        <TerminalPane
          kind={props.entry.kind}
          sessionId={props.entry.sessionId}
          projectSlug={props.entry.projectSlug}
          worktreeId={props.entry.worktreeId ?? undefined}
          borderColor="transparent"
        />
      </div>
    </div>
  );
};
