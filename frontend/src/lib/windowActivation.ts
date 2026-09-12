/**
 * Window activation coordinator — the single place that decides what a blur,
 * an occlusion, a long hide and a return each cost.
 *
 * The rules it encodes (design decision 6):
 *   - **Blur** is a focus-state change. Nothing is suspended, nothing is
 *     disposed: the window is still on screen and the user may be reading it.
 *   - **Hidden** suspends painting immediately, then arms ONE five-second
 *     reclamation timer. Repeated `visibilitychange` events while already
 *     hidden enqueue no extra work.
 *   - **Reclamation** only happens if the grace period elapses while the
 *     window is *still* hidden and no newer activation has intervened.
 *   - **Return** is measured against WALL TIME, never against whether the
 *     timer got to run: a suspended machine can hold a `setTimeout` for half
 *     an hour. If the deadline passed but reclamation never fired, the target
 *     is revealed FIRST and the overdue non-target cleanup runs only after the
 *     first usable frame — we never tear down a usable renderer just to
 *     satisfy an overdue timer.
 *   - Native focus and document visibility arrive separately for the same
 *     return; they coalesce into ONE activation (one generation, one
 *     `onReturn`, one `onAfterUsable`).
 *
 * Everything is injected so the state machine is testable without Tauri, a
 * real clock or a real document. There is deliberately no focus callback in
 * the dependency surface: returning to the app must never steal the caret
 * from a search field, editor or modal.
 */

import { invoke } from "@tauri-apps/api/core";

import { beginActivation, finishNavigation, markNavigation } from "./navigationDiagnostics";

/** Wall-clock grace before a hidden window's presentation is reclaimed. */
const GRACE_MS = 5_000;

/** Native-focus and document-visibility notifications for one return. */
const COALESCE_MS = 250;

export interface WindowActivationDeps {
  /** Wall clock (`Date.now`): a suspended page's monotonic clock may stall. */
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (handle: number) => void;
  isHidden: () => boolean;
  subscribeVisibility: (callback: () => void) => () => void;
  /** Tauri's `onFocusChanged`. May reject (no Tauri host) — that is fine. */
  subscribeNativeFocus: (
    callback: (focused: boolean) => void,
  ) => (() => void) | Promise<() => void>;
  /** Document went hidden: suspend painting. No allocation, no disposal. */
  onHidden: () => void;
  /** Grace elapsed while still hidden: release expensive presentation. */
  onReclaim: () => void;
  onReturn: (elapsedHiddenMs: number, wasReclaimed: boolean) => void;
  /** First usable frame is on screen: peripheral refresh (status, labels). */
  onAfterUsable: () => void;
  /**
   * The grace deadline passed while the timer was suspended and reclamation
   * never ran. Reclaims NON-target resources after the return is usable; the
   * scheduler's own budget logic covers the target, which must not be torn
   * down. Defaults to a no-op.
   */
  onReclaimStale?: () => void;
  reportPhase?: (phase: string, ms: number) => void;
  /** Run after the first usable frame. Defaults to double-rAF + timeout. */
  afterFrame?: (callback: () => void) => void;
}

/**
 * Two frames of breathing room, raced against a timeout because rAF never
 * fires on a hidden page and jsdom may not schedule it at all — the deferred
 * refresh must never become a stall.
 */
function defaultAfterFrame(callback: () => void): void {
  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    callback();
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => requestAnimationFrame(run));
  }
  setTimeout(run, 32);
}

/** Best-effort backend log line, same `webview_wake_report` phase name the
 *  renderer scheduler used to emit so the daily log stays comparable. */
function defaultReportPhase(phase: string, ms: number): void {
  void Promise.resolve()
    .then(() => invoke("webview_wake_report", { phase, ms: Math.max(0, Math.round(ms)) }))
    .catch(() => {});
}

