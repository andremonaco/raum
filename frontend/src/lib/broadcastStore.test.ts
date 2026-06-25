import { describe, it, expect, beforeEach, vi } from "vitest";

// broadcastStore resolves membership from the live terminal indices + the
// active project, so we mock those two seams and drive them per-test. Hoisted
// so the vi.mock factories (which run before imports) can see them.
const mocks = vi.hoisted(() => ({
  harnessIds: vi.fn((): Set<string> => new Set<string>()),
  idsByProjectSlug: vi.fn((): Map<string, Set<string>> => new Map<string, Set<string>>()),
  activeProjectSlug: vi.fn((): string | null => null),
}));

vi.mock("../stores/terminalStore", () => ({
  harnessIds: mocks.harnessIds,
  idsByProjectSlug: mocks.idsByProjectSlug,
}));
vi.mock("../stores/projectStore", () => ({
  activeProjectSlug: mocks.activeProjectSlug,
}));

import {
  isBroadcastActive,
  isBroadcastMember,
  broadcastMemberIds,
  setBroadcastActive,
  setBroadcastScope,
  setBroadcastMembers,
  __resetBroadcastStoreForTests,
} from "./broadcastStore";

beforeEach(() => {
  __resetBroadcastStoreForTests();
  mocks.harnessIds.mockReturnValue(new Set<string>());
  mocks.idsByProjectSlug.mockReturnValue(new Map<string, Set<string>>());
  mocks.activeProjectSlug.mockReturnValue(null);
});

describe("broadcastStore", () => {
  it("is inert while off — predicates empty/false regardless of scope/members", () => {
    mocks.harnessIds.mockReturnValue(new Set(["s1", "s2"]));
    setBroadcastScope("all-visible");
    setBroadcastMembers(["s1"]);
    // active still false
    expect(isBroadcastActive()).toBe(false);
    expect(broadcastMemberIds()).toEqual([]);
    expect(isBroadcastMember("s1")).toBe(false);
  });

  it("all-visible scope = every live harness across projects", () => {
    mocks.harnessIds.mockReturnValue(new Set(["s1", "s2"]));
    setBroadcastScope("all-visible");
    setBroadcastActive(true);
    expect([...broadcastMemberIds()].sort()).toEqual(["s1", "s2"]);
    expect(isBroadcastMember("s1")).toBe(true);
    expect(isBroadcastMember("s3")).toBe(false);
  });

  it("active-project scope = harnesses in the active project only", () => {
    mocks.idsByProjectSlug.mockReturnValue(
      new Map([
        ["proj-a", new Set(["a1", "a2"])],
        ["proj-b", new Set(["b1"])],
      ]),
    );
    mocks.activeProjectSlug.mockReturnValue("proj-a");
    setBroadcastScope("active-project");
    setBroadcastActive(true);
    expect([...broadcastMemberIds()].sort()).toEqual(["a1", "a2"]);
    expect(isBroadcastMember("a1")).toBe(true);
    expect(isBroadcastMember("b1")).toBe(false);
  });

  it("active-project scope yields nothing when no project is active", () => {
    mocks.idsByProjectSlug.mockReturnValue(new Map([["proj-a", new Set(["a1"])]]));
    mocks.activeProjectSlug.mockReturnValue(null);
    setBroadcastScope("active-project");
    setBroadcastActive(true);
    expect(broadcastMemberIds()).toEqual([]);
    expect(isBroadcastMember("a1")).toBe(false);
  });

  it("manual scope = explicit members intersected with live harnesses (drops closed ids)", () => {
    // live1/live2 are live; dead3 was closed since the user added it.
    mocks.harnessIds.mockReturnValue(new Set(["live1", "live2"]));
    setBroadcastScope("manual");
    setBroadcastMembers(["live1", "dead3"]);
    setBroadcastActive(true);
    expect(broadcastMemberIds()).toEqual(["live1"]);
    expect(isBroadcastMember("live1")).toBe(true);
    expect(isBroadcastMember("dead3")).toBe(false); // not live → dropped
    expect(isBroadcastMember("live2")).toBe(false); // live but not a manual member
  });
});
