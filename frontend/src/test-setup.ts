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

// jsdom doesn't ship `ResizeObserver`. Several components observe size
// changes on layout roots in `onMount`; the call sites are guarded by
// `typeof ResizeObserver !== "undefined"` where they could degrade
// gracefully, but `terminal-grid.tsx` requires the observer to drive
// drag-preview rect recomputation and isn't conditional. Stub a no-op
// implementation so component mounts under jsdom don't throw.
if (typeof globalThis.ResizeObserver === "undefined") {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: typeof NoopResizeObserver }).ResizeObserver =
    NoopResizeObserver;
}
