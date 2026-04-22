import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

import { listen } from "@tauri-apps/api/event";
import {
  __resetProjectStoreForTests,
  projectBySlug,
  projectColor,
  projectStore,
  removeProject,
  setProjects,
  subscribeProjectEvents,
  upsertProject,
  type ProjectListItem,
} from "./projectStore";

const listenMock = vi.mocked(listen);

function project(overrides: Partial<ProjectListItem> = {}): ProjectListItem {
  return {
    slug: "alpha",
    name: "Alpha",
    color: "#123456",
    sigil: "Α",
    rootPath: "/tmp/alpha",
    inRepoSettings: false,
    hasRaumToml: true,
    ...overrides,
  };
}

describe("projectStore bySlug index", () => {
  beforeEach(() => {
    __resetProjectStoreForTests();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
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
