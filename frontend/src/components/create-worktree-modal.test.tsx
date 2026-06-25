import { render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub Tauri's IPC so the modal's `invoke` calls become assertable spies.
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  // Minimal Channel shim — the modal constructs `new Channel()` to receive
  // progress events from the backend; tests don't exercise the submit path,
  // but the constructor still has to be callable at module load.
  Channel: class {
    onmessage: ((data: unknown) => void) | null = null;
  },
}));

import { CreateWorktreeModal, useWorktreeCreate } from "./create-worktree-modal";
import { clearWorktreeListCache, worktreesByProject, type Worktree } from "../stores/worktreeStore";
import { Channel } from "@tauri-apps/api/core";
import { createRoot } from "solid-js";

const PROJECT_SLUG = "demo";

describe("<CreateWorktreeModal>", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "worktree_branches":
          return Promise.resolve({
            branches: ["main", "feat/old", "release/2025-04"],
            current: "main",
          });
        case "worktree_preview_path":
          return Promise.resolve({
            prefixedBranch: "feat/example",
            path: "/tmp/demo-worktrees/feat-example",
            pattern: "{parent-dir}/{base-folder}-worktrees/{branch-slug}",
            branchPrefixMode: "none",
            pathStrategy: "nested",
          });
        case "worktree_preview_manifest":
          return Promise.resolve({ copy: [], symlink: [], fromRaumToml: false });
        default:
          return Promise.resolve(null);
      }
    });
  });

  it("pre-selects the project's configured strategy", async () => {
    render(() => (
      <CreateWorktreeModal projectSlug={PROJECT_SLUG} open={true} onClose={() => undefined} />
    ));

    // Wait for the default-preview resource to resolve, then assert the
    // segmented control reflects the backend-reported strategy ("nested").
    await waitFor(() => {
      const nestedBtn = screen.getByTestId("strategy-nested");
      expect(nestedBtn.getAttribute("aria-checked")).toBe("true");
    });

    const sibling = screen.getByTestId("strategy-sibling-group");
    expect(sibling.getAttribute("aria-checked")).toBe("false");
  });

  it("defaults the base branch picker to the project's current branch", async () => {
    render(() => (
      <CreateWorktreeModal projectSlug={PROJECT_SLUG} open={true} onClose={() => undefined} />
    ));

    const trigger = await screen.findByTestId("base-branch-dropdown");
    await waitFor(() => {
      expect(trigger.textContent).toContain("main");
    });
    // Helper text mirrors the chosen base branch.
    expect(screen.getByText(/New branch will be created from/i).textContent).toContain("main");
  });

  // Regression for #45: a worktree whose postCreate hook fails is still
  // created on disk, but `worktree_create` returns Err. The list must refresh
  // anyway so the worktree shows up immediately instead of staying hidden
  // until the next successful create re-lists everything.
  it("refreshes the worktree list even when the create command rejects", async () => {
    clearWorktreeListCache(PROJECT_SLUG);
    const created: Worktree = {
      branch: "feat/hooked",
      path: "/tmp/demo-worktrees/feat-hooked",
      head: "abc123",
      locked: false,
      detached: false,
      upstream: null,
      baseBranch: "main",
    };
    mockInvoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "worktree_create":
          // postCreate hook failure — the worktree exists, the command errors.
          return Promise.reject(new Error("hook:postCreate: exit code 1"));
        case "worktree_list":
          // On-disk truth includes the created-but-hook-failed worktree.
          return Promise.resolve([created]);
        default:
          return Promise.resolve(null);
      }
    });

    await createRoot(async (dispose) => {
      const creator = useWorktreeCreate(() => PROJECT_SLUG);
      await expect(
        creator.create(
          {
            branch: "feat/hooked",
            baseBranch: "main",
            strategyOverride: null,
            patternOverride: null,
          },
          new Channel(),
        ),
      ).rejects.toThrow(/postCreate/);
      dispose();
    });

    expect(worktreesByProject()[PROJECT_SLUG]).toEqual([created]);
  });
});
