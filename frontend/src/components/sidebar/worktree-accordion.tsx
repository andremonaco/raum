/**
 * §2 / §9 — WorktreeAccordion: the expanded sidebar body.
 *
 * A vertical stack of collapsible worktree "tabs". The main worktree is pinned
 * first as the local *base* repo; exactly one tab is open at a time (single-open
 * accordion) and its Changes / History / Files detail fills the remaining
 * height. This replaces the short-lived top/bottom split (DetailPanel +
 * WorktreeSwitcher) — the changes handle is per-worktree again, fused with the
 * worktree's own info instead of floating as a general panel.
 *
 * Absorbs the retired `project-section.tsx` duties: lazy worktree-list fetch +
 * status seeding, main-vs-additional partition, and the Delete / Unlink / Merge
 * / Create modal lifecycle (with the exact cache-invalidation preserved). Owns
 * the mini-toolbar (filter + "+") and the `openPath` accordion coordinator.
 */

import {
  Component,
  For,
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  untrack,
} from "solid-js";

import {
  ALL_WORKTREES_SCOPE,
  activeWorktreeStore,
  clearWorktreeListCache,
  pruneWorktreeStatus,
  refreshWorktreeList,
  refreshWorktreeStatuses,
  setActiveWorktree,
  worktreesByProject,
  type Worktree,
  type WorktreeScope,
} from "../../stores/worktreeStore";
import { activeProjectSlug, removeProject, type ProjectListItem } from "../../stores/projectStore";
import { harnessCountsForProject } from "../../stores/terminalStore";
import { PlusIcon } from "../icons";
import { CreateWorktreeModal } from "../create-worktree-modal";
import { AllTerminalsRow } from "./all-terminals-row";
import { WorktreeTab } from "./worktree-tab";
import type { WorktreeAccordionProps } from "./types";

const DeleteWorktreeModal = lazy(() =>
  import("../delete-worktree-modal").then((m) => ({ default: m.DeleteWorktreeModal })),
);
const MergeWorktreeModal = lazy(() =>
  import("../merge-worktree-modal").then((m) => ({ default: m.MergeWorktreeModal })),
);
const UnlinkProjectModal = lazy(() =>
  import("../unlink-project-modal").then((m) => ({ default: m.UnlinkProjectModal })),
);

/**
 * Inner accordion bound to a *definite* project — mirrors the retired
 * ProjectSection so the partition memos stay null-free. Owns the per-project
 * modals and the single-open `openPath` coordinator.
 */
