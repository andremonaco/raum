/**
 * §9 — per-project worktree section.
 *
 * Renders the active project's worktree list inside the expanded sidebar.
 * Owns:
 *   • the lazy worktree-list fetch via `worktreeStore`.
 *   • main-vs-additional partitioning.
 *   • delete / unlink / merge modal lifecycle (lazy-loaded modals).
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
  worktreesByProject,
  type Worktree,
  type WorktreeScope,
} from "../../stores/worktreeStore";
import { removeProject } from "../../stores/projectStore";
import { harnessCountsForProject } from "../../stores/terminalStore";
import { CreateWorktreeModal } from "../create-worktree-modal";
import { AllTerminalsRow } from "./all-terminals-row";
import { WorktreeRow } from "./worktree-row";
import type { ProjectSectionProps } from "./types";

const DeleteWorktreeModal = lazy(() =>
  import("../delete-worktree-modal").then((m) => ({ default: m.DeleteWorktreeModal })),
);
const MergeWorktreeModal = lazy(() =>
  import("../merge-worktree-modal").then((m) => ({ default: m.MergeWorktreeModal })),
);
const UnlinkProjectModal = lazy(() =>
  import("../unlink-project-modal").then((m) => ({ default: m.UnlinkProjectModal })),
);

export const ProjectSection: Component<ProjectSectionProps> = (sectionProps) => {
  const slug = createMemo(() => sectionProps.project.slug);

  createEffect(() => {
    const s = slug();
    if (worktreesByProject()[s]) return;
    void refreshWorktreeList(s);
  });

  // Delete/unlink target — `null` means closed. `{ kind: "wt", wt }` opens
  // the worktree-delete modal; `{ kind: "project" }` opens the unlink modal
  // for this section's project root.
  const [deleteTarget, setDeleteTarget] = createSignal<
    { kind: "wt"; wt: Worktree } | { kind: "project" } | null
  >(null);
  const closeDeleteTarget = () => setDeleteTarget(null);

  // Merge target — `null` means closed. Opens MergeWorktreeModal for the
  // selected non-main worktree.
  const [mergeTarget, setMergeTarget] = createSignal<Worktree | null>(null);
  const closeMergeTarget = () => setMergeTarget(null);

  const items = createMemo(() => {
    const cached = worktreesByProject()[slug()];
    return cached ?? [];
  });

  createEffect(() => {
    const paths = items().map((wt) => wt.path);
    if (paths.length > 0) void untrack(() => refreshWorktreeStatuses(paths, { onlyMissing: true }));
  });

  const filteredItems = createMemo<Worktree[]>(() => {
    const q = sectionProps.worktreeFilter.toLowerCase().trim();
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

  // Split filtered items into the main worktree (path === project rootPath)
  // and all added worktrees. Main is always rendered first.
  const mainWorktree = createMemo(
    () => filteredItems().find((wt) => wt.path === sectionProps.project.rootPath) ?? null,
  );
  const additionalWorktrees = createMemo(() =>
    filteredItems().filter((wt) => wt.path !== sectionProps.project.rootPath),
  );

  return (
    <section class="mb-2">
      <Show
        when={filteredItems().length > 0}
        fallback={
          <p class="px-2 py-1 text-[11px] text-foreground-dim">
            {items().length === 0 ? "No worktrees yet." : "No matching worktrees."}
          </p>
        }
      >
        {/* Card container — groups main + worktrees visually. The project
            identity (color, sigil, name) lives in the top-bar tab, so this
            section shows only the active project's root + worktrees. */}
        <div class="overflow-hidden rounded-md">
          {/* Aggregate "All terminals" row — same card chrome as main */}
          <div class="bg-card/30">
            <ul>
              <AllTerminalsRow
                projectSlug={slug()}
                isActive={isAllActive()}
                counts={projectHarnessCounts()}
              />
            </ul>
          </div>

          {/* Main worktree — slightly elevated background */}
          <Show when={mainWorktree()}>
            {(main) => (
              <div class="bg-card/30">
                <ul>
                  <WorktreeRow
                    worktree={main()}
                    projectSlug={slug()}
                    isActive={activePath() === main().path}
                    projectColor={sectionProps.project.color}
                    projectSigil={sectionProps.project.sigil}
                    isMain={true}
                    mainBranchFallback={main().branch}
                    onRequestDelete={() => setDeleteTarget({ kind: "project" })}
                  />
                </ul>
              </div>
            )}
          </Show>

          {/* Added worktrees */}
          <Show when={additionalWorktrees().length > 0}>
            <ul class="space-y-0.5 py-0.5">
              <For each={additionalWorktrees()}>
                {(wt) => (
                  <WorktreeRow
                    worktree={wt}
                    projectSlug={slug()}
                    isActive={activePath() === wt.path}
                    projectColor={sectionProps.project.color}
                    projectSigil={sectionProps.project.sigil}
                    isMain={false}
                    mainBranchFallback={mainWorktree()?.branch ?? null}
                    onRequestDelete={() => setDeleteTarget({ kind: "wt", wt })}
                    onRequestMerge={() => setMergeTarget(wt)}
                  />
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
      <CreateWorktreeModal
        projectSlug={slug()}
        open={sectionProps.createOpen}
        onClose={sectionProps.onCreateClose}
        onCreated={() => {
          sectionProps.onCreateClose();
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
              project={sectionProps.project}
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
    </section>
  );
};
