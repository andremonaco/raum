import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  __resetProjectStoreForTests,
  activeProjectSlug,
  projectBySlug,
  projectColor,
  projectStore,
  removeProject,
  reopenProject,
  setActiveProjectSlug,
  setProjectHidden,
  setProjects,
  subscribeProjectEvents,
  upsertProject,
  type ProjectListItem,
} from "./projectStore";

const listenMock = vi.mocked(listen);
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

describe("projectStore bySlug index", () => {
  beforeEach(() => {
    __resetProjectStoreForTests();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("projectColor reads the indexed map, not a linear .find()", () => {
    setProjects([project(), project({ slug: "beta", color: "#abcdef", name: "Beta" })]);

    expect(projectColor("alpha")).toBe("#123456");
    expect(projectColor("beta")).toBe("#abcdef");
    expect(projectColor("gamma")).toBeUndefined();
    expect(projectColor(undefined)).toBeUndefined();

    const map = projectBySlug();
    expect(map.size).toBe(2);
    expect(map.get("alpha")?.name).toBe("Alpha");
    expect(map.get("beta")?.color).toBe("#abcdef");
  });

  it("upsert keeps items and bySlug in sync", () => {
    setProjects([project()]);
    upsertProject(project({ slug: "beta", color: "#222222" }));
    upsertProject(project({ slug: "alpha", color: "#ff0000" }));

    expect(projectStore.items).toHaveLength(2);
    expect(projectColor("alpha")).toBe("#ff0000");
    expect(projectColor("beta")).toBe("#222222");
    expect(projectBySlug().get("alpha")?.color).toBe("#ff0000");
  });

  it("removeProject clears the map entry", () => {
    setProjects([project(), project({ slug: "beta" })]);
    removeProject("alpha");

    expect(projectColor("alpha")).toBeUndefined();
    expect(projectBySlug().has("alpha")).toBe(false);
    expect(projectBySlug().get("beta")?.slug).toBe("beta");
  });

  it("color and sigil events patch both items and bySlug", async () => {
    setProjects([project()]);
    const listeners: Record<string, (ev: { payload: unknown }) => void> = {};
    listenMock.mockImplementation(async (event, handler) => {
      listeners[event] = handler as (ev: { payload: unknown }) => void;
      return () => undefined;
    });

    const unlisten = await subscribeProjectEvents();

    listeners["project-color-changed"]({ payload: { slug: "alpha", color: "#010203" } });
    expect(projectColor("alpha")).toBe("#010203");
    expect(projectBySlug().get("alpha")?.color).toBe("#010203");
    expect(projectStore.items.find((p) => p.slug === "alpha")?.color).toBe("#010203");

    listeners["project-sigil-changed"]({ payload: { slug: "alpha", sigil: "Ω" } });
    expect(projectBySlug().get("alpha")?.sigil).toBe("Ω");
    expect(projectStore.items.find((p) => p.slug === "alpha")?.sigil).toBe("Ω");

    unlisten();
  });
});

describe("projectStore visibility", () => {
  beforeEach(() => {
    __resetProjectStoreForTests();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("setProjectHidden patches the flag optimistically and persists it", async () => {
    setProjects([project()]);
    await setProjectHidden("alpha", true);

    expect(projectStore.items.find((p) => p.slug === "alpha")?.hidden).toBe(true);
    expect(projectBySlug().get("alpha")?.hidden).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("project_update", {
      update: { slug: "alpha", hidden: true },
    });
  });

  it("hiding the active project switches selection to a non-hidden sibling", async () => {
    setProjects([project(), project({ slug: "beta", name: "Beta" })]);
    setActiveProjectSlug("alpha");

    await setProjectHidden("alpha", true);

    expect(activeProjectSlug()).toBe("beta");
  });

  it("hiding the last visible project clears the active selection", async () => {
    setProjects([project()]);
    setActiveProjectSlug("alpha");

    await setProjectHidden("alpha", true);

    expect(activeProjectSlug()).toBeUndefined();
  });

  it("rolls back the optimistic patch when the persist fails", async () => {
    setProjects([project()]);
    // Fail only the persist — selection changes fire their own `invoke`
    // (`project_set_active`), which must not swallow the rejection.
    invokeMock.mockImplementation((cmd) =>
      cmd === "project_update" ? Promise.reject(new Error("boom")) : Promise.resolve(undefined),
    );

    await setProjectHidden("alpha", true);

    expect(projectStore.items.find((p) => p.slug === "alpha")?.hidden).toBe(false);
  });

  it("tells the backend which project is active so the git watcher follows", () => {
    setProjects([project(), project({ slug: "beta", name: "Beta" })]);
    invokeMock.mockClear();

    setActiveProjectSlug("beta");

    expect(invokeMock).toHaveBeenCalledWith("project_set_active", { slug: "beta" });
  });

  it("reopenProject selects the project and clears its hidden flag", async () => {
    setProjects([project({ hidden: true }), project({ slug: "beta", name: "Beta" })]);
    setActiveProjectSlug("beta");

    reopenProject("alpha");
    // The hidden→false persist is async; flush microtasks.
    await Promise.resolve();

    expect(activeProjectSlug()).toBe("alpha");
    expect(projectStore.items.find((p) => p.slug === "alpha")?.hidden).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("project_update", {
      update: { slug: "alpha", hidden: false },
    });
  });

  it("project-visibility-changed event patches the flag and re-homes the active tab", async () => {
    setProjects([project(), project({ slug: "beta", name: "Beta" })]);
    setActiveProjectSlug("alpha");
    const listeners: Record<string, (ev: { payload: unknown }) => void> = {};
    listenMock.mockImplementation(async (event, handler) => {
      listeners[event] = handler as (ev: { payload: unknown }) => void;
      return () => undefined;
    });

    const unlisten = await subscribeProjectEvents();

    listeners["project-visibility-changed"]({ payload: { slug: "alpha", hidden: true } });
    expect(projectStore.items.find((p) => p.slug === "alpha")?.hidden).toBe(true);
    expect(activeProjectSlug()).toBe("beta");

    unlisten();
  });
});
