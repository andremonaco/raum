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

import { Component, Show, createSignal } from "solid-js";

import { FolderIcon, GitBranchIcon, HistoryIcon } from "../icons";
import { ChangesView } from "./changes-view";
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

export const WorktreeDetail: Component<WorktreeDetailProps> = (props) => {
  const [tab, setTab] = createSignal<ExpandedTabId>("changes");
  const [visited, setVisited] = createSignal<ReadonlySet<ExpandedTabId>>(new Set(["changes"]));

  const selectTab = (id: ExpandedTabId) => {
    setTab(id);
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  };

  return (
    <div class="flex flex-col">
      <ViewTabBar tabs={TABS} active={tab()} onChange={selectTab} />

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
