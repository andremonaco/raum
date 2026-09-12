/**
 * §4.2 — renderer scheduler.
 *
 * At most 8 panes may simultaneously hold a WebGL renderer; everything else
 * runs on the canvas addon. Focusing a canvas pane promotes it to WebGL,
 * evicting the LRU pane to canvas if the cap is hit; a merely-visible pane
 * takes a slot only while one is free (`requestWebglIfSlotFree`), so focus
 * always wins a contested slot. If a pane's WebGL
 * context is lost (`webglcontextlost`) we demote it permanently for the rest
 * of the session and surface a console WARN + a `render-warning` window
 * event so the UI can show a banner.
 *
 * Presentation residency (change `instant-view-switching`, task 4.3) rides on
 * top of that under the `warm-residency` policy: hiding a pane no longer
 * disposes its addon on the spot, it parks the pane in `warm-hidden` for a
 * few seconds so an A->B->A navigation costs no renderer work at all. Budgets
 * (entry count + estimated backing bytes) and a deferred, cancellable
 * reclamation bound how much stays resident. `legacy` selects exactly the
 * pre-residency lifecycle and is the default until the native spike in
 * `openspec/changes/instant-view-switching/measurements/presentation-policy.md`
 * has run.
 *
 * Promotion is asynchronous (the WebGL addon is dynamically imported), so a
 * pane owns at most one promotion *job* at a time. A job carries the entry's
 * lifecycle generation, so a hide/unregister that lands mid-flight cancels it
 * and nothing is ever allocated into a stale entry. Focus does not enqueue a
 * second job behind an opportunistic one — it raises that job's priority and
 * pulls it out of the frame queue.
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

/** `dom` means no renderer addon is installed: xterm's own DOM renderer draws. */
export type RendererKind = "webgl" | "canvas" | "dom";

/**
 * Presentation residency for hidden panes.
 *
 * - `legacy` — the pre-residency lifecycle: hiding a pane disposes its
 *   renderer addon immediately and hidden hosts stay `visibility: hidden`.
 * - `warm-residency` — a bounded set of recently hidden panes keeps its addon
 *   (`warm-hidden`) so returning to them is free, and hidden hosts are
 *   `display: none` so they stop laying out and painting.
 *
 * Host presentation and scheduler lifecycle must agree, so `surfaces.tsx`
 * reads this same switch — mixed ownership is not allowed.
 */
export type PresentationPolicy = "legacy" | "warm-residency";

/** Per-entry residency state. `disposed` is simply an unregistered entry. */
export type PresentationState = "visible" | "warm-hidden" | "cold-hidden";

const POLICY_STORAGE_KEY = "raum:presentation-policy";

/**
 * There is no persisted UI-settings store on the frontend boot path (the only
 * comparable knob, the terminal font size, also lives in `localStorage`), so
 * the switch is read once here. Flip it with
 * `localStorage.setItem("raum:presentation-policy", "warm-residency")` and
 * reload, or call `setPresentationPolicy` from the console.
 */
function readInitialPolicy(): PresentationPolicy {
  try {
    return localStorage.getItem(POLICY_STORAGE_KEY) === "warm-residency"
      ? "warm-residency"
      : "legacy";
  } catch {
    // No DOM storage (tests, locked-down webview): stay on the safe default.
    return "legacy";
  }
}

let policy: PresentationPolicy = readInitialPolicy();

export function getPresentationPolicy(): PresentationPolicy {
  return policy;
}

/** Rollback switch. Leaving `warm-residency` colds every resident hidden pane. */
export function setPresentationPolicy(next: PresentationPolicy): void {
  if (policy === next) return;
  policy = next;
  try {
    localStorage.setItem(POLICY_STORAGE_KEY, next);
  } catch {
    /* best-effort persistence */
  }
  if (policy === "legacy") {
    for (const entry of panes.values()) if (!entry.visible) coldEntry(entry);
  }
}

