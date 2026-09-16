/**
 * The GitHub view of an open worktree tab — the branch's pull request on top,
 * then the repo-wide Deployments and Releases sections.
 *
 * Top to bottom: the detail of this branch's own pull request (header, one
 * status line with three dot+token items, actions, checks grouped by workflow
 * with all-green groups collapsed), then every other open PR of the repo as a
 * compact row, then the latest deployment and the latest release as single
 * rows that unfold their history on click.
 *
 * Restraint: the only semantic colour is the 6px bucket dot. Nothing fills,
 * stripes or glows. Like the other views this renders flat into the worktree
 * tab's single Scrollable — no inner scroll container.
 */

import {
  Component,
  For,
  Show,
  createMemo,
  createSignal,
  lazy,
  Suspense,
  type ComponentProps,
} from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  deploymentsForProject,
  formatAge,
  prForPath,
  prsForProject,
  releasesForProject,
} from "../../stores/githubStore";
import { bucketDotClass } from "../../lib/githubAttention";
import type {
  Check,
  CheckBucket,
  DeploymentEnv,
  MergeStateStatus,
  PullRequest,
  PullRequestSummary,
  Release,
} from "../../lib/githubTypes";
import { ChevronDownIcon, ChevronRightIcon, LoaderIcon } from "../icons";
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from "../ui/tooltip";
import type { GithubViewProps } from "./types";
import type { WorktreeStatus } from "../../stores/worktreeStore";

const MergePrSheet = lazy(() =>
  import("../merge-pr-sheet").then((m) => ({ default: m.MergePrSheet })),
);
const DeleteWorktreeModal = lazy(() =>
  import("../delete-worktree-modal").then((m) => ({ default: m.DeleteWorktreeModal })),
);

/**
 * GitHub mark for the tab bar. The other three tabs are stroke glyphs about
 * git (branch, clock, folder); a second branch-like glyph read as a duplicate,
 * so this one is the filled octocat silhouette — unmistakably "the hosted
 * side" rather than another local view.
 */
export const GithubMarkIcon = (props: ComponentProps<"svg">) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
    {...props}
  >
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

/* ---------- derived state ---------- */

type Tone = "ok" | "warn" | "bad" | "dim";

interface Cell {
  bucket: CheckBucket;
  /** Fits a 200px sidebar: `6/10`, `✓`, `blocked`. */
  short: string;
  /** Full sentence for the tooltip. */
  label: string;
  sub: string;
}

/** Only these two let GitHub merge right now. */
function mergeableNow(state: MergeStateStatus): boolean {
  return state === "CLEAN" || state === "HAS_HOOKS";
}

/** The three status cells: checks · review · merge. */
function statusCells(pr: PullRequest): { checks: Cell; review: Cell; merge: Cell } {
  const s = pr.checksSummary;
  const checks: Cell =
    s.total === 0
      ? { bucket: "skipped", short: "–", label: "No checks", sub: "" }
      : s.fail > 0
        ? {
            bucket: "fail",
            short: `${s.fail}✗`,
            label: `${s.fail} failing`,
            sub: `${s.pass}/${s.total} passed`,
          }
        : s.pending > 0
          ? {
              bucket: "pending",
              short: `${s.pass}/${s.total}`,
              label: `${s.pass}/${s.total} passed`,
              sub: `${s.pending} running`,
            }
          : {
              bucket: "pass",
              short: `${s.pass}/${s.total}`,
              label: `${s.pass}/${s.total} passed`,
              sub: s.skipped > 0 ? `${s.skipped} skipped` : "",
            };

  const review: Cell =
    pr.reviewDecision === "APPROVED"
      ? { bucket: "pass", short: "approved", label: "Approved", sub: "" }
      : pr.reviewDecision === "CHANGES_REQUESTED"
        ? { bucket: "fail", short: "changes", label: "Changes requested", sub: "" }
        : pr.reviewDecision === "REVIEW_REQUIRED"
          ? { bucket: "pending", short: "review", label: "Review required", sub: "" }
          : { bucket: "skipped", short: "–", label: "No review needed", sub: "" };

  let merge: Cell;
  switch (pr.mergeStateStatus) {
    case "CLEAN":
    case "HAS_HOOKS":
      merge = { bucket: "pass", short: "ready", label: "Ready to merge", sub: "" };
      break;
    case "DIRTY":
      merge = {
        bucket: "fail",
        short: "conflicts",
        label: "Conflicts",
        sub: `rebase onto ${pr.baseRefName}`,
      };
      break;
    case "BEHIND":
      merge = {
        bucket: "pending",
        short: "behind",
        label: `Behind ${pr.baseRefName}`,
        sub: "update branch",
      };
      break;
    case "BLOCKED":
      merge = {
        bucket: "pending",
        short: "blocked",
        label: "Blocked",
        sub: "by branch protection",
      };
      break;
    case "DRAFT":
      merge = { bucket: "skipped", short: "draft", label: "Draft", sub: "" };
      break;
    case "UNSTABLE":
      merge = { bucket: "pending", short: "waiting", label: "Waiting on checks", sub: "" };
      break;
    default:
      merge = { bucket: "skipped", short: "?", label: "State unknown", sub: "" };
  }
  return { checks, review, merge };
}

