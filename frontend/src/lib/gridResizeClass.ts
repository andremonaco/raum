/**
 * Window-resize → grid 1:1 tracking.
 *
 * During a window resize the grid root reflows continuously: percentage-based
 * pane rects recompute on every browser layout pass. The `.leaf-frame`
 * position transition (`left/top/width/height` over ~160 ms) is *wrong* for
 * this — it makes panes lag the window edge during a drag-resize, so the
 * terminal content visibly trails the chrome and xterm's fit measurement
 * fights the in-flight transition. The fix mirrors the divider-drag pattern:
 * while the window is actively resizing, stamp a `window-resize-active` class
 * on the grid root and let styles.css zero out `.leaf-frame` transitions
 * (same mechanism as `.is-resizing`), so panes track the new geometry 1:1.
 *
 * The class is removed on a short debounce after the last resize event — long
 * enough that a continuous drag-resize keeps it on, short enough that the
 * settle animation returns the instant the user lets go of the window edge.
 */

/** Class toggled on the grid root while the window is actively resizing. */
export const WINDOW_RESIZE_ACTIVE_CLASS = "window-resize-active";

/** Idle gap (ms) after the last resize event before we consider the resize
 *  finished and re-enable position transitions. Kept just above one frame's
 *  worth of resize-event coalescing so a continuous drag never flickers the
 *  class off mid-gesture, but short enough to feel immediate on release. */
const RESIZE_IDLE_MS = 140;

/**
 * Install a window `resize` listener that toggles {@link WINDOW_RESIZE_ACTIVE_CLASS}
 * on `getRoot()`'s return value. Returns a teardown function (remove the
 * listener, clear any pending debounce, strip the class). The root is read
 * lazily per event so it works even if the element mounts after install.
 */
export function installWindowResizeClass(getRoot: () => HTMLElement | null): () => void {
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function clearIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function onResize(): void {
    const root = getRoot();
    if (!root) return;
    root.classList.add(WINDOW_RESIZE_ACTIVE_CLASS);
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      // `is-resizing` removal in paneDnD/divider triggers TerminalPane's
      // MutationObserver to flush the throttled resize pump; the same
      // observer watches `window-resize-active` so the final geometry is
      // measured once the window settles.
      getRoot()?.classList.remove(WINDOW_RESIZE_ACTIVE_CLASS);
    }, RESIZE_IDLE_MS);
  }

  window.addEventListener("resize", onResize);
  return () => {
    window.removeEventListener("resize", onResize);
    clearIdleTimer();
    getRoot()?.classList.remove(WINDOW_RESIZE_ACTIVE_CLASS);
  };
}