// --- residency budgets -----------------------------------------------------
// Every constant below is a starting point, not a measurement: the native
// spike (tasks 4.1/4.2) has not run. See
// `openspec/changes/instant-view-switching/measurements/presentation-policy.md`.

/**
 * How long a hidden pane keeps its addon before reclamation. Long enough that
 * flipping between two views is free, short enough that a project switch does
 * not leave a whole grid resident.
 * pending native measurement (task 4.2)
 */
export const WARM_RECLAIM_MS = 4_000;

/**
 * Warm-hidden entries kept at most; the LRU ones are colded first.
 * pending native measurement (task 4.2)
 */
export const MAX_WARM_HIDDEN_PANES = 4;

/**
 * Estimated renderer backing-store budget across every pane that still holds
 * an addon (visible + warm-hidden). A context count alone does not bound
 * canvas memory — one retina pane is roughly 4 x w*h*dpr^2 x 4 B.
 * pending native measurement (task 4.2)
 */
export const MAX_PRESENTATION_BYTES = 384 * 1024 * 1024;

const budget = { warmEntries: MAX_WARM_HIDDEN_PANES, bytes: MAX_PRESENTATION_BYTES };
let reclaimMs = WARM_RECLAIM_MS;

/** Injectable so tests can drive reclamation without real time. */
interface PresentationTimer {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}
const realTimer: PresentationTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
let timer: PresentationTimer = realTimer;

type JobPriority = "opportunistic" | "focus";
type JobState = "queued" | "running" | "cancelled" | "done";

/** At most one promotion per pane is alive at a time — see `PaneEntry.pending`. */
interface PromotionJob {
  entry: PaneEntry;
  /** `entry.generation` at creation; a hide/unregister bumps it and strands us. */
  generation: number;
  priority: JobPriority;
  state: JobState;
  /**
   * Whether this job holds one of the `reservedSlots`. The flag is the sole
   * owner record: cancellation and the `finally` both route their release
   * through it, so the shared counter can never be decremented twice.
   */
  ownsReservation: boolean;
  promise: Promise<void>;
  settle: () => void;
}

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
  /** Residency state; only `warm-hidden` entries hold an addon while hidden. */
  presentation: PresentationState;
  /** Armed while `warm-hidden`; cancelled when the pane comes back. */
  reclaimTimer: unknown | null;
  /** Last non-zero backing size, so an unmeasurable host is not free. */
  lastPx: { w: number; h: number } | null;
  /** Monotonic counter used for LRU ordering. Higher = more recently used. */
  mru: number;
  /** Held WebGL when the page was backgrounded; re-promote on return. */
  pendingRepromote: boolean;
  /** Bumped on hide and unregister; invalidates any job that captured it. */
  generation: number;
  pending: PromotionJob | null;
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

/**
 * Eviction victim for a contested WebGL slot. Hidden holders go first: a
 * warm-hidden pane paints nothing, so taking its context costs the user
 * nothing now and at most one re-promotion later, while evicting a visible
 * pane makes a pane the user is looking at repaint.
 */
function findLruWebgl(excludePaneId: string): PaneEntry | null {
  let hidden: PaneEntry | null = null;
  let shown: PaneEntry | null = null;
  for (const e of panes.values()) {
    if (e.paneId === excludePaneId) continue;
    if (e.renderer !== "webgl") continue;
    if (e.visible) {
      if (shown === null || e.mru < shown.mru) shown = e;
    } else if (hidden === null || e.mru < hidden.mru) {
      hidden = e;
    }
  }
  return hidden ?? shown;
}

/**
 * Take the WebGL context off `entry`. A visible pane needs a renderer right
 * away; a hidden one must NOT get a replacement CanvasAddon built for it
 * (design decision 3) — it drops to cold-hidden and re-promotes when shown.
 */
function demoteFromWebgl(entry: PaneEntry): void {
  if (entry.visible) {
    installCanvas(entry);
    return;
  }
  coldEntry(entry);
}

