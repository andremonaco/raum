import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Tauri invoke so `schedulePersist` doesn't blow up in jsdom.
// `vi.hoisted` lets us define the spy before `vi.mock` runs (which is itself
// hoisted to the top of the file).
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
}));

import {
  beginThemePreview,
  endThemePreview,
  getCurrentTheme,
  loadAndApplyTheme,
  previewThemeId,
  setThemeId,
  subscribeThemeChange,
  DEFAULT_THEME_ID,
} from "./themeController";

beforeEach(async () => {
  // Ensure every test starts from a known-applied theme (the default).
  invokeMock.mockClear();
  await loadAndApplyTheme(DEFAULT_THEME_ID);
  // loadAndApplyTheme does not persist; next invoke calls come from tests.
  invokeMock.mockClear();
});

afterEach(() => {
  // Make sure no preview session leaks between tests.
  endThemePreview(false);
});

describe("themeController — live preview", () => {
  it("beginThemePreview + previewThemeId applies without persisting", async () => {
    const before = getCurrentTheme();
    expect(before?.id).toBe(DEFAULT_THEME_ID);

    beginThemePreview();
    await previewThemeId("dracula");

    const after = getCurrentTheme();
    expect(after?.id).toBe("dracula");
    // Persist goes through `invoke("config_set_appearance_theme", ...)`. Preview
    // must never hit that — the config stays on whatever was there before.
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("endThemePreview(false) restores the original theme and skips persist", async () => {
    beginThemePreview();
    await previewThemeId("tokyo-night");
    expect(getCurrentTheme()?.id).toBe("tokyo-night");

    endThemePreview(false);
    expect(getCurrentTheme()?.id).toBe(DEFAULT_THEME_ID);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("endThemePreview(true) persists whatever is currently live", async () => {
    beginThemePreview();
    await previewThemeId("nord");
    expect(getCurrentTheme()?.id).toBe("nord");

    endThemePreview(true);
    // The persist is debounced (200 ms) — advance timers so we can assert.
    vi.useFakeTimers();
    endThemePreview(true); // defensive: session already ended, no-op
    vi.useRealTimers();

    // Actual persist assertion: wait for the 200 ms debounce.
    await new Promise((r) => setTimeout(r, 250));
    expect(invokeMock).toHaveBeenCalledWith("config_set_appearance_theme", {
      themeId: "nord",
      customThemePath: null,
    });
  });

  it("endThemePreview(true) is a no-op when nothing changed", async () => {
    beginThemePreview();
    // No previewThemeId call — the theme is unchanged
    endThemePreview(true);
    await new Promise((r) => setTimeout(r, 250));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("previewThemeId is a no-op without beginThemePreview", async () => {
    await previewThemeId("dracula");
    expect(getCurrentTheme()?.id).toBe(DEFAULT_THEME_ID);
  });

  it("setThemeId during a preview subsumes the session (preview does not fight)", async () => {
    beginThemePreview();
    await previewThemeId("monokai");
    expect(getCurrentTheme()?.id).toBe("monokai");

    await setThemeId("dracula");
    expect(getCurrentTheme()?.id).toBe("dracula");

    // Calling endThemePreview(false) now should NOT restore the old original
    // because the session was cleared by setThemeId.
    endThemePreview(false);
    expect(getCurrentTheme()?.id).toBe("dracula");

    await new Promise((r) => setTimeout(r, 250));
    expect(invokeMock).toHaveBeenCalledWith("config_set_appearance_theme", {
      themeId: "dracula",
      customThemePath: null,
    });
  });

  it("fires subscribers on preview (so terminals/CodeMirror retint)", async () => {
    const seen: string[] = [];
    const unsub = subscribeThemeChange((t) => seen.push(t.id));

    beginThemePreview();
    await previewThemeId("dracula");
    await previewThemeId("nord");
    endThemePreview(false);

    unsub();
    // Subscribers saw preview→preview→restore
    expect(seen).toEqual(["dracula", "nord", DEFAULT_THEME_ID]);
  });
});
