/**
 * §3 / §8 — the detail body of an open worktree tab: three keep-alive views
 * (Changes / History / Files) behind the underline `ViewTabBar`.
 *
 * Renamed from `worktree-expanded.tsx`. Two structural changes vs the old
 * inline-row panel:
 *   • The views render scroll-less (plain `<div>`s) — the open `WorktreeTab`
 *     owns the one large `Scrollable` wrapping this component, so there are no
 *     nested `max-h-64` instances and no nested-momentum jitter (§8).
 *   • Tab + visited-set state lives here. The tab mounts this subtree when it
 *     opens and unmounts it when it collapses — so the selected tab, History
 *     pagination, and expanded tree dirs survive switching between views, but
 *     reset on collapse/re-expand (the desirable staleness behavior).
 *
 * Panels use a "visited keep-alive" pattern: each renders on first activation
 * and afterwards only toggles `hidden`, so per-view state is not torn down on
 * every tab switch.
 */

import { Component, Show, createEffect, createMemo, createSignal } from "solid-js";

import { ghUsable, prForPath } from "../../stores/githubStore";
import { FolderIcon, GitBranchIcon, HistoryIcon } from "../icons";
import { ChangesView } from "./changes-view";
import { GithubMarkIcon, GithubView } from "./github-view";
import { FileBrowser } from "./file-browser";
import { HistoryView } from "./history-view";
import { ViewTabBar } from "./view-tab-bar";
import type { ExpandedTabId, ViewTabItem, WorktreeDetailProps } from "./types";

// Per-tab icons (§4) — icon-only tabs, labels surface as tooltips:
// Changes→source-control branch glyph, History→rewind-clock, Files→folder.
const TABS: readonly ViewTabItem[] = [
  { id: "changes", label: "Changes", icon: GitBranchIcon },
  { id: "history", label: "History", icon: HistoryIcon },
  { id: "files", label: "Files", icon: FolderIcon },
];

const GITHUB_TAB: ViewTabItem = { id: "github", label: "GitHub", icon: GithubMarkIcon };

export const WorktreeDetail: Component<WorktreeDetailProps> = (props) => {
  const initial = props.initialTab ?? "changes";
  const [tab, setTab] = createSignal<ExpandedTabId>(initial);
  const [visited, setVisited] = createSignal<ReadonlySet<ExpandedTabId>>(
    new Set(["changes", initial]),
  );

  const selectTab = (id: ExpandedTabId) => {
    setTab(id);
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  };
  // Let the owning tab deep-link into a view while this detail stays mounted.
  createEffect(() => props.onReady?.(selectTab));

  // The GitHub tab exists only when `gh` is installed and authenticated AND
  // the backend reported this worktree as a GitHub remote. No event yet counts
  // as "maybe" — the view renders its own loading line.
  const githubVisible = createMemo(
    () => ghUsable() && prForPath(props.worktree.path)?.available !== false,
  );
  const tabs = createMemo<readonly ViewTabItem[]>(() =>
    githubVisible() ? [...TABS, GITHUB_TAB] : TABS,
  );

  return (
    <div class="flex flex-col">
      <ViewTabBar tabs={tabs()} active={tab()} onChange={selectTab} />

      {/* Changes is always mounted (cheapest view + the default landing tab). */}
      <div role="tabpanel" hidden={tab() !== "changes"}>
        <ChangesView
          worktree={props.worktree}
          projectSlug={props.projectSlug}
          status={props.status}
          statusPending={props.statusPending}
          onOpenDiff={props.onOpenDiff}
          onOpenEditor={props.onOpenEditor}
        />
      </div>

      <Show when={visited().has("history")}>
        <div role="tabpanel" hidden={tab() !== "history"}>
          <HistoryView
            worktree={props.worktree}
            active={tab() === "history"}
            onOpenDiff={props.onOpenDiff}
          />
        </div>
      </Show>

      <Show when={visited().has("github") && githubVisible()}>
        <div role="tabpanel" hidden={tab() !== "github"}>
          <GithubView
            worktree={props.worktree}
            projectSlug={props.projectSlug}
            status={props.status}
            isMain={props.isMain ?? false}
          />
        </div>
      </Show>

      <Show when={visited().has("files")}>
        <div role="tabpanel" hidden={tab() !== "files"}>
          <FileBrowser
            worktree={props.worktree}
            status={props.status}
            onOpenEditor={props.onOpenEditor}
            onOpenDiff={props.onOpenDiff}
            activeEditorPath={props.activeEditorPath}
          />
        </div>
      </Show>
    </div>
  );
};