/** Drop the installed addon; the pane falls back to xterm's DOM renderer. */
function disposeAddon(entry: PaneEntry): void {
  try {
    entry.addon?.dispose();
  } catch {
    /* dispose() is best-effort. */
  }
  entry.addon = null;
  entry.renderer = "dom";
}

function installCanvas(entry: PaneEntry): void {
  if (import.meta.env.DEV) {
    console.log(
      `%c[flicker-debug] installCanvas pane=${entry.paneId} from=${entry.renderer}`,
      "color:#c70",
    );
  }
  disposeAddon(entry);
  try {
    const canvas = new CanvasAddon();
    entry.terminal.loadAddon(canvas);
    entry.addon = canvas;
    entry.renderer = "canvas";
  } catch (err) {
    // Leaves the pane on the DOM renderer: degraded but usable.
    emitWarn(`canvas renderer failed to load for ${entry.paneId}: ${String(err)}`);
  }
}

/**
 * A visible pane that is NOT getting WebGL (cap hit, forbidden, backgrounded,
 * hidden mid-promotion) still needs a renderer. Installed lazily here rather
 * than eagerly on register/show, so a pane headed straight for WebGL is not
 * painted twice — with a dozen panes flipping visible on a project switch,
 * that double paint was a visible stall.
 */
function ensureCanvas(entry: PaneEntry): void {
  // An unregistered entry must never be allocated into, however late the
  // caller is: its terminal may already be disposed.
  if (panes.get(entry.paneId) !== entry) return;
  if (entry.visible && entry.addon === null) installCanvas(entry);
}

// ---------------------------------------------------------------------------
// Presentation residency
// ---------------------------------------------------------------------------

/**
 * Surfaces each renderer keeps alive. ESTIMATES: xterm's canvas addon stacks
 * roughly four full-pane layers; WebGL keeps one framebuffer plus a glyph
 * atlas. GPU-process memory is the external check, not this arithmetic.
 */
const CANVAS_SURFACES = 4;
const WEBGL_SURFACES = 2;
/** Stand-in for a host that has never measured non-zero, so an unmeasured
 *  pane is never accounted as free. */
const ASSUMED_CSS_PX = { w: 1280, h: 800 };

/** Physical (device) pixels of the pane's host, cached at its last non-zero. */
function backingPixels(entry: PaneEntry): { w: number; h: number } {
  const el = (entry.terminal as unknown as { element?: HTMLElement | null }).element ?? null;
  const dpr = globalThis.devicePixelRatio || 1;
  const w = Math.round((el?.clientWidth ?? 0) * dpr);
  const h = Math.round((el?.clientHeight ?? 0) * dpr);
  if (w > 0 && h > 0) {
    entry.lastPx = { w, h };
    return entry.lastPx;
  }
  return (
    entry.lastPx ?? {
      w: Math.round(ASSUMED_CSS_PX.w * dpr),
      h: Math.round(ASSUMED_CSS_PX.h * dpr),
    }
  );
}

/** Estimated backing bytes held by this pane's renderer addon. */
function estimatePresentationBytes(entry: PaneEntry): number {
  if (entry.addon === null) return 0;
  const { w, h } = backingPixels(entry);
  return w * h * 4 * (entry.renderer === "webgl" ? WEBGL_SURFACES : CANVAS_SURFACES);
}

function clearReclaim(entry: PaneEntry): void {
  if (entry.reclaimTimer === null) return;
  timer.clear(entry.reclaimTimer);
  entry.reclaimTimer = null;
}

/** warm-hidden -> cold-hidden: release the addon, allocate nothing. */
function coldEntry(entry: PaneEntry): void {
  clearReclaim(entry);
  disposeAddon(entry);
  entry.presentation = "cold-hidden";
}

/** One deferred, cancellable reclamation per warm entry. */
function armReclaim(entry: PaneEntry): void {
  clearReclaim(entry);
  entry.reclaimTimer = timer.set(() => {
    entry.reclaimTimer = null;
    // The pane may have been shown again or unregistered in the meantime.
    if (panes.get(entry.paneId) !== entry || entry.visible) return;
    coldEntry(entry);
  }, reclaimMs);
}

