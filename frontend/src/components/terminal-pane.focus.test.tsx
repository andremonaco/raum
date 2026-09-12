import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";

/**
 * Focus/visibility regression guard for `<TerminalPane>` (change
 * `instant-view-switching`, task group 2). Moving focus between two mounted
 * panes at identical geometry must cost nothing: no `fit.fit()`, no
 * `terminal_resize` round-trip, no spawn/reattach. Real geometry changes must
 * still produce exactly one resize at the final dimensions.
 *
 * xterm.js can't run under jsdom (no canvas, no layout), so the terminal, its
 * addons and the Tauri bridge are mocked. The fake `fit()` derives cols/rows
 * from the stubbed host box and the current font size — that is what makes
 * "did the geometry actually change?" observable here.
 */

const h = vi.hoisted(() => {
  const hostBox = { width: 800, height: 480 };
  const counters = { fits: 0 };
  const invokes: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const terminals: Array<Record<string, unknown>> = [];
  const held: Array<() => void> = [];
  const state = { holdResizes: false };
  // Cell metrics of the fake renderer: cols/rows change with the host box AND
  // with the font size, so a zoom is a real geometry change like in the app.
  const CELL_W = 0.6;
  const CELL_H = 1.2;

  class FakeTerminal {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    textarea = document.createElement("textarea");
    element = document.createElement("div");
    unicode = { activeVersion: "6" };
    buffer = {
      active: { type: "normal", baseY: 0, viewportY: 0, length: 0, getLine: () => null },
      normal: { length: 0, getLine: () => null },
    };
    scrollToBottom = vi.fn();
    scrollToTop = vi.fn();
    scrollToLine = vi.fn();
    clear = vi.fn();
    selectAll = vi.fn();
    focus = vi.fn();
    reset = vi.fn();
    write = vi.fn((_data: unknown, cb?: () => void) => cb?.());
    dispose = vi.fn();
    getSelection = (): string => "";
    hasSelection = (): boolean => false;

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      terminals.push(this as unknown as Record<string, unknown>);
    }
    loadAddon(addon: { activate?: (t: FakeTerminal) => void }): void {
      addon.activate?.(this);
    }
    open(): void {}
    attachCustomKeyEventHandler(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    onScroll(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    onResize(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    onWriteParsed(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
  }

  class FakeFitAddon {
    private term: FakeTerminal | null = null;
    activate(term: FakeTerminal): void {
      this.term = term;
    }
    fit(): void {
      counters.fits += 1;
      if (!this.term) return;
      const fontSize = Number(this.term.options.fontSize ?? 13);
      this.term.cols = Math.max(1, Math.floor(hostBox.width / (fontSize * CELL_W)));
      this.term.rows = Math.max(1, Math.floor(hostBox.height / (fontSize * CELL_H)));
    }
    dispose(): void {}
  }

  class NoopAddon {
    activate(): void {}
    serialize(): string {
      return "";
    }
    dispose(): void {}
  }

  return {
    hostBox,
    counters,
    invokes,
    terminals,
    held,
    state,
    CELL_W,
    CELL_H,
    FakeTerminal,
    FakeFitAddon,
    NoopAddon,
  };
});

vi.mock("@xterm/xterm", () => ({ Terminal: h.FakeTerminal }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: h.FakeFitAddon }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: h.NoopAddon }));
vi.mock("@xterm/addon-serialize", () => ({ SerializeAddon: h.NoopAddon }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: h.NoopAddon }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: h.NoopAddon }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((data: unknown) => void) | null = null;
  },
  invoke: vi.fn((cmd: string, args: Record<string, unknown> = {}) => {
    h.invokes.push({ cmd, args });
    switch (cmd) {
      case "terminal_reattach": {
        const inner = args.args as { session_id: string };
        return Promise.resolve({ sessionId: inner.session_id, historyStatus: "live-bridge" });
      }
      case "terminal_resize":
        if (!h.state.holdResizes) return Promise.resolve(null);
        return new Promise<null>((resolve) => h.held.push(() => resolve(null)));
      case "config_get":
        return Promise.resolve({});
      case "terminal_list":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  }),
}));
// Boot orchestration, not under test: release every pane immediately.
vi.mock("../lib/rehydrateGate", () => ({
  awaitSessionReady: () => Promise.resolve(),
}));
// Owned by another lane; stubbed so this test asserts the calls the pane makes
// rather than the scheduler's internals (and so no real addon import runs).
vi.mock("../lib/rendererScheduler", () => ({
  registerPane: vi.fn(),
  unregisterPane: vi.fn(),
  setPaneVisibility: vi.fn(),
  requestWebgl: vi.fn().mockResolvedValue(undefined),
  requestWebglIfSlotFree: vi.fn(),
}));

