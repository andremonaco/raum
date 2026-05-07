import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { Portal } from "solid-js/web";

import { type AgentKind } from "../../lib/agentKind";
import { ensureFirstPromptLoaded, firstPromptForSession } from "../../lib/firstPromptCache";
import {
  focusedPaneId,
  layoutRev,
  maximizedPaneId,
  runtimeLayoutStore,
} from "../../stores/runtimeLayoutStore";
import { dragState } from "../../lib/paneDnD";
import { activeProjectSlug } from "../../stores/projectStore";
import { allReviewLinks } from "../../stores/reviewLinkStore";
import { HARNESS_ICONS } from "../icons";
import { crossProjectViewMode } from "../top-row";
import { type ReviewSnapOverlayProps, type ReviewTetherPosition } from "./types";

/**
 * Cross-harness review "snap" overlay. Rendered *inside* the target
 * pane's `LeafFrame` while the user is hovering the center zone of a
 * review-eligible target. The body of the target pane gets blurred via
 * the `pane-review-snap-target` class on the LeafFrame; this overlay
 * sits over the blur and shows the visual contract of what's about to
 * happen:
 *
 *     [reviewer-icon]   reviews →   [reviewed-icon]
 *     ─────────────────────────────────────────────
 *     <target's last user prompt>
 *
 * Snap-on is `dragState.zone === "center"` over a sibling agent pane.
 * Snap-off is any other zone (move further toward an edge → unsnaps,
 * pane reflow takes over again). The hit-test's enter/exit hysteresis
 * (paneDnD.ts EDGE_ENTER_FRACTION / EDGE_EXIT_FRACTION) gives the
 * "you have to move further to leave the snap" feel.
 *
 * The overlay is mounted inside the LeafFrame and uses `position:
 * absolute; inset: 0` instead of viewport-pinned positioning, so it can
 * never land over a *different* pane's xterm canvas. The blur is a CSS
 * transition triggered by the class swap, not a per-frame re-render —
 * xterm's canvas isn't repainted continuously.
 */
