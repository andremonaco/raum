/**
 * §9 — read-only commit history tab. Pages `git_log` in chunks of 50 via an
 * explicit "Load older commits" button (scroll-bottom detection inside an
 * OverlayScrollbars viewport buys nothing at this scale). Clicking a commit
 * expands its changed files inline; clicking a file opens the diff viewer in
 * commit mode.
 *
 * Re-activating the tab refetches the newest page and resets the list only
 * when the head commit actually moved — cheap staleness fix after commits
 * land, without losing pagination on every tab switch.
 */

import { Component, For, Show, createEffect, createResource, createSignal } from "solid-js";

import { formatRelativeShort } from "../../lib/relativeTime";
import { LoaderIcon } from "../icons";
import { Scrollable } from "../ui/scrollable";
import { FileChangeRow } from "./file-change-row";
import { gitCommitFiles, gitLog, type CommitInfo } from "./git-commands";
import type { HistoryViewProps } from "./types";

const PAGE_SIZE = 50;

export const HistoryView: Component<HistoryViewProps> = (props) => {
  const [commits, setCommits] = createSignal<CommitInfo[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [exhausted, setExhausted] = createSignal(false);
  const [expandedHash, setExpandedHash] = createSignal<string | null>(null);
  let initialized = false;

  const [commitFiles] = createResource(expandedHash, (hash) =>
    gitCommitFiles(props.worktree.path, hash),
  );

  const loadInitial = async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await gitLog(props.worktree.path, 0, PAGE_SIZE);
      setCommits(page);
      setExhausted(page.length < PAGE_SIZE);
      initialized = true;
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const loadOlder = async () => {
    if (loading() || exhausted()) return;
    setLoading(true);
    setError(null);
    try {
      const page = await gitLog(props.worktree.path, commits().length, PAGE_SIZE);
      setCommits((prev) => [...prev, ...page]);
      setExhausted(page.length < PAGE_SIZE);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // First fetch on mount (the panel only mounts when first visited), then a
  // head-check on every re-activation.
  createEffect(() => {
    if (!props.active) return;
    if (!initialized) {
      void loadInitial();
      return;
    }
    void (async () => {
      try {
        const page = await gitLog(props.worktree.path, 0, PAGE_SIZE);
        if (page[0]?.hash !== commits()[0]?.hash) {
          setCommits(page);
          setExhausted(page.length < PAGE_SIZE);
          setExpandedHash(null);
        }
      } catch {
        /* Keep showing the stale list — the next explicit action retries. */
      }
    })();
  });

  return (
    <Scrollable axis="y" class="max-h-64">
      <Show
        when={!(loading() && commits().length === 0)}
        fallback={
          <div class="flex items-center gap-1.5 px-1 py-1 font-mono text-[10px] text-foreground-dim">
            <LoaderIcon class="size-3 animate-spin" />
            <span>Loading history…</span>
          </div>
        }
      >
        <Show
          when={error() === null || commits().length > 0}
          fallback={
            <div class="px-1 py-1 font-mono text-[10px] text-destructive/80">
              <span class="line-clamp-2">{error()}</span>
              <button
                type="button"
                class="mt-0.5 text-foreground-dim hover:text-foreground"
                onClick={() => void loadInitial()}
              >
                Retry
              </button>
            </div>
          }
        >
          <Show
            when={commits().length > 0}
            fallback={
              <div class="px-1 py-1 font-mono text-[10px] italic text-foreground-dim">
                No commits yet
              </div>
            }
          >
            <ul>
              <For each={commits()}>
                {(commit) => (
                  <li>
                    <button
                      type="button"
                      class="group flex w-full items-baseline gap-1.5 rounded px-1 py-0.5 text-left hover:bg-hover"
                      aria-expanded={expandedHash() === commit.hash}
                      onClick={() =>
                        setExpandedHash((prev) => (prev === commit.hash ? null : commit.hash))
                      }
                    >
                      <span class="shrink-0 font-mono text-[9px] text-foreground-dim" aria-hidden>
                        {expandedHash() === commit.hash ? "▾" : "▸"}
                      </span>
                      <span class="shrink-0 font-mono text-[10px] text-foreground-dim">
                        {commit.shortHash}
                      </span>
                      <span
                        class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground group-hover:text-foreground"
                        title={`${commit.subject} — ${commit.author}`}
                      >
                        {commit.subject || "(no subject)"}
                      </span>
                      <Show when={commit.unpushed}>
                        <span
                          class="shrink-0 font-mono text-[9px] text-foreground-subtle"
                          title="Not pushed to upstream"
                        >
                          ↑
                        </span>
                      </Show>
                      <span class="shrink-0 font-mono text-[9px] text-foreground-dim">
                        {formatRelativeShort(commit.timestamp)}
                      </span>
                    </button>
                    <Show when={expandedHash() === commit.hash}>
                      <Show
                        when={!commitFiles.loading}
                        fallback={
                          <div class="flex items-center gap-1.5 py-0.5 pl-5 font-mono text-[10px] text-foreground-dim">
                            <LoaderIcon class="size-3 animate-spin" />
                            <span>Loading files…</span>
                          </div>
                        }
                      >
                        <Show
                          when={!commitFiles.error}
                          fallback={
                            <div class="py-0.5 pl-5 font-mono text-[10px] text-destructive/80">
                              Failed to load commit files
                            </div>
                          }
                        >
                          <ul class="pl-5">
                            <For each={commitFiles() ?? []}>
                              {(file) => (
                                <FileChangeRow
                                  path={file.path}
                                  origPath={file.origPath}
                                  kind={file.kind}
                                  insertions={file.insertions}
                                  deletions={file.deletions}
                                  onOpen={() =>
                                    props.onOpenDiff({
                                      mode: "commit",
                                      file: file.path,
                                      hash: commit.hash,
                                      shortHash: commit.shortHash,
                                    })
                                  }
                                />
                              )}
                            </For>
                          </ul>
                        </Show>
                      </Show>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
            <Show when={!exhausted()}>
              <button
                type="button"
                class="w-full rounded py-1 text-center font-mono text-[10px] text-foreground-dim hover:bg-hover hover:text-foreground disabled:opacity-50"
                disabled={loading()}
                onClick={() => void loadOlder()}
              >
                {loading() ? "Loading…" : "Load older commits"}
              </button>
            </Show>
            <Show when={error() !== null && commits().length > 0}>
              <div class="px-1 py-0.5 font-mono text-[10px] text-destructive/80 line-clamp-2">
                {error()}
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </Scrollable>
  );
};
