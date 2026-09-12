import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { installWindowActivation, type WindowActivationDeps } from "./windowActivation";

/** Injected clock, timers and frame queue — no Tauri, no real document. */
function harness(options: { hidden?: boolean } = {}) {
  let now = 0;
  let hidden = options.hidden ?? false;
  let nextHandle = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const frames: (() => void)[] = [];
  let onVisibility: (() => void) | null = null;
  let onNativeFocus: ((focused: boolean) => void) | null = null;

  const stopVisibility = vi.fn();
  const stopNativeFocus = vi.fn();
  const onHidden = vi.fn();
  const onReclaim = vi.fn();
  const onReturn = vi.fn<(elapsedHiddenMs: number, wasReclaimed: boolean) => void>();
  const onAfterUsable = vi.fn();
  const onReclaimStale = vi.fn();
  const reportPhase = vi.fn<(phase: string, ms: number) => void>();

  const deps: WindowActivationDeps = {
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const handle = ++nextHandle;
      timers.set(handle, { at: now + delayMs, callback });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle);
    },
    isHidden: () => hidden,
    subscribeVisibility: (callback) => {
      onVisibility = callback;
      return stopVisibility;
    },
    subscribeNativeFocus: (callback) => {
      onNativeFocus = callback;
      return stopNativeFocus;
    },
    onHidden,
    onReclaim,
    onReturn,
    onAfterUsable,
    onReclaimStale,
    reportPhase,
    afterFrame: (callback) => frames.push(callback),
  };

  const dispose = installWindowActivation(deps);

  return {
    dispose,
    onHidden,
    onReclaim,
    onReturn,
    onAfterUsable,
    onReclaimStale,
    reportPhase,
    stopVisibility,
    stopNativeFocus,
    advance(ms: number) {
      now += ms;
    },
    /** Fire every timer whose deadline has passed. */
    runTimers() {
      // Deleting the current entry mid-iteration is safe for a Map iterator.
      for (const [handle, timer] of timers) {
        if (timer.at > now) continue;
        timers.delete(handle);
        timer.callback();
      }
    },
    armedTimers: () => timers.size,
    runFrames() {
      for (const callback of frames.splice(0)) callback();
    },
    hide() {
      hidden = true;
      onVisibility?.();
    },
    show() {
      hidden = false;
      onVisibility?.();
    },
    focus(focused: boolean) {
      onNativeFocus?.(focused);
    },
    /** The native-focus subscription resolves over a couple of microtasks. */
    async ready() {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    },
  };
}