const ProjectAccordion: Component<{
  project: ProjectListItem;
  worktreeFilter: string;
  createOpen: boolean;
  onCreateClose: () => void;
}> = (listProps) => {
  const slug = createMemo(() => listProps.project.slug);

  // Lazy-load the worktree list the first time this project is shown.
  createEffect(() => {
    const s = slug();
    if (worktreesByProject()[s]) return;
    void refreshWorktreeList(s);
  });

  // Delete/unlink target — `null` = closed. `{ kind: "wt", wt }` opens the
  // worktree-delete modal; `{ kind: "project" }` opens the unlink modal.
  const [deleteTarget, setDeleteTarget] = createSignal<
    { kind: "wt"; wt: Worktree } | { kind: "project" } | null
  >(null);
  const closeDeleteTarget = () => setDeleteTarget(null);

  // Merge target — `null` = closed.
  const [mergeTarget, setMergeTarget] = createSignal<Worktree | null>(null);
  const closeMergeTarget = () => setMergeTarget(null);

  const items = createMemo(() => worktreesByProject()[slug()] ?? []);

  // Seed any missing statuses once so the collapsed headers can show
  // dirty/ahead immediately. (Live updates flow through each tab's own stream.)
  createEffect(() => {
    const paths = items().map((wt) => wt.path);
    if (paths.length > 0) void untrack(() => refreshWorktreeStatuses(paths, { onlyMissing: true }));
  });

  const filteredItems = createMemo<Worktree[]>(() => {
    const q = listProps.worktreeFilter.toLowerCase().trim();
    if (!q) return items();
    return items().filter(
      (wt) =>
        (wt.branch ?? "").toLowerCase().includes(q) ||
        wt.path.split("/").pop()?.toLowerCase().includes(q),
    );
  });

  const scope = createMemo<WorktreeScope>(
    () => activeWorktreeStore.byProject[slug()] ?? ALL_WORKTREES_SCOPE,
  );
  const activePath = createMemo(() => {
    const s = scope();
    return s.mode === "worktree" ? s.path : undefined;
  });
  const isAllActive = createMemo(() => scope().mode === "all");
  const projectHarnessCounts = createMemo(() => harnessCountsForProject(slug()));

  // Main worktree = the one whose path equals the project root; pinned first.
  const mainWorktree = createMemo(
    () => filteredItems().find((wt) => wt.path === listProps.project.rootPath) ?? null,
  );
  const additionalWorktrees = createMemo(() =>
    filteredItems().filter((wt) => wt.path !== listProps.project.rootPath),
  );

  // Single-open accordion: which worktree path has its detail expanded. Seeded
  // once to the active worktree (or the main repo) so the panel never starts
  // empty; thereafter driven purely by header clicks.
  const [openPath, setOpenPath] = createSignal<string | null>(null);
  let seeded = false;
  createEffect(() => {
    if (seeded) return;
    const all = items();
    if (all.length === 0) return;
    seeded = true;
    setOpenPath(untrack(() => activePath() ?? mainWorktree()?.path ?? all[0]?.path ?? null));
  });

  const toggle = (path: string) => {
    if (openPath() === path) {
      setOpenPath(null); // collapse; the active scope is left untouched
    } else {
      setOpenPath(path);
      setActiveWorktree(slug(), path);
    }
  };

  return (
    <>
      <ul class="flex min-h-0 flex-1 flex-col px-2 pb-2">
        <Show
          when={filteredItems().length > 0}
          fallback={
            <li class="px-2 py-1 text-[11px] text-foreground-dim">
              {items().length === 0 ? "No worktrees yet." : "No matching worktrees."}
            </li>
          }
        >
          {/* Aggregate "All scopes" divider — selects the cross-worktree scope. */}
          <AllTerminalsRow
            projectSlug={slug()}
            projectName={listProps.project.name}
            isActive={isAllActive()}
            counts={projectHarnessCounts()}
          />

          {/* Main worktree — pinned first, tagged as the local base repo. */}
          <Show when={mainWorktree()}>
            {(main) => (
              <WorktreeTab
                worktree={main()}
                projectSlug={slug()}
                isActive={activePath() === main().path}
                isOpen={openPath() === main().path}
                isMain={true}
                projectColor={listProps.project.color}
                projectSigil={listProps.project.sigil}
                mainBranchFallback={main().branch}
                onToggle={() => toggle(main().path)}
                onRequestDelete={() => setDeleteTarget({ kind: "project" })}
              />
            )}
          </Show>

          {/* Added worktrees. */}
          <For each={additionalWorktrees()}>
            {(wt) => (
              <WorktreeTab
                worktree={wt}
                projectSlug={slug()}
                isActive={activePath() === wt.path}
                isOpen={openPath() === wt.path}
                isMain={false}
                projectColor={listProps.project.color}
                projectSigil={listProps.project.sigil}
                mainBranchFallback={mainWorktree()?.branch ?? null}
                onToggle={() => toggle(wt.path)}
                onRequestDelete={() => setDeleteTarget({ kind: "wt", wt })}
                onRequestMerge={() => setMergeTarget(wt)}
              />
            )}
          </For>
        </Show>
      </ul>

      <CreateWorktreeModal
        projectSlug={slug()}
        open={listProps.createOpen}
        onClose={listProps.onCreateClose}
        onCreated={() => {
          listProps.onCreateClose();
          void refreshWorktreeList(slug());
        }}
      />

      {(() => {
        const target = deleteTarget();
        if (target === null) return null;
        if (target.kind === "wt") {
          return (
            <Suspense>
              <DeleteWorktreeModal
                open={true}
                projectSlug={slug()}
                worktree={target.wt}
                onClose={closeDeleteTarget}
                onDeleted={() => {
                  pruneWorktreeStatus(target.wt.path);
                  clearWorktreeListCache(slug());
                  void refreshWorktreeList(slug());
                }}
              />
            </Suspense>
          );
        }
        return (
          <Suspense>
            <UnlinkProjectModal
              open={true}
              project={listProps.project}
              onClose={closeDeleteTarget}
              onUnlinked={() => {
                for (const wt of items()) pruneWorktreeStatus(wt.path);
                removeProject(slug());
                clearWorktreeListCache(slug());
              }}
            />
          </Suspense>
        );
      })()}

      <Show when={mergeTarget()}>
        {(wt) => (
          <Suspense>
            <MergeWorktreeModal
              open={true}
              projectSlug={slug()}
              worktree={wt()}
              onClose={closeMergeTarget}
              onMerged={() => {
                clearWorktreeListCache(slug());
                void refreshWorktreeList(slug());
              }}
            />
          </Suspense>
        )}
      </Show>
    </>
  );
};

export const WorktreeAccordion: Component<WorktreeAccordionProps> = (props) => {
  const [worktreeFilter, setWorktreeFilter] = createSignal("");

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      {/* Mini-toolbar — filter worktrees + "+" new worktree. */}
      <div class="flex shrink-0 items-center gap-1 px-2 py-2">
        <input
          type="search"
          class="h-7 min-w-0 flex-1 rounded bg-selected px-2 text-[11px] text-foreground placeholder:text-foreground-dim focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="Filter worktrees…"
          value={worktreeFilter()}
          onInput={(e) => setWorktreeFilter(e.currentTarget.value)}
          aria-label="Filter worktrees"
        />
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-selected text-muted-foreground transition-all duration-100 hover:bg-hover hover:text-foreground active:scale-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100"
          title={activeProjectSlug() ? "New worktree" : "Select a project first"}
          disabled={!props.project}
          onClick={() => props.onRequestCreate()}
        >
          <PlusIcon class="size-4" />
        </button>
      </div>

      <Show
        when={props.project}
        keyed
        fallback={<p class="px-2 py-1 text-foreground-dim">No projects registered yet.</p>}
      >
        {(project) => (
          <ProjectAccordion
            project={project}
            worktreeFilter={worktreeFilter()}
            createOpen={props.createOpen}
            onCreateClose={props.onCreateClose}
          />
        )}
      </Show>
    </div>
  );
};