export function installWindowActivation(deps: WindowActivationDeps): () => void {
  const afterFrame = deps.afterFrame ?? defaultAfterFrame;
  const reportPhase = deps.reportPhase ?? defaultReportPhase;

  let disposed = false;
  let hidden = false;
  /** Wall time the current hidden stretch began; `null` while visible. */
  let hiddenAtMs: number | null = null;
  let reclaimed = false;
  let nativeFocused = !deps.isHidden();
  /** Bumped per activation. Every timer and deferred callback rechecks it. */
  let activationGeneration = 0;
  let lastActivationMs: number | null = null;
  let reclamationTimer: number | null = null;

  function cancelReclamation(): void {
    if (reclamationTimer === null) return;
    deps.clearTimeout(reclamationTimer);
    reclamationTimer = null;
  }

  function enterHidden(): void {
    if (disposed || hidden) return;
    hidden = true;
    hiddenAtMs = deps.now();
    reclaimed = false;
    // A hide always starts a fresh return: the next visible/focus pair must
    // not be swallowed as a duplicate of the activation that preceded it.
    lastActivationMs = null;
    deps.onHidden();
    const claimed = activationGeneration;
    reclamationTimer = deps.setTimeout(() => {
      reclamationTimer = null;
      if (disposed || !hidden || claimed !== activationGeneration) return;
      reclaimed = true;
      deps.onReclaim();
    }, GRACE_MS);
  }

  function activate(): void {
    if (disposed) return;
    const at = deps.now();
    // Second half of a native-focus/document-visible pair for the same return.
    if (lastActivationMs !== null && at - lastActivationMs <= COALESCE_MS) return;
    lastActivationMs = at;
    cancelReclamation();

    const wasHidden = hiddenAtMs !== null;
    const elapsedHiddenMs = hiddenAtMs === null ? 0 : Math.max(0, at - hiddenAtMs);
    const wasReclaimed = reclaimed;
    const staleDeadline = wasHidden && !wasReclaimed && elapsedHiddenMs >= GRACE_MS;
    hidden = false;
    hiddenAtMs = null;
    reclaimed = false;
    const claimed = ++activationGeneration;

    // A return from reclaimed presentation is still an ordinary activation —
    // `recovery` is reserved for actual WebContent death, which this module
    // never observes (the backend health probe owns that).
    const token = beginActivation("native", wasReclaimed ? { reclaimed: "1" } : {});
    deps.onReturn(elapsedHiddenMs, wasReclaimed);
    markNavigation(token, "focus-ready");
    if (wasHidden) reportPhase("hidden-for", elapsedHiddenMs);

    afterFrame(() => {
      if (disposed) return;
      // Hidden again (or superseded) before the frame landed: drop the refresh.
      if (hidden || claimed !== activationGeneration) {
        finishNavigation(token, "superseded");
        return;
      }
      deps.onAfterUsable();
      if (staleDeadline) deps.onReclaimStale?.();
      finishNavigation(token, "complete");
    });
  }

  function onVisibilityChange(): void {
    if (disposed) return;
    if (deps.isHidden()) enterHidden();
    else activate();
  }

  function onNativeFocus(focused: boolean): void {
    if (disposed || focused === nativeFocused) return;
    nativeFocused = focused;
    if (focused) activate();
  }

  const stopVisibility = deps.subscribeVisibility(onVisibilityChange);
  let stopNativeFocus: (() => void) | undefined;
  // `.then(() => …)` rather than calling it inline: `getCurrentWindow()`
  // throws synchronously outside a Tauri host (browser dev / vitest), and that
  // must not take the whole coordinator down with it.
  void Promise.resolve()
    .then(() => deps.subscribeNativeFocus(onNativeFocus))
    .then((unlisten) => {
      if (disposed) unlisten();
      else stopNativeFocus = unlisten;
    })
    .catch(() => {
      /* no Tauri host (browser dev / tests): visibility alone drives returns */
    });

  // Installed while already hidden (launched behind another window, or a
  // reload during screen lock): take the hidden path rather than assuming a
  // visible start.
  if (deps.isHidden()) enterHidden();

  return () => {
    disposed = true;
    cancelReclamation();
    stopVisibility();
    stopNativeFocus?.();
  };
}
