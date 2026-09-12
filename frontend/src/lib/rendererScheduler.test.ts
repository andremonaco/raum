import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// Mock the addon constructors so we don't need a real WebGL context under
// jsdom. Both fakes record construction/disposal so tests can assert on
// identities and live-context counts, not just the final renderer kind.
const fakes = vi.hoisted(() => {
  const state = {
    webglInstances: [] as FakeWebgl[],
    canvasInstances: [] as FakeCanvas[],
    liveWebgl: 0,
    /** High-water mark of simultaneously live WebGL contexts. */
    peakLiveWebgl: 0,
    canvasDisposeThrows: false,
  };
  class FakeWebgl {
    disposed = false;
    lossCb: (() => void) | null = null;
    constructor() {
      state.webglInstances.push(this);
      state.liveWebgl += 1;
      state.peakLiveWebgl = Math.max(state.peakLiveWebgl, state.liveWebgl);
    }
    onContextLoss(cb: () => void): void {
      this.lossCb = cb;
    }
    dispose(): void {
      if (this.disposed) return;
      this.disposed = true;
      state.liveWebgl -= 1;
    }
  }
  class FakeCanvas {
    disposed = false;
    constructor() {
      state.canvasInstances.push(this);
    }
    dispose(): void {
      this.disposed = true;
      if (state.canvasDisposeThrows) throw new Error("canvas dispose exploded");
    }
  }
  const reset = (): void => {
    state.webglInstances.length = 0;
    state.canvasInstances.length = 0;
    state.liveWebgl = 0;
    state.peakLiveWebgl = 0;
    state.canvasDisposeThrows = false;
  };
  return { state, FakeWebgl, FakeCanvas, reset };
});
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: fakes.FakeWebgl }));
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: fakes.FakeCanvas }));

import {
  MAX_WEBGL_PANES,
  reclaimBackgroundPresentation,
  registerPane,
  requestWebgl,
  requestWebglIfSlotFree,
  resumePresentation,
  setPaneVisibility,
  setPresentationPolicy,
  snapshot,
  suspendHiddenPresentation,
  unregisterPane,
  __resetSchedulerForTests,
  __setPresentationBudgetForTests,
  __setPresentationTimerForTests,
} from "./rendererScheduler";
import type { Terminal } from "@xterm/xterm";

interface FakeTerm extends Terminal {
  loaded: unknown[];
}

function fakeTerminal(opts: { throwOnLoad?: boolean } = {}): FakeTerm {
  const loaded: unknown[] = [];
  return {
    loaded,
    loadAddon: (addon: unknown) => {
      if (opts.throwOnLoad) throw new Error("loadAddon exploded");
      loaded.push(addon);
    },
  } as unknown as FakeTerm;
}

/**
 * rAF is stubbed with a microtask so the scheduler's frame yields resolve
 * deterministically (no real sleeps) while the call count stays assertable.
 * A test observes "mid-promotion" state simply by not awaiting: the addon
 * import resolves on a microtask, so anything in the same synchronous block
 * runs while the promotion is still in flight.
 */
let rafCalls = 0;

function rendererOf(paneId: string): string | undefined {
  return snapshot().find((s) => s.paneId === paneId)?.renderer;
}

function presentationOf(paneId: string): string | undefined {
  return snapshot().find((s) => s.paneId === paneId)?.presentation;
}

function countPresentation(state: string): number {
  return snapshot().filter((s) => s.presentation === state).length;
}