/**
 * Cold the LRU warm-hidden entries until both budgets hold again. Bytes are
 * summed over every addon holder (visible included) because the budget bounds
 * total renderer memory; only hidden entries are ever taken, so a visible pane
 * is never rebuilt to make room.
 */
function enforceWarmBudget(): void {
  for (;;) {
    let warmCount = 0;
    let bytes = 0;
    let lru: PaneEntry | null = null;
    for (const e of panes.values()) {
      if (e.addon === null) continue;
      bytes += estimatePresentationBytes(e);
      if (e.presentation !== "warm-hidden") continue;
      warmCount += 1;
      if (lru === null || e.mru < lru.mru) lru = e;
    }
    if (lru === null) return;
    if (warmCount <= budget.warmEntries && bytes <= budget.bytes) return;
    coldEntry(lru);
  }
}

// ---------------------------------------------------------------------------
// Promotion jobs
// ---------------------------------------------------------------------------

/** Context slots claimed by running jobs that have not installed yet. */
let reservedSlots = 0;

/**
 * Opportunistic jobs only: one promotion per frame, because each is
 * synchronous shader-compile + atlas + repaint work and a project switch
 * flips a whole grid visible in one tick. Focus promotions never enter this
 * queue — they run immediately so the pane the user is looking at paints in
 * the first frame.
 */
const queue: PromotionJob[] = [];
let draining = false;
/** Bumped by the test reset so a drain loop from a previous test bails out. */
let schedulerEpoch = 0;

function createJob(entry: PaneEntry, priority: JobPriority): PromotionJob {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const job: PromotionJob = {
    entry,
    generation: entry.generation,
    priority,
    state: "queued",
    ownsReservation: false,
    promise,
    settle,
  };
  entry.pending = job;
  return job;
}

/** Idempotent across success, error, cancellation and unregister. */
function finishJob(job: PromotionJob, state: "done" | "cancelled"): void {
  if (job.state !== "done" && job.state !== "cancelled") job.state = state;
  if (job.ownsReservation) {
    job.ownsReservation = false;
    reservedSlots -= 1;
  }
  if (job.entry.pending === job) job.entry.pending = null;
  job.settle();
}

function cancelPending(entry: PaneEntry): void {
  const job = entry.pending;
  if (job) finishJob(job, "cancelled");
}

/** Everything a promotion needs to still be true, checked around every await. */
function jobIsLive(job: PromotionJob): boolean {
  const entry = job.entry;
  if (job.state === "cancelled" || job.state === "done") return false;
  if (panes.get(entry.paneId) !== entry) return false;
  if (entry.generation !== job.generation) return false;
  return entry.visible && !backgrounded && !entry.forbidWebgl && entry.renderer !== "webgl";
}

function removeFromQueue(job: PromotionJob): void {
  const i = queue.indexOf(job);
  if (i >= 0) queue.splice(i, 1);
}

/** Drops dead jobs without spending a frame on each — see design decision 3. */
function takeNextLiveJob(): PromotionJob | null {
  while (queue.length > 0) {
    const job = queue.shift()!;
    if (jobIsLive(job)) return job;
    finishJob(job, "cancelled");
  }
  return null;
}

function enqueue(job: PromotionJob): void {
  queue.push(job);
  void drainQueue();
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  const epoch = schedulerEpoch;
  try {
    for (;;) {
      // Purge first: a queue that only holds cancelled jobs must not cost a
      // frame, and must not delay whatever the user navigated to.
      if (queue.length > 0 && !queue.some(jobIsLive)) {
        while (takeNextLiveJob() !== null) {
          /* takeNextLiveJob cancels as it goes */
        }
      }
      if (queue.length === 0) return;
      await yieldToFrame();
      if (epoch !== schedulerEpoch) return;
      // Taken after the yield so a focus request can still claim the job.
      const job = takeNextLiveJob();
      if (!job) continue;
      await runJob(job);
    }
  } finally {
    if (epoch === schedulerEpoch) draining = false;
  }
}