describe("windowActivation", () => {
  it("treats a blur with the window still visible as focus state only", async () => {
    const h = harness();
    await h.ready();

    h.focus(false);

    expect(h.onHidden).not.toHaveBeenCalled();
    expect(h.onReclaim).not.toHaveBeenCalled();
    expect(h.onReturn).not.toHaveBeenCalled();
    expect(h.armedTimers()).toBe(0);
  });

  it("suspends once and arms one reclamation timer for duplicate hidden events", () => {
    const h = harness();

    h.hide();
    h.hide();
    h.hide();

    expect(h.onHidden).toHaveBeenCalledTimes(1);
    expect(h.armedTimers()).toBe(1);
  });

  it("suspends immediately when installed while already hidden", () => {
    const h = harness({ hidden: true });

    expect(h.onHidden).toHaveBeenCalledTimes(1);
    expect(h.armedTimers()).toBe(1);
  });

  it("returns from a one-second hide without reclaiming anything", () => {
    const h = harness();

    h.hide();
    h.advance(1_000);
    h.runTimers();
    h.show();

    expect(h.onReclaim).not.toHaveBeenCalled();
    expect(h.onReturn).toHaveBeenCalledTimes(1);
    expect(h.onReturn).toHaveBeenCalledWith(1_000, false);
    expect(h.armedTimers()).toBe(0);
    expect(h.reportPhase).toHaveBeenCalledWith("hidden-for", 1_000);

    h.runFrames();
    expect(h.onAfterUsable).toHaveBeenCalledTimes(1);
    expect(h.onReclaimStale).not.toHaveBeenCalled();
  });

  it("reclaims once the grace deadline expires, and reports the return as reclaimed", () => {
    const h = harness();

    h.hide();
    h.advance(5_000);
    h.runTimers();
    expect(h.onReclaim).toHaveBeenCalledTimes(1);

    h.advance(2_000);
    h.show();
    h.runFrames();

    expect(h.onReclaim).toHaveBeenCalledTimes(1);
    expect(h.onReturn).toHaveBeenCalledWith(7_000, true);
    expect(h.onAfterUsable).toHaveBeenCalledTimes(1);
    // The overdue-timer path is for deadlines that never ran, not this one.
    expect(h.onReclaimStale).not.toHaveBeenCalled();
  });

  it("reveals the target first when a suspended timer never fired, reclaiming after", () => {
    const h = harness();

    h.hide();
    // Machine slept: 30 s of wall time, and the timer never got to run.
    h.advance(30_000);
    h.show();

    // The target is revealed with its renderer intact — no teardown to satisfy
    // an overdue deadline.
    expect(h.onReturn).toHaveBeenCalledWith(30_000, false);
    expect(h.onReclaim).not.toHaveBeenCalled();
    expect(h.onReclaimStale).not.toHaveBeenCalled();

    h.runFrames();
    expect(h.onReclaimStale).toHaveBeenCalledTimes(1);
    expect(h.onAfterUsable.mock.invocationCallOrder[0]).toBeLessThan(
      h.onReclaimStale.mock.invocationCallOrder[0],
    );
  });

  it("ignores a suspended reclamation timer that fires after the return", () => {
    const h = harness();

    h.hide();
    h.advance(30_000);
    h.show();
    h.runFrames();
    // The stale timer finally runs, long after the window came back.
    h.runTimers();

    expect(h.onReclaim).not.toHaveBeenCalled();
  });

  it("cancels the deferred refresh when the window hides again first", () => {
    const h = harness();

    h.hide();
    h.advance(100);
    h.show();
    h.hide();
    h.runFrames();

    expect(h.onReturn).toHaveBeenCalledTimes(1);
    expect(h.onAfterUsable).not.toHaveBeenCalled();
  });

  it("counts a native focus and a document-visible for one return once", async () => {
    const h = harness();
    await h.ready();

    h.focus(false);
    h.hide();
    h.advance(1_000);
    h.show();
    h.advance(10);
    h.focus(true);
    h.runFrames();

    expect(h.onReturn).toHaveBeenCalledTimes(1);
    expect(h.onAfterUsable).toHaveBeenCalledTimes(1);
  });

  it("counts one return when the native focus lands before the visibility event", async () => {
    const h = harness();
    await h.ready();

    h.focus(false);
    h.hide();
    h.advance(1_000);
    h.focus(true);
    h.advance(10);
    h.show();
    h.runFrames();

    expect(h.onReturn).toHaveBeenCalledTimes(1);
    expect(h.onAfterUsable).toHaveBeenCalledTimes(1);
  });

  it("still activates a second return that follows closely after the first", () => {
    const h = harness();

    h.hide();
    h.advance(50);
    h.show();
    h.runFrames();
    h.advance(50);
    h.hide();
    h.advance(50);
    h.show();
    h.runFrames();

    // Both returns resume presentation: the coalescing window must not swallow
    // a genuine second return that happens to be within 250 ms.
    expect(h.onReturn).toHaveBeenCalledTimes(2);
    expect(h.onAfterUsable).toHaveBeenCalledTimes(2);
  });

  it("fires nothing after disposal, including already-queued callbacks", async () => {
    const h = harness();

    h.hide();
    h.advance(100);
    h.show();
    h.dispose();
    // Native unsubscribe resolves over a couple of microtasks.
    await h.ready();

    h.runFrames();
    h.advance(10_000);
    h.runTimers();
    h.show();
    h.focus(true);

    expect(h.onAfterUsable).not.toHaveBeenCalled();
    expect(h.onReclaim).not.toHaveBeenCalled();
    expect(h.onReturn).toHaveBeenCalledTimes(1);
    expect(h.stopVisibility).toHaveBeenCalled();
    expect(h.stopNativeFocus).toHaveBeenCalled();
  });

  it("never touches DOM focus on return", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const h = harness();

    h.hide();
    h.advance(1_000);
    h.show();
    h.runFrames();

    expect(document.activeElement).toBe(input);
    input.remove();
  });
});
