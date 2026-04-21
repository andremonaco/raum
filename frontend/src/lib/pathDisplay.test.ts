import { describe, it, expect, beforeEach } from "vitest";

import { setHomeDirForTesting, tildify } from "./pathDisplay";

describe("tildify", () => {
  beforeEach(() => {
    setHomeDirForTesting("/Users/alice");
  });

  it("returns empty string for nullish input", () => {
    expect(tildify(undefined)).toBe("");
    expect(tildify(null)).toBe("");
    expect(tildify("")).toBe("");
  });

  it("returns ~ for an exact home-dir match", () => {
    expect(tildify("/Users/alice")).toBe("~");
  });

  it("replaces the home prefix with ~ for child paths", () => {
    expect(tildify("/Users/alice/Projekte/raum")).toBe("~/Projekte/raum");
  });

  it("leaves unrelated paths untouched", () => {
    expect(tildify("/opt/homebrew/bin/task")).toBe("/opt/homebrew/bin/task");
  });

  it("does not tildify a mid-segment substring match", () => {
    expect(tildify("/Users/alicesmith/work")).toBe("/Users/alicesmith/work");
  });

  it("returns input unchanged when home dir is not initialised", () => {
    setHomeDirForTesting(null);
    expect(tildify("/Users/alice/foo")).toBe("/Users/alice/foo");
  });
});