/**
 * Claim one context slot for this job. `installed + reserved` is the real
 * ceiling: a grid promoting at once would otherwise blow past the cap while
 * every job is still inside its dynamic import.
 */
function reserveSlot(job: PromotionJob): boolean {
  if (currentWebglCount() + reservedSlots >= MAX_WEBGL_PANES) {
    // Only focus evicts. An opportunistic pane keeps its current usable
    // renderer rather than stealing a context from a pane already painting.
    if (job.priority !== "focus") return false;
    const victim = findLruWebgl(job.entry.paneId);
    if (!victim) return false;
    demoteFromWebgl(victim);
  }
  job.ownsReservation = true;
  reservedSlots += 1;
  return true;
}

async function runJob(job: PromotionJob): Promise<void> {
  const entry = job.entry;
  job.state = "running";
  try {
    if (import.meta.env.DEV) {
      console.log(
        `%c[flicker-debug] installWebgl pane=${entry.paneId} from=${entry.renderer}`,
        "color:#0a7",
      );
    }
    let WebglAddon: typeof import("@xterm/addon-webgl").WebglAddon;
    try {
      ({ WebglAddon } = await loadWebglAddon());
    } catch (err) {
      emitWarn(`WebGL addon failed to load for ${entry.paneId}: ${String(err)}`);
      entry.forbidWebgl = true;
      ensureCanvas(entry);
      return;
    }
    // The import above spans real time (tens of ms for the first pane to need
    // it). The pane may have been hidden, unregistered or the page
    // backgrounded meanwhile — taking a slot now would strand a context no
    // demotion path can reclaim, since every demotion checks
    // `renderer === "webgl"` on a *registered* entry.
    if (!jobIsLive(job)) {
      if (backgrounded && entry.visible && panes.get(entry.paneId) === entry) {
        entry.pendingRepromote = true;
      }
      ensureCanvas(entry);
      return;
    }
    if (!reserveSlot(job)) {
      ensureCanvas(entry);
      return;
    }
    // No await from here to the install: the ownership transition off the old
    // addon and onto the new one is synchronous and cannot be preempted.
    const startedMs = performance.now();
    disposeAddon(entry);
    let webgl: ITerminalAddon | null = null;
    try {
      const addon = new WebglAddon();
      webgl = addon;
      addon.onContextLoss(() => {
        // A context loss from an addon we already replaced (or from a pane
        // that has since been unregistered) says nothing about the renderer
        // in use now, and must not blacklist WebGL for this pane.
        if (panes.get(entry.paneId) !== entry || entry.addon !== addon) return;
        emitWarn(`WebGL context lost on ${entry.paneId}; demoting to canvas for session`);
        entry.forbidWebgl = true;
        demoteFromWebgl(entry);
      });
      entry.terminal.loadAddon(addon);
      entry.addon = addon;
      entry.renderer = "webgl";
      reportWakePhase("webgl-install", performance.now() - startedMs);
    } catch (err) {
      emitWarn(`WebGL renderer failed to load for ${entry.paneId}: ${String(err)}`);
      entry.forbidWebgl = true;
      try {
        webgl?.dispose();
      } catch {
        /* best-effort: the half-built addon must not retain its context */
      }
      entry.addon = null;
      installCanvas(entry);
    }
  } finally {
    finishJob(job, "done");
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
    renderer: "dom",
    forbidWebgl: !!opts.forbidWebgl,
    visible: opts.visible !== false,
    presentation: opts.visible !== false ? "visible" : "cold-hidden",
    reclaimTimer: null,
    lastPx: null,
    mru: mruCounter++,
    pendingRepromote: false,
    generation: 0,
    pending: null,
  };
  panes.set(paneId, entry);
}