/** Let queued microtasks (imports, frame yields, drain steps) run out. */
async function settle(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** `resumePresentation` is fire-and-forget and spans one frame yield per
 *  pane, so tests drain generously rather than awaiting a handle. */
async function settleResume(): Promise<void> {
  await settle(120);
}

/** Deferred reclamations, captured instead of run on a real clock. */
const reclaimTimers: { fn: () => void }[] = [];
function installFakeReclaimTimer(): void {
  reclaimTimers.length = 0;
  __setPresentationTimerForTests({
    set: (fn) => reclaimTimers.push({ fn }) - 1,
    clear: (handle) => {
      const slot = reclaimTimers[handle as number];
      if (slot) slot.fn = () => {};
    },
  });
}
/** Fire every armed (uncancelled) reclamation. */
function runReclaims(): void {
  for (const slot of reclaimTimers.splice(0)) slot.fn();
}

describe("rendererScheduler", () => {
  beforeEach(() => {
    rafCalls = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCalls += 1;
      queueMicrotask(() => cb(0));
      return rafCalls;
    });
    // Reset the scheduler first: it disposes leftover addons, which the
    // fake counters would otherwise book against the new test.
    __resetSchedulerForTests();
    fakes.reset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts every pane on the DOM renderer", () => {
    registerPane("a", fakeTerminal());
    registerPane("b", fakeTerminal());
    expect(snapshot().every((s) => s.renderer === "dom")).toBe(true);
    expect(fakes.state.canvasInstances).toHaveLength(0);
  });

  it("promotes to WebGL on request and caps at MAX_WEBGL_PANES", async () => {
    for (let i = 0; i < MAX_WEBGL_PANES + 2; i++) {
      const id = `p-${i}`;
      registerPane(id, fakeTerminal());
      await requestWebgl(id);
    }
    const webglCount = snapshot().filter((s) => s.renderer === "webgl").length;
    expect(webglCount).toBe(MAX_WEBGL_PANES);
    expect(fakes.state.peakLiveWebgl).toBeLessThanOrEqual(MAX_WEBGL_PANES);
  });

  it("evicts the LRU pane when the cap is hit", async () => {
    for (let i = 0; i < MAX_WEBGL_PANES; i++) {
      const id = `p-${i}`;
      registerPane(id, fakeTerminal());
      await requestWebgl(id);
    }
    // p-0 is least recently used. Touch p-1..MAX-1 to bump their MRU, then
    // register and promote a fresh pane.
    for (let i = 1; i < MAX_WEBGL_PANES; i++) {
      await requestWebgl(`p-${i}`);
    }
    registerPane("new", fakeTerminal());
    await requestWebgl("new");

    const byId = new Map(snapshot().map((s) => [s.paneId, s]));
    expect(byId.get("p-0")?.renderer).toBe("canvas");
    expect(byId.get("new")?.renderer).toBe("webgl");
  });

  it("unregister removes the pane", () => {
    registerPane("x", fakeTerminal());
    unregisterPane("x");
    expect(snapshot().find((s) => s.paneId === "x")).toBeUndefined();
  });

  it("background demotion releases WebGL and re-promotes on return", async () => {
    registerPane("a", fakeTerminal());
    registerPane("b", fakeTerminal());
    await requestWebgl("a");
    await requestWebgl("b");

    suspendHiddenPresentation();
    expect(fakes.state.liveWebgl).toBe(2); // suspension alone releases nothing
    reclaimBackgroundPresentation();
    // Reclaimed panes fall to the DOM renderer — no replacement is allocated.
    expect(snapshot().every((s) => s.renderer === "dom")).toBe(true);
    expect(fakes.state.liveWebgl).toBe(0);
    expect(fakes.state.canvasInstances).toHaveLength(0);

    resumePresentation();
    await settleResume();
    expect(rendererOf("a")).toBe("webgl");
    expect(rendererOf("b")).toBe("webgl");
  });

  it("background demotion is not a context loss — forbidWebgl stays clear", async () => {
    registerPane("a", fakeTerminal());
    await requestWebgl("a");
    suspendHiddenPresentation();
    reclaimBackgroundPresentation();
    resumePresentation();
    await settleResume();
    expect(snapshot().find((s) => s.paneId === "a")?.forbidWebgl).toBe(false);
  });

  it("requestWebgl is a no-op while backgrounded", async () => {
    registerPane("a", fakeTerminal());
    suspendHiddenPresentation();
    await requestWebgl("a");
    expect(rendererOf("a")).toBe("canvas");
    resumePresentation();
    await settleResume();
    await requestWebgl("a");
    expect(rendererOf("a")).toBe("webgl");
  });

  it("re-promotion runs MRU-first and preserves pre-background mru order", async () => {
    // Track the order WebGL addons are installed. The mocked WebglAddon is
    // recognizable by its `onContextLoss` method.
    const webglOrder: string[] = [];
    const trackingTerminal = (id: string): Terminal =>
      ({
        loadAddon: (addon: { onContextLoss?: unknown }) => {
          if (typeof addon.onContextLoss === "function") webglOrder.push(id);
        },
      }) as unknown as Terminal;

    registerPane("a", trackingTerminal("a"));
    registerPane("b", trackingTerminal("b"));
    registerPane("c", trackingTerminal("c"));
    await requestWebgl("a");
    await requestWebgl("b");
    await requestWebgl("c"); // c is most recently used

    const mruBefore = new Map(snapshot().map((s) => [s.paneId, s.mru]));
    suspendHiddenPresentation();
    reclaimBackgroundPresentation();
    webglOrder.length = 0;
    resumePresentation();
    await settleResume();

    // The pane the user last touched gets its WebGL context back first…
    expect(webglOrder).toEqual(["c", "b", "a"]);
    // …and the LRU bookkeeping is untouched by the re-promotion pass.
    for (const s of snapshot()) {
      expect(s.mru).toBe(mruBefore.get(s.paneId));
    }
  });

  it("a re-hide mid-re-promotion leaves unreached panes marked for the next wake", async () => {
    registerPane("a", fakeTerminal());
    registerPane("b", fakeTerminal());
    registerPane("c", fakeTerminal());
    await requestWebgl("a");
    await requestWebgl("b");
    await requestWebgl("c");
    suspendHiddenPresentation();
    reclaimBackgroundPresentation();

    // Wake begins, then a second hide lands while the loop is mid-flight
    // (second lock, occlusion flicker). The aborted run must not strip the
    // pendingRepromote marks of panes it never reached.
    resumePresentation();
    suspendHiddenPresentation();
    await settleResume();
    const midCount = snapshot().filter((s) => s.renderer === "webgl").length;
    expect(midCount).toBeLessThanOrEqual(1);

    // The next wake must recover ALL panes, not just the ones the aborted
    // run happened to reach.
    resumePresentation();
    await settleResume();
    expect(snapshot().every((s) => s.renderer === "webgl")).toBe(true);
  });

  it("a hidden pane holds no renderer; a declined WebGL request installs canvas once", async () => {
    let loads = 0;
    const term = { loadAddon: () => void loads++ } as unknown as Terminal;
    registerPane("a", term, { visible: false, forbidWebgl: true });
    expect(loads).toBe(0);
    setPaneVisibility("a", true);
    expect(loads).toBe(0);
    await requestWebgl("a");
    expect(loads).toBe(1);
    setPaneVisibility("a", false);
    setPaneVisibility("a", true);
    await requestWebgl("a");
    expect(loads).toBe(2);
  });

  it("a granted WebGL request paints once — no canvas install first", async () => {
    const term = fakeTerminal();
    registerPane("a", term);
    await requestWebgl("a");
    expect(term.loaded).toHaveLength(1);
    expect(fakes.state.canvasInstances).toHaveLength(0);
    expect(rendererOf("a")).toBe("webgl");
  });

  it("a pane hidden mid-promotion does not take a WebGL slot", async () => {
    registerPane("a", fakeTerminal());
    // The addon import is still in flight when the pane goes off-screen; the
    // slot must not be claimed, or nothing can ever demote it back.
    const promotion = requestWebgl("a");
    setPaneVisibility("a", false);
    await promotion;
    expect(rendererOf("a")).toBe("dom");
  });

  it("a focus promotion and an opportunistic one cannot both claim the last slot", async () => {
    for (let i = 0; i < MAX_WEBGL_PANES - 1; i++) {
      registerPane(`p-${i}`, fakeTerminal());
      await requestWebgl(`p-${i}`);
    }
    registerPane("focused", fakeTerminal());
    registerPane("visible", fakeTerminal());
    const focus = requestWebgl("focused");
    requestWebglIfSlotFree("visible"); // same tick, focus promotion unresolved
    await focus;
    await settle();
    expect(snapshot().filter((s) => s.renderer === "webgl")).toHaveLength(MAX_WEBGL_PANES);
    expect(fakes.state.peakLiveWebgl).toBeLessThanOrEqual(MAX_WEBGL_PANES);
  });

  it("re-promotion skips DOM-only panes and untouched ones", async () => {
    registerPane("webgl-pane", fakeTerminal());
    registerPane("idle-pane", fakeTerminal());
    await requestWebgl("webgl-pane");

    suspendHiddenPresentation();
    reclaimBackgroundPresentation();
    resumePresentation();
    await settleResume();

    expect(rendererOf("webgl-pane")).toBe("webgl");
    expect(rendererOf("idle-pane")).toBe("dom");
  });

  // --- job ownership (§3) -------------------------------------------------

  it("focus raises a queued promotion instead of enqueuing a second one", async () => {
    const term = fakeTerminal();
    registerPane("a", term);
    requestWebglIfSlotFree("a"); // queued, parked on the frame yield
    await requestWebgl("a"); // same pane takes focus before the import resolves
    await settle();

    expect(fakes.state.webglInstances).toHaveLength(1);
    expect(term.loaded).toEqual([fakes.state.webglInstances[0]]);
    expect(rendererOf("a")).toBe("webgl");
  });

  it("hiding a pane mid-promotion allocates nothing into it", async () => {
    const term = fakeTerminal();
    registerPane("a", term);
    const promotion = requestWebgl("a");
    setPaneVisibility("a", false);
    await promotion;
    await settle();

    expect(fakes.state.webglInstances).toHaveLength(0);
    expect(fakes.state.canvasInstances).toHaveLength(0);
    expect(term.loaded).toHaveLength(0);
    expect(rendererOf("a")).toBe("dom");
  });

  it("unregistering mid-promotion allocates nothing into the dead entry", async () => {
    const term = fakeTerminal();
    registerPane("a", term);
    const promotion = requestWebgl("a");
    unregisterPane("a");
    await promotion;
    await settle();

    expect(fakes.state.webglInstances).toHaveLength(0);
    expect(fakes.state.canvasInstances).toHaveLength(0);
    expect(term.loaded).toHaveLength(0);
  });

  it("a job from a previous registration cannot touch the re-registered pane", async () => {
    const oldTerm = fakeTerminal();
    const newTerm = fakeTerminal();
    registerPane("a", oldTerm);
    const stale = requestWebgl("a");
    unregisterPane("a");
    registerPane("a", newTerm); // same pane id, brand new terminal
    await stale;
    await settle();

    expect(oldTerm.loaded).toHaveLength(0);
    expect(newTerm.loaded).toHaveLength(0);
    expect(fakes.state.webglInstances).toHaveLength(0);
    expect(rendererOf("a")).toBe("dom");

    // …and the new registration can still promote normally.
    await requestWebgl("a");
    expect(newTerm.loaded).toHaveLength(1);
    expect(rendererOf("a")).toBe("webgl");
  });

  it("concurrent promotions never exceed the context ceiling", async () => {
    for (let i = 0; i < MAX_WEBGL_PANES - 1; i++) {
      registerPane(`p-${i}`, fakeTerminal());
      await requestWebgl(`p-${i}`);
    }
    expect(fakes.state.liveWebgl).toBe(MAX_WEBGL_PANES - 1);

    const contenders = ["c0", "c1", "c2", "c3"];
    for (const id of contenders) registerPane(id, fakeTerminal());
    const pending = contenders.map((id) => requestWebgl(id));
    requestWebglIfSlotFree("c0");
    await Promise.all(pending);
    await settle();

    expect(fakes.state.peakLiveWebgl).toBeLessThanOrEqual(MAX_WEBGL_PANES);
    expect(fakes.state.liveWebgl).toBe(MAX_WEBGL_PANES);
    expect(snapshot().filter((s) => s.renderer === "webgl")).toHaveLength(MAX_WEBGL_PANES);
  });

  it("dead queued jobs do not block a new pane's opportunistic promotion", async () => {
    // Seven panes queue a promotion and then leave the view before any of
    // them runs. They hold no slot, so the cap is still wide open.
    for (let i = 0; i < MAX_WEBGL_PANES - 1; i++) {
      registerPane(`gone-${i}`, fakeTerminal());
      requestWebglIfSlotFree(`gone-${i}`);
      setPaneVisibility(`gone-${i}`, false);
    }
    const term = fakeTerminal();
    registerPane("fresh", term);
    requestWebglIfSlotFree("fresh");
    await settle();

    expect(rendererOf("fresh")).toBe("webgl");
    expect(term.loaded).toEqual([fakes.state.webglInstances[0]]);
    expect(fakes.state.webglInstances).toHaveLength(1);
  });

  it("cancelled queue entries cost the focused pane no extra frames", async () => {
    registerPane("a", fakeTerminal());
    registerPane("b", fakeTerminal());
    registerPane("c", fakeTerminal());
    requestWebglIfSlotFree("a");
    requestWebglIfSlotFree("b");
    const framesAfterQueueing = rafCalls;

    // Navigate away: A and B leave the view, C takes focus.
    setPaneVisibility("a", false);
    setPaneVisibility("b", false);
    await requestWebgl("c");

    expect(rendererOf("c")).toBe("webgl");
    // C waited on no frame of its own, and the drain does not spend one per
    // cancelled job on its way to finding the queue empty.
    expect(rafCalls).toBe(framesAfterQueueing);
    await settle();
    expect(rafCalls).toBe(framesAfterQueueing);
    expect(fakes.state.webglInstances).toHaveLength(1);
  });

  it("context loss from a replaced addon leaves the current renderer alone", async () => {
    const term = fakeTerminal();
    registerPane("a", term);
    await requestWebgl("a");
    const first = fakes.state.webglInstances[0]!;

    // Background/foreground swaps the addon out and back in.
    suspendHiddenPresentation();
    reclaimBackgroundPresentation();
    resumePresentation();
    await settleResume();
    const second = fakes.state.webglInstances[1]!;
    expect(second).not.toBe(first);
    expect(term.loaded[term.loaded.length - 1]).toBe(second);

    const loadsBefore = term.loaded.length;
    first.lossCb?.(); // the dead context finally reports its loss
    expect(rendererOf("a")).toBe("webgl");
    expect(snapshot().find((s) => s.paneId === "a")?.forbidWebgl).toBe(false);
    expect(term.loaded).toHaveLength(loadsBefore);
    expect(term.loaded[term.loaded.length - 1]).toBe(second);

    // Loss reported for an unregistered pane is equally inert.
    unregisterPane("a");
    second.lossCb?.();
    expect(snapshot()).toHaveLength(0);
  });

  it("a live context loss still demotes the pane for the session", async () => {
    const term = fakeTerminal();
    registerPane("a", term);
    await requestWebgl("a");
    fakes.state.webglInstances[0]!.lossCb?.();
    expect(rendererOf("a")).toBe("canvas");
    expect(snapshot().find((s) => s.paneId === "a")?.forbidWebgl).toBe(true);
  });

  it("a failed install leaks no reservation", async () => {
    // This terminal rejects every addon: the WebGL install throws, and so
    // does the canvas fallback, so the pane is left on the DOM renderer.
    registerPane("bad", fakeTerminal({ throwOnLoad: true }));
    await requestWebgl("bad");
    expect(rendererOf("bad")).toBe("dom");
    expect(snapshot().find((s) => s.paneId === "bad")?.forbidWebgl).toBe(true);
    expect(fakes.state.liveWebgl).toBe(0); // the half-built addon was disposed

    // Every slot must still be available afterwards.
    for (let i = 0; i < MAX_WEBGL_PANES; i++) {
      registerPane(`p-${i}`, fakeTerminal());
      await requestWebgl(`p-${i}`);
    }
    expect(snapshot().filter((s) => s.renderer === "webgl")).toHaveLength(MAX_WEBGL_PANES);
  });

  it("a throwing dispose does not block the next install", async () => {
    const term = fakeTerminal();
    registerPane("a", term);
    // Park the pane on canvas, then make that addon's dispose throw.
    suspendHiddenPresentation();
    await requestWebgl("a");
    resumePresentation();
    await settleResume();
    expect(rendererOf("a")).toBe("canvas");
    fakes.state.canvasDisposeThrows = true;

    await requestWebgl("a");
    expect(rendererOf("a")).toBe("webgl");
    expect(fakes.state.webglInstances).toHaveLength(1);
  });
  it("suspending a hidden page releases nothing and allocates nothing", async () => {
    registerPane("a", fakeTerminal());
    await requestWebgl("a");
    suspendHiddenPresentation();
    // Brief occlusion is the common case: the warm context survives it.
    expect(rendererOf("a")).toBe("webgl");
    expect(fakes.state.liveWebgl).toBe(1);
    expect(fakes.state.canvasInstances).toHaveLength(0);
  });

  // --- presentation residency (tasks 4.3-4.5) -----------------------------

  describe("warm-residency policy", () => {
    beforeEach(() => {
      installFakeReclaimTimer();
      setPresentationPolicy("warm-residency");
    });
    afterEach(() => {
      setPresentationPolicy("legacy");
      __setPresentationTimerForTests(null);
    });

    it("a hide/show cycle keeps the same addon and constructs nothing", async () => {
      const term = fakeTerminal();
      registerPane("a", term);
      await requestWebgl("a");
      const addon = fakes.state.webglInstances[0]!;

      for (let i = 0; i < 3; i++) {
        setPaneVisibility("a", false);
        expect(presentationOf("a")).toBe("warm-hidden");
        expect(rendererOf("a")).toBe("webgl");
        setPaneVisibility("a", true);
        await requestWebgl("a");
      }

      expect(fakes.state.webglInstances).toHaveLength(1);
      expect(fakes.state.webglInstances[0]).toBe(addon);
      expect(addon.disposed).toBe(false);
      expect(fakes.state.canvasInstances).toHaveLength(0);
      expect(term.loaded).toHaveLength(1);
    });

    it("selecting the view again cancels the queued reclamation", async () => {
      registerPane("a", fakeTerminal());
      await requestWebgl("a");
      setPaneVisibility("a", false);
      setPaneVisibility("a", true);

      runReclaims(); // the timer fires after the view came back
      expect(presentationOf("a")).toBe("visible");
      expect(rendererOf("a")).toBe("webgl");
      expect(fakes.state.liveWebgl).toBe(1);
    });

    it("a due reclamation colds the pane without allocating a replacement", async () => {
      registerPane("a", fakeTerminal());
      await requestWebgl("a");
      setPaneVisibility("a", false);

      runReclaims();
      expect(presentationOf("a")).toBe("cold-hidden");
      expect(rendererOf("a")).toBe("dom");
      expect(fakes.state.liveWebgl).toBe(0);
      expect(fakes.state.canvasInstances).toHaveLength(0);
    });

    it("an injected warm-entry budget colds the LRU hidden pane first", async () => {
      __setPresentationBudgetForTests({ warmEntries: 2 });
      for (const id of ["a", "b", "c"]) {
        registerPane(id, fakeTerminal());
        await requestWebgl(id);
      }
      setPaneVisibility("a", false);
      setPaneVisibility("b", false);
      setPaneVisibility("c", false);

      expect(presentationOf("a")).toBe("cold-hidden");
      expect(presentationOf("b")).toBe("warm-hidden");
      expect(presentationOf("c")).toBe("warm-hidden");
      expect(fakes.state.canvasInstances).toHaveLength(0);
    });

    it("an injected byte budget colds warm panes under the entry cap", async () => {
      __setPresentationBudgetForTests({ warmEntries: 8, bytes: 1 });
      registerPane("a", fakeTerminal());
      await requestWebgl("a");
      setPaneVisibility("a", false);

      expect(presentationOf("a")).toBe("cold-hidden");
      expect(fakes.state.liveWebgl).toBe(0);
    });

    it("a zero warm budget colds every hide immediately", async () => {
      __setPresentationBudgetForTests({ warmEntries: 0 });
      registerPane("a", fakeTerminal());
      registerPane("b", fakeTerminal());
      await requestWebgl("a");
      await requestWebgl("b");
      setPaneVisibility("a", false);
      setPaneVisibility("b", false);

      expect(countPresentation("warm-hidden")).toBe(0);
      expect(fakes.state.liveWebgl).toBe(0);
      // The fallback must not build a CanvasAddon on a pane nobody can see.
      expect(fakes.state.canvasInstances).toHaveLength(0);
    });

    it("a contested slot evicts a warm-hidden holder before a visible one", async () => {
      for (let i = 0; i < MAX_WEBGL_PANES; i++) {
        registerPane(`p-${i}`, fakeTerminal());
        await requestWebgl(`p-${i}`);
      }
      // p-3 keeps its context while hidden; p-0 is the least recently used
      // VISIBLE holder and must survive the next promotion.
      setPaneVisibility("p-3", false);

      registerPane("focused", fakeTerminal());
      await requestWebgl("focused");

      expect(rendererOf("focused")).toBe("webgl");
      expect(rendererOf("p-3")).toBe("dom");
      expect(presentationOf("p-3")).toBe("cold-hidden");
      expect(rendererOf("p-0")).toBe("webgl");
      // Demoting a hidden pane must not build it a CanvasAddon.
      expect(fakes.state.canvasInstances).toHaveLength(0);
      expect(fakes.state.peakLiveWebgl).toBeLessThanOrEqual(MAX_WEBGL_PANES);
    });

    it("cycling more views than the cache holds stays inside both ceilings", async () => {
      const ids = Array.from({ length: 14 }, (_, i) => `p-${i}`);
      for (const id of ids) registerPane(id, fakeTerminal(), { visible: false });

      for (const id of ids) {
        setPaneVisibility(id, true);
        await requestWebgl(id);
        setPaneVisibility(id, false);
      }
      await settle();

      expect(fakes.state.peakLiveWebgl).toBeLessThanOrEqual(MAX_WEBGL_PANES);
      expect(snapshot().filter((s) => s.renderer === "webgl").length).toBeLessThanOrEqual(
        MAX_WEBGL_PANES,
      );
      expect(countPresentation("warm-hidden")).toBeLessThanOrEqual(4);
    });

    it("a cold pane is usable on show without waiting for WebGL", () => {
      registerPane("a", fakeTerminal(), { visible: false, forbidWebgl: true });
      setPaneVisibility("a", true);
      // Synchronous: input never waits on a renderer promotion.
      requestWebglIfSlotFree("a");
      expect(rendererOf("a")).toBe("canvas");
    });

    it("reclaiming a backgrounded page colds warm entries and keeps visible marks", async () => {
      registerPane("shown", fakeTerminal());
      registerPane("hidden", fakeTerminal());
      await requestWebgl("shown");
      await requestWebgl("hidden");
      setPaneVisibility("hidden", false);

      suspendHiddenPresentation();
      reclaimBackgroundPresentation();
      expect(fakes.state.liveWebgl).toBe(0);
      expect(fakes.state.canvasInstances).toHaveLength(0);
      expect(presentationOf("hidden")).toBe("cold-hidden");

      resumePresentation();
      await settleResume();
      expect(rendererOf("shown")).toBe("webgl");
      // A hidden pane is not re-promoted on wake; it waits to be shown.
      expect(rendererOf("hidden")).toBe("dom");
    });

    it("switching back to legacy colds every resident hidden pane", async () => {
      registerPane("a", fakeTerminal());
      await requestWebgl("a");
      setPaneVisibility("a", false);
      expect(presentationOf("a")).toBe("warm-hidden");

      setPresentationPolicy("legacy");
      expect(presentationOf("a")).toBe("cold-hidden");
      expect(fakes.state.liveWebgl).toBe(0);
    });
  });
});
