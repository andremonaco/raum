import { describe, expect, it } from "vitest";

import { __attachSchedulerStateForTests, acquireAttachSlot } from "./attachScheduler";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("attachScheduler", () => {
  it("caps queued attaches at three, drains visible before hidden, and never queues the focused pane", async () => {
    const order: string[] = [];
    const grab = (label: string, priority: 0 | 1 | 2): Promise<() => void> =>
      acquireAttachSlot(priority).then((release) => {
        order.push(label);
        return release;
      });

    const hidden = [grab("h1", 2), grab("h2", 2), grab("h3", 2), grab("h4", 2)];
    const visible = grab("v1", 1);
    await flush();
    // Three slots: h1..h3 took them before v1 enqueued; h4 and v1 wait.
    expect(order).toEqual(["h1", "h2", "h3"]);
    expect(__attachSchedulerStateForTests()).toEqual({ inFlight: 3, queued: 2 });

    // Focused pane bypasses the limit entirely.
    const focusedRelease = await grab("focused", 0);
    expect(order.at(-1)).toBe("focused");
    expect(__attachSchedulerStateForTests().inFlight).toBe(4);
    focusedRelease();

    // Releasing one slot admits the visible pane ahead of the older hidden one.
    (await hidden[0])();
    await flush();
    expect(order.at(-1)).toBe("v1");
    (await hidden[1])();
    await flush();
    expect(order.at(-1)).toBe("h4");

    // Double release is a no-op.
    const r = await visible;
    r();
    r();
    (await hidden[2])();
    (await hidden[3])();
    expect(__attachSchedulerStateForTests()).toEqual({ inFlight: 0, queued: 0 });
  });
});