/** What the primary button says, what its tooltip explains, and whether it may be pressed. */
function mergeAction(pr: PullRequest): { label: string; hint: string; disabled: boolean } {
  if (mergeableNow(pr.mergeStateStatus)) {
    return { label: "Merge", hint: "Merge this pull request now", disabled: false };
  }
  if (pr.mergeStateStatus === "DIRTY") {
    return { label: "Conflicts", hint: `Rebase onto ${pr.baseRefName} first`, disabled: true };
  }
  if (pr.isDraft || pr.mergeStateStatus === "DRAFT") {
    return { label: "Draft", hint: "Mark the pull request ready for review first", disabled: true };
  }
  if (pr.checksSummary.pending > 0) {
    return {
      label: "Auto-merge",
      hint: "Queue the merge for when every check passes",
      disabled: false,
    };
  }
  return { label: "Blocked", hint: "Branch protection is blocking the merge", disabled: true };
}

const WORST: CheckBucket[] = ["fail", "pending", "cancelled", "pass", "skipped"];
function worst(buckets: CheckBucket[]): CheckBucket {
  for (const b of WORST) if (buckets.includes(b)) return b;
  return "skipped";
}

interface CheckGroup {
  name: string;
  bucket: CheckBucket;
  checks: Check[];
  /** Longest single job, as the group's "how long did this take". */
  duration: string;
  /** Groups with something to look at start open; all-green ones start shut. */
  openByDefault: boolean;
}

/** Group checks by workflow; status contexts without one share a group. */
function groupChecks(checks: Check[]): CheckGroup[] {
  const byName = new Map<string, Check[]>();
  for (const c of checks) {
    const key = c.workflow ?? "Status checks";
    const list = byName.get(key) ?? [];
    list.push(c);
    byName.set(key, list);
  }
  const groups: CheckGroup[] = [];
  for (const [name, list] of byName) {
    const bucket = worst(list.map((c) => c.bucket));
    const longest = Math.max(0, ...list.map(durationSeconds));
    groups.push({
      name,
      bucket,
      checks: list,
      duration: formatSeconds(longest),
      openByDefault: bucket === "fail" || bucket === "pending" || bucket === "cancelled",
    });
  }
  // Same order as the rows: anything alarming first, green last.
  groups.sort((a, b) => WORST.indexOf(a.bucket) - WORST.indexOf(b.bucket));
  return groups;
}

function durationSeconds(check: Check): number {
  if (!check.startedAt) return 0;
  const end = check.completedAt ? Date.parse(check.completedAt) : Date.now();
  const s = Math.floor((end - Date.parse(check.startedAt)) / 1000);
  return Number.isNaN(s) || s < 0 ? 0 : s;
}

