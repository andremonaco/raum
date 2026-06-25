import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { __resetAgentStoreForTests } from "./agentStore";
import {
  __resetProjectStoreForTests,
  projectStore,
  setActiveProjectSlug,
  setProjectHidden,
  setProjects,
  type ProjectListItem,
} from "./projectStore";
import {
  __resetTerminalStoreForTests,
  applyAgentStateToTerminal,
  setTerminals,
  type TerminalListItem,
} from "./terminalStore";
import {
  __resetProjectVisibilityForTests,
  otherProjects,
  visibleProjects,
} from "./projectVisibility";

const invokeMock = vi.mocked(invoke);

function project(overrides: Partial<ProjectListItem> = {}): ProjectListItem {
  return {
    slug: "alpha",
    name: "Alpha",
    color: "#123456",
    sigil: "Α",
    rootPath: "/tmp/alpha",
    inRepoSettings: false,
    hasRaumToml: true,
    hidden: false,
    ...overrides,
  };
}

function terminal(overrides: Partial<TerminalListItem> = {}): TerminalListItem {
  return {
    session_id: "s-alpha",
    project_slug: "alpha",
    worktree_id: "/tmp/alpha",
    kind: "claude-code",
    created_unix: 1,
    ...overrides,
  };
}

describe("projectVisibility", () => {
  beforeEach(() => {
    __resetProjectStoreForTests();
    __resetTerminalStoreForTests();
    __resetAgentStoreForTests();
    __resetProjectVisibilityForTests();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("shows the selected project and any with live sessions; suspends the rest", () => {
    setProjects([
      project(),
      project({ slug: "beta", name: "Beta" }),
      project({ slug: "gamma", name: "Gamma" }),
    ]);
    setActiveProjectSlug("alpha");
    // beta has a live session; gamma has none and isn't selected.
    setTerminals([terminal({ session_id: "s-beta", project_slug: "beta" })]);

    const visible = visibleProjects().map((p) => p.slug);
    expect(visible).toContain("alpha"); // selected
    expect(visible).toContain("beta"); // has a session
    expect(visible).not.toContain("gamma"); // auto-suspended
    expect(otherProjects().map((p) => p.slug)).toEqual(["gamma"]);
  });

  it("counts plain shells as keeping a project visible", () => {
    setProjects([project(), project({ slug: "beta", name: "Beta" })]);
    setActiveProjectSlug("alpha");
    setTerminals([terminal({ session_id: "sh-beta", project_slug: "beta", kind: "shell" })]);

    expect(visibleProjects().map((p) => p.slug)).toContain("beta");
  });

  it("manual hidden suppresses a project even with a live session", () => {
    setProjects([project(), project({ slug: "beta", name: "Beta", hidden: true })]);
    setActiveProjectSlug("alpha");
    setTerminals([terminal({ session_id: "s-beta", project_slug: "beta" })]);

    expect(visibleProjects().map((p) => p.slug)).not.toContain("beta");
    expect(otherProjects().map((p) => p.slug)).toContain("beta");
  });

  it("does not auto-suspend before the terminal snapshot settles", () => {
    setProjects([project(), project({ slug: "beta", name: "Beta" })]);
    setActiveProjectSlug("alpha");
    // No setTerminals() yet → terminalsReady is false → show all non-hidden.

    const visible = visibleProjects().map((p) => p.slug);
    expect(visible).toContain("alpha");
    expect(visible).toContain("beta");
  });

  it("otherProjects is the exact complement of visibleProjects", () => {
    setProjects([project(), project({ slug: "beta" }), project({ slug: "gamma" })]);
    setActiveProjectSlug("alpha");
    setTerminals([]); // ready, no sessions

    const visible = new Set(visibleProjects().map((p) => p.slug));
    const other = new Set(otherProjects().map((p) => p.slug));
    expect([...visible].some((s) => other.has(s))).toBe(false);
    expect(visible.size + other.size).toBe(3);
  });

  it("manual shelve of an already-waiting project sticks (no resurface bounce)", async () => {
    setProjects([project({ slug: "beta", name: "Beta" }), project()]);
    setActiveProjectSlug("alpha");
    setTerminals([terminal({ session_id: "s-beta", project_slug: "beta" })]);
    applyAgentStateToTerminal("s-beta", "waiting"); // beta waiting but visible (not hidden)
    await Promise.resolve();

    // User explicitly shelves the already-waiting project — the rising edge has
    // already fired, so it must NOT be auto-resurfaced back.
    await setProjectHidden("beta", true);
    await Promise.resolve();

    expect(projectStore.items.find((p) => p.slug === "beta")?.hidden).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith("project_update", {
      update: { slug: "beta", hidden: false },
    });
  });

  it("auto-resurfaces a shelved project that gains a waiting session", async () => {
    setProjects([project({ slug: "beta", name: "Beta", hidden: true }), project()]);
    setActiveProjectSlug("alpha");
    setTerminals([terminal({ session_id: "s-beta", project_slug: "beta" })]);
    applyAgentStateToTerminal("s-beta", "waiting");

    // The auto-resurface effect clears `hidden` via project_update.
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith("project_update", {
      update: { slug: "beta", hidden: false },
    });
    expect(projectStore.items.find((p) => p.slug === "beta")?.hidden).toBe(false);
  });
});
