/**
 * §9 — the expanded panel of a worktree row: a quiet segmented switcher over
 * three views (Changes / History / Files).
 *
 * Panels use a "visited keep-alive" pattern: each renders on first
 * activation and afterwards only toggles `hidden`, so pagination position,
 * expanded commits, and expanded tree directories survive switching tabs.
 * Collapsing the row unmounts everything — re-expanding starts fresh, which
 * is the desirable staleness behavior.
 */

import { Component, Show, createSignal } from "solid-js";

import { ChangesView } from "./changes-view";
import { FileBrowser } from "./file-browser";
import { HistoryView } from "./history-view";
import { SegmentedSwitcher } from "./segmented-switcher";
import type { ExpandedTabId, WorktreeExpandedProps } from "./types";

const TABS: readonly { id: ExpandedTabId; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "history", label: "History" },
  { id: "files", label: "Files" },
];

export const WorktreeExpanded: Component<WorktreeExpandedProps> = (props) => {
  const [tab, setTab] = createSignal<ExpandedTabId>("changes");
  const [visited, setVisited] = createSignal<ReadonlySet<ExpandedTabId>>(new Set(["changes"]));

  const selectTab = (id: string) => {
    const next = id as ExpandedTabId;
    setTab(next);
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
  };

  return (
    <div class="flex flex-col gap-2">
      <SegmentedSwitcher tabs={TABS} active={tab()} onChange={selectTab} />

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
          />
        </div>
      </Show>
    </div>
  );
};