import { TerminalPane } from "./terminal-pane";
import { requestWebgl, setPaneVisibility } from "../lib/rendererScheduler";
import { setTerminalFontSize } from "../lib/xtermConfig";

const observerCallbacks = new Map<object, () => void>();
const liveObservers = new Set<object>();

class TestResizeObserver {
  constructor(cb: () => void) {
    observerCallbacks.set(this, cb);
  }
  observe(): void {
    liveObservers.add(this);
  }
  unobserve(): void {
    liveObservers.delete(this);
  }
  disconnect(): void {
    liveObservers.delete(this);
  }
}

function fireResizeObservers(): void {
  // Set iteration tolerates the disconnects a callback may trigger.
  for (const o of liveObservers) observerCallbacks.get(o)?.();
}

function resizeCalls(): Array<{ cols: number; rows: number }> {
  return h.invokes
    .filter((c) => c.cmd === "terminal_resize")
    .map((c) => ({ cols: c.args.cols as number, rows: c.args.rows as number }));
}

function attachCalls(): number {
  return h.invokes.filter(
    (c) =>
      c.cmd === "terminal_spawn" ||
      c.cmd === "terminal_reattach" ||
      c.cmd === "terminal_respawn_dead" ||
      c.cmd === "terminal_self_heal",
  ).length;
}

function clearCounters(): void {
  h.invokes.length = 0;
  h.counters.fits = 0;
}

function setHostBox(width: number, height: number): void {
  h.hostBox.width = width;
  h.hostBox.height = height;
}

function expectedDims(fontSize = 13): { cols: number; rows: number } {
  return {
    cols: Math.floor(h.hostBox.width / (fontSize * h.CELL_W)),
    rows: Math.floor(h.hostBox.height / (fontSize * h.CELL_H)),
  };
}

