/**
 * §9.7 — sidebar resize handle.
 *
 * Drag the right edge to resize. Pointer-move samples are coalesced via
 * `requestAnimationFrame` so we only push one width into the Solid signal per
 * frame, and the backend `config_set_sidebar_width` invoke is fired exactly
 * once on drag-end (via `onCommit`).
 */

import { Component, createSignal } from "solid-js";
import { SIDEBAR_MAX_PX, SIDEBAR_MIN_PX } from "./constants";
import type { ResizeHandleProps } from "./types";

export const ResizeHandle: Component<ResizeHandleProps> = (handleProps) => {
  const [isDragging, setIsDragging] = createSignal(false);

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
      setIsDragging(false);
      handleProps.onCommit(pending);
    };
    handleProps.onDragChange(true);
    setIsDragging(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      class="sidebar-resize-handle"
      classList={{ "is-resizing": isDragging() }}
      onPointerDown={onPointerDown}
    />
  );
};
