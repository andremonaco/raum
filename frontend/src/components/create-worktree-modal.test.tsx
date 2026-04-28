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

import { CreateWorktreeModal } from "./create-worktree-modal";

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
});
