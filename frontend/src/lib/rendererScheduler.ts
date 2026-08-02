/**
 * §4.2 — renderer scheduler.
 *
 * At most 8 panes may simultaneously hold a WebGL renderer; everything else
 * runs on the canvas addon. Focusing a canvas pane promotes it to WebGL,
 * evicting the LRU pane to canvas if the cap is hit. If a pane's WebGL
 * context is lost (`webglcontextlost`) we demote it permanently for the rest
 * of the session and surface a console WARN + a `render-warning` window
 * event so the UI can show a banner.
 */

import { invoke } from "@tauri-apps/api/core";
import { CanvasAddon } from "@xterm/addon-canvas";
import type { Terminal, ITerminalAddon } from "@xterm/xterm";

// WebGL addon is deferred: it is only needed when a terminal receives focus,
// so we dynamic-import it on first use and cache the result.
let _webglAddonModule: Promise<typeof import("@xterm/addon-webgl")> | null = null;
function loadWebglAddon() {
  if (!_webglAddonModule) _webglAddonModule = import("@xterm/addon-webgl");
  return _webglAddonModule;
}
import { createSignal } from "solid-js";

export const MAX_WEBGL_PANES = 8;

export type RendererKind = "webgl" | "canvas";

interface PaneEntry {
  paneId: string;
  terminal: Terminal;
  /** The renderer addon currently installed. */
  addon: ITerminalAddon | null;
  renderer: RendererKind;
  /** If true, we've already lost a WebGL context here; never try again. */
  forbidWebgl: boolean;
  /** Hidden terminal surfaces stay alive but may not hold scarce WebGL slots. */
  visible: boolean;
  /** Monotonic counter used for LRU ordering. Higher = more recently used. */
  mru: number;
  /** Held WebGL when the page was backgrounded; re-promote on return. */
  pendingRepromote: boolean;
}

const panes = new Map<string, PaneEntry>();
let mruCounter = 0;

/**
 * True while the page itself is hidden (screen locked / window fully
 * occluded). WebGL contexts held during that window are pure GPU-memory
 * pressure — macOS sometimes responds by killing the whole WebContent
 * process — so we release them all and re-promote when the page returns.
 */
let backgrounded = false;

/**
 * Solid signal of WARN messages emitted by the scheduler. Components can
 * subscribe via [`useRendererScheduler`] to render a non-blocking banner.
 */
const [warnings, setWarnings] = createSignal<string[]>([]);

function emitWarn(message: string): void {
  console.warn(`[rendererScheduler] ${message}`);
  setWarnings((w) => [...w, message]);
  try {
    // Synthesized window event so non-Solid code can also observe the warning.
    window.dispatchEvent(new CustomEvent("render-warning", { detail: message }));
  } catch {
    // Ignore: `window` may be unavailable in a non-DOM environment.
  }
}

function currentWebglCount(): number {
  let n = 0;
  for (const e of panes.values()) {
    if (e.renderer === "webgl") n += 1;
  }
  return n;
}

function findLruWebgl(excludePaneId: string): PaneEntry | null {
  let lru: PaneEntry | null = null;
  for (const e of panes.values()) {
    if (e.paneId === excludePaneId) continue;
    if (e.renderer !== "webgl") continue;
    if (lru === null || e.mru < lru.mru) lru = e;
  }
  return lru;
}

function installCanvas(entry: PaneEntry): void {
  if (import.meta.env.DEV) {
    console.log(
      `%c[flicker-debug] installCanvas pane=${entry.paneId} from=${entry.renderer}`,
      "color:#c70",
    );
  }
  try {
    entry.addon?.dispose();
  } catch {
    /* dispose() is best-effort. */
  }
  const canvas = new CanvasAddon();
  try {
    entry.terminal.loadAddon(canvas);
    entry.addon = canvas;
    entry.renderer = "canvas";
  } catch (err) {
    emitWarn(`canvas renderer failed to load for ${entry.paneId}: ${String(err)}`);
    entry.addon = null;
    entry.renderer = "canvas";
  }
}

