/**
 * The cross-component deep link: Spotlight and the attention rail select a
 * worktree and then dispatch `raum:worktree-tab-requested`. Only the tab whose
 * path matches may react, and a collapsed tab has to open itself first.
 */
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));

import { WorktreeTab } from "./worktree-tab";
import { __resetGithubStoreForTests, applyPrChanged } from "../../stores/githubStore";
import type { Worktree } from "../../stores/worktreeStore";

const WT: Worktree = {
  branch: "feat/x",
  path: "/wt/a",
  head: "abc123",
  locked: false,
  detached: false,
  upstream: "origin/main",
  baseBranch: "main",
};

const requestTab = (path: string) => {
  window.dispatchEvent(
    new CustomEvent("raum:worktree-tab-requested", { detail: { path, tab: "github" } }),
  );
};

afterEach(() => {
  cleanup();
  __resetGithubStoreForTests();
});

describe("<WorktreeTab> deep link", () => {
  it("opens a collapsed tab when its own path is requested", () => {
    const onToggle = vi.fn();
    render(() => (
      <WorktreeTab
        worktree={WT}
        projectSlug="demo"
        isActive={false}
        isOpen={false}
        isMain={false}
        mainBranchFallback="main"
        onToggle={onToggle}
        onRequestDelete={() => undefined}
      />
    ));

    requestTab("/wt/a");
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("routes the PR chip through the same event", async () => {
    applyPrChanged({
      path: "/wt/a",
      available: true,
      pr: {
        number: 412,
        title: "Add the thing",
        url: "https://github.com/o/r/pull/412",
        state: "OPEN",
        isDraft: false,
        author: "andre",
        baseRefName: "main",
        headRefName: "feat/x",
        headRefOid: "abc123",
        reviewDecision: "APPROVED",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        checks: [],
        checksSummary: { total: 0, pass: 0, fail: 0, pending: 0, skipped: 0 },
        rollup: "pass",
        updatedAt: "2026-09-16T12:00:00Z",
      },
    });
    const onToggle = vi.fn();
    render(() => (
      <WorktreeTab
        worktree={WT}
        projectSlug="demo"
        isActive={false}
        isOpen={false}
        isMain={false}
        mainBranchFallback="main"
        onToggle={onToggle}
        onRequestDelete={() => undefined}
      />
    ));

    // Assert on the dispatched event, not just the toggle: a chip whose
    // handler never fired would bubble to the header button and toggle anyway.
    const seen: Array<{ path?: string; tab?: string }> = [];
    const spy = (ev: Event) => seen.push((ev as CustomEvent).detail);
    window.addEventListener("raum:worktree-tab-requested", spy);
    screen.getByText("#412").click();
    window.removeEventListener("raum:worktree-tab-requested", spy);

    expect(seen).toEqual([{ path: "/wt/a", tab: "github" }]);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("ignores a request aimed at another worktree", () => {
    const onToggle = vi.fn();
    render(() => (
      <WorktreeTab
        worktree={WT}
        projectSlug="demo"
        isActive={false}
        isOpen={false}
        isMain={false}
        mainBranchFallback="main"
        onToggle={onToggle}
        onRequestDelete={() => undefined}
      />
    ));

    requestTab("/wt/other");
    expect(onToggle).not.toHaveBeenCalled();
  });
});
