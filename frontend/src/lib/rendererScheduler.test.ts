import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the addon constructors so we don't need a real WebGL context under
// jsdom. Each constructor is a no-op class with a dispose method and, for
// WebGL, an `onContextLoss` registration used by the scheduler.
vi.mock("@xterm/addon-webgl", () => {
  class FakeWebgl {
    onContextLoss(_cb: () => void): void {
      /* not triggered in these tests */
    }
    dispose(): void {
      /* no-op */
    }
  }
  return { WebglAddon: FakeWebgl };
});
vi.mock("@xterm/addon-canvas", () => {
  class FakeCanvas {
    dispose(): void {
      /* no-op */
    }
  }
  return { CanvasAddon: FakeCanvas };
});

import {
  MAX_WEBGL_PANES,
  registerPane,
  requestWebgl,
  snapshot,
  unregisterPane,
  __resetSchedulerForTests,
} from "./rendererScheduler";
import type { Terminal } from "@xterm/xterm";

function fakeTerminal(): Terminal {
  return {
    loadAddon: () => undefined,
  } as unknown as Terminal;
}

describe("rendererScheduler", () => {
  beforeEach(() => {
    __resetSchedulerForTests();
  });

  it("starts every pane on canvas", () => {
    registerPane("a", fakeTerminal());
    registerPane("b", fakeTerminal());
    expect(snapshot().every((s) => s.renderer === "canvas")).toBe(true);
  });

  it("promotes to WebGL on request and caps at MAX_WEBGL_PANES", () => {
    for (let i = 0; i < MAX_WEBGL_PANES + 2; i++) {
      const id = `p-${i}`;
      registerPane(id, fakeTerminal());
      requestWebgl(id);
    }
    const webglCount = snapshot().filter((s) => s.renderer === "webgl").length;
    expect(webglCount).toBe(MAX_WEBGL_PANES);
  });

  it("evicts the LRU pane when the cap is hit", () => {
    for (let i = 0; i < MAX_WEBGL_PANES; i++) {
      const id = `p-${i}`;
      registerPane(id, fakeTerminal());
      requestWebgl(id);
    }
    // p-0 is least recently used. Touch p-1..MAX-1 to bump their MRU, then
    // register and promote a fresh pane.
    for (let i = 1; i < MAX_WEBGL_PANES; i++) {
      requestWebgl(`p-${i}`);
    }
    registerPane("new", fakeTerminal());
    requestWebgl("new");

    const byId = new Map(snapshot().map((s) => [s.paneId, s]));
    expect(byId.get("p-0")?.renderer).toBe("canvas");
    expect(byId.get("new")?.renderer).toBe("webgl");
  });

  it("unregister removes the pane", () => {
    registerPane("x", fakeTerminal());
    unregisterPane("x");
    expect(snapshot().find((s) => s.paneId === "x")).toBeUndefined();
  });
});
