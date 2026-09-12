/**
 * Correlated navigation diagnostics: one record per user intent, from the
 * event handler through selection commit, focus readiness and target paint.
 *
 * Framework-independent on purpose (no Solid, no DOM) so the recorder can be
 * driven from stores, components and the window lifecycle alike, and tested
 * with an injected clock and sink.
 *
 * Payloads carry opaque IDs only — never project names, paths or terminal
 * text.
 */

import { invoke } from "@tauri-apps/api/core";

export type NavigationKind = "project" | "worktree" | "tab" | "pane-focus" | "window-return";

export type NavigationSource = "mouse" | "keyboard" | "dock" | "notification" | "native";

export type NavigationMilestone =
  | "handler"
  | "selection-committed"
  | "focus-ready"
  | "target-rendered"
  | "all-visible-rendered";

export type NavigationResult = "complete" | "superseded" | "recovery" | "timeout";

export interface NavigationTarget {
  projectSlug?: string;
  scopeKey?: string;
  cellId?: string;
  tabId?: string;
  sessionId?: string;
  /** `"1"` when this return followed a background presentation reclaim. */
  reclaimed?: string;
}

export interface NavigationRecord {
  id: number;
  kind: NavigationKind;
  source: NavigationSource;
  startMs: number;
  target: NavigationTarget;
  milestones: Partial<Record<NavigationMilestone, number>>;
  /** Only set when the caller supplied an event timestamp on the same clock. */
  eventDelayMs?: number;
  result?: NavigationResult;
}

export type ScopedCounterName =
  | "addon-dispose"
  | "addon-install"
  | "surface-projection"
  | "fit"
  | "resize-dispatch"
  | "snapshot-serialize"
  | "output-write";

export interface ScopedCounter {
  count: number;
  totalMs: number;
}

export interface NavigationDiagnosticsPayload {
  records: NavigationRecord[];
  counters: Partial<Record<ScopedCounterName, ScopedCounter>>;
}

export interface NavigationToken {
  readonly id: number;
}

export interface NavigationDiagnosticsOptions {
  now?: () => number;
  sink?: (payload: NavigationDiagnosticsPayload) => void;
  /** Injected so tests drive the trailing flush without real timers. */
  schedule?: (callback: () => void, delayMs: number) => void;
  enabled?: boolean;
}

const MAX_COMPLETED = 256;
const MAX_IN_FLIGHT = 32;
const TIMEOUT_MS = 10_000;
const FLUSH_INTERVAL_MS = 1_000;
/** Native focus and document-visibility fire separately for one return. */
const ACTIVATION_COALESCE_MS = 250;

/** Kinds that own "which view is selected" — only these supersede each other. */
const SELECTION_KINDS: ReadonlySet<NavigationKind> = new Set<NavigationKind>([
  "project",
  "worktree",
  "tab",
]);

const NO_OP_TOKEN: NavigationToken = { id: 0 };

