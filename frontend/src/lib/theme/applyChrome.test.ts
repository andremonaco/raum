import { describe, it, expect, beforeEach } from "vitest";

import { applyChrome } from "./applyChrome";
import type { ChromePalette } from "./types";

const PALETTE: ChromePalette = {
  background: "#101010",
  foreground: "#fefefe",
  card: "#181818",
  cardForeground: "#fefefe",
  popover: "#181818",
  popoverForeground: "#fefefe",
  primary: "#fefefe",
  primaryForeground: "#101010",
  secondary: "#272727",
  secondaryForeground: "#fefefe",
  muted: "#272727",
  mutedForeground: "#999999",
  accent: "#272727",
  accentForeground: "#fefefe",
  destructive: "#ff5555",
  border: "#ffffff1a",
  input: "#ffffff26",
  ring: "#777777",
  terminalBackground: "#0a0a0a",
  terminalForeground: "#fefefe",
  surfaceRaised: "#141418",
  surfaceSunken: "#09090b",
  panel: "#111114",
  panelForeground: "#fefefe",
  foregroundSubtle: "#999999",
  foregroundDim: "#666666",
  borderSubtle: "#ffffff14",
  borderStrong: "#ffffff40",
  success: "#22c55e",
  warning: "#eab308",
  info: "#38bdf8",
  hover: "#ffffff10",
  active: "#ffffff20",
  selected: "#ffffff28",
  scrim: "rgb(0 0 0 / 0.55)",
  scrimStrong: "rgb(0 0 0 / 0.7)",
  shadowXs: "0 1px 2px rgb(0 0 0 / 0.5)",
  shadowSm: "0 2px 4px rgb(0 0 0 / 0.55)",
  shadowMd: "0 8px 16px -4px rgb(0 0 0 / 0.6)",
  shadowLg: "0 24px 64px -12px rgb(0 0 0 / 0.65)",
};

describe("applyChrome — DOM writer", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
  });

  it("writes every CSS variable from the palette onto the root style", () => {
    applyChrome(PALETTE, "dark", root);
    expect(root.style.getPropertyValue("--background")).toBe("#101010");
    expect(root.style.getPropertyValue("--foreground")).toBe("#fefefe");
    expect(root.style.getPropertyValue("--card")).toBe("#181818");
    expect(root.style.getPropertyValue("--muted-foreground")).toBe("#999999");
    expect(root.style.getPropertyValue("--terminal-bg")).toBe("#0a0a0a");
    expect(root.style.getPropertyValue("--terminal-fg")).toBe("#fefefe");
  });

  it("toggles data-kb-theme + color-scheme to match the variant", () => {
    applyChrome(PALETTE, "dark", root);
    expect(root.getAttribute("data-kb-theme")).toBe("dark");
    expect(root.style.getPropertyValue("color-scheme")).toBe("dark");

    applyChrome(PALETTE, "light", root);
    expect(root.getAttribute("data-kb-theme")).toBe("light");
    expect(root.style.getPropertyValue("color-scheme")).toBe("light");
  });

  it("overwrites previous values on re-apply (no leakage)", () => {
    const first: ChromePalette = { ...PALETTE, background: "#aaaaaa" };
    const second: ChromePalette = { ...PALETTE, background: "#bbbbbb" };
    applyChrome(first, "dark", root);
    applyChrome(second, "dark", root);
    expect(root.style.getPropertyValue("--background")).toBe("#bbbbbb");
  });

  it("writes every extended token (surface, state, shadow, scrim)", () => {
    applyChrome(PALETTE, "dark", root);
    // Surfaces
    expect(root.style.getPropertyValue("--surface-raised")).toBe("#141418");
    expect(root.style.getPropertyValue("--surface-sunken")).toBe("#09090b");
    expect(root.style.getPropertyValue("--panel")).toBe("#111114");
    // Text hierarchy
    expect(root.style.getPropertyValue("--foreground-subtle")).toBe("#999999");
    expect(root.style.getPropertyValue("--foreground-dim")).toBe("#666666");
    // Borders
    expect(root.style.getPropertyValue("--border-subtle")).toBe("#ffffff14");
    expect(root.style.getPropertyValue("--border-strong")).toBe("#ffffff40");
    // State
    expect(root.style.getPropertyValue("--success")).toBe("#22c55e");
    expect(root.style.getPropertyValue("--warning")).toBe("#eab308");
    expect(root.style.getPropertyValue("--info")).toBe("#38bdf8");
    // Interactive
    expect(root.style.getPropertyValue("--hover")).toBe("#ffffff10");
    expect(root.style.getPropertyValue("--active")).toBe("#ffffff20");
    expect(root.style.getPropertyValue("--selected")).toBe("#ffffff28");
    // Scrim
    expect(root.style.getPropertyValue("--scrim")).toBe("rgb(0 0 0 / 0.55)");
    // Shadows
    expect(root.style.getPropertyValue("--shadow-md")).toContain("rgb(0 0 0");
    expect(root.style.getPropertyValue("--shadow-lg")).toContain("rgb(0 0 0");
  });
});