async function installWebgl(entry: PaneEntry): Promise<boolean> {
  if (entry.forbidWebgl) return false;
  if (import.meta.env.DEV) {
    console.log(
      `%c[flicker-debug] installWebgl pane=${entry.paneId} from=${entry.renderer}`,
      "color:#0a7",
    );
  }
  try {
    entry.addon?.dispose();
  } catch {
    /* best-effort */
  }
  let WebglAddon: typeof import("@xterm/addon-webgl").WebglAddon;
  try {
    ({ WebglAddon } = await loadWebglAddon());
  } catch (err) {
    emitWarn(`WebGL addon failed to load for ${entry.paneId}: ${String(err)}`);
    entry.forbidWebgl = true;
    installCanvas(entry);
    return false;
  }
  const webgl = new WebglAddon();
  try {
    webgl.onContextLoss(() => {
      emitWarn(`WebGL context lost on ${entry.paneId}; demoting to canvas for session`);
      entry.forbidWebgl = true;
      installCanvas(entry);
    });
    entry.terminal.loadAddon(webgl);
    entry.addon = webgl;
    entry.renderer = "webgl";
    return true;
  } catch (err) {
    emitWarn(`WebGL renderer failed to load for ${entry.paneId}: ${String(err)}`);
    entry.forbidWebgl = true;
    installCanvas(entry);
    return false;
  }
}

/** Register a pane; the scheduler installs an initial canvas addon. */
export function registerPane(
  paneId: string,
  terminal: Terminal,
  opts: { forbidWebgl?: boolean; visible?: boolean } = {},
): void {
  if (panes.has(paneId)) return;
  const entry: PaneEntry = {
    paneId,
    terminal,
    addon: null,
    renderer: "canvas",
    forbidWebgl: !!opts.forbidWebgl,
    visible: opts.visible !== false,
    mru: mruCounter++,
    pendingRepromote: false,
  };
  panes.set(paneId, entry);
  installCanvas(entry);
}

export function unregisterPane(paneId: string): void {
  const entry = panes.get(paneId);
  if (!entry) return;
  try {
    entry.addon?.dispose();
  } catch {
    /* best-effort */
  }
  panes.delete(paneId);
}

export function setPaneVisibility(paneId: string, visible: boolean): void {
  const entry = panes.get(paneId);
  if (!entry) return;
  if (import.meta.env.DEV && entry.visible !== visible) {
    console.log(
      `%c[flicker-debug] setPaneVisibility pane=${paneId} ${entry.visible} -> ${visible} renderer=${entry.renderer}`,
      "color:#a4a",
    );
  }
  entry.visible = visible;
  if (!visible && entry.renderer === "webgl") {
    installCanvas(entry);
  }
}

/**
 * Promote `paneId` to WebGL, evicting the LRU WebGL pane to canvas if the
 * cap would otherwise be exceeded. No-op if the pane is already WebGL, or if
 * it has been demoted permanently due to context loss.
 */
export async function requestWebgl(paneId: string): Promise<void> {
  const entry = panes.get(paneId);
  if (!entry) return;
  entry.mru = mruCounter++;
  if (backgrounded) return;
  if (entry.renderer === "webgl") return;
  if (entry.forbidWebgl) return;
  if (!entry.visible) return;

  if (currentWebglCount() >= MAX_WEBGL_PANES) {
    const lru = findLruWebgl(paneId);
    if (lru) installCanvas(lru);
  }
  await installWebgl(entry);
}

/**
 * Release every WebGL context because the page went hidden. Demoted panes
 * are marked for re-promotion — this is *not* a context loss, so
 * `forbidWebgl` stays untouched.
 */
export function demoteAllForBackground(): void {
  backgrounded = true;
  for (const entry of panes.values()) {
    if (entry.renderer !== "webgl") continue;
    entry.pendingRepromote = true;
    installCanvas(entry);
  }
}

/**
 * Best-effort backend log line so wake-phase costs land in the daily log
 * next to the probe/reattach markers. The `Promise.resolve().then` wrapper
 * absorbs the synchronous throw `invoke` produces under vitest/jsdom.
 */
function reportWakePhase(phase: string, ms: number): void {
  void Promise.resolve()
    .then(() => invoke("webview_wake_report", { phase, ms: Math.max(0, Math.round(ms)) }))
    .catch(() => {});
}

/**
 * One frame's worth of breathing room. rAF is raced against a short timeout
 * because rAF never fires on a hidden page (and jsdom may not schedule it) —
 * the yield must never become a stall.
 */
function yieldToFrame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    try {
      requestAnimationFrame(() => finish());
    } catch {
      /* non-DOM environment */
    }
    setTimeout(finish, 50);
  });
}

/**
 * Monotonic token for [`endBackgroundDemotion`] runs. The loop now spans
 * real time (one frame-yield per pane), so a hide→show flicker can start a
 * second run while the first is still awaiting — the stale run must stop
 * touching entries the moment a newer one (or a re-hide) supersedes it.
 */
let repromoteGeneration = 0;

