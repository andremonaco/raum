import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  __resetFirstPromptCacheForTests,
  ensureFirstPromptLoaded,
  firstPromptForSession,
} from "./firstPromptCache";

const invokeMock = vi.mocked(invoke);

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("firstPromptCache", () => {
  beforeEach(() => {
    __resetFirstPromptCacheForTests();
    invokeMock.mockReset();
  });

  it("returns undefined before fetch, loads via Tauri, then caches", async () => {
    invokeMock.mockResolvedValueOnce("the original task");
    expect(firstPromptForSession("S")).toBeUndefined();

    ensureFirstPromptLoaded("S");
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("session_first_prompt", {
      args: { sessionId: "S" },
    });
    expect(firstPromptForSession("S")).toBe("the original task");

    // Subsequent ensure calls don't trigger another invoke.
    ensureFirstPromptLoaded("S");
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("caches null when the backend returns no prompt", async () => {
    invokeMock.mockResolvedValueOnce(null);
    ensureFirstPromptLoaded("S");
    await flush();
    expect(firstPromptForSession("S")).toBeNull();

    // Null is a valid cached state — don't retry.
    ensureFirstPromptLoaded("S");
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent in-flight fetches for the same session", async () => {
    let resolveFetch: ((v: string) => void) | undefined;
    invokeMock.mockImplementationOnce(
      () => new Promise<string>((resolve) => (resolveFetch = resolve)),
    );

    ensureFirstPromptLoaded("S");
    ensureFirstPromptLoaded("S");
    ensureFirstPromptLoaded("S");
    expect(invokeMock).toHaveBeenCalledTimes(1);

    resolveFetch?.("done");
    await flush();
    expect(firstPromptForSession("S")).toBe("done");
  });

  it("caches null on failure so we don't retry forever", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    ensureFirstPromptLoaded("S");
    await flush();
    expect(firstPromptForSession("S")).toBeNull();

    ensureFirstPromptLoaded("S");
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("ignores nullish session ids", () => {
    expect(firstPromptForSession(null)).toBeUndefined();
    expect(firstPromptForSession(undefined)).toBeUndefined();
    ensureFirstPromptLoaded(null);
    ensureFirstPromptLoaded(undefined);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
