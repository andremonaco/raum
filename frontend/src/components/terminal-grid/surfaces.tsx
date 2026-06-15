import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { type Rect } from "../../lib/layoutTree";
import { dropTargetPaneId } from "../../lib/fileDrop";
import { ROOT_TARGET, dragState } from "../../lib/paneDnD";
import { type TerminalSurfaceDescriptor } from "../../lib/terminalSurfaceProjection";
import {
  LAYOUT_UNIT,
  maxAnimTargetId,
  removeCellTab,
  runtimeLayoutStore,
  setActiveTabId,
  setFocusedPaneId,
  setTabSessionId,
  toggleMaximize,
} from "../../stores/runtimeLayoutStore";
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
          const surface = createMemo(() => byKey().get(key) ?? null);
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
    const { cellId, tabId, sessionId } = props.surface;
    if (!cellId) return;
    if (tabId && runtimeLayoutStore.panes[cellId]?.activeTabId !== tabId) {
      setActiveTabId(cellId, tabId);
    }
    setFocusedPaneId(cellId);
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
          active={props.surface.active}
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