export const ReviewSnapOverlay: Component<ReviewSnapOverlayProps> = (props) => {
  const dragData = createMemo<{
    sourceKind: AgentKind;
    sourceLabel: string;
    armDelayMs: number;
    armed: boolean;
    armStartedAtMs: number | null;
  } | null>(() => {
    const s = dragState();
    if (!s) return null;
    if (!s.snapped) return null;
    if (s.targetId !== props.cellId) return null;
    if (s.sourceKind === "shell" || s.sourceKind === "empty") return null;
    if (props.cellKind === "shell" || props.cellKind === "empty") return null;
    return {
      sourceKind: s.sourceKind as AgentKind,
      sourceLabel: s.sourceLabel,
      armDelayMs: s.armDelayMs,
      armed: s.armed,
      armStartedAtMs: s.armStartedAtMs,
    };
  });

  // Lazy-load the first prompt the moment the snap activates, so the
  // overlay can show "what task is being reviewed" without paying a
  // Tauri call per session at startup. The cache dedupes in-flight
  // fetches and keeps results forever (a session's first prompt is
  // immutable once recorded).
  createEffect(() => {
    if (dragData()) ensureFirstPromptLoaded(props.targetSessionId);
  });

  const firstPrompt = createMemo<string | null | undefined>(() =>
    firstPromptForSession(props.targetSessionId),
  );

  return (
    <Show when={dragData()}>
      {(data) => {
        const ReviewerIcon = HARNESS_ICONS[data().sourceKind as keyof typeof HARNESS_ICONS];
        const ReviewedIcon = HARNESS_ICONS[props.cellKind as keyof typeof HARNESS_ICONS];
        // Dwell progress key: the CSS animation is restarted from 0
        // every time `armStartedAtMs` changes — initial engagement,
        // OR re-targeting from another pane onto this one within the
        // same drag. Solid's `<Show keyed>` rebuilds the DOM subtree
        // when the keyed value identity changes, which restarts the
        // bar's CSS @keyframes from frame 0.
        const dwellKey = createMemo(() => (data().armDelayMs > 0 ? data().armStartedAtMs : null));
        return (
          <div
            class="pane-review-snap-overlay pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center text-center"
            classList={{ "is-armed": data().armed, "is-dwelling": !data().armed }}
            data-testid="review-snap-overlay"
          >
            <div class="pane-review-snap-icons">
              {ReviewerIcon ? <ReviewerIcon class="pane-review-snap-icon" /> : null}
              <span class="pane-review-snap-arrow">reviews →</span>
              {ReviewedIcon ? <ReviewedIcon class="pane-review-snap-icon" /> : null}
            </div>
            <Show
              when={firstPrompt()}
              fallback={
                <div class="pane-review-snap-prompt pane-review-snap-prompt-empty">
                  {firstPrompt() === undefined
                    ? "Loading original task…"
                    : "No original task captured — the reviewer will work from the diff alone."}
                </div>
              }
            >
              {(text) => <div class="pane-review-snap-prompt">{text()}</div>}
            </Show>
            {/* Dwell progress bar. Hidden when armDelayMs===0 (empty
                source: instant arm, no dwell). For non-empty sources,
                a thin foreground line fills left→right over the dwell
                duration; once full the user can release to commit.
                The `keyed` value is the dwell start timestamp — when
                it changes (retargeting onto this pane mid-drag, or
                re-engaging after Escape), Solid remounts the subtree
                which restarts the CSS @keyframes from frame 0. */}
            <Show when={dwellKey()} keyed>
              {(_stamp: number) => (
                <div
                  class="pane-review-snap-progress"
                  style={{ "--review-dwell-ms": `${data().armDelayMs}ms` }}
                  data-testid="review-snap-progress"
                >
                  <div class="pane-review-snap-progress-fill" />
                </div>
              )}
            </Show>
            <div class="pane-review-snap-hint" data-testid="review-snap-hint">
              {data().armDelayMs === 0 || data().armed ? "Release to review" : "Hold to review…"}
            </div>
          </div>
        );
      }}
    </Show>
  );
};

/**
 * Persistent visual link between two reviewed-and-reviewing panes once the
 * snap completes. Renders an oval chip that floats at the shared edge of
 * the two cells:
 *
 *      ┌──────────────┬──────────────┐
 *      │              │              │
 *      │  reviewed    │   reviewer   │
 *      │           ┌──────┐          │
 *      │           │  🅡 → 🅒  │     │  ← the brace, half-overlapping each
 *      │           └──────┘          │     pane, anchored on the divider
 *      │              │              │
 *      └──────────────┴──────────────┘
 *
 * The brace is the structural "you are looking at one bound unit" signal.
 * Together with the natural adjacency from `spawnReviewerPane` (which
 * splits the reviewed pane to the right with the new reviewer pane) it
 * replaces the previously-too-quiet header badge as the primary review
 * affordance.
 *
 * Renders only for *adjacent* linked pairs. Non-adjacent links (e.g.
 * after the user manually rearranged the layout) fall back to the small
 * header badge in `<PaneHeader>` so the link is still visible somewhere.
 */
