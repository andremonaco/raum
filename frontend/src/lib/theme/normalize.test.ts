import { describe, it, expect } from "vitest";

import dracula from "../../themes/catalog/dracula.json";
import githubLight from "../../themes/catalog/github-light.json";
import { normalizeTheme, parseRawTheme } from "./normalize";
import type { RawThemeJson } from "./types";

describe("normalizeTheme — VSCode JSON to RaumTheme", () => {
  it("maps Dracula's terminal.* tokens straight into the xterm palette", () => {
    const raw = dracula as RawThemeJson;
    const theme = normalizeTheme(raw, {
      id: "dracula",
      label: "Dracula",
      sourceVersion: "tm-themes",
    });

    // Confirm provenance + variant survive normalization
    expect(theme.id).toBe("dracula");
    expect(theme.type).toBe("dark");

    // Direct mappings — Dracula sets every terminal.* key explicitly, so the
    // xterm palette should match the raw JSON without falling through to the
    // baseline ANSI table.
    const colors = raw.colors!;
    expect(theme.xterm.background).toBe(colors["terminal.background"]);
    expect(theme.xterm.foreground).toBe(colors["terminal.foreground"]);
    expect(theme.xterm.red).toBe(colors["terminal.ansiRed"]);
    expect(theme.xterm.brightCyan).toBe(colors["terminal.ansiBrightCyan"]);

    // Chrome: editor.background drives the workbench background
    expect(theme.chrome.background).toBe(colors["editor.background"]);
    // Sidebar fallback chain — Dracula doesn't ship `sideBar.background`,
    // but it does have `panel.background`, which is the second link in
    // pick(["sideBar.background", "panel.background", ...]).
    expect(theme.chrome.card.length).toBeGreaterThan(0);
  });

  it("falls back to per-type ANSI baselines when terminal.* keys are missing", () => {
    const sparse: RawThemeJson = {
      type: "dark",
      colors: {
        "editor.background": "#101010",
        "editor.foreground": "#eaeaea",
      },
    };
    const theme = normalizeTheme(sparse, {
      id: "sparse",
      label: "Sparse",
      sourceVersion: "test",
    });
    // No terminal.background → falls back to editor.background
    expect(theme.xterm.background).toBe("#101010");
    // No terminal.ansiRed → falls back to baked-in DARK_ANSI
    expect(theme.xterm.red).toBe("#cd3131");
    // chrome.background uses editor.background
    expect(theme.chrome.background).toBe("#101010");
  });

  it("flips data through to the light variant when type=light", () => {
    const raw = githubLight as RawThemeJson;
    const theme = normalizeTheme(raw, {
      id: "github-light",
      label: "GitHub Light",
      sourceVersion: "tm-themes",
    });
    expect(theme.type).toBe("light");
    // White background should round-trip
    expect(theme.chrome.background.toLowerCase()).toMatch(/^#fff/);
  });

  it("collapses VSCode hc-dark/hc-light to dark/light", () => {
    const hc: RawThemeJson = { type: "hc-light", colors: {} };
    const theme = normalizeTheme(hc, { id: "hc", label: "HC", sourceVersion: "test" });
    expect(theme.type).toBe("light");
  });

  it("fills every ChromePalette field with a non-empty value for empty dark input", () => {
    const theme = normalizeTheme(
      { type: "dark", colors: {} },
      { id: "empty-dark", label: "Empty", sourceVersion: "test" },
    );
    for (const [key, value] of Object.entries(theme.chrome)) {
      expect(typeof value, `chrome.${key} should be a string`).toBe("string");
      expect(value.length, `chrome.${key} should not be empty`).toBeGreaterThan(0);
    }
  });

  it("fills every ChromePalette field with a non-empty value for empty light input", () => {
    const theme = normalizeTheme(
      { type: "light", colors: {} },
      { id: "empty-light", label: "Empty", sourceVersion: "test" },
    );
    for (const [key, value] of Object.entries(theme.chrome)) {
      expect(typeof value, `chrome.${key} should be a string`).toBe("string");
      expect(value.length, `chrome.${key} should not be empty`).toBeGreaterThan(0);
    }
  });

  it("derives scrim/shadow from theme.type (not VSCode JSON)", () => {
    const dark = normalizeTheme(
      { type: "dark", colors: {} },
      { id: "d", label: "D", sourceVersion: "test" },
    );
    const light = normalizeTheme(
      { type: "light", colors: {} },
      { id: "l", label: "L", sourceVersion: "test" },
    );
    // Dark scrim is black-based; light scrim is slate-based
    expect(dark.chrome.scrim).toContain("rgb(0 0 0");
    expect(light.chrome.scrim).toContain("rgb(15 23 42");
    // Shadows differ by theme kind (black drop vs slate drop)
    expect(dark.chrome.shadowMd).toContain("rgb(0 0 0");
    expect(light.chrome.shadowMd).toContain("rgb(15 23 42");
  });
});

describe("parseRawTheme — JSONC tolerance", () => {
  it("accepts plain JSON", () => {
    const raw = parseRawTheme('{"type":"dark","colors":{"editor.background":"#000"}}');
    expect(raw.type).toBe("dark");
    expect(raw.colors?.["editor.background"]).toBe("#000");
  });

  it("accepts comments + trailing commas (real-world VSCode themes)", () => {
    const text = `
      // top comment
      {
        "type": "dark", /* inline */
        "colors": {
          "editor.background": "#111", // trailing comma below
        },
      }
    `;
    const raw = parseRawTheme(text);
    expect(raw.colors?.["editor.background"]).toBe("#111");
  });

  it("rejects non-object roots", () => {
    expect(() => parseRawTheme("[]")).toThrow();
  });
});
