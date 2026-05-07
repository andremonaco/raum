/**
 * Global mouse-idle signal.
 *
 * `mouseIdle()` is `true` when no `mousemove` event has fired on the
 * window in the last `IDLE_AFTER_MS` milliseconds, and flips to
 * `false` synchronously on the next move. Used by the per-pane prompt
 * overlay to fade out whenever the user touches the mouse, so the
 * overlay never obstructs interaction with xterm.
 *
 * Lives at module scope (single shared signal across every pane) and
 * installs the `mousemove` listener exactly once on first import.
 * The pointer-events:none overlay does not consume the event itself.
 */

import { createSignal } from "solid-js";

const IDLE_AFTER_MS = 1200;

const [mouseIdle, setMouseIdle] = createSignal(true);

let installed = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function bumpIdleTimer(): void {
  if (mouseIdle()) setMouseIdle(false);
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    setMouseIdle(true);
    idleTimer = null;
  }, IDLE_AFTER_MS);
}

function installListener(): void {
  if (installed) return;
  installed = true;
  if (typeof window === "undefined") return;
  window.addEventListener("mousemove", bumpIdleTimer, { passive: true });
}

installListener();

export { mouseIdle };

/** Test-only reset hook: clear the timer and force-reset to idle. */
export function __resetMouseIdleForTests(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  setMouseIdle(true);
}