interface Entry {
  record: NavigationRecord;
  /** Surface keys still awaited for `all-visible-rendered`; null when unset. */
  pending: Set<string> | null;
  /** The focused target; `target-rendered` waits for it, not for any sibling. */
  focusedKey: string | null;
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

export function createNavigationDiagnostics(options: NavigationDiagnosticsOptions = {}) {
  const now = options.now ?? (() => performance.now());
  const sink = options.sink;
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number) => {
      globalThis.setTimeout(callback, delayMs);
    });
  let enabled = options.enabled ?? true;

  const inFlight = new Map<number, Entry>();
  let completed: NavigationRecord[] = [];
  let unflushed: NavigationRecord[] = [];
  const counters = new Map<ScopedCounterName, ScopedCounter>();
  let nextId = 1;
  let lastFlushMs: number | null = null;
  let flushArmed = false;

  function complete(entry: Entry, result: NavigationResult): void {
    inFlight.delete(entry.record.id);
    entry.record.result = result;
    completed.push(entry.record);
    if (completed.length > MAX_COMPLETED) completed.splice(0, completed.length - MAX_COMPLETED);
    unflushed.push(entry.record);
    if (unflushed.length > MAX_COMPLETED) unflushed.splice(0, unflushed.length - MAX_COMPLETED);
    armFlush();
  }

  /**
   * One pending timer for the rest of the current second, so the last record
   * of a burst is reported instead of waiting for traffic that never comes.
   * Guarded by `flushArmed`, so the once-a-second cap still holds.
   */
  function armFlush(): void {
    if (!sink || flushArmed) return;
    flushArmed = true;
    const at = now();
    const wait =
      lastFlushMs === null
        ? FLUSH_INTERVAL_MS
        : Math.max(0, FLUSH_INTERVAL_MS - (at - lastFlushMs));
    schedule(() => {
      flushArmed = false;
      lastFlushMs = now();
      flush();
    }, wait);
  }

  function flush(): void {
    if (!sink || (unflushed.length === 0 && counters.size === 0)) return;
    sink({ records: unflushed, counters: Object.fromEntries(counters) });
    unflushed = [];
    counters.clear();
  }

  /** Lazy housekeeping: expire stale intents, then flush at most once a second. */
  function tick(at: number): void {
    // Deleting the current entry mid-iteration is safe for a Map iterator.
    for (const entry of inFlight.values()) {
      if (at - entry.record.startMs >= TIMEOUT_MS) complete(entry, "timeout");
    }
    if (lastFlushMs === null) {
      lastFlushMs = at;
      return;
    }
    if (at - lastFlushMs < FLUSH_INTERVAL_MS) return;
    lastFlushMs = at;
    flush();
  }

  function begin(
    kind: NavigationKind,
    source: NavigationSource,
    target: NavigationTarget,
    eventTimeStampMs?: number,
  ): NavigationToken {
    if (!enabled) return NO_OP_TOKEN;
    const at = now();
    tick(at);
    if (SELECTION_KINDS.has(kind)) {
      for (const entry of inFlight.values()) {
        if (SELECTION_KINDS.has(entry.record.kind)) complete(entry, "superseded");
      }
    }
    const record: NavigationRecord = {
      id: nextId++,
      kind,
      source,
      startMs: at,
      target,
      milestones: {},
    };
    if (eventTimeStampMs !== undefined) {
      record.eventDelayMs = round(Math.max(0, at - eventTimeStampMs));
    }
    inFlight.set(record.id, { record, pending: null, focusedKey: null });
    // Oldest intent first: a wedged record must not crowd out live ones.
    if (inFlight.size > MAX_IN_FLIGHT) {
      const oldest = inFlight.values().next().value;
      if (oldest) complete(oldest, "timeout");
    }
    return { id: record.id };
  }

  return {
    beginNavigation(
      kind: NavigationKind,
      source: NavigationSource,
      target: NavigationTarget,
      opts?: { eventTimeStampMs?: number },
    ): NavigationToken {
      return begin(kind, source, target, opts?.eventTimeStampMs);
    },

    /**
     * Window return. Native focus and document-visibility events for the same
     * return share one record, so a return is never counted twice.
     */
    beginActivation(source: NavigationSource, target: NavigationTarget = {}): NavigationToken {
      if (!enabled) return NO_OP_TOKEN;
      const at = now();
      for (const entry of inFlight.values()) {
        if (
          entry.record.kind === "window-return" &&
          at - entry.record.startMs <= ACTIVATION_COALESCE_MS
        ) {
          return { id: entry.record.id };
        }
      }
      return begin("window-return", source, target);
    },

    markNavigation(token: NavigationToken, milestone: NavigationMilestone): void {
      const entry = inFlight.get(token.id);
      if (!entry) return;
      const at = now();
      entry.record.milestones[milestone] = round(at - entry.record.startMs);
      tick(at);
    },

    /** Surfaces that must paint before `all-visible-rendered` is reached. */
    expectVisibleTargets(token: NavigationToken, surfaceKeys: string[], focusedKey?: string): void {
      const entry = inFlight.get(token.id);
      if (!entry) return;
      entry.pending = new Set(surfaceKeys);
      entry.focusedKey = focusedKey ?? null;
      if (entry.pending.size === 0) {
        entry.record.milestones["all-visible-rendered"] = round(now() - entry.record.startMs);
      }
    },

    markTargetRendered(token: NavigationToken, surfaceKey: string): void {
      const entry = inFlight.get(token.id);
      if (!entry) return;
      const at = now();
      // A sibling painting first says nothing about the pane the user is
      // waiting on; only the focused target (when known) sets this milestone.
      if (entry.focusedKey === null || surfaceKey === entry.focusedKey) {
        entry.record.milestones["target-rendered"] ??= round(at - entry.record.startMs);
      }
      if (!entry.pending) return;
      entry.pending.delete(surfaceKey);
      if (entry.pending.size === 0) {
        entry.record.milestones["all-visible-rendered"] = round(at - entry.record.startMs);
      }
    },

    finishNavigation(token: NavigationToken, result: NavigationResult): void {
      const entry = inFlight.get(token.id);
      if (!entry) return;
      const at = now();
      complete(entry, result);
      tick(at);
    },

    countScoped(name: ScopedCounterName, ms = 0): void {
      if (!enabled) return;
      const c = counters.get(name) ?? { count: 0, totalMs: 0 };
      c.count += 1;
      c.totalMs = round(c.totalMs + ms);
      counters.set(name, c);
    },

    /** Drain now regardless of the once-a-second budget (blur, quit, tests). */
    flushNow(): void {
      lastFlushMs = now();
      flush();
    },

    setEnabled(value: boolean): void {
      enabled = value;
    },

    snapshotForTests() {
      return {
        inFlight: [...inFlight.values()].map((e) => e.record),
        completed: [...completed],
        counters: Object.fromEntries(counters),
      };
    },

    __reset(): void {
      inFlight.clear();
      completed = [];
      unflushed = [];
      counters.clear();
      nextId = 1;
      lastFlushMs = null;
    },
  };
}

export type NavigationDiagnostics = ReturnType<typeof createNavigationDiagnostics>;

/**
 * Release opt-in: the recorder is on in dev builds and otherwise only when
 * `localStorage["raum:navigation-diagnostics"] === "1"` (the same switch shape
 * as `raum:presentation-policy`). The acceptance runs in
 * `openspec/changes/instant-view-switching/measurements/baseline.md` need it.
 */
function releaseOptIn(): boolean {
  try {
    return globalThis.localStorage?.getItem("raum:navigation-diagnostics") === "1";
  } catch {
    return false;
  }
}

const singleton = createNavigationDiagnostics({
  enabled: import.meta.env.DEV || releaseOptIn(),
  sink: (payload) => {
    void Promise.resolve()
      .then(() => invoke("webview_navigation_report", { payload }))
      .catch(() => {});
  },
});

export const beginNavigation = singleton.beginNavigation;
export const beginActivation = singleton.beginActivation;
export const markNavigation = singleton.markNavigation;
export const expectVisibleTargets = singleton.expectVisibleTargets;
export const markTargetRendered = singleton.markTargetRendered;
export const finishNavigation = singleton.finishNavigation;
export const countScoped = singleton.countScoped;
export const flushNavigationDiagnostics = singleton.flushNow;
export const setNavigationDiagnosticsEnabled = singleton.setEnabled;
export const snapshotNavigationDiagnostics = singleton.snapshotForTests;
export const __resetNavigationDiagnosticsForTests = singleton.__reset;
