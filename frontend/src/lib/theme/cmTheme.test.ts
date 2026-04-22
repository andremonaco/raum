import { describe, it, expect } from "vitest";
import { tags as t } from "@lezer/highlight";

import {
  buildGenericCodeMirrorTheme,
  hasPinnedCodeMirrorTheme,
  tokenColorsToStyles,
} from "./cmTheme";
import { normalizeTheme } from "./normalize";
import type { RawThemeJson } from "./types";

describe("tokenColorsToStyles — VSCode scopes → Lezer tags", () => {
  it("longest-prefix wins for nested scopes", () => {
    const styles = tokenColorsToStyles([
      { scope: "keyword", settings: { foreground: "#aaa" } },
      { scope: "keyword.control", settings: { foreground: "#bbb" } },
    ]);
    // Two rules → two outputs, each pointing at the most-specific tag they
    // match.
    expect(styles).toHaveLength(2);
    const general = styles.find((s) => s.color === "#aaa");
    const control = styles.find((s) => s.color === "#bbb");
    expect(general?.tag).toBe(t.keyword);
    expect(control?.tag).toBe(t.controlKeyword);
  });

  it("expands array + comma-separated scopes into one entry per scope", () => {
    const styles = tokenColorsToStyles([
      { scope: ["string", "string.regexp"], settings: { foreground: "#0f0" } },
      { scope: "comment, punctuation.definition.comment", settings: { foreground: "#888" } },
    ]);
    expect(styles.length).toBe(4);
  });

  it("parses fontStyle into fontWeight / fontStyle / textDecoration", () => {
    const styles = tokenColorsToStyles([
      {
        scope: "markup.bold",
        settings: { fontStyle: "bold italic underline" },
      },
    ]);
    expect(styles[0]).toMatchObject({
      fontWeight: "bold",
      fontStyle: "italic",
      textDecoration: "underline",
    });
  });

  it("drops rules with no foreground and no fontStyle", () => {
    const styles = tokenColorsToStyles([
      { scope: "anything.unknown", settings: {} },
      { scope: "comment", settings: { background: "#000" } },
    ]);
    expect(styles).toHaveLength(0);
  });

  it("silently drops scopes that don't match any mapping row", () => {
    const styles = tokenColorsToStyles([
      { scope: "totally.made.up.scope", settings: { foreground: "#fff" } },
      { scope: "string", settings: { foreground: "#0f0" } },
    ]);
    expect(styles).toHaveLength(1);
  });
});

describe("buildGenericCodeMirrorTheme", () => {
  it("returns a non-empty Extension from a minimal theme", () => {
    const raw: RawThemeJson = {
      type: "dark",
      colors: {
        "editor.background": "#101010",
        "editor.foreground": "#eaeaea",
      },
      tokenColors: [{ scope: "string", settings: { foreground: "#a0d8a0" } }],
    };
    const raum = normalizeTheme(raw, { id: "byo", label: "BYO", sourceVersion: "test" });
    const ext = buildGenericCodeMirrorTheme(raum);
    // CodeMirror Extensions are arrays under the hood; createTheme returns a
    // truthy compound. We just assert it constructs without throwing.
    expect(ext).toBeDefined();
  });
});

describe("hasPinnedCodeMirrorTheme", () => {
  it("knows about every catalog id we ship a @uiw package for", () => {
    expect(hasPinnedCodeMirrorTheme("dracula")).toBe(true);
    expect(hasPinnedCodeMirrorTheme("nord")).toBe(true);
    expect(hasPinnedCodeMirrorTheme("github-dark")).toBe(true);
    expect(hasPinnedCodeMirrorTheme("github-light")).toBe(true);
    expect(hasPinnedCodeMirrorTheme("solarized-dark")).toBe(true);
    expect(hasPinnedCodeMirrorTheme("solarized-light")).toBe(true);
    expect(hasPinnedCodeMirrorTheme("monokai")).toBe(true);
    expect(hasPinnedCodeMirrorTheme("tokyo-night")).toBe(true);
  });

  it("returns false for catalog themes without a pinned package (BYO fallback)", () => {
    expect(hasPinnedCodeMirrorTheme("catppuccin-mocha")).toBe(false);
    expect(hasPinnedCodeMirrorTheme("rose-pine")).toBe(false);
    expect(hasPinnedCodeMirrorTheme("custom:/some/path.json")).toBe(false);
  });
});
