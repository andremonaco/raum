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
  /** Monotonic counter used for LRU ordering. Higher = more recently used. */
  mru: number;
}

const panes = new Map<string, PaneEntry>();
let mruCounter = 0;

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
  opts: { forbidWebgl?: boolean } = {},
): void {
  if (panes.has(paneId)) return;
  const entry: PaneEntry = {
    paneId,
    terminal,
    addon: null,
    renderer: "canvas",
    forbidWebgl: !!opts.forbidWebgl,
    mru: mruCounter++,
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

/**
 * Promote `paneId` to WebGL, evicting the LRU WebGL pane to canvas if the
 * cap would otherwise be exceeded. No-op if the pane is already WebGL, or if
 * it has been demoted permanently due to context loss.
 */
export async function requestWebgl(paneId: string): Promise<void> {
  const entry = panes.get(paneId);
  if (!entry) return;
  entry.mru = mruCounter++;
  if (entry.renderer === "webgl") return;
  if (entry.forbidWebgl) return;

  if (currentWebglCount() >= MAX_WEBGL_PANES) {
    const lru = findLruWebgl(paneId);
    if (lru) installCanvas(lru);
  }
  await installWebgl(entry);
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
  setWarnings([]);
}