/**
 * Page is visible again: re-promote the panes that held WebGL when it went
 * hidden. Each promotion is synchronous main-thread work (shader compile,
 * glyph atlas, full repaint), so the loop yields a frame between panes to
 * keep input responsive right after unlock, and runs MRU-first so the pane
 * the user is looking at gets WebGL in the first frame. `requestWebgl`
 * re-stamps `mru`; restoring it afterwards preserves the pre-background
 * LRU order the eviction logic depends on.
 *
 * The loop is abortable: a re-hide mid-run (second lock, full occlusion)
 * or a newer run supersedes it. Crucially each entry's `pendingRepromote`
 * is cleared only at ITS turn, and the abort check runs before that clear
 * — so panes the aborted run never reached keep their mark and are picked
 * up by the next `endBackgroundDemotion` instead of being stranded on the
 * canvas renderer for the session.
 */
export async function endBackgroundDemotion(): Promise<void> {
  backgrounded = false;
  const generation = ++repromoteGeneration;
  const marked = Array.from(panes.values())
    .filter((e) => e.pendingRepromote)
    .sort((a, b) => b.mru - a.mru);
  if (marked.length === 0) return;
  // Warm the dynamic import off the first promotion's critical path.
  void loadWebglAddon().catch(() => {});
  const startedMs = performance.now();
  // Aborted runs report under a distinct phase: the slow wakes are exactly
  // the ones most likely to be interrupted (each pane adds up to a frame of
  // wall time), and dropping them would bias the metric toward fast wakes.
  const reportAborted = (): void => {
    reportWakePhase("webgl-repromote-aborted", performance.now() - startedMs);
  };
  for (const entry of marked) {
    if (backgrounded || generation !== repromoteGeneration) {
      reportAborted();
      return;
    }
    entry.pendingRepromote = false;
    if (!entry.visible || entry.forbidWebgl) continue;
    const mru = entry.mru;
    await requestWebgl(entry.paneId);
    entry.mru = mru;
    if (backgrounded && entry.renderer !== "webgl") {
      // A re-hide landed inside `requestWebgl` (it early-returns while
      // backgrounded): this pane's mark was already cleared but it never
      // got its context back — restore the mark for the next wake.
      entry.pendingRepromote = true;
      reportAborted();
      return;
    }
    await yieldToFrame();
  }
  reportWakePhase("webgl-repromote", performance.now() - startedMs);
}

/**
 * Wire `document.visibilitychange` to the background demotion above.
 * macOS marks the page hidden when the window is fully occluded — which
 * includes the locked screen — so this sheds up to [`MAX_WEBGL_PANES`] GPU
 * contexts for the duration of a lock. Best-effort hardening: if the OS
 * kills the WebContent process anyway, the backend's focus-gated health
 * check reloads the page. Returns a remover for `onCleanup`.
 */
export function installBackgroundRendererDemotion(): () => void {
  // Wall-clock (not performance.now): a suspended page's monotonic clock
  // may not advance, and "how long was the screen locked" is wall time.
  let hiddenAtMs: number | null = null;
  const onVisibilityChange = (): void => {
    if (document.hidden) {
      hiddenAtMs = Date.now();
      demoteAllForBackground();
    } else {
      if (hiddenAtMs !== null) {
        reportWakePhase("hidden-for", Date.now() - hiddenAtMs);
        hiddenAtMs = null;
      }
      void endBackgroundDemotion();
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

export interface SchedulerSnapshot {
  paneId: string;
  renderer: RendererKind;
  forbidWebgl: boolean;
  mru: number;
}

export function snapshot(): SchedulerSnapshot[] {
  return Array.from(panes.values()).map((e) => ({
    paneId: e.paneId,
    renderer: e.renderer,
    forbidWebgl: e.forbidWebgl,
    mru: e.mru,
  }));
}

/**
 * Hook exposing scheduler state to Solid components. Today it only surfaces
 * the reactive warning list; future Waves (perf banner, renderer badge in
 * pane chrome) can pull richer state through here.
 */
export function useRendererScheduler(): {
  warnings: () => string[];
  requestWebgl: (paneId: string) => Promise<void>;
  snapshot: () => SchedulerSnapshot[];
} {
  return {
    warnings,
    requestWebgl,
    snapshot,
  };
}

/** Test-only helper: wipe scheduler state. */
export function __resetSchedulerForTests(): void {
  for (const e of panes.values()) {
    try {
      e.addon?.dispose();
    } catch {
      /* best-effort */
    }
  }
  panes.clear();
  mruCounter = 0;
  backgrounded = false;
  setWarnings([]);
}
