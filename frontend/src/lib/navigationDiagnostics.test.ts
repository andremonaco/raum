import { describe, expect, it, vi } from "vitest";

import {
  createNavigationDiagnostics,
  type NavigationDiagnosticsPayload,
} from "./navigationDiagnostics";

function harness(enabled = true) {
  let t = 0;
  const timers: { at: number; callback: () => void }[] = [];
  const sink = vi.fn<(payload: NavigationDiagnosticsPayload) => void>();
  const d = createNavigationDiagnostics({
    now: () => t,
    sink,
    enabled,
    schedule: (callback, delayMs) => timers.push({ at: t + delayMs, callback }),
  });
  return {
    d,
    sink,
    /** Fire every timer due at the current injected time. */
    runTimers() {
      for (const timer of timers.splice(0)) {
        if (timer.at <= t) timer.callback();
        else timers.push(timer);
      }
    },
    at(ms: number) {
      t = ms;
    },
    advance(ms: number) {
      t += ms;
    },
  };
}

describe("navigationDiagnostics", () => {
  it("does no sink work when disabled", () => {
    const { d, sink, advance } = harness(false);
    const token = d.beginNavigation("project", "mouse", { projectSlug: "p" });
    d.markNavigation(token, "handler");
    d.expectVisibleTargets(token, ["s1"]);
    d.markTargetRendered(token, "s1");
    d.countScoped("fit", 3);
    advance(5000);
    d.finishNavigation(token, "complete");
    d.flushNow();

    expect(sink).not.toHaveBeenCalled();
    const snap = d.snapshotForTests();
    expect(snap.inFlight).toHaveLength(0);
    expect(snap.completed).toHaveLength(0);
    expect(snap.counters).toEqual({});
  });

  it("keeps at most 256 completed records, evicting the oldest", () => {
    const { d } = harness();
    for (let i = 0; i < 257; i++) {
      const token = d.beginNavigation("pane-focus", "keyboard", { cellId: `c${i}` });
      d.finishNavigation(token, "complete");
    }
    const { completed } = d.snapshotForTests();
    expect(completed).toHaveLength(256);
    // Record 1 evicted; the window is ids 2..257.
    expect(completed[0]?.id).toBe(2);
    expect(completed.at(-1)?.id).toBe(257);
  });

  it("leaves a milestone absent when it never happened", () => {
    const { d, advance } = harness();
    const token = d.beginNavigation("tab", "mouse", { tabId: "t1" });
    advance(2);
    d.markNavigation(token, "handler");
    advance(6);
    d.markNavigation(token, "focus-ready");
    d.finishNavigation(token, "complete");

    const record = d.snapshotForTests().completed[0];
    expect(record?.milestones).toEqual({ handler: 2, "focus-ready": 8 });
    expect(record?.milestones["target-rendered"]).toBeUndefined();
  });

  it("supersedes the previous in-flight selection when a newer one starts", () => {
    const { d, advance } = harness();
    const a = d.beginNavigation("project", "mouse", { projectSlug: "a" });
    advance(5);
    const b = d.beginNavigation("project", "keyboard", { projectSlug: "b" });
    advance(5);
    d.finishNavigation(b, "complete");

    const { completed } = d.snapshotForTests();
    expect(completed.map((r) => [r.id, r.result])).toEqual([
      [a.id, "superseded"],
      [b.id, "complete"],
    ]);
  });

  it("does not supersede a scope switch from a pane-focus intent", () => {
    const { d } = harness();
    const scope = d.beginNavigation("worktree", "mouse", { scopeKey: "s" });
    d.beginNavigation("pane-focus", "keyboard", { cellId: "c1" });

    expect(d.snapshotForTests().inFlight.map((r) => r.id)).toContain(scope.id);
    expect(d.snapshotForTests().completed).toHaveLength(0);
  });

  it("cannot finish a newer record with a stale token", () => {
    const { d } = harness();
    const a = d.beginNavigation("project", "mouse", { projectSlug: "a" });
    const b = d.beginNavigation("project", "mouse", { projectSlug: "b" });
    d.finishNavigation(a, "complete");

    const snap = d.snapshotForTests();
    expect(snap.inFlight.map((r) => r.id)).toEqual([b.id]);
    // A was already closed as superseded; the late finish changed nothing.
    expect(snap.completed.map((r) => r.result)).toEqual(["superseded"]);
  });

  it("expires an unfinished record after 10 s as timeout, keeping partial milestones", () => {
    const { d, at } = harness();
    const token = d.beginNavigation("project", "mouse", { projectSlug: "a" });
    at(4);
    d.markNavigation(token, "handler");
    at(10_000);
    // Any later call runs the lazy sweep.
    d.beginNavigation("pane-focus", "keyboard", { cellId: "c1" });

    const record = d.snapshotForTests().completed[0];
    expect(record?.id).toBe(token.id);
    expect(record?.result).toBe("timeout");
    expect(record?.milestones).toEqual({ handler: 4 });
  });

  it("counts duplicate native focus and visibility events for one return once", () => {
    const { d, at } = harness();
    const first = d.beginActivation("native");
    at(80);
    const second = d.beginActivation("native");
    expect(second.id).toBe(first.id);
    expect(d.snapshotForTests().inFlight).toHaveLength(1);

    at(400);
    const later = d.beginActivation("native");
    expect(later.id).not.toBe(first.id);
    expect(d.snapshotForTests().inFlight).toHaveLength(2);
  });

  it("completes all-visible-rendered from render marks alone, without waiting for output", () => {
    const { d, advance } = harness();
    const token = d.beginNavigation("worktree", "mouse", { scopeKey: "s" });
    d.expectVisibleTargets(token, ["surf-a", "surf-b"]);
    advance(7);
    d.markTargetRendered(token, "surf-a");
    expect(d.snapshotForTests().inFlight[0]?.milestones["all-visible-rendered"]).toBeUndefined();
    advance(5);
    d.markTargetRendered(token, "surf-b");
    d.finishNavigation(token, "complete");

    const record = d.snapshotForTests().completed[0];
    expect(record?.milestones["target-rendered"]).toBe(7);
    expect(record?.milestones["all-visible-rendered"]).toBe(12);
  });

  it("marks target-rendered only when the focused surface paints", () => {
    const { d, advance } = harness();
    const token = d.beginNavigation("project", "mouse", { projectSlug: "p" });
    d.expectVisibleTargets(token, ["surf-a", "surf-b"], "surf-b");
    advance(3);
    d.markTargetRendered(token, "surf-a");
    expect(d.snapshotForTests().inFlight[0]?.milestones["target-rendered"]).toBeUndefined();
    advance(6);
    d.markTargetRendered(token, "surf-b");
    d.finishNavigation(token, "complete");

    const record = d.snapshotForTests().completed[0];
    expect(record?.milestones["target-rendered"]).toBe(9);
    expect(record?.milestones["all-visible-rendered"]).toBe(9);
  });

  it("stops waiting for targets dropped by a newer navigation", () => {
    const { d, advance } = harness();
    const a = d.beginNavigation("worktree", "mouse", { scopeKey: "a" });
    d.expectVisibleTargets(a, ["surf-a", "surf-b"]);
    d.markTargetRendered(a, "surf-a");
    advance(3);
    const b = d.beginNavigation("worktree", "mouse", { scopeKey: "b" });
    d.expectVisibleTargets(b, ["surf-c"]);
    // The surface only the old scope contained never paints — and must not
    // hold anything open.
    advance(4);
    d.markTargetRendered(b, "surf-c");
    d.finishNavigation(b, "complete");

    const [oldRecord, newRecord] = d.snapshotForTests().completed;
    expect(oldRecord?.result).toBe("superseded");
    expect(oldRecord?.milestones["all-visible-rendered"]).toBeUndefined();
    expect(newRecord?.result).toBe("complete");
    expect(newRecord?.milestones["all-visible-rendered"]).toBe(4);
  });

  it("records the event-to-handler delay only when an event timestamp is given", () => {
    const { d, at } = harness();
    at(50);
    const withEvent = d.beginNavigation("tab", "mouse", {}, { eventTimeStampMs: 42 });
    const without = d.beginNavigation("pane-focus", "mouse", {});
    d.finishNavigation(withEvent, "complete");
    d.finishNavigation(without, "complete");

    const [a, b] = d.snapshotForTests().completed;
    expect(a?.eventDelayMs).toBe(8);
    expect(b?.eventDelayMs).toBeUndefined();
  });

  it("flushes at most once per second, batching records and counters", () => {
    const { d, sink, at } = harness();
    for (let i = 0; i < 40; i++) {
      at(i * 10);
      const token = d.beginNavigation("pane-focus", "keyboard", { cellId: `c${i}` });
      d.countScoped("fit", 1);
      d.finishNavigation(token, "complete");
    }
    // 400 ms of traffic — still inside the first flush budget.
    expect(sink).not.toHaveBeenCalled();

    at(1500);
    const token = d.beginNavigation("pane-focus", "keyboard", { cellId: "last" });
    d.finishNavigation(token, "complete");
    expect(sink).toHaveBeenCalledTimes(1);
    const payload = sink.mock.calls[0]?.[0];
    // The 41st record's own begin() ran the flush, so it lands in the next batch.
    expect(payload?.records).toHaveLength(40);
    expect(payload?.counters).toEqual({ fit: { count: 40, totalMs: 40 } });

    // Next second of traffic adds exactly one more flush.
    for (let i = 0; i < 20; i++) {
      at(1500 + i * 10);
      const t2 = d.beginNavigation("pane-focus", "keyboard", { cellId: `d${i}` });
      d.finishNavigation(t2, "complete");
    }
    expect(sink).toHaveBeenCalledTimes(1);
    at(2600);
    d.flushNow();
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[1]?.[0].records).toHaveLength(21);
  });

  it("flushes a trailing record once the second elapses, without new traffic", () => {
    const { d, sink, at, runTimers } = harness();
    const token = d.beginNavigation("project", "mouse", { projectSlug: "a" });
    d.finishNavigation(token, "complete");
    expect(sink).not.toHaveBeenCalled();

    // Timer is due at the end of the first flush window, not before.
    at(500);
    runTimers();
    expect(sink).not.toHaveBeenCalled();

    at(1000);
    runTimers();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0].records).toHaveLength(1);

    // Nothing left to send: a later sweep must not fire a second call.
    at(2500);
    runTimers();
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("__reset clears every bucket", () => {
    const { d } = harness();
    const token = d.beginNavigation("project", "mouse", { projectSlug: "a" });
    d.countScoped("addon-install", 2);
    d.finishNavigation(token, "complete");
    d.__reset();

    expect(d.snapshotForTests()).toEqual({ inFlight: [], completed: [], counters: {} });
  });
});
