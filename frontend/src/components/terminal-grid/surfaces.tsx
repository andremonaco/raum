import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { type Rect } from "../../lib/layoutTree";
import { dropTargetPaneId } from "../../lib/fileDrop";
import { ROOT_TARGET, dragState } from "../../lib/paneDnD";
import {
  sameSurfaceDescriptor,
  type TerminalSurfaceDescriptor,
} from "../../lib/terminalSurfaceProjection";
import { getPresentationPolicy } from "../../lib/rendererScheduler";
import { activateView, crossProjectViewMode } from "../../lib/viewActivation";
import {
  LAYOUT_UNIT,
  focusedPaneId,
  maxAnimTargetId,
  removeCellTab,
  runtimeLayoutStore,
  setActiveTabId,
  setFocusedPaneId,
  setTabSessionId,
  toggleMaximize,
} from "../../stores/runtimeLayoutStore";
import { activeProjectSlug } from "../../stores/projectStore";
import { agentStore, isAcknowledgedReactive, markAcknowledged } from "../../stores/agentStore";
import { TerminalPane } from "../terminal-pane";
import { AutoLabelBinder } from "./auto-label-binder";
import { consumeReviewSpawn } from "./review-spawn";
import { rectStyle, requestTerminalKill } from "./utils";

// ---- TerminalSurfaceLayer: one persistent terminal per tab/session --------

export const TerminalSurfaceLayer: Component<{ surfaces: TerminalSurfaceDescriptor[] }> = (
  props,
) => {
  const byKey = createMemo(() => new Map(props.surfaces.map((surface) => [surface.key, surface])));
  const keys = createMemo(() => props.surfaces.map((surface) => surface.key));

  return (
    <div class="terminal-surface-layer absolute inset-0">
      <For each={keys()}>
        {(key) => {
          // Per-key identity guard: the global projector reruns whenever ANY
          // surface's geometry/membership changes, but a host only needs a new
          // descriptor when one of ITS fields actually moved. Returning the
          // previous object keeps every downstream memo in this host from
          // re-evaluating (and, at 100 sessions, keeps a single pane's rect
          // change off the other 99 hosts).
          const surface = createMemo<TerminalSurfaceDescriptor | null>((prev) => {
            const next = byKey().get(key) ?? null;
            if (prev && next && sameSurfaceDescriptor(prev, next)) return prev;
            return next;
          }, null);
          return (
            <Show when={surface()}>{(current) => <TerminalSurfaceHost surface={current()} />}</Show>
          );
        }}
      </For>
    </div>
  );
};