function formatSeconds(seconds: number): string {
  if (seconds <= 0) return "";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Run duration as `1m 20s`, or the skip word when there is no span. */
function checkDuration(check: Check): string {
  if (check.bucket === "skipped") return "skipped";
  if (check.bucket === "cancelled") return "cancelled";
  if (check.bucket === "pending" && !check.startedAt) return "queued";
  return formatSeconds(durationSeconds(check));
}

const openExternal = (url: string | null): void => {
  if (!url) return;
  void openUrl(url).catch((e) => console.warn("[github] openUrl failed", e));
};

/* ---------- small pieces ---------- */

/** Status glyph: a 6px dot, or a spinner while something is still running. */
const Dot: Component<{ bucket: CheckBucket; class?: string }> = (p) => (
  <Show
    when={p.bucket === "pending"}
    fallback={
      <span class={`size-1.5 shrink-0 rounded-full ${bucketDotClass(p.bucket)} ${p.class ?? ""}`} />
    }
  >
    <LoaderIcon class={`size-2.5 shrink-0 animate-spin text-warning ${p.class ?? ""}`} />
  </Show>
);

const TONE_TEXT: Record<Tone, string> = {
  ok: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
  dim: "text-foreground-dim",
};

/** One item of the status line: dot + short token, full text in the tooltip. */
const StatusItem: Component<{ cell: Cell; title: string }> = (p) => (
  <Tooltip openDelay={200}>
    <TooltipTrigger
      as="span"
      class="flex min-w-0 items-center gap-1 font-mono text-[10px] text-foreground-subtle"
      aria-label={`${p.title}: ${p.cell.label}${p.cell.sub ? `, ${p.cell.sub}` : ""}`}
    >
      <Dot bucket={p.cell.bucket} />
      <span class="truncate">{p.cell.short}</span>
    </TooltipTrigger>
    <TooltipPortal>
      <TooltipContent>
        <span class="text-foreground-dim">{p.title} · </span>
        {p.cell.label}
        <Show when={p.cell.sub}>
          <span class="text-foreground-dim"> · {p.cell.sub}</span>
        </Show>
      </TooltipContent>
    </TooltipPortal>
  </Tooltip>
);

/** Collapsible header for a check group or a repo-wide section. */
const Disclosure: Component<{
  open: boolean;
  onToggle: () => void;
  bucket?: CheckBucket;
  title: string;
  meta?: string;
  /** Native tooltip; carries what the row has no room to print. */
  hint?: string;
  trailing?: string;
  uppercase?: boolean;
}> = (p) => (
  <button
    type="button"
    class="focus-ring flex w-full items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-hover"
    aria-expanded={p.open}
    title={p.hint}
    onClick={() => p.onToggle()}
  >
    <Show when={p.open} fallback={<ChevronRightIcon class="size-3 shrink-0 text-foreground-dim" />}>
      <ChevronDownIcon class="size-3 shrink-0 text-foreground-dim" />
    </Show>
    <Show when={p.bucket}>{(b) => <Dot bucket={b()} />}</Show>
    <span
      class="min-w-0 truncate font-mono text-[10px] text-foreground-subtle"
      classList={{ "uppercase tracking-wide text-foreground-dim": p.uppercase }}
    >
      {p.title}
    </span>
    <Show when={p.meta}>
      <span class="shrink-0 font-mono text-[10px] text-foreground-dim">{p.meta}</span>
    </Show>
    <Show when={p.trailing}>
      <span class="ml-auto shrink-0 font-mono text-[9px] tabular-nums text-foreground-dim opacity-60">
        {p.trailing}
      </span>
    </Show>
  </button>
);

/** A clickable leaf row: dot, name, dim detail, right-aligned trailing text. */
const Row: Component<{
  bucket?: CheckBucket;
  name: string;
  detail?: string;
  trailing: string;
  url: string | null;
  indent?: boolean;
  highlight?: boolean;
  tone?: Tone;
  /** Native tooltip; defaults to the name so a truncated row is still readable. */
  hint?: string;
}> = (p) => (
  <button
    type="button"
    class="focus-ring flex w-full items-center gap-1.5 rounded py-0.5 pr-1 text-left hover:bg-hover disabled:cursor-default"
    classList={{ "pl-5": p.indent, "pl-1": !p.indent, "bg-hover": p.highlight }}
    disabled={!p.url}
    title={p.hint ?? p.name}
    onClick={() => openExternal(p.url)}
  >
    <Show when={p.bucket} fallback={<span class="size-1.5 shrink-0" />}>
      {(b) => <Dot bucket={b()} />}
    </Show>
    <span
      class="min-w-0 truncate font-mono text-[10px]"
      classList={{
        "text-foreground-subtle": !p.tone,
        [TONE_TEXT[p.tone ?? "dim"]]: !!p.tone,
      }}
    >
      {p.name}
    </span>
    <Show when={p.detail}>
      <span class="min-w-0 truncate font-mono text-[10px] text-foreground-dim">{p.detail}</span>
    </Show>
    <span class="ml-auto shrink-0 font-mono text-[9px] tabular-nums text-foreground-dim opacity-60">
      {p.trailing}
    </span>
  </button>
);

/* ---------- checks ---------- */

const CheckGroupRow: Component<{ group: CheckGroup }> = (p) => {
  const [toggle, setToggle] = createSignal<boolean | null>(null);
  const open = () => toggle() ?? p.group.openByDefault;
  return (
    <li>
      <Disclosure
        open={open()}
        onToggle={() => setToggle(!open())}
        bucket={p.group.bucket}
        title={p.group.name}
        hint={`${p.group.name} · ${p.group.checks.length} job${p.group.checks.length === 1 ? "" : "s"}`}
        trailing={p.group.duration}
      />
      <Show when={open()}>
        <ul class="flex flex-col">
          <For each={p.group.checks}>
            {(check) => (
              <li>
                <Row
                  bucket={check.bucket}
                  name={check.name}
                  detail={check.workflow ? undefined : (check.description ?? undefined)}
                  trailing={checkDuration(check)}
                  url={check.url}
                  indent
                />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </li>
  );
};

/* ---------- view ---------- */

/** Jump to the worktree that has this PR checked out, or open it on GitHub. */
function activatePr(pr: PullRequestSummary): void {
  if (pr.worktreePath) {
    window.dispatchEvent(
      new CustomEvent("raum:worktree-tab-requested", {
        detail: { path: pr.worktreePath, tab: "github" },
      }),
    );
    return;
  }
  openExternal(pr.url);
}

/** Dot colour for a PR row: draft is quiet, changes requested is red, else the rollup. */
function prBucket(pr: PullRequestSummary): CheckBucket {
  if (pr.isDraft) return "skipped";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "fail";
  return pr.rollup;
}

/** Suffix after the title; empty when the dot already says everything. */
function prSuffix(pr: PullRequestSummary): string {
  if (pr.isDraft) return "draft";
  const s = pr.checksSummary;
  if (s.fail > 0) return `${s.fail}✗`;
  if (s.pending > 0) return `${s.pass}/${s.total}`;
  return "";
}

/** One open PR that is not this worktree's. */
const PrRow: Component<{ pr: PullRequestSummary }> = (p) => (
  <li>
    <button
      type="button"
      class="focus-ring flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-hover"
      title={[
        `#${p.pr.number} ${p.pr.title}`,
        [p.pr.headRefName, p.pr.author].filter(Boolean).join(" · "),
        p.pr.worktreePath ? "Checked out here — opens its worktree" : "Opens on GitHub",
      ].join("\n")}
      onClick={() => activatePr(p.pr)}
    >
      <Dot bucket={prBucket(p.pr)} />
      <span class="shrink-0 font-mono text-[10px] text-foreground-dim">#{p.pr.number}</span>
      <span class="min-w-0 truncate font-mono text-[10px] text-foreground-subtle">
        {p.pr.title}
      </span>
      <Show when={prSuffix(p.pr)}>
        {(suffix) => (
          <span class="shrink-0 font-mono text-[10px] text-foreground-dim">{suffix()}</span>
        )}
      </Show>
      <span class="ml-auto shrink-0 font-mono text-[9px] tabular-nums text-foreground-dim opacity-60">
        {formatAge(p.pr.updatedAt)}
      </span>
      <Show when={p.pr.worktreePath}>
        <span class="shrink-0 font-mono text-[9px] text-foreground-dim" aria-hidden="true">
          ⎇
        </span>
      </Show>
    </button>
  </li>
);

/**
 * "Latest first" section: one row for the newest item with a chevron; clicking
 * the row unfolds the rest. The trailing `↗` opens the newest item itself.
 * `kind` is the dim word that tells the two sections apart on a narrow rail.
 */
const LatestSection: Component<{
  kind: string;
  latest: { bucket: CheckBucket; name: string; detail?: string; age: string; url: string | null };
  history: {
    bucket?: CheckBucket;
    name: string;
    detail?: string;
    age: string;
    url: string | null;
    highlight?: boolean;
  }[];
  hint: string;
}> = (p) => {
  const [open, setOpen] = createSignal(false);
  const hasHistory = () => p.history.length > 0;
  return (
    <section class="border-t border-border-subtle px-1 py-1">
      <div class="flex items-center">
        <button
          type="button"
          class="focus-ring flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-hover disabled:cursor-default"
          aria-expanded={hasHistory() ? open() : undefined}
          disabled={!hasHistory()}
          title={p.hint}
          onClick={() => setOpen(!open())}
        >
          <Show when={hasHistory()} fallback={<span class="size-3 shrink-0" aria-hidden="true" />}>
            <Show
              when={open()}
              fallback={<ChevronRightIcon class="size-3 shrink-0 text-foreground-dim" />}
            >
              <ChevronDownIcon class="size-3 shrink-0 text-foreground-dim" />
            </Show>
          </Show>
          <Dot bucket={p.latest.bucket} />
          <span class="shrink-0 font-mono text-[9px] uppercase tracking-wide text-foreground-dim">
            {p.kind}
          </span>
          <span class="min-w-0 truncate font-mono text-[10px] text-foreground-subtle">
            {p.latest.name}
          </span>
          <Show when={p.latest.detail}>
            <span class="min-w-0 truncate font-mono text-[10px] text-foreground-dim">
              {p.latest.detail}
            </span>
          </Show>
          <span class="ml-auto shrink-0 font-mono text-[9px] tabular-nums text-foreground-dim opacity-60">
            {p.latest.age}
          </span>
        </button>
        <Show when={p.latest.url}>
          <button
            type="button"
            class="focus-ring flex size-6 shrink-0 items-center justify-center rounded text-[11px] text-foreground-dim hover:bg-hover hover:text-foreground-subtle"
            aria-label={`Open ${p.latest.name} on GitHub`}
            title="Open on GitHub"
            onClick={() => openExternal(p.latest.url)}
          >
            <span aria-hidden="true">↗</span>
          </button>
        </Show>
      </div>
      <Show when={open()}>
        <ul class="flex flex-col pb-0.5">
          <For each={p.history}>
            {(row) => (
              <li>
                <Row
                  bucket={row.bucket}
                  tone={row.bucket ? undefined : "dim"}
                  name={row.name}
                  detail={row.detail}
                  trailing={row.age}
                  url={row.url}
                  highlight={row.highlight}
                  indent
                />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
};

/** The full detail of this worktree's own pull request. */
const PrDetail: Component<{
  pr: PullRequest;
  status: WorktreeStatus;
  onMerge: () => void;
}> = (props) => {
  const groups = createMemo(() => groupChecks(props.pr.checks));
  const cells = createMemo(() => statusCells(props.pr));
  const action = createMemo(() => mergeAction(props.pr));
  return (
    <section class="px-2 pb-2 pt-2.5">
      {/* Header: number + title, then the provenance line. */}
      <div class="flex items-baseline gap-1.5">
        <span class="shrink-0 font-mono text-[10px] text-foreground-dim">#{props.pr.number}</span>
        <span class="line-clamp-2 min-w-0 flex-1 text-xs leading-snug text-foreground">
          {props.pr.title}
        </span>
      </div>
      <div
        class="mt-1 flex items-center gap-1.5 truncate font-mono text-[10px] text-foreground-dim"
        title={`${props.pr.headRefName} → ${props.pr.baseRefName}${
          props.pr.author ? ` · by ${props.pr.author}` : ""
        }`}
      >
        <span class="truncate">→ {props.pr.baseRefName}</span>
        <span aria-hidden="true">·</span>
        <span class="shrink-0">{formatAge(props.pr.updatedAt)} ago</span>
        <Show when={props.pr.isDraft}>
          <span class="shrink-0 rounded bg-surface-sunken px-1 py-px text-[8px] uppercase tracking-wide">
            draft
          </span>
        </Show>
      </div>

      {/* Status line: checks · review · merge, each a dot and a token. */}
      <div class="mt-2 flex items-center gap-3">
        <StatusItem cell={cells().checks} title="Checks" />
        <StatusItem cell={cells().review} title="Review" />
        <StatusItem cell={cells().merge} title="Merge" />
      </div>

      {/* Actions */}
      <div class="mt-2 flex items-center justify-end gap-1">
        <Tooltip openDelay={200}>
          <TooltipTrigger
            as="button"
            type="button"
            class="focus-ring flex size-6 items-center justify-center rounded text-foreground-dim hover:bg-hover hover:text-foreground-subtle"
            aria-label="Open pull request on GitHub"
            onClick={() => openExternal(props.pr.url)}
          >
            <span aria-hidden="true" class="text-[11px]">
              ↗
            </span>
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent>Open on GitHub</TooltipContent>
          </TooltipPortal>
        </Tooltip>
        <Tooltip openDelay={200}>
          <TooltipTrigger
            as="button"
            type="button"
            class="focus-ring flex min-w-0 items-center gap-1 rounded border border-border-subtle bg-surface-raised px-2 py-0.5 font-mono text-[10px] text-foreground hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
            disabled={action().disabled}
            onClick={() => props.onMerge()}
          >
            <span class="truncate">{action().label}</span>
            <Show when={!action().disabled}>
              <span class="text-foreground-dim" aria-hidden="true">
                ▾
              </span>
            </Show>
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent>{action().hint}</TooltipContent>
          </TooltipPortal>
        </Tooltip>
      </div>

      {/* Checks, grouped by workflow. */}
      <Show when={groups().length > 0}>
        <ul class="mt-2.5 flex flex-col border-t border-border-subtle pt-1.5">
          <For each={groups()}>{(group) => <CheckGroupRow group={group} />}</For>
        </ul>
      </Show>
    </section>
  );
};

export const GithubView: Component<GithubViewProps> = (props) => {
  const entry = createMemo(() => prForPath(props.worktree.path));
  const pr = createMemo(() => entry()?.pr ?? null);
  const allPrs = createMemo(() => prsForProject(props.projectSlug));
  const loading = createMemo(() => entry() === undefined && allPrs() === undefined);

  /** Every other open PR, newest first. */
  const otherPrs = createMemo<PullRequestSummary[]>(() => {
    const own = pr()?.number;
    return (allPrs() ?? [])
      .filter((p) => p.number !== own)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  });

  const [mergeOpen, setMergeOpen] = createSignal(false);
  const [deleteOffer, setDeleteOffer] = createSignal(false);

  // Newest deployment first; this branch's own deployments are tinted in the
  // unfolded history so "is my branch on dev yet" needs no reading.
  const deployments = createMemo<DeploymentEnv[]>(() =>
    [...deploymentsForProject(props.projectSlug)].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    ),
  );
  const releases = createMemo<Release[]>(() => releasesForProject(props.projectSlug));

  const releaseDetail = (r: Release): string | undefined =>
    r.isLatest
      ? "latest"
      : r.isDraft
        ? "draft"
        : r.isPrerelease
          ? "pre-release"
          : r.name && r.name !== r.tagName
            ? r.name
            : undefined;

  return (
    <div class="flex flex-col pb-2">
      <Show
        when={!loading()}
        fallback={<p class="px-2 py-2 text-[11px] text-foreground-dim">Loading…</p>}
      >
        {/* This branch's pull request, in full. */}
        <Show when={pr()}>
          {(p) => <PrDetail pr={p()} status={props.status} onMerge={() => setMergeOpen(true)} />}
        </Show>

        {/* Every other open PR of the repo. */}
        <section class="px-1 py-1" classList={{ "border-t border-border-subtle": pr() !== null }}>
          <Show
            when={otherPrs().length > 0}
            fallback={
              <p class="px-1 py-1 font-mono text-[10px] text-foreground-dim">
                {pr() ? "No other open pull requests" : "No open pull requests"}
              </p>
            }
          >
            <div class="flex items-center gap-1.5 px-1 py-1 font-mono text-[9px] uppercase tracking-wide text-foreground-dim">
              <span>{pr() ? "Other pull requests" : "Pull requests"}</span>
              <span>{otherPrs().length}</span>
            </div>
            <ul class="flex flex-col">
              <For each={otherPrs()}>{(row) => <PrRow pr={row} />}</For>
            </ul>
          </Show>
        </section>
      </Show>

      {/* Deployments: every environment, newest first, like the GitHub repo
          sidebar. A spinner marks one still running. Absent when the repo has
          none. */}
      <Show when={deployments().length > 0}>
        <section class="border-t border-border-subtle px-1 py-1">
          <div class="flex items-center gap-1.5 px-1 py-1 font-mono text-[9px] uppercase tracking-wide text-foreground-dim">
            <span>Deployments</span>
            <span>{deployments().length}</span>
          </div>
          <ul class="flex flex-col">
            <For each={deployments()}>
              {(env) => (
                <li>
                  <Row
                    bucket={env.bucket}
                    name={env.environment}
                    detail={[env.ref, env.sha].filter(Boolean).join(" · ")}
                    trailing={formatAge(env.updatedAt)}
                    url={env.environmentUrl ?? env.logUrl}
                    highlight={env.ref === props.worktree.branch}
                    hint={`${env.environment} · ${env.state.toLowerCase()}${
                      env.message ? `\n${env.message}` : ""
                    }`}
                  />
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>

      {/* Latest release, history on click. Absent when the repo has none. */}
      <Show when={releases()[0]}>
        {(latest) => (
          <LatestSection
            kind="release"
            hint={`${latest().tagName}${latest().name && latest().name !== latest().tagName ? ` · ${latest().name}` : ""}${
              releases().length > 1 ? `\n${releases().length - 1} older — click to unfold` : ""
            }`}
            latest={{
              bucket: latest().isLatest ? "pass" : "skipped",
              name: latest().tagName,
              detail: releaseDetail(latest()),
              age: formatAge(latest().publishedAt),
              url: latest().url,
            }}
            history={releases()
              .slice(1)
              .map((r) => ({
                bucket: undefined,
                name: r.tagName,
                detail: releaseDetail(r),
                age: formatAge(r.publishedAt),
                url: r.url,
              }))}
          />
        )}
      </Show>

      {/* Merge sheet — offers the delete-worktree flow afterwards, never runs it. */}
      <Show when={mergeOpen() && pr()}>
        {(p) => (
          <Suspense>
            <MergePrSheet
              open={true}
              path={props.worktree.path}
              pr={p()}
              onClose={() => setMergeOpen(false)}
              onMerged={() => {
                setMergeOpen(false);
                if (!props.isMain) setDeleteOffer(true);
              }}
            />
          </Suspense>
        )}
      </Show>

      <Show when={deleteOffer()}>
        <Suspense>
          <DeleteWorktreeModal
            open={true}
            projectSlug={props.projectSlug}
            worktree={props.worktree}
            onClose={() => setDeleteOffer(false)}
            onDeleted={() => setDeleteOffer(false)}
          />
        </Suspense>
      </Show>
    </div>
  );
};
