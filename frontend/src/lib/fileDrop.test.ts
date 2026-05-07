import { afterEach, describe, expect, it, vi } from "vitest";

import { paneUnderCursor, pasteModeForKind } from "./fileDrop";

describe("pasteModeForKind", () => {
  it("returns 'harness' for Claude Code", () => {
    expect(pasteModeForKind("claude-code")).toBe("harness");
  });

  it("returns 'harness' for Codex", () => {
    expect(pasteModeForKind("codex")).toBe("harness");
  });

  it("returns 'harness' for OpenCode", () => {
    expect(pasteModeForKind("opencode")).toBe("harness");
  });

  it("returns 'shell' for a shell pane", () => {
    expect(pasteModeForKind("shell")).toBe("shell");
  });

  it("returns 'shell' when the kind is unknown / missing", () => {
    expect(pasteModeForKind(undefined)).toBe("shell");
  });
});

interface FakeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function mountShell(opts: {
  paneId?: string | null;
  sessionId?: string | null;
  rect: FakeRect;
}): HTMLElement {
  const el = document.createElement("div");
  if (opts.paneId !== null && opts.paneId !== undefined) {
    el.setAttribute("data-pane-id", opts.paneId);
  }
  if (opts.sessionId !== null && opts.sessionId !== undefined) {
    el.setAttribute("data-session-id", opts.sessionId);
  }
  const r = opts.rect;
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    left: r.left,
    top: r.top,
    right: r.left + r.width,
    bottom: r.top + r.height,
    width: r.width,
    height: r.height,
    x: r.left,
    y: r.top,
    toJSON: () => ({}),
  } as DOMRect);
  document.body.appendChild(el);
  return el;
}

describe("paneUnderCursor", () => {
  const originalDpr = window.devicePixelRatio;

  afterEach(() => {
    document.body.innerHTML = "";
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: originalDpr,
    });
    vi.restoreAllMocks();
  });

  it("returns the pane whose rect contains the cursor", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    mountShell({
      paneId: "pane-a",
      sessionId: "session-a",
      rect: { left: 0, top: 0, width: 400, height: 600 },
    });
    mountShell({
      paneId: "pane-b",
      sessionId: "session-b",
      rect: { left: 400, top: 0, width: 400, height: 600 },
    });

    const hit = paneUnderCursor(500, 300);
    expect(hit).toEqual({ paneId: "pane-b", sessionId: "session-b" });
  });

  it("can hit the full surface frame when the cursor is above the xterm body", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    mountShell({
      paneId: "pane-surface",
      sessionId: "session-surface",
      rect: { left: 0, top: 0, width: 400, height: 600 },
    });
    mountShell({
      paneId: "pane-body",
      sessionId: "session-surface",
      rect: { left: 0, top: 28, width: 400, height: 572 },
    });

    const hit = paneUnderCursor(100, 12);
    expect(hit).toEqual({ paneId: "pane-surface", sessionId: "session-surface" });
  });

  it("prefers raw webview coordinates when they hit a pane", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    mountShell({
      paneId: "pane-a",
      sessionId: "session-a",
      rect: { left: 0, top: 0, width: 400, height: 600 },
    });
    mountShell({
      paneId: "pane-b",
      sessionId: "session-b",
      rect: { left: 400, top: 0, width: 400, height: 600 },
    });

    // Raw (500, 300) is pane-b; scaling by DPR would incorrectly point at pane-a.
    const hit = paneUnderCursor(500, 300);
    expect(hit).toEqual({ paneId: "pane-b", sessionId: "session-b" });
  });

  it("falls back to DPR-scaled coordinates if raw coordinates miss every pane", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    mountShell({
      paneId: "pane-b",
      sessionId: "session-b",
      rect: { left: 400, top: 0, width: 400, height: 600 },
    });

    // Raw (1000, 600) misses; scaled (500, 300) lands in pane-b.
    const hit = paneUnderCursor(1000, 600);
    expect(hit).toEqual({ paneId: "pane-b", sessionId: "session-b" });
  });

  it("returns null when the cursor is outside every pane", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    mountShell({
      paneId: "pane-a",
      sessionId: "session-a",
      rect: { left: 0, top: 0, width: 100, height: 100 },
    });
    expect(paneUnderCursor(500, 500)).toBeNull();
  });

  it("ignores elements that have only data-session-id (surface-frame chrome)", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    // A surface-frame style element: data-session-id but no data-pane-id.
    // It must NOT match — that was the source of the original bug.
    mountShell({
      paneId: null,
      sessionId: "frame-session",
      rect: { left: 0, top: 0, width: 800, height: 800 },
    });
    expect(paneUnderCursor(100, 100)).toBeNull();
  });

  it("prefers the later DOM-order pane when rects overlap (paint order)", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    mountShell({
      paneId: "pane-below",
      sessionId: "session-below",
      rect: { left: 0, top: 0, width: 400, height: 400 },
    });
    mountShell({
      paneId: "pane-on-top",
      sessionId: "session-on-top",
      rect: { left: 100, top: 100, width: 200, height: 200 },
    });

    const hit = paneUnderCursor(150, 150);
    expect(hit).toEqual({ paneId: "pane-on-top", sessionId: "session-on-top" });
  });

  it("skips zero-area shells", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    mountShell({
      paneId: "pane-hidden",
      sessionId: "session-hidden",
      rect: { left: 0, top: 0, width: 0, height: 0 },
    });
    mountShell({
      paneId: "pane-visible",
      sessionId: "session-visible",
      rect: { left: 0, top: 0, width: 400, height: 400 },
    });
    const hit = paneUnderCursor(10, 10);
    expect(hit).toEqual({ paneId: "pane-visible", sessionId: "session-visible" });
  });

  it("skips hidden mounted pane shells", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    const hidden = mountShell({
      paneId: "pane-hidden",
      sessionId: "session-hidden",
      rect: { left: 0, top: 0, width: 400, height: 400 },
    });
    hidden.style.visibility = "hidden";
    mountShell({
      paneId: "pane-visible",
      sessionId: "session-visible",
      rect: { left: 0, top: 0, width: 400, height: 400 },
    });

    const hit = paneUnderCursor(10, 10);
    expect(hit).toEqual({ paneId: "pane-visible", sessionId: "session-visible" });
  });

  it("skips pane shells hidden by an ancestor surface", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    const hiddenParent = document.createElement("div");
    hiddenParent.style.visibility = "hidden";
    document.body.appendChild(hiddenParent);
    const hidden = mountShell({
      paneId: "pane-hidden",
      sessionId: "session-hidden",
      rect: { left: 0, top: 0, width: 400, height: 400 },
    });
    hiddenParent.appendChild(hidden);
    mountShell({
      paneId: "pane-visible",
      sessionId: "session-visible",
      rect: { left: 0, top: 0, width: 400, height: 400 },
    });

    const hit = paneUnderCursor(10, 10);
    expect(hit).toEqual({ paneId: "pane-visible", sessionId: "session-visible" });
  });
});