export const ReviewBracesLayer: Component = () => {
  // Tick that bumps whenever something that affects pane geometry changes:
  // layout mutations (`layoutRev`), window resizes, sidebar/dock collapses
  // (ResizeObserver on the dnd root). Each bump re-runs `positions` to
  // re-read DOM rects.
  const [tick, setTick] = createSignal(0);

  // Stable identity for tether items across `positions()` reruns. Keyed by
  // `${reviewerSessionId}::${reviewedSessionId}`. Without this, every
  // recompute hands `<For>` brand-new objects, which Solid treats as
  // entirely new items — triggering a full unmount/remount of the dot+line
  // DOM and visibly restarting the `review-tether-fade-in` CSS animation.
  const positionCache = new Map<string, ReviewTetherPosition>();

  // Cell id currently under the mouse (any pane, not just linked ones).
  // Cheap to track because we only listen for `mouseover` (fires once per
  // pane crossing, never per-pixel), and we update only on transitions.
  const [hoveredCellId, setHoveredCellId] = createSignal<string | null>(null);

  onMount(() => {
    const bump = (): void => {
      setTick((t) => t + 1);
    };
    window.addEventListener("resize", bump);

    // Watch the dnd-root for any size change. Layout commits inside the
    // store flip `layoutRev`, but the DOM reflow that *applies* those
    // commits to pane rects can lag a frame, so we observe the actual
    // geometry too.
    const root = document.querySelector<HTMLElement>('[data-dnd-root="true"]');
    let ro: ResizeObserver | null = null;
    if (root) {
      ro = new ResizeObserver(bump);
      ro.observe(root);
    }

    // Track which pane the cursor is over so the tether can dim out when
    // the user reaches into a linked pane to interact with it. We attach
    // to the dnd-root (covers every pane) and use bubbling `mouseover`
    // which fires on element-crossing transitions, not on every pixel.
    function onMouseOver(e: Event): void {
      const target = e.target as HTMLElement | null;
      const cell = target?.closest<HTMLElement>("[data-cell-id]");
      const id = cell?.getAttribute("data-cell-id") ?? null;
      setHoveredCellId(id);
    }
    function onMouseLeave(): void {
      setHoveredCellId(null);
    }
    if (root) {
      root.addEventListener("mouseover", onMouseOver);
      root.addEventListener("mouseleave", onMouseLeave);
    }

    onCleanup(() => {
      window.removeEventListener("resize", bump);
      ro?.disconnect();
      if (root) {
        root.removeEventListener("mouseover", onMouseOver);
        root.removeEventListener("mouseleave", onMouseLeave);
      }
    });
  });

  // Topology: the slice of `runtimeLayoutStore.cells` that the tether
  // actually depends on (id → kind, active session, project). Pulled
  // into its own memo with a signature-based equality so per-cell churn
  // that doesn't change topology — most importantly the `lastActivityMs`
  // bumps emitted on every `agent-state-changed` event (~1 Hz while a
  // harness is alive) — does not invalidate `positions` and force a
  // tether re-render every tick.
  interface CellTopology {
    sessionToCell: Map<string, string>;
    cellsByKind: Map<string, AgentKind>;
    cellProjectById: Map<string, string | undefined>;
    signature: string;
  }
  // Hand-rolled identity cache: when the rebuilt object's signature
  // matches the previous result, hand back the exact same object so the
  // downstream `positions` memo (which subscribes to `topology()`) does
  // not re-run on a no-op recompute. Equivalent to passing `equals` to
  // `createMemo`, but sidesteps the overload that would otherwise require
  // an initial value of `CellTopology`.
  let prevTopology: CellTopology | null = null;
  // Diagnostic counters for the tether's reactive chain. Exposed on `window`
  // so the user can verify in devtools whether the tether is re-running on
  // idle harness activity. Reset by reloading the page.
  if (import.meta.env.DEV) {
    const w = window as unknown as { __raumTether?: Record<string, number> };
    w.__raumTether ??= {
      topologyRuns: 0,
      topologyEmits: 0,
      positionsRuns: 0,
      positionsForReturns: 0,
      positionsCacheHits: 0,
      positionsCacheMisses: 0,
    };
  }
  const bumpDebug = (key: string): void => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __raumTether: Record<string, number> };
    w.__raumTether[key] = (w.__raumTether[key] ?? 0) + 1;
  };

  const topology = createMemo<CellTopology>(() => {
    bumpDebug("topologyRuns");
    const sessionToCell = new Map<string, string>();
    const cellsByKind = new Map<string, AgentKind>();
    const cellProjectById = new Map<string, string | undefined>();
    const sigParts: string[] = [];
    for (const cell of runtimeLayoutStore.cells) {
      const activeTab = cell.tabs.find((t) => t.id === cell.activeTabId);
      const sessionId = activeTab?.sessionId ?? "";
      if (sessionId) sessionToCell.set(sessionId, cell.id);
      if (cell.kind !== "empty") cellsByKind.set(cell.id, cell.kind as AgentKind);
      cellProjectById.set(cell.id, cell.projectSlug);
      sigParts.push(
        `${cell.id}|${cell.kind}|${cell.activeTabId ?? ""}|${sessionId}|${cell.projectSlug ?? ""}`,
      );
    }
    const signature = sigParts.join("\n");
    if (prevTopology && prevTopology.signature === signature) return prevTopology;
    bumpDebug("topologyEmits");
    prevTopology = { sessionToCell, cellsByKind, cellProjectById, signature };
    return prevTopology;
  });

  const positions = createMemo<ReviewTetherPosition[]>(() => {
    bumpDebug("positionsRuns");
    // Track reactive deps explicitly so the memo re-runs whenever the
    // visible view changes — otherwise the memo holds stale viewport
    // coords from before the change and the tether lingers over the
    // wrong project / cross-project view / maximized pane.
    layoutRev();
    tick();
    const projectSlug = activeProjectSlug();
    const xMode = crossProjectViewMode();
    const maxId = maximizedPaneId();

    // Tether is a per-project, in-grid affordance only. Hide it during
    // any "view is changing" state so it doesn't render against panes
    // that aren't actually on screen.
    if (xMode !== null) return [];
    if (maxId !== null) return [];
    if (!projectSlug) return [];

    const links = allReviewLinks();
    if (links.length === 0) return [];

    // Topology drives the (session → cell, cell → kind, cell → project)
    // lookups. `cellProjectById` gates panes that belong to a different
    // project — they may linger in `runtimeLayoutStore.cells` after a
    // project switch but their LeafFrames aren't in the DOM, so the
    // querySelector below also catches that case.
    const { sessionToCell: cellIdByActiveSession, cellsByKind, cellProjectById } = topology();

    const out: ReviewTetherPosition[] = [];
    const seen = new Set<string>();
    for (const { reviewerSessionId, reviewedSessionId } of links) {
      const reviewerCellId = cellIdByActiveSession.get(reviewerSessionId);
      const reviewedCellId = cellIdByActiveSession.get(reviewedSessionId);
      if (!reviewerCellId || !reviewedCellId) continue;

      // Skip when either pane belongs to a different project — even if
      // the cells exist in the store, they aren't rendered for the
      // current project tab.
      if (cellProjectById.get(reviewerCellId) !== projectSlug) continue;
      if (cellProjectById.get(reviewedCellId) !== projectSlug) continue;

      // Pull the *actually rendered* rects from the DOM. This bypasses
      // any layout-coord ↔ pixel translation we'd otherwise have to do,
      // and works regardless of pane-gap insets, scroll, or zoom.
      const reviewerEl = document.querySelector<HTMLElement>(`[data-cell-id="${reviewerCellId}"]`);
      const reviewedEl = document.querySelector<HTMLElement>(`[data-cell-id="${reviewedCellId}"]`);
      if (!reviewerEl || !reviewedEl) continue;

      const rA = reviewedEl.getBoundingClientRect();
      const rB = reviewerEl.getBoundingClientRect();

      // Decide which is left/right by their actual x positions.
      let leftRect: DOMRect;
      let rightRect: DOMRect;
      if (rA.right <= rB.left + 4) {
        leftRect = rA;
        rightRect = rB;
      } else if (rB.right <= rA.left + 4) {
        leftRect = rB;
        rightRect = rA;
      } else {
        // Not horizontally adjacent (overlapping or stacked).
        continue;
      }

      const overlapTop = Math.max(leftRect.top, rightRect.top);
      const overlapBottom = Math.min(leftRect.bottom, rightRect.bottom);
      if (overlapBottom <= overlapTop) continue;

      // Center the tether in the gap between the two panes.
      const x = (leftRect.right + rightRect.left) / 2;
      const y = (overlapTop + overlapBottom) / 2;

      const reviewerKind = cellsByKind.get(reviewerCellId);
      const reviewedKind = cellsByKind.get(reviewedCellId);
      if (!reviewerKind || !reviewedKind) continue;

      // Reuse the previous object when *every* field matches. Solid's
      // `<For>` is reference-keyed, so handing back the exact same item
      // skips the whole "remove DOM, fade-in new DOM" cycle that would
      // otherwise visibly flicker the tether on every `positions()`
      // rerun. We can't mutate the cached object to update coords —
      // `pos.x`/`pos.y` are read non-reactively in the For body, so
      // mutations would not propagate to the DOM. Coord drift therefore
      // forces a fresh object (and a one-shot fade-in for that tether),
      // which is the correct UX when geometry actually changes.
      const key = `${reviewerSessionId}::${reviewedSessionId}`;
      seen.add(key);
      const existing = positionCache.get(key);
      if (
        existing &&
        existing.x === x &&
        existing.y === y &&
        existing.reviewerKind === reviewerKind &&
        existing.reviewedKind === reviewedKind &&
        existing.reviewerCellId === reviewerCellId &&
        existing.reviewedCellId === reviewedCellId
      ) {
        bumpDebug("positionsCacheHits");
        out.push(existing);
      } else {
        bumpDebug("positionsCacheMisses");
        const fresh: ReviewTetherPosition = {
          x,
          y,
          reviewerKind,
          reviewedKind,
          reviewerCellId,
          reviewedCellId,
          key,
        };
        positionCache.set(key, fresh);
        out.push(fresh);
      }
    }
    // Drop cache entries for links that vanished — otherwise the map
    // would grow unbounded as users link/unlink different pane pairs.
    for (const cachedKey of positionCache.keys()) {
      if (!seen.has(cachedKey)) positionCache.delete(cachedKey);
    }
    return out;
  });

  return (
    <Show when={positions().length > 0}>
      {/* `<Portal>` mounts at `document.body` so the tether escapes
          every ancestor's stacking context, overflow:hidden, and
          transform-induced clip. Combined with `position: fixed` on
          each child, the tether is guaranteed to render at the right
          viewport coords regardless of any chrome wrapper geometry. */}
      <Portal>
        <For each={positions()}>
          {(pos) => {
            const ReviewerIcon = HARNESS_ICONS[pos.reviewerKind as keyof typeof HARNESS_ICONS];
            const ReviewedIcon = HARNESS_ICONS[pos.reviewedKind as keyof typeof HARNESS_ICONS];
            // Tether recedes when the user reaches into either linked
            // pane (mouse-hover OR focus). Stays present but dimmed so
            // it doesn't compete with the work the user's doing inside
            // the pane. Pure CSS opacity transition — no layout work,
            // no impact on xterm.
            const recede = (): boolean => {
              const fid = focusedPaneId();
              const hid = hoveredCellId();
              return (
                fid === pos.reviewerCellId ||
                fid === pos.reviewedCellId ||
                hid === pos.reviewerCellId ||
                hid === pos.reviewedCellId
              );
            };
            return (
              <div
                class="review-tether"
                classList={{ "review-tether--recede": recede() }}
                data-testid={`review-tether-${pos.key}`}
                style={{
                  position: "fixed",
                  left: `${pos.x}px`,
                  top: `${pos.y}px`,
                  "z-index": "9999",
                }}
                aria-label="cross-harness review link"
              >
                <div class="review-tether-dot" data-side="reviewed">
                  {ReviewedIcon ? <ReviewedIcon class="review-tether-icon" /> : null}
                </div>
                <div class="review-tether-line" aria-hidden="true" />
                <div class="review-tether-dot" data-side="reviewer">
                  {ReviewerIcon ? <ReviewerIcon class="review-tether-icon" /> : null}
                </div>
              </div>
            );
          }}
        </For>
      </Portal>
    </Show>
  );
};
