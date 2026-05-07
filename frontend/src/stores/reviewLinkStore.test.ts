import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  __resetReviewLinkStoreForTests,
  allReviewLinks,
  applyReviewLinked,
  applyReviewUnlinked,
  clearReviewLinkForSession,
  isReviewLinked,
  reviewedBy,
  reviewerOf,
  subscribeReviewLinkEvents,
} from "./reviewLinkStore";

const listenMock = vi.mocked(listen);
const invokeMock = vi.mocked(invoke);

describe("reviewLinkStore", () => {
  beforeEach(() => {
    __resetReviewLinkStoreForTests();
    listenMock.mockReset();
    invokeMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
  });

  it("records a link and looks it up in both directions", () => {
    applyReviewLinked({ reviewerSessionId: "A", reviewedSessionId: "B" });
    expect(reviewerOf("A")).toBe("B");
    expect(reviewedBy("B")).toEqual(["A"]);
    expect(isReviewLinked("A")).toBe(true);
    expect(isReviewLinked("B")).toBe(true);
    expect(isReviewLinked("C")).toBe(false);
  });

  it("supports multiple reviewers reviewing the same session", () => {
    applyReviewLinked({ reviewerSessionId: "A", reviewedSessionId: "T" });
    applyReviewLinked({ reviewerSessionId: "B", reviewedSessionId: "T" });
    expect(reviewedBy("T").sort()).toEqual(["A", "B"]);
  });

  it("drops both endpoints when a link is unlinked", () => {
    applyReviewLinked({ reviewerSessionId: "A", reviewedSessionId: "B" });
    applyReviewLinked({ reviewerSessionId: "C", reviewedSessionId: "D" });
    applyReviewUnlinked("A");
    expect(reviewerOf("A")).toBeUndefined();
    expect(reviewedBy("B")).toEqual([]);
    // Untouched pair survives.
    expect(reviewerOf("C")).toBe("D");
  });

  it("unlinking via the reviewed side also clears the reviewer entry", () => {
    applyReviewLinked({ reviewerSessionId: "A", reviewedSessionId: "B" });
    applyReviewUnlinked("B");
    expect(reviewerOf("A")).toBeUndefined();
    expect(reviewedBy("B")).toEqual([]);
  });

  it("ignores nullish session ids", () => {
    expect(reviewerOf(null)).toBeUndefined();
    expect(reviewerOf(undefined)).toBeUndefined();
    expect(reviewedBy(null)).toEqual([]);
    expect(isReviewLinked(null)).toBe(false);
  });

  it("subscribes to review:linked and review:unlinked events", async () => {
    type Listener = (ev: {
      payload: { reviewerSessionId: string; reviewedSessionId: string };
    }) => void;
    const listeners: Record<string, Listener> = {};
    listenMock.mockImplementation(((event: string, cb: Listener) => {
      listeners[event] = cb;
      return Promise.resolve(() => undefined);
    }) as unknown as typeof listen);

    const unlisten = await subscribeReviewLinkEvents();

    listeners["review:linked"]({ payload: { reviewerSessionId: "X", reviewedSessionId: "Y" } });
    expect(reviewerOf("X")).toBe("Y");

    listeners["review:unlinked"]({ payload: { reviewerSessionId: "X", reviewedSessionId: "Y" } });
    expect(reviewerOf("X")).toBeUndefined();

    unlisten();
  });

  it("clearReviewLinkForSession invokes the backend with the session id", async () => {
    invokeMock.mockResolvedValue(undefined);
    await clearReviewLinkForSession("S");
    expect(invokeMock).toHaveBeenCalledWith("clear_review_link", {
      args: { sessionId: "S" },
    });
  });

  it("clearReviewLinkForSession swallows backend errors", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    await expect(clearReviewLinkForSession("S")).resolves.toBeUndefined();
  });

  it("allReviewLinks returns every active pair, empty by default", () => {
    expect(allReviewLinks()).toEqual([]);
    applyReviewLinked({ reviewerSessionId: "A", reviewedSessionId: "B" });
    applyReviewLinked({ reviewerSessionId: "C", reviewedSessionId: "D" });
    const pairs = allReviewLinks().sort((x, y) =>
      x.reviewerSessionId.localeCompare(y.reviewerSessionId),
    );
    expect(pairs).toEqual([
      { reviewerSessionId: "A", reviewedSessionId: "B" },
      { reviewerSessionId: "C", reviewedSessionId: "D" },
    ]);
  });
});
