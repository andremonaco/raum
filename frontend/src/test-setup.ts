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

// Node ≥ 25 defines its own `globalThis.localStorage` getter that returns
// `undefined` unless `--localstorage-file` is passed, and it shadows the
// jsdom implementation vitest would otherwise expose. Replace it with a
// minimal in-memory Storage so persistence tests work without a node flag.
if (typeof globalThis.localStorage === "undefined") {
  const backing = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key) => backing.get(String(key)) ?? null,
    key: (index) => [...backing.keys()][index] ?? null,
    removeItem: (key) => {
      backing.delete(String(key));
    },
    setItem: (key, value) => {
      backing.set(String(key), String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: shim, configurable: true });
}
