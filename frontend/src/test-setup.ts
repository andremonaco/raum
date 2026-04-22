import "@testing-library/jest-dom/vitest";

// jsdom doesn't ship `matchMedia`; solid-sonner's Toaster reads it to
// resolve `theme="system"`, and the app-shell test mounts the Toaster.
// Stub with a minimal MediaQueryList so mounting doesn't throw.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