export function unregisterPane(paneId: string): void {
  const entry = panes.get(paneId);
  if (!entry) return;
  entry.generation += 1;
  cancelPending(entry);
  clearReclaim(entry);
  panes.delete(paneId);
  disposeAddon(entry);
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
  if (visible) {
    // Show while warm: the addon is still installed, so this costs zero
    // renderer work — just call off the reclamation counting down on it.
    // Show while cold installs nothing here either: the pane's visibility
    // effect requests WebGL next, and `ensureCanvas` covers every decline.
    clearReclaim(entry);
    entry.presentation = "visible";
    return;
  }
  entry.generation += 1;
  cancelPending(entry);
  if (policy === "legacy" || entry.addon === null) {
    // Legacy lifecycle: a hidden tab holds no renderer addon at all: xterm
    // falls back to its DOM renderer, which owns no canvases. The canvas
    // addon keeps four pane-sized GPU surfaces (~60 MB per pane at retina)
    // alive even under `visibility: hidden`, so dozens of background tabs ran
    // the WebContent process into the gigabytes.
    coldEntry(entry);
    return;
  }
  // Warm residency: keep the addon, refresh recency, and arm ONE cancellable
  // reclamation. Budgets may cold this or an older entry right away.
  entry.presentation = "warm-hidden";
  entry.mru = mruCounter++;
  armReclaim(entry);
  enforceWarmBudget();
}

/**
 * Opportunistic promotion for a pane that is on screen but not focused.
 * Callers use this instead of [`requestWebgl`] when the pane has no claim
 * on a contested slot: it never evicts and never bumps `mru`, so focus stays
 * the tiebreaker whenever the cap is contested.
 */
export function requestWebglIfSlotFree(paneId: string): void {
  const entry = panes.get(paneId);
  if (!entry) return;
  if (entry.renderer === "webgl") return;
  if (backgrounded || entry.forbidWebgl || !entry.visible) {
    ensureCanvas(entry);
    return;
  }
  if (entry.pending) return;
  // Admission check only — no slot is reserved until the job actually runs.
  // A pane with no chance at the cap gets its canvas now instead of waiting
  // out the queue for a refusal. Cancelled jobs still sitting in the queue
  // claim nothing, so they must not count against this pane.
  const queuedLive = queue.reduce((n, job) => n + (jobIsLive(job) ? 1 : 0), 0);
  if (currentWebglCount() + reservedSlots + queuedLive >= MAX_WEBGL_PANES) {
    ensureCanvas(entry);
    return;
  }
  enqueue(createJob(entry, "opportunistic"));
}

/**
 * Promote `paneId` to WebGL, evicting the LRU WebGL pane to canvas if the
 * cap would otherwise be exceeded. No-op if the pane is already WebGL, or if
 * it has been demoted permanently due to context loss.
 */
export function requestWebgl(paneId: string): Promise<void> {
  const entry = panes.get(paneId);
  if (!entry) return Promise.resolve();
  entry.mru = mruCounter++;
  if (entry.renderer === "webgl") return Promise.resolve();
  if (backgrounded || entry.forbidWebgl || !entry.visible) {
    ensureCanvas(entry);
    return Promise.resolve();
  }
  const pending = entry.pending;
  if (pending) {
    // Raise the existing job instead of enqueuing a second installation.
    pending.priority = "focus";
    if (pending.state === "queued") {
      // Still waiting on a frame it no longer has to wait for.
      removeFromQueue(pending);
      return runJob(pending);
    }
    return pending.promise;
  }
  return runJob(createJob(entry, "focus"));
}

/**
 * The page went hidden (screen lock, full occlusion, window switch). Brief
 * occlusion is the common case, so nothing is released and nothing is built
 * here: pending promotions are cancelled so no context is allocated into a
 * page nobody can see, and current WebGL holders are marked so a later
 * reclamation is undone on return. Releasing is
 * [`reclaimBackgroundPresentation`]'s job, after a grace period.
 */
export function suspendHiddenPresentation(): void {
  backgrounded = true;
  for (const entry of panes.values()) {
    cancelPending(entry);
    if (entry.renderer === "webgl") entry.pendingRepromote = true;
  }
}

