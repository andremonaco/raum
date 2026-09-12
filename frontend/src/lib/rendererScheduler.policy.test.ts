import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: class {} }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("presentation policy at startup", () => {
  it.each([null, "warm-residency", "", "unknown"])(
    "defaults to warm residency for stored value %s",
    async (value) => {
      vi.stubGlobal("localStorage", { getItem: () => value });
      const scheduler = await import("./rendererScheduler");
      expect(scheduler.getPresentationPolicy()).toBe("warm-residency");
    },
  );

  it("preserves an explicit legacy rollback", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "legacy" });
    const scheduler = await import("./rendererScheduler");
    expect(scheduler.getPresentationPolicy()).toBe("legacy");
  });

  it("uses warm residency when storage is unavailable", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("Storage unavailable");
      },
    });
    const scheduler = await import("./rendererScheduler");
    expect(scheduler.getPresentationPolicy()).toBe("warm-residency");
  });
});
