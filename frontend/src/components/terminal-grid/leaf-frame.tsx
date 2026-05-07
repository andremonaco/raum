import { Component, Show, createMemo, onCleanup, onMount } from "solid-js";

import { type AgentKind } from "../../lib/agentKind";
import { dropPreviewPaths, dropTargetPaneId } from "../../lib/fileDrop";
import { ROOT_TARGET, dragState } from "../../lib/paneDnD";
import {
  LAYOUT_UNIT,
  focusedPaneId,
  maxAnimTargetId,
  setFocusedPaneId,
  toggleMaximize,
  type RuntimeCell,
} from "../../stores/runtimeLayoutStore";
import { isReviewLinked } from "../../stores/reviewLinkStore";
import { FileDropOverlay } from "./file-drop-overlay";
import { PaneHeader } from "./pane-header";
import { ReviewSnapOverlay } from "./review-overlay";
import { ReviewPickerOverlay } from "./review-picker-overlay";

// ---- LeafFrame: absolute-positioned pane ----------------------------------

export const LeafFrame: Component<{ cell: RuntimeCell; maximizedPaneId: string | null }> = (
  props,
) => {
  const isMaximized = () => props.maximizedPaneId === props.cell.id;
  // The pane currently transitioning to/from maximized — kept paint-visible
  // while every other leaf-frame is hidden by the `.maximize-anim` rule, so
  // the restore animation isn't covered by sibling chrome.
  const isMaxAnimTarget = () => maxAnimTargetId() === props.cell.id;
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

  /** Active session id of the cell, for review-link lookups. */
  const activeSession = createMemo<string | undefined>(
    () => props.cell.tabs.find((t) => t.id === props.cell.activeTabId)?.sessionId,
  );
  const isLinked = () => isReviewLinked(activeSession());

  /**
   * Cross-harness review snap target: this cell is the destination of an
   * engaged magnetic snap (paneDnD's `snapped` flag, gated on kind via
   * `canSnapTo`). Drives both the body blur (`.pane-review-snap-target`)
   * and the conditional render of `<ReviewSnapOverlay>` below. The kind
   * checks here are belt-and-suspenders against the eligibility callback.
   */
  const isReviewSnapTarget = createMemo(() => {
    const s = dragState();
    if (!s) return false;
    if (!s.snapped) return false;
    if (s.targetId !== props.cell.id) return false;
    if (props.cell.kind === "empty" || props.cell.kind === "shell") return false;
    if (s.sourceKind === "shell" || s.sourceKind === "empty") return false;
    return true;
  });

  /** Source pane that has snapped onto a target. Drives the
   *  `.is-snapped` chrome modifier so the pane stops following the
   *  cursor and visually docks onto the target's rect (the user's
   *  "hard border where the drag stops" cue). */
  const isSnappedSource = createMemo(() => {
    if (!isDragSource()) return false;
    const s = dragState();
    return s?.snapped === true && s.targetId !== null && s.targetId !== ROOT_TARGET;
  });
  const isFileDropTarget = createMemo(
    () =>
      props.cell.kind !== "empty" &&
      props.cell.kind !== "shell" &&
      props.cell.activeTabId === dropTargetPaneId(),
  );

  return (
    <div
      ref={(el) => {
        cellRef = el;
      }}
      data-dnd-target-pane-id={props.cell.id}
      data-pane-id={props.cell.activeTabId ?? ""}
      data-cell-id={props.cell.id}
      data-session-id={activeSession() ?? ""}
      data-review-linked={isLinked() ? "true" : undefined}
      class="leaf-frame terminal-chrome-frame flex min-h-0 min-w-0 flex-col"
      classList={{
        "pane-selected": isFocused(),
        "pane-dragging": isDragSource(),
        "is-snapped": isSnappedSource(),
        "pane-maximized": isMaximized(),
        "pane-max-anim-target": isMaxAnimTarget(),
        "pane-review-linked": isLinked(),
        "pane-review-snap-target": isReviewSnapTarget(),
        "file-drop-target": isFileDropTarget(),
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
        <ReviewSnapOverlay
          cellId={props.cell.id}
          cellKind={props.cell.kind}
          targetSessionId={activeSession()}
        />
      </div>
      <Show when={props.cell.kind !== "empty" && props.cell.kind !== "shell"}>
        <FileDropOverlay
          active={isFileDropTarget()}
          kind={props.cell.kind as AgentKind}
          paths={dropPreviewPaths()}
        />
        <ReviewPickerOverlay cellId={props.cell.id} />
      </Show>
    </div>
  );
};

// Re-export the cell type for callers that want it adjacent.
export type { RuntimeCell };