/**
 * Still hidden after the grace period: release the expensive addons. WebGL
 * contexts are GPU-memory pressure macOS sometimes answers by killing the
 * whole WebContent process, and the canvas addon's four pane-sized layers are
 * not much cheaper. Nothing is allocated in their place — every pane falls
 * back to xterm's own DOM renderer (which owns no canvases) and the
 * `pendingRepromote` marks bring the renderers back on return. This is *not*
 * a context loss, so `forbidWebgl` stays untouched.
 */
export function reclaimBackgroundPresentation(): void {
  for (const entry of panes.values()) {
    clearReclaim(entry);
    if (entry.addon === null) continue;
    // Visible panes (the window is occluded, not the pane) must come back
    // with a renderer; hidden ones are simply colded.
    if (entry.visible) entry.pendingRepromote = true;
    disposeAddon(entry);
    if (!entry.visible) entry.presentation = "cold-hidden";
  }
}

/**
 * Page is visible again: clear the background flag and re-promote MRU-first.
 * Fire-and-forget — the re-promotion spans frames by design.
 */
export function resumePresentation(): void {
  void repromoteAfterBackground();
}

/**
 * Best-effort backend log line so wake-phase costs land in the daily log
 * next to the probe/reattach markers. The `Promise.resolve().then` wrapper
 * absorbs the synchronous throw `invoke` produces under vitest/jsdom.
 */
export function reportWakePhase(phase: string, ms: number): void {
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
 * Monotonic token for [`repromoteAfterBackground`] runs. The loop now spans
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
 * up by the next `repromoteAfterBackground` instead of being stranded on the
 * DOM renderer for the session.
 */
async function repromoteAfterBackground(): Promise<void> {
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
    if (!entry.visible) continue;
    if (entry.forbidWebgl) {
      // Never getting WebGL, but it still lost its addon to the reclamation:
      // give it back a canvas rather than leaving it on the DOM renderer.
      ensureCanvas(entry);
      continue;
    }
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

export interface SchedulerSnapshot {
  paneId: string;
  renderer: RendererKind;
  presentation: PresentationState;
  forbidWebgl: boolean;
  mru: number;
  /** Estimated renderer backing bytes — see [`estimatePresentationBytes`]. */
  estimatedBytes: number;
}

export function snapshot(): SchedulerSnapshot[] {
  return Array.from(panes.values()).map((e) => ({
    paneId: e.paneId,
    renderer: e.renderer,
    presentation: e.presentation,
    forbidWebgl: e.forbidWebgl,
    mru: e.mru,
    estimatedBytes: estimatePresentationBytes(e),
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

/** Test-only helper: shrink the residency budgets to force eviction. */
export function __setPresentationBudgetForTests(next: {
  warmEntries?: number;
  bytes?: number;
  reclaimMs?: number;
}): void {
  if (next.warmEntries !== undefined) budget.warmEntries = next.warmEntries;
  if (next.bytes !== undefined) budget.bytes = next.bytes;
  if (next.reclaimMs !== undefined) reclaimMs = next.reclaimMs;
}

/** Test-only helper: drive reclamation without real time. */
export function __setPresentationTimerForTests(next: PresentationTimer | null): void {
  timer = next ?? realTimer;
}

/** Test-only helper: wipe scheduler state. */
export function __resetSchedulerForTests(): void {
  schedulerEpoch += 1;
  policy = "legacy";
  budget.warmEntries = MAX_WARM_HIDDEN_PANES;
  budget.bytes = MAX_PRESENTATION_BYTES;
  reclaimMs = WARM_RECLAIM_MS;
  for (const job of queue.splice(0)) finishJob(job, "cancelled");
  for (const e of panes.values()) {
    cancelPending(e);
    clearReclaim(e);
    try {
      e.addon?.dispose();
    } catch {
      /* best-effort */
    }
  }
  panes.clear();
  mruCounter = 0;
  reservedSlots = 0;
  draining = false;
  backgrounded = false;
  repromoteGeneration = 0;
  timer = realTimer;
  setWarnings([]);
}
