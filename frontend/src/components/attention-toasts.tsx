/**
 * In-app attention toasts — the notification-style twin of the "Needs you"
 * rail. Mirrors {@link attentionQueue} into `solid-sonner` toasts (top-right,
 * stacked, unfold on hover): one toast per `(session, state)` while the entry
 * is in the queue, dismissed the moment it leaves (reply, TUI answer,
 * acknowledgement, session gone).
 *
 * Anatomy: project sigil (in project color) + project name, harness tab
 * label in muted mono, elapsed time tinted by state (waiting / errored /
 * done). A waiting toast with a replyable permission carries the tool +
 * subject line and inline Allow / Deny. Clicking the body focuses the pane.
 *
 * Renders nothing itself — mount once next to `<Toaster />`.
 */

import {
  Component,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { toast } from "solid-sonner";
import { attentionQueue, markAcknowledged, type AttentionItem } from "../stores/agentStore";
import { projectBySlug } from "../stores/projectStore";
import { terminalStore } from "../stores/terminalStore";
import { resolveSessionTabLabel } from "../lib/harnessTabLabel";
import { pendingPermissionForSession, replyPermission } from "../lib/notificationCenter";
import {
  ackGithubAttention,
  activateGithubAttention,
  bucketDotClass,
  githubAttention,
  type GithubAttentionRow,
} from "../lib/githubAttention";
import { permissionSummary } from "../lib/permissionSummary";
import { formatAge, stateVerb } from "./attention-rail";

/** Completed / errored toasts auto-dismiss after this; waiting ones are sticky. */
const DONE_TOAST_MS = 8_000;

const [now, setNow] = createSignal(Date.now());

function toastKey(item: AttentionItem): string {
  return `attention:${item.session.session_id ?? ""}:${item.session.state}`;
}

const AttentionToast: Component<{ item: AttentionItem; toastId: string }> = (props) => {
  const id = () => props.item.session.session_id ?? "";
  const state = () => props.item.session.state;
  const project = () => {
    const slug = terminalStore.byId[id()]?.project_slug;
    return slug ? (projectBySlug().get(slug) ?? null) : null;
  };
  const tone = () =>
    state() === "errored"
      ? "text-destructive"
      : state() === "completed"
        ? "text-success"
        : "text-warning";
  const pending = () => (state() === "waiting" ? pendingPermissionForSession(id()) : undefined);
  const summary = createMemo(() => {
    const p = pending();
    return p ? permissionSummary(props.item.session.harness, p.payload) : null;
  });
  const [replying, setReplying] = createSignal(false);

  async function reply(decision: "allow" | "deny"): Promise<void> {
    const p = pending();
    if (!p || replying()) return;
    setReplying(true);
    try {
      await replyPermission(p, decision);
    } finally {
      setReplying(false);
    }
  }

  function focus(): void {
    window.dispatchEvent(
      new CustomEvent("terminal-focus-requested", { detail: { sessionId: id() } }),
    );
    toast.dismiss(props.toastId);
  }

  return (
    <div
      class="flex w-full flex-col gap-2"
      data-testid="attention-toast"
      // A toast must never take keyboard focus from the pane the user is
      // typing in: sonner's <li> is tabbable, so a plain click would move
      // focus there and swallow keystrokes. Cancelling mousedown keeps focus
      // where it was; click handlers still fire.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        class="flex min-w-0 flex-1 items-start gap-2.5 text-left focus:outline-none"
        onClick={focus}
      >
        <span
          class="w-4 shrink-0 text-center font-mono text-[15px] leading-none font-semibold"
          style={{ color: project()?.color }}
        >
          {project()?.sigil ?? "·"}
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="flex min-w-0 items-baseline gap-2">
            <span class="shrink-0 text-[12.5px] font-medium text-foreground">
              {project()?.name ?? "—"}
            </span>
            <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
              {resolveSessionTabLabel(id())}
            </span>
            <span class={`shrink-0 font-mono text-[10.5px] font-medium tabular-nums ${tone()}`}>
              {stateVerb(state())} {formatAge(props.item.blockedSince, now())}
            </span>
          </span>
          <Show when={summary()}>
            {(s) => (
              <span
                class="truncate font-mono text-[10.5px] text-muted-foreground"
                title={`${s().tool}${s().head ? `: ${s().head}` : ""}`}
              >
                <span class="font-medium text-foreground-subtle">{s().tool}</span>
                {s().head ? ` ${s().head}` : ""}
              </span>
            )}
          </Show>
        </span>
      </button>
      <Show when={summary()}>
        <div class="flex gap-1.5 pl-[26px]" data-testid="attention-toast-permission">
          <button
            type="button"
            class="focus-ring rounded-md bg-foreground px-2.5 py-1.5 text-[11px] leading-none font-medium text-background hover:opacity-90 disabled:opacity-40"
            disabled={replying()}
            data-testid="attention-toast-allow"
            onClick={() => void reply("allow")}
          >
            Allow
          </button>
          <button
            type="button"
            class="focus-ring rounded-md bg-active px-2.5 py-1.5 text-[11px] leading-none font-medium text-foreground-subtle hover:text-foreground disabled:opacity-40"
            disabled={replying()}
            data-testid="attention-toast-deny"
            onClick={() => void reply("deny")}
          >
            Deny
          </button>
        </div>
      </Show>
    </div>
  );
};

/**
 * PR / deployment toast — the twin of the rail's GitHub row, laid out like the
 * agent toast above: the project's sigil in its colour leads, the project name
 * heads the first line, the status dot rides the second.
 */
const GithubToast: Component<{ row: GithubAttentionRow; toastId: string }> = (props) => {
  const project = () =>
    props.row.projectSlug ? (projectBySlug().get(props.row.projectSlug) ?? null) : null;
  return (
    <div
      class="flex w-full items-start gap-2.5"
      data-testid="attention-github-toast"
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        class="flex min-w-0 flex-1 items-start gap-2.5 text-left focus:outline-none"
        onClick={() => {
          activateGithubAttention(props.row);
          toast.dismiss(props.toastId);
        }}
      >
        <span
          class="w-4 shrink-0 text-center font-mono text-[15px] leading-none font-semibold"
          style={{ color: project()?.color }}
        >
          {project()?.sigil ?? "·"}
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="flex min-w-0 items-baseline gap-2">
            <span class="shrink-0 text-[12.5px] font-medium text-foreground">
              {project()?.name ?? "GitHub"}
            </span>
            <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground-subtle">
              {props.row.label}
            </span>
            <span class="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
              {formatAge(props.row.at, now())}
            </span>
          </span>
          <span class="flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
            <span class={`size-1.5 shrink-0 rounded-full ${bucketDotClass(props.row.bucket)}`} />
            <span class="truncate">{props.row.sub}</span>
          </span>
        </span>
      </button>
    </div>
  );
};

export const AttentionToasts: Component = () => {
  onMount(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });

  // Keys currently shown. Diffed against the queue on every change.
  const shown = new Map<string, AttentionItem>();
  let first = true;

  createEffect(() => {
    const queue = attentionQueue();
    const live = new Set<string>();
    for (const item of queue) {
      if (!item.session.session_id) continue;
      const key = toastKey(item);
      live.add(key);
      if (shown.has(key)) continue;
      shown.set(key, item);
      // Boot / rehydrate replays every unread completion; only agents that
      // are actually blocked deserve a toast on the first pass.
      if (first && item.session.state !== "waiting") continue;
      const sticky = item.session.state === "waiting";
      toast(() => <AttentionToast item={item} toastId={key} />, {
        id: key,
        duration: sticky ? Number.POSITIVE_INFINITY : DONE_TOAST_MS,
        classNames: { content: "min-w-0 flex-1", title: "w-full" },
        // × on a done/errored toast acknowledges it (drops it from the
        // rail too); a waiting one can only be answered, so × just hides.
        onDismiss: sticky ? undefined : () => markAcknowledged(item.session.session_id ?? ""),
      });
    }
    for (const key of shown.keys()) {
      if (live.has(key)) continue;
      shown.delete(key);
      toast.dismiss(key);
    }
    first = false;
  });

  // Same diff, for GitHub rows. They are never sticky: a PR edge is
  // information, not a block, so the toast auto-closes and the rail keeps the
  // row until the user dismisses it or a later transition supersedes it.
  const shownGithub = new Set<string>();
  createEffect(() => {
    const rows = githubAttention();
    const live = new Set(rows.map((r) => r.id));
    for (const row of rows) {
      if (shownGithub.has(row.id)) continue;
      shownGithub.add(row.id);
      toast(() => <GithubToast row={row} toastId={row.id} />, {
        id: row.id,
        duration: DONE_TOAST_MS,
        classNames: { content: "min-w-0 flex-1", title: "w-full" },
        // × acknowledges the row (sonner fires `onAutoClose`, not this, when
        // the timer elapses, so a timed-out toast leaves the rail row alone).
        onDismiss: () => ackGithubAttention(row.id),
      });
    }
    for (const id of shownGithub) {
      if (live.has(id)) continue;
      shownGithub.delete(id);
      toast.dismiss(id);
    }
  });

  return null;
};

export default AttentionToasts;
