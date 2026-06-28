/**
 * §6 — read-only commit history, rendered as a vertical commit TIMELINE.
 * Pages `git_log` in chunks of 50 via an explicit "Load older commits" button
 * (scroll-bottom detection inside the single worktree-tab viewport buys nothing
 * at this scale). Each commit is a node on a spine — a small filled dot, a
 * hollow ring for merge commits, a bright ringed node while expanded — beside a
 * card that hangs off the node: a two-line row (subject, with a quiet
 * conventional-commit type accent, + relative time; author chip · name · short
 * hash). Commits are split by frontend-derived "day divider" headers (Today /
 * Yesterday / "Mon D") styled as a labelled rule, pinned below the view-tab bar
 * so they read as a higher-level break than the rows. Clicking a commit expands
 * the card (surface-raised, matching the active worktree card): the subject
 * un-truncates IN PLACE (no duplicate message) and the detail body adds the
 * absolute date, a diffstat, and the changed files — clicking a file opens the
 * diff viewer in commit mode.
 *
 * Re-activating the tab refetches the newest page and resets the list only
 * when the head commit actually moved — cheap staleness fix after commits
 * land, without losing pagination on every tab switch.
 *
 * No inner scroll container: rows flow flat into the worktree tab's single
 * Scrollable; sticky date headers rely on `position: sticky` against that one
 * viewport.
 */

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";

import { formatRelativeShort } from "../../lib/relativeTime";
import { CopyIcon, LoaderIcon } from "../icons";
import { CommitDetailCard } from "./commit-detail-card";
import { gitCommitFiles, gitLog, type CommitInfo } from "./git-commands";
import type { HistoryViewProps } from "./types";

const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;

/** Start-of-day epoch (local) for calendar-day bucketing. */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Frontend-derived date-group label: "Today" / "Yesterday" / "Mon D" (with a
 *  year suffix once the commit falls outside the current calendar year). */
function commitDateGroup(unixSeconds: number, now: Date): string {
  const d = new Date(unixSeconds * 1000);
  const today = startOfDay(now);
  const that = startOfDay(d);
  if (that === today) return "Today";
  if (that === today - DAY_MS) return "Yesterday";
  return d.toLocaleDateString(
    undefined,
    d.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
}

/** First-letter initials for the restrained author chip (no avatar service). */
function authorInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Heuristic merge detection (CommitInfo carries no parent count) — drives the
 *  hollow-ring timeline node so merges stand out from regular commits. */
function isMergeCommit(c: CommitInfo): boolean {
  return /^Merge\b/.test(c.subject ?? "");
}

// Conventional-commit prefix (`type(scope)!:`) split out so the type can carry a
// quiet semantic accent. Returns null for non-conventional subjects (e.g. merges).
const CONVENTIONAL_RE = /^([a-z]+)(\([^)]*\))?(!)?:\s/i;
function splitConventional(subject: string): { type: string; prefix: string; rest: string } | null {
  const m = CONVENTIONAL_RE.exec(subject);
  if (!m) return null;
  return {
    type: m[1].toLowerCase(),
    prefix: `${m[1]}${m[2] ?? ""}${m[3] ?? ""}:`,
    rest: subject.slice(m[0].length),
  };
}

/**
 * Per-conventional-commit-type accent. Each type carries its own hue so the log
 * scans by category at a glance — but never green or red, which read as a
 * pass/fail status rather than a *kind* of change. Housekeeping / tooling stays
 * a muted neutral grey: it isn't user-facing, so it recedes.
 */
function typeAccentClass(type: string): string {
  switch (type) {
    case "feat":
      return "text-sky-400"; // new features → blue
    case "fix":
    case "revert":
      return "text-violet-400"; // corrections / undos → purple
    case "perf":
      return "text-amber-400"; // performance → amber
    case "refactor":
      return "text-fuchsia-400"; // restructuring → magenta
    case "docs":
      return "text-cyan-400"; // documentation → cyan
    // Housekeeping / tooling — muted neutral grey, recedes.
    case "chore":
    case "build":
    case "ci":
    case "test":
    case "style":
      return "text-muted-foreground";
    default:
      return "text-foreground-subtle";
  }
}

