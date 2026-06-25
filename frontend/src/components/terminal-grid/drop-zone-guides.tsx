/**
 * <DropZoneGuides> — the drop affordance shown while dragging a pane: a grip
 * handle on every seam and outer edge, so each drop boundary reads as
 * "grab / drop here" at a glance. One element type, solid pills (no glass —
 * backdrop blur shimmers as terminal output streams behind it), kept stable
 * across pointermoves (the geometry depends only on the layout tree, so
 * nothing re-mounts or re-animates frame to frame).
 *
 * The active feedback is the latch itself: once the dwell arms a zone, these
 * hide and the dragged pane settles into its slot (it's its own landing
 * preview) while the rest reflow. Hidden during a review snap (which owns its
 * own in-pane overlay). Rendered in the DnD chrome layer (`pointer-events:
 * none`, above the panes).
 */

import { Component, For, Show, createMemo } from "solid-js";

import { dragState } from "../../lib/paneDnD";
import { type LayoutNode } from "../../lib/layoutTree";
import { computeAnchors } from "../../lib/dropZones";

/** Centering / edge-aligned placement (border handles align flush so they
 *  don't render half off-screen). */
function anchorTransform(cx: number, cy: number): string {
  const tx = cx <= 0 ? "0" : cx >= 100 ? "-100%" : "-50%";
  const ty = cy <= 0 ? "0" : cy >= 100 ? "-100%" : "-50%";
  return `translate(${tx}, ${ty})`;
}

export const DropZoneGuides: Component<{ tree: LayoutNode | null }> = (props) => {
  // Discovery phase as a STABLE boolean — true for the whole drag until the
  // dwell arms the preview (and not mid review-snap). Doesn't change identity
  // on every pointermove, so the handles mount once.
  const phase = createMemo(() => {
    const s = dragState();
    return !!s && !s.armed && !s.snapped;
  });

  // Depends ONLY on the tree (stable during a drag) → the <For> never remounts
  // mid-drag, so the handles don't flicker.
  const anchors = createMemo(() => computeAnchors(props.tree));

  return (
    <Show when={phase()}>
      <div class="drop-anchors">
        <For each={anchors()}>
          {(a) => (
            <div
              class={`drop-anchor drop-anchor-${a.orient}`}
              style={{ left: `${a.cx}%`, top: `${a.cy}%`, transform: anchorTransform(a.cx, a.cy) }}
            >
              {/* Grip dots — the universal "grab / drop here" handle. */}
              <span class="drop-grip" />
              <span class="drop-grip" />
              <span class="drop-grip" />
            </div>
          )}
        </For>
      </div>
    </Show>
  );
};
