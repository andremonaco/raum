import { describe, expect, it } from "vitest";

import { MAX_PREVIEW_CHARS, MAX_PREVIEW_LINES, formatPromptPreview } from "./promptPreview";

describe("formatPromptPreview", () => {
  it("returns undefined for empty input", () => {
    expect(formatPromptPreview(undefined)).toBeUndefined();
    expect(formatPromptPreview(null)).toBeUndefined();
    expect(formatPromptPreview("   \n\n ")).toBeUndefined();
  });

  it("passes short prompts through untouched", () => {
    expect(formatPromptPreview("fix the tooltip overflow")).toBe("fix the tooltip overflow");
  });

  it("caps long prompts and marks the cut", () => {
    const out = formatPromptPreview("word ".repeat(400))!;
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_PREVIEW_CHARS + 1);
  });

  it("cuts on a word boundary when one is near the limit", () => {
    const out = formatPromptPreview(`${"a".repeat(200)} ${"b".repeat(60)}`)!;
    expect(out).toBe(`${"a".repeat(200)}…`);
  });

  it("hard-cuts an unbroken token with no boundary to fall back on", () => {
    const out = formatPromptPreview("x".repeat(500))!;
    expect(out).toBe(`${"x".repeat(MAX_PREVIEW_CHARS)}…`);
  });

  it("caps the line count before the character count", () => {
    const out = formatPromptPreview(Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n"))!;
    expect(out.split("\n")).toHaveLength(MAX_PREVIEW_LINES);
    expect(out.endsWith("…")).toBe(true);
  });

  it("normalizes CRLF and collapses blank-line runs", () => {
    expect(formatPromptPreview("a\r\n\r\n\r\n\r\nb")).toBe("a\n\nb");
  });
});