export const HistoryView: Component<HistoryViewProps> = (props) => {
  const [commits, setCommits] = createSignal<CommitInfo[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [exhausted, setExhausted] = createSignal(false);
  const [expandedHash, setExpandedHash] = createSignal<string | null>(null);
  // Which full hash was just copied (drives the brief copy affordance feedback).
  const [copiedHash, setCopiedHash] = createSignal<string | null>(null);
  let initialized = false;

  const [commitFiles] = createResource(expandedHash, (hash) =>
    gitCommitFiles(props.worktree.path, hash),
  );

  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copyTimer));

  // Copy the FULL hash (CommitInfo.hash) — the abbreviated form is display-only.
  const copyHash = (commit: CommitInfo) => {
    void navigator.clipboard
      .writeText(commit.hash)
      .catch((e) => console.warn("clipboard.writeText failed", e));
    setCopiedHash(commit.hash);
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => setCopiedHash(null), 1200);
  };

  const toggle = (hash: string) => setExpandedHash((prev) => (prev === hash ? null : hash));

  // Newest-first commits are contiguous by calendar day, so a single linear
  // pass coalesces them into sticky-headed date sections.
  const groups = createMemo(() => {
    const now = new Date();
    const out: { key: string; label: string; commits: CommitInfo[] }[] = [];
    for (const commit of commits()) {
      const label = commitDateGroup(commit.timestamp, now);
      const last = out[out.length - 1];
      if (last && last.label === label) last.commits.push(commit);
      else out.push({ key: `${label}::${commit.hash}`, label, commits: [commit] });
    }
    return out;
  });

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
    <div class="flex flex-col">
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
            <For each={groups()}>
              {(group) => (
                <section>
                  {/* Day divider — a labelled rule on the timeline. Pinned below
                      the view-tab bar (h-8 → top-8) so it never collides with it,
                      and visually distinct from the Changes groups: this reads as
                      a higher-level dated break, not another row. */}
                  <h3 class="sticky top-8 z-20 flex items-center gap-2 bg-background py-2 pl-6 pr-1">
                    <span class="shrink-0 font-mono text-[10px] font-semibold tracking-wide text-foreground-subtle">
                      {group.label}
                    </span>
                    <span
                      class="h-px flex-1 bg-gradient-to-r from-border-subtle to-transparent"
                      aria-hidden
                    />
                  </h3>
                  <ul>
                    <For each={group.commits}>
                      {(commit) => {
                        const active = () => expandedHash() === commit.hash;
                        const merge = isMergeCommit(commit);
                        const conv = splitConventional(commit.subject ?? "");
                        return (
                          <li class="group/commit relative py-px">
                            {/* Timeline spine + node, in the left gutter. The card
                                to the right hangs off the node. */}
                            <span
                              class="pointer-events-none absolute bottom-0 left-3 top-0 w-px bg-border-subtle"
                              aria-hidden
                            />
                            <span
                              class="pointer-events-none absolute left-[7.5px] top-[10px] z-10 flex size-2.5 items-center justify-center"
                              aria-hidden
                            >
                              <span
                                class="rounded-full transition-all"
                                classList={{
                                  "size-2 bg-foreground ring-2 ring-foreground/15": active(),
                                  "size-2 border border-foreground-dim bg-background":
                                    !active() && merge,
                                  "size-[5px] bg-foreground-dim": !active() && !merge,
                                }}
                              />
                            </span>

                            {/* Commit card — matches the active worktree card
                                (surface-raised + soft shadow) when expanded. */}
                            <div
                              class="ml-6 overflow-hidden rounded-md transition-[background-color,box-shadow] duration-150"
                              classList={{
                                "bg-surface-raised shadow-[0_6px_18px_-8px_rgba(0,0,0,0.7)]":
                                  active(),
                              }}
                            >
                              <div
                                role="button"
                                tabindex="0"
                                class="focus-ring flex w-full cursor-pointer flex-col px-2 py-1.5 text-left"
                                classList={{ "rounded-md hover:bg-hover": !active() }}
                                aria-expanded={active()}
                                onClick={() => toggle(commit.hash)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    toggle(commit.hash);
                                  }
                                }}
                              >
                                {/* Line 1 (hero): subject (with conventional-type
                                    accent) — truncates collapsed, wraps when open. */}
                                <div class="flex items-baseline gap-2">
                                  <span
                                    class="min-w-0 flex-1 break-words font-mono text-[12.5px] font-medium leading-snug text-foreground/80 group-hover/commit:text-foreground"
                                    classList={{
                                      "text-foreground": active(),
                                      truncate: !active(),
                                    }}
                                  >
                                    {conv ? (
                                      <>
                                        <span class={typeAccentClass(conv.type)}>
                                          {conv.prefix}
                                        </span>{" "}
                                        {conv.rest}
                                      </>
                                    ) : (
                                      commit.subject || "(no subject)"
                                    )}
                                  </span>
                                  <span class="shrink-0 font-mono text-[9px] tabular-nums text-foreground-dim">
                                    {formatRelativeShort(commit.timestamp)}
                                  </span>
                                </div>

                                {/* Line 2 (metadata): smaller + dimmer than the
                                    subject; inline copy-hash on hover. */}
                                <div class="mt-1 flex items-center gap-1.5">
                                  <span class="shrink-0 select-none rounded bg-foreground/10 px-1 font-mono text-[8px] font-medium leading-[1.5] text-foreground-subtle">
                                    {authorInitials(commit.author)}
                                  </span>
                                  <span class="min-w-0 truncate font-mono text-[9.5px] text-foreground-dim">
                                    {commit.author}
                                  </span>
                                  <span
                                    class="shrink-0 font-mono text-[9.5px] text-foreground-dim opacity-60"
                                    aria-hidden
                                  >
                                    ·
                                  </span>
                                  <span class="shrink-0 font-mono text-[9.5px] text-foreground-dim">
                                    {commit.shortHash}
                                  </span>
                                  <button
                                    type="button"
                                    class="focus-ring flex size-4 shrink-0 items-center justify-center rounded text-foreground-dim opacity-0 transition-opacity hover:bg-hover hover:text-foreground focus-visible:opacity-100 group-hover/commit:opacity-100"
                                    classList={{ "opacity-100": copiedHash() === commit.hash }}
                                    title={
                                      copiedHash() === commit.hash ? "Copied" : "Copy commit hash"
                                    }
                                    aria-label="Copy commit hash"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      copyHash(commit);
                                    }}
                                  >
                                    <CopyIcon
                                      class="size-3"
                                      classList={{ "text-success": copiedHash() === commit.hash }}
                                    />
                                  </button>
                                  <Show when={commit.unpushed}>
                                    <span
                                      class="ml-auto shrink-0 font-mono text-[9px] text-foreground-subtle"
                                      title="Not pushed to upstream"
                                    >
                                      ↑
                                    </span>
                                  </Show>
                                </div>
                              </div>

                              {/* Expanded detail — date + diffstat + files only
                                  (no repeated subject / author / hash). */}
                              <Show when={active()}>
                                <CommitDetailCard
                                  commit={commit}
                                  files={commitFiles()}
                                  loading={commitFiles.loading}
                                  error={Boolean(commitFiles.error)}
                                  onOpenDiff={props.onOpenDiff}
                                />
                              </Show>
                            </div>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </section>
              )}
            </For>
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
              <div class="line-clamp-2 px-1 py-0.5 font-mono text-[10px] text-destructive/80">
                {error()}
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  );
};
