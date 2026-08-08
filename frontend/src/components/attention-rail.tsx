/**
 * FLEET — "Needs you" rail ("mission control").
 *
 * A pinnable panel that lists every agent wanting a human, in triage order:
 * waiting (oldest-blocked first) → errored → completed-unread. Each row shows
 * the harness icon, the owning project's sigil, a label, and a live age
 * ("waiting 8m"); clicking focuses the pane. Completed/errored rows carry a ×
 * to acknowledge without focusing — the only way to clear a completion in a
 * NON-active project without switching to it, since the notification center
 * auto-acks the active project only, by design.
 *
 * Rendered by `top-row.tsx`, which owns the compact trigger + the pin state
 * and hands them in as props. The rail itself is content; the anchoring
 * (Popover vs. always-on pinned panel) is the caller's concern.
 */

import { invoke } from "@tauri-apps/api/core";
import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { attentionQueue, markAcknowledged, type AttentionItem } from "../stores/agentStore";
import { projectBySlug } from "../stores/projectStore";
import { terminalStore } from "../stores/terminalStore";
import { resolveSessionTabLabel } from "../lib/harnessTabLabel";
import { clearPendingPermission, pendingPermissionForSession } from "../lib/notificationCenter";
import { permissionSummary } from "../lib/permissionSummary";
import { HARNESS_ICONS, type HarnessIconKind } from "./icons";

/** Format a blocked-since timestamp as a terse relative age ("8m", "2h"). */
function formatAge(blockedSince: number, now: number): string {
  if (!blockedSince) return "";
  const secs = Math.max(0, Math.floor((now - blockedSince) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/** Human verb for the state prefix of the age label. */
function stateVerb(state: AttentionItem["session"]["state"]): string {
  if (state === "waiting") return "waiting";
  if (state === "errored") return "errored";
  if (state === "completed") return "done";
  return state;
}

export interface AttentionRailProps {
  /** Dismiss the rail (e.g. after a focus action) — supplied by the caller. */
  onClose?: () => void;
}

export const AttentionRail: Component<AttentionRailProps> = (props) => {
  // 1 Hz tick so the age labels advance while the panel is open. Cheap: a
  // single signal that re-renders only the (small) visible rail.
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });

  const queue = createMemo<AttentionItem[]>(() => attentionQueue());

  function focusSession(sessionId: string): void {
    window.dispatchEvent(new CustomEvent("terminal-focus-requested", { detail: { sessionId } }));
  }

  return (
    <div class="flex w-80 flex-col" data-testid="attention-rail">
      <div class="flex items-center px-2 py-1.5">
        <span class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Needs you
        </span>
      </div>

      <Show
        when={queue().length > 0}
        fallback={
          <p class="px-2 pb-2 text-[11px] leading-snug text-muted-foreground">
            No agents need you right now.
          </p>
        }
      >
        <div class="max-h-80 overflow-y-auto px-1">
          <For each={queue()}>
            {(item) => {
              const id = item.session.session_id;
              const project = () => {
                const rec = id ? terminalStore.byId[id] : undefined;
                const slug = rec?.project_slug;
                return slug ? (projectBySlug().get(slug) ?? null) : null;
              };
              const Icon =
                HARNESS_ICONS[item.session.harness as HarnessIconKind] ??
                HARNESS_ICONS["shell" as HarnessIconKind];
              const tone =
                item.session.state === "errored"
                  ? "text-destructive"
                  : item.session.state === "completed"
                    ? "text-success"
                    : "text-warning";
              // Replyable permission request for this session, if any. Rows
              // without one keep today's focus-only behavior.
              const pending = () =>
                item.session.state === "waiting" && id
                  ? pendingPermissionForSession(id)
                  : undefined;
              const summary = createMemo(() => {
                const p = pending();
                return p ? permissionSummary(item.session.harness, p.payload) : null;
              });
              // Latched per row for the duration of one in-flight reply, so a
              // double click can't send twice. Released in `finally`: the row
              // usually vanishes with the entry, but a session with a second
              // parked request re-renders with that request's summary and must
              // stay answerable.
              const [replying, setReplying] = createSignal(false);

              async function reply(decision: "allow" | "deny"): Promise<void> {
                const p = pending();
                if (!p?.requestId || replying()) return;
                setReplying(true);
                try {
                  await invoke("reply_permission", {
                    args: {
                      request_id: p.requestId,
                      session_id: p.sessionId,
                      decision,
                    },
                  });
                  clearPendingPermission(p.permissionKey);
                } catch (e) {
                  // Transport failure: leave the row so the user can retry
                  // (or answer in the harness's own prompt, which still fires).
                  console.warn("reply_permission failed", e);
                } finally {
                  setReplying(false);
                }
              }

              return (
                <div class="group flex flex-col rounded-md px-1.5 py-1.5 text-xs hover:bg-hover">
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none"
                      onClick={() => {
                        if (!id) return;
                        focusSession(id);
                        props.onClose?.();
                      }}
                    >
                      <Icon class={`size-3.5 shrink-0 ${tone}`} />
                      <span class="min-w-0 flex-1 truncate text-foreground/90">
                        {id ? resolveSessionTabLabel(id) : "—"}
                      </span>
                      <Show when={project()}>
                        {(p) => (
                          <span
                            class="shrink-0 font-mono text-[10px]"
                            style={{ color: p().color }}
                            title={p().name}
                          >
                            {p().sigil}
                          </span>
                        )}
                      </Show>
                      <span class={`shrink-0 text-[10px] tabular-nums ${tone}`}>
                        {stateVerb(item.session.state)} {formatAge(item.blockedSince, now())}
                      </span>
                    </button>
                    <Show when={id && item.session.state !== "waiting"}>
                      <button
                        type="button"
                        class="focus-ring pointer-events-none shrink-0 rounded px-0.5 text-xs leading-none text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
                        title="Dismiss"
                        aria-label="Dismiss"
                        data-testid="attention-dismiss"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (id) markAcknowledged(id);
                        }}
                      >
                        ×
                      </button>
                    </Show>
                  </div>

                  <Show when={summary()}>
                    {(s) => (
                      <div
                        class="mt-1 flex items-center gap-1.5 pl-5"
                        data-testid="attention-permission"
                      >
                        <span
                          class="min-w-0 flex-1 truncate text-[10px] text-muted-foreground"
                          title={`${s().tool}${s().head ? `: ${s().head}` : ""}`}
                        >
                          <span class="text-foreground/70">{s().tool}</span>
                          {s().head ? ` ${s().head}` : ""}
                        </span>
                        <button
                          type="button"
                          class="focus-ring shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground/80 transition-colors hover:bg-hover hover:text-foreground disabled:opacity-40"
                          disabled={replying()}
                          data-testid="attention-allow"
                          onClick={(e) => {
                            e.stopPropagation();
                            void reply("allow");
                          }}
                        >
                          Allow
                        </button>
                        <button
                          type="button"
                          class="focus-ring shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground/80 transition-colors hover:bg-hover hover:text-foreground disabled:opacity-40"
                          disabled={replying()}
                          data-testid="attention-deny"
                          onClick={(e) => {
                            e.stopPropagation();
                            void reply("deny");
                          }}
                        >
                          Deny
                        </button>
                      </div>
                    )}
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default AttentionRail;