/** Drain timers + microtasks: mount gates, rAF, attach and resize round-trips. */
async function settle(ms = 1000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("TerminalPane focus/visibility work", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    liveObservers.clear();
    observerCallbacks.clear();
    h.terminals.length = 0;
    h.held.length = 0;
    h.state.holdResizes = false;
    clearCounters();
    setHostBox(800, 480);
    setTerminalFontSize(13);
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    // jsdom has no layout: feed the pane's host-box measurement from `hostBox`.
    for (const prop of ["clientWidth", "offsetWidth"]) {
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get: () => h.hostBox.width,
      });
    }
    for (const prop of ["clientHeight", "offsetHeight"]) {
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get: () => h.hostBox.height,
      });
    }
    // rAF isn't part of the default fake-timer set; route it through setTimeout
    // so `advanceTimersByTimeAsync` drains it deterministically.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function renderPair(kind: "codex" | "shell" | "opencode" = "codex") {
    const [activeKey, setActiveKey] = createSignal<string | null>("a");
    const [visibleKeys, setVisibleKeys] = createSignal<string[]>(["a", "b"]);
    const result = render(() => (
      <>
        <TerminalPane
          surfaceKey="a"
          sessionId="sess-a"
          kind={kind}
          visible={visibleKeys().includes("a")}
          active={activeKey() === "a"}
        />
        <TerminalPane
          surfaceKey="b"
          sessionId="sess-b"
          kind={kind}
          visible={visibleKeys().includes("b")}
          active={activeKey() === "b"}
        />
      </>
    ));
    return { ...result, setActiveKey, setVisibleKeys };
  }

  it("reattaches both panes on mount (fixture sanity)", async () => {
    renderPair();
    await settle();
    expect(attachCalls()).toBe(2);
    expect(h.terminals.length).toBe(2);
  });

  it("moving focus A→B at identical geometry does no fit, resize or attach", async () => {
    const { setActiveKey } = renderPair();
    await settle();
    expect(attachCalls()).toBe(2);
    clearCounters();

    setActiveKey("b");
    await settle();

    expect(h.counters.fits).toBe(0);
    expect(resizeCalls()).toEqual([]);
    expect(attachCalls()).toBe(0);
    // Focus still routes renderer promotion.
    expect(requestWebgl).toHaveBeenCalledWith("b");
  });

  it("re-selecting the pane that already owns focus does nothing", async () => {
    const { setActiveKey } = renderPair();
    await settle();
    clearCounters();
    vi.mocked(requestWebgl).mockClear();

    setActiveKey("a");
    await settle();

    expect(h.counters.fits).toBe(0);
    expect(resizeCalls()).toEqual([]);
    expect(requestWebgl).not.toHaveBeenCalled();
  });

  it("hiding and showing at unchanged geometry issues no fit or resize", async () => {
    const { setVisibleKeys } = renderPair();
    await settle();
    clearCounters();

    setVisibleKeys(["a"]);
    await settle();
    setVisibleKeys(["a", "b"]);
    await settle();

    expect(h.counters.fits).toBe(0);
    expect(resizeCalls()).toEqual([]);
    expect(attachCalls()).toBe(0);
    expect(setPaneVisibility).toHaveBeenCalledWith("b", false);
    expect(setPaneVisibility).toHaveBeenCalledWith("b", true);
  });

  it("showing after the host grew issues exactly one resize at the final dims", async () => {
    const { setVisibleKeys } = renderPair();
    await settle();
    clearCounters();

    setVisibleKeys(["a"]);
    await settle();
    // The parent layout changes while B is hidden: its observer ticks are
    // ignored, so the show is what has to notice the new box.
    setHostBox(1200, 600);
    fireResizeObservers();
    await settle();
    const whileHidden = resizeCalls().length;

    setVisibleKeys(["a", "b"]);
    await settle();

    // Pane A is visible throughout and resizes on the observer tick; pane B
    // resizes exactly once, on show, and at the final dimensions.
    expect(resizeCalls().length).toBe(whileHidden + 1);
    expect(resizeCalls().at(-1)).toEqual(expectedDims());
  });

  it("a font-zoom change issues one resize per visible pane", async () => {
    renderPair();
    await settle();
    clearCounters();

    setTerminalFontSize(18);
    await settle();

    const dims = expectedDims(18);
    expect(resizeCalls()).toEqual([dims, dims]);
  });

  it("a resize during an in-flight round-trip sends one follow-up at the latest dims", async () => {
    renderPair();
    await settle();
    clearCounters();

    h.state.holdResizes = true;
    setHostBox(1000, 500);
    fireResizeObservers();
    await settle();
    const inFlight = resizeCalls().length;
    expect(inFlight).toBe(2);

    // Two further geometry changes while the first round-trip is outstanding.
    setHostBox(1100, 520);
    fireResizeObservers();
    setHostBox(1234, 560);
    fireResizeObservers();
    await settle();
    expect(resizeCalls().length).toBe(inFlight);

    h.state.holdResizes = false;
    for (const release of h.held.splice(0)) release();
    await settle();

    const after = resizeCalls().slice(inFlight);
    expect(after.length).toBe(2); // one follow-up per pane, none lost or doubled
    for (const call of after) expect(call).toEqual(expectedDims());
  });

  it("never fits or dispatches while the host measures zero", async () => {
    const { setVisibleKeys } = renderPair();
    await settle();
    clearCounters();

    setVisibleKeys(["a"]);
    await settle();
    setHostBox(0, 0);
    fireResizeObservers();
    await settle();
    setVisibleKeys(["a", "b"]);
    await settle();

    expect(h.counters.fits).toBe(0);
    expect(resizeCalls()).toEqual([]);
  });

  it("still repins an OpenCode pane to the buffer tail on a real resize", async () => {
    renderPair("opencode");
    await settle();
    clearCounters();
    for (const t of h.terminals) (t.scrollToBottom as ReturnType<typeof vi.fn>).mockClear();

    setHostBox(1000, 500);
    fireResizeObservers();
    await settle();

    expect(resizeCalls().length).toBe(2);
    for (const t of h.terminals) expect(t.scrollToBottom).toHaveBeenCalled();
  });
});