export const TerminalSurfaceHost: Component<{ surface: TerminalSurfaceDescriptor }> = (props) => {
  if (import.meta.env.DEV) {
    const k = props.surface.key;
    const sid = props.surface.sessionId ?? "—";
    console.log(`%c[flicker-debug] TerminalSurfaceHost MOUNT key=${k} sid=${sid}`, "color:#08c");
    onCleanup(() => {
      console.log(
        `%c[flicker-debug] TerminalSurfaceHost CLEANUP key=${k} sid=${sid}`,
        "color:#c30",
      );
    });
  }
  const [lastRect, setLastRect] = createSignal<Rect | null>(null);
  createEffect(() => {
    const rect = props.surface.rect;
    if (rect && rect.w > 0 && rect.h > 0) setLastRect(rect);
  });

  const rect = createMemo(() => props.surface.rect ?? lastRect());
  const visible = createMemo(() => props.surface.visible && rect() !== null);
  // Focus lives OUTSIDE the surface projection (it used to be a projector
  // input, so every pane click rebuilt the whole descriptor list). Reproduce
  // the projector's old `visible && activeTab && focusedCell === cellId` from
  // narrow accessors instead: the scalar focused-cell signal plus this pane's
  // own `activeTabId`. Orphan surfaces have no cell/tab and are never active.
  const isActiveTab = createMemo(() => {
    const { cellId, tabId } = props.surface;
    if (!cellId || !tabId) return false;
    return runtimeLayoutStore.panes[cellId]?.activeTabId === tabId;
  });
  const isActive = createMemo(
    () => visible() && isActiveTab() && focusedPaneId() === props.surface.cellId,
  );
  // True when this surface owns the pane currently being dragged. The
  // `.surface-dragging-source` CSS rule then translates it with the same
  // `--drag-dx`/`--drag-dy` the chrome uses, so the live terminal rides
  // alongside its chrome card while the rest of the grid reflows underneath.
  const isDragSource = createMemo(
    () => !!props.surface.cellId && props.surface.cellId === dragState()?.sourceId,
  );
  // Mirror the chrome's `is-snapped` toggle so the surface reads the same
  // `--snap-*` transform as its chrome card while the magnetic snap is
  // engaged. Without this, the terminal pixels would keep tracking the
  // cursor while the chrome docked onto the target — visible mismatch.
  const isSnappedSource = createMemo(() => {
    if (!isDragSource()) return false;
    const s = dragState();
    return s?.snapped === true && s.targetId !== null && s.targetId !== ROOT_TARGET;
  });
  // Mirror the chrome's edge-snap dock so the live terminal pixels click into
  // the landing slot alongside their card.
  const isEdgeSnappedSource = createMemo(() => {
    if (!isDragSource()) return false;
    const s = dragState();
    return (
      !!s && s.armed && !s.snapped && s.zone !== null && s.zone !== "center" && s.targetId !== null
    );
  });
  const fileDropActive = createMemo(
    () => props.surface.kind !== "shell" && dropTargetPaneId() === props.surface.key,
  );
  // Mirrors `LeafFrame`'s `pane-unread-completed` so the green ring is
  // robust to states where the chrome layer is translated/hidden (drag,
  // maximize animation). The CSS rule targets `.leaf-frame.pane-unread-completed`
  // which both chrome and surface frames share via their `.leaf-frame` class.
  const isUnreadCompleted = createMemo(() => {
    const sid = props.surface.sessionId;
    if (!sid) return false;
    const state = agentStore.sessions[sid]?.state;
    if (state !== "completed" && state !== "errored") return false;
    return !isAcknowledgedReactive(sid);
  });
  // Mirrors LeafFrame's `.pane-max-anim-target` so the surface stays painted
  // while every other surface is hidden during a maximize/restore — without
  // the mirror the chrome would animate alone and the live xterm pixels
  // would either snap or be covered by sibling chrome above the layer.
  const isMaxAnimTarget = createMemo(
    () => !!props.surface.cellId && maxAnimTargetId() === props.surface.cellId,
  );
  // Under `warm-residency` a hidden host is taken out of layout entirely:
  // `visibility: hidden` still lays out and still lets xterm paint into its
  // canvases, which is exactly the hidden work task 4.3 removes. Two
  // transitions must keep their current presentation until the gesture ends,
  // because both animate a surface the projection has already stopped calling
  // visible: the drag source (it rides `--drag-dx/dy` and must stay painted
  // under the cursor) and the maximize animation target. Siblings of a
  // maximized pane are unaffected — the projector keeps them `visible` and CSS
  // covers them by z-index, so they never reach this branch.
  const hiddenByDisplay = createMemo(
    () =>
      !visible() &&
      getPresentationPolicy() === "warm-residency" &&
      !isDragSource() &&
      !isMaxAnimTarget(),
  );
  const style = createMemo<Record<string, string>>(() => {
    // The last known rect is kept either way: show must not have to wait for a
    // geometry round-trip to know where the pane goes.
    const r = rect() ?? { id: props.surface.key, x: 0, y: 0, w: LAYOUT_UNIT, h: LAYOUT_UNIT };
    const style: Record<string, string> = {
      ...rectStyle(r),
      visibility: visible() ? "visible" : "hidden",
      // Ghost surface must pass pointer events through so destination panes
      // remain hit-testable during the drag.
      "pointer-events": visible() && !isDragSource() ? "auto" : "none",
    };
    // Dropped from the object (not set to `block`) when it no longer applies:
    // Solid removes keys that leave the style object, and the frame's own CSS
    // owns its display mode.
    if (hiddenByDisplay()) style.display = "none";
    return style;
  });

  function claimFocus(): void {
    const { cellId, tabId, sessionId } = props.surface;
    if (!cellId) return;
    const slug = props.surface.projectSlug ?? activeProjectSlug();
    if (slug && crossProjectViewMode() === null) {
      // Same batch/generation path as every other entry point. Scope is
      // omitted: clicking a pane never changes the sidebar selection.
      activateView({ projectSlug: slug, cellId, tabId, source: "mouse" });
    } else {
      // Project-less shell pane, or a pane projected by the cross-project
      // spotlight: neither may switch the active project or re-resolve the
      // cell against a scope it is not in — just take focus.
      if (tabId) setActiveTabId(cellId, tabId);
      setFocusedPaneId(cellId);
    }
    // Acknowledge unread completion on this surface's session so the
    // green pane chrome clears even when the click lands inside an
    // already-focused pane — the focus signal stays equal in that
    // case, so the paneFocusAcknowledger effect won't re-run.
    if (sessionId) {
      const state = agentStore.sessions[sessionId]?.state;
      if (state === "completed" || state === "errored") {
        markAcknowledged(sessionId);
      }
    }
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

  function closeSurface(): void {
    const { sessionId, cellId, tabId } = props.surface;
    requestTerminalKill(sessionId, "TerminalSurfaceHost");
    if (cellId && tabId) removeCellTab(cellId, tabId);
  }

  return (
    <div
      class="leaf-frame terminal-surface-frame flex min-h-0 min-w-0 flex-col"
      classList={{
        "pane-maximized": props.surface.maximized,
        "pane-max-anim-target": isMaxAnimTarget(),
        "surface-dragging-source": isDragSource(),
        "is-snapped": isSnappedSource(),
        "is-edge-snapped": isEdgeSnappedSource(),
        "pane-unread-completed": isUnreadCompleted(),
        "file-drop-target": fileDropActive(),
      }}
      data-surface-key={props.surface.key}
      data-pane-id={props.surface.key}
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
          cellId={props.surface.cellId}
          tabId={props.surface.tabId}
          borderColor="transparent"
          visible={visible()}
          active={isActive()}
          initialPrompt={props.surface.initialPrompt}
          modelOverride={props.surface.modelOverride}
          recoverableAfterReboot={props.surface.recoverableAfterReboot}
          onSpawned={(sessionId) => {
            if (props.surface.cellId && props.surface.tabId) {
              setTabSessionId(props.surface.cellId, props.surface.tabId, sessionId);
              // Cross-harness review: if this tab was created as a reviewer
              // pane, link the new session to the reviewed one and clear the
              // pending fields so re-spawn paths don't re-link.
              consumeReviewSpawn(props.surface.cellId, props.surface.tabId, sessionId);
            }
          }}
          onRequestClose={() => {
            closeSurface();
          }}
        />
      </div>
    </div>
  );
};
