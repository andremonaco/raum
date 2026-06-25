import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import { clearPendingAddProject, openProjectFromCli, pendingAddProjectPath } from "./cliOpen";
import {
  __resetProjectStoreForTests,
  activeProjectSlug,
  projectStore,
  type ProjectListItem,
} from "../stores/projectStore";

const invokeMock = vi.mocked(invoke);

function project(overrides: Partial<ProjectListItem> = {}): ProjectListItem {
  return {
    slug: "beta",
    name: "Beta",
    color: "#123456",
    sigil: "Β",
    rootPath: "/tmp/beta",
    inRepoSettings: false,
    hasRaumToml: false,
    hidden: false,
    ...overrides,
  };
}

describe("openProjectFromCli", () => {
  beforeEach(() => {
    __resetProjectStoreForTests();
    clearPendingAddProject();
    invokeMock.mockReset();
  });

  it("focuses an existing project without prompting to add", async () => {
    invokeMock.mockResolvedValueOnce(project());
    const result = await openProjectFromCli("/tmp/beta");
    expect(result).toBe("focused");
    expect(invokeMock).toHaveBeenCalledWith("project_find_by_path", { path: "/tmp/beta" });
    expect(projectStore.items.some((p) => p.slug === "beta")).toBe(true);
    expect(activeProjectSlug()).toBe("beta");
    expect(pendingAddProjectPath()).toBeUndefined();
  });

  it("requests the add-project modal for an unregistered directory", async () => {
    invokeMock.mockResolvedValueOnce(null);
    const result = await openProjectFromCli("/tmp/new-thing");
    expect(result).toBe("add-requested");
    expect(pendingAddProjectPath()).toBe("/tmp/new-thing");
    expect(projectStore.items).toHaveLength(0);
  });

  it("ignores an empty path", async () => {
    const result = await openProjectFromCli("");
    expect(result).toBe("noop");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(pendingAddProjectPath()).toBeUndefined();
  });

  it("reports an error (not a throw) when the backend lookup fails", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    const result = await openProjectFromCli("/tmp/explode");
    expect(result).toBe("error");
    expect(pendingAddProjectPath()).toBeUndefined();
  });
});
