/**
 * FLEET — Attention rail ("mission control").
 *
 * A pinnable panel that lists every agent wanting a human, in triage order:
 * waiting (oldest-blocked first) → errored → completed-unread. Each row shows
 * the harness icon, the owning project's sigil, a label, and a live age
 * ("waiting 8m"); clicking focuses the pane. Rows are multi-selectable so the
 * user can fan a batch action (focus-cycle, send a prompt, kill, restart)
 * across several agents at once.
 *
 * Rendered by `top-row.tsx`, which owns the compact trigger + the pin state
 * and hands them in as props. The rail itself is content; the anchoring
 * (Popover vs. always-on pinned panel) is the caller's concern.
 */

import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { attentionQueue, markAcknowledged, type AttentionItem } from "../stores/agentStore";
import { projectBySlug } from "../stores/projectStore";
import { terminalStore } from "../stores/terminalStore";
import { resolveSessionTabLabel } from "../lib/harnessTabLabel";
import { HARNESS_ICONS, type HarnessIconKind } from "./icons";
import { Button } from "./ui/button";

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

  // Multi-select state. Keyed by session id; only ids still present in the
  // queue count toward batch actions, so a row that resolves itself out drops
  // from the selection automatically (see `selectedIds`).
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());

  const liveIds = createMemo<ReadonlySet<string>>(() => {
    const s = new Set<string>();
    for (const item of queue()) {
      const id = item.session.session_id;
      if (id) s.add(id);
    }
    return s;
  });

  const selectedIds = createMemo<string[]>(() => {
    const live = liveIds();
    return Array.from(selected()).filter((id) => live.has(id));
  });

  function toggleSelect(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection(): void {
    setSelected(new Set<string>());
  }

  function focusSession(sessionId: string): void {
    window.dispatchEvent(new CustomEvent("terminal-focus-requested", { detail: { sessionId } }));
  }

  // ---- batch actions -----------------------------------------------------

  // Focus-cycle: dispatch focus to each selected pane in turn. The grid only
  // physically surfaces one at a time, so we step on a short timer — the user
  // sees each pane flash to front, ending on the last. Falls back to a single
  // focus when nothing is multi-selected.
  function focusCycleSelected(): void {
    const ids = selectedIds();
    if (ids.length === 0) return;
    if (ids.length === 1) {
      focusSession(ids[0]!);
      return;
    }
    ids.forEach((id, i) => {
      setTimeout(() => focusSession(id), i * 350);
    });
  }

  // Send the same prompt to every selected agent. `terminal_paste_text`
  // mirrors the bracketed-paste path the focused pane uses, so multi-line
  // prompts land intact. A trailing newline submits it.
  const [promptDraft, setPromptDraft] = createSignal("");
  function sendPromptToSelected(): void {
    const text = promptDraft().trim();
    if (!text) return;
    const ids = selectedIds();
    for (const sessionId of ids) {
      void invoke("terminal_paste_text", { sessionId, text: `${text}\n` }).catch((e) => {
        console.warn("[attention-rail] terminal_paste_text failed", e);
      });
    }
    setPromptDraft("");
  }

  // Dismiss = acknowledge without focusing. Only completed/errored rows are
  // dismissible ("waiting" is sticky — there is nothing to dismiss, the
  // agent still wants input). This is the only way to clear a completion in
  // a NON-active project without switching to it: the notification center
  // auto-acks the active project only, by design.
  function dismissSelected(): void {
    const dismissible = new Set(
      queue()
        .filter((i) => i.session.state === "completed" || i.session.state === "errored")
        .map((i) => i.session.session_id),
    );
    for (const sessionId of selectedIds()) {
      if (dismissible.has(sessionId)) markAcknowledged(sessionId);
    }
    clearSelection();
  }

  function killSelected(): void {
    for (const sessionId of selectedIds()) {
      void invoke("terminal_kill", { sessionId }).catch((e) => {
        console.warn("[attention-rail] terminal_kill failed", e);
      });
    }
    clearSelection();
  }

  // Restart = re-run the harness in place via the dead-pane respawn path.
  // We can't call `terminal_respawn_dead` directly from here: it isn't
  // fire-and-forget — it streams the rebuilt pane's I/O over a Channel into a
  // live xterm, which the rail has no surface for (a bare { sessionId } also
  // fails ReattachArgs deserialization). Instead we focus the session (so its
  // TerminalPane is mounted) and dispatch `raum:terminal-recover-requested`;
  // the pane routes it through `recoverDeadPaneRef`, which builds the full
  // ReattachArgs + onData channel and resumes the conversation. Mirrors how
  // focusSession already drives the app via `terminal-focus-requested`.
  function restartSelected(): void {
    for (const sessionId of selectedIds()) {
      focusSession(sessionId);
      requestAnimationFrame(() => {
        window.dispatchEvent(
          new CustomEvent("raum:terminal-recover-requested", { detail: { sessionId } }),
        );
      });
    }
  }

  return (
    <div class="flex w-80 flex-col" data-testid="attention-rail">
      <div class="flex items-center justify-between px-2 py-1.5">
        <span class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Attention
        </span>
        <Show when={selectedIds().length > 0}>
          <button
            type="button"
            class="text-[10px] text-muted-foreground hover:text-foreground"
            onClick={clearSelection}
          >
            Clear ({selectedIds().length})
          </button>
        </Show>
      </div>

      <Show
        when={queue().length > 0}
        fallback={
          <p class="px-2 pb-2 text-[11px] leading-snug text-muted-foreground">
            No agents need attention.
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
              const isSelected = () => (id ? selected().has(id) : false);
              const tone =
                item.session.state === "errored"
                  ? "text-destructive"
                  : item.session.state === "completed"
                    ? "text-success"
                    : "text-warning";
              return (
                <div
                  class="group flex items-center gap-2 rounded-md px-1.5 py-1.5 text-xs hover:bg-hover"
                  classList={{ "bg-selected": isSelected() }}
                >
                  <input
                    type="checkbox"
                    class="size-3 shrink-0 cursor-pointer accent-foreground"
                    checked={isSelected()}
                    onChange={() => id && toggleSelect(id)}
                    aria-label="Select agent for batch action"
                  />
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
              );
            }}
          </For>
        </div>
      </Show>

      {/* Batch action bar — only meaningful with a selection. */}
      <Show when={selectedIds().length > 0}>
        <div class="mt-1 border-t border-border px-2 pt-2 pb-2">
          <div class="flex items-center gap-1">
            <input
              type="text"
              value={promptDraft()}
              onInput={(e) => setPromptDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  sendPromptToSelected();
                }
              }}
              placeholder={`Prompt ${selectedIds().length} agent${selectedIds().length === 1 ? "" : "s"}…`}
              class="h-7 min-w-0 flex-1 rounded border border-input bg-background px-2 text-[11px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
              data-testid="attention-batch-prompt"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="h-7 px-2 text-[11px]"
              disabled={!promptDraft().trim()}
              onClick={sendPromptToSelected}
            >
              Send
            </Button>
          </div>
          <div class="mt-1.5 flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="h-6 flex-1 px-2 text-[11px]"
              onClick={focusCycleSelected}
            >
              Focus
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="h-6 flex-1 px-2 text-[11px]"
              onClick={restartSelected}
            >
              Restart
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="h-6 flex-1 px-2 text-[11px]"
              onClick={dismissSelected}
            >
              Dismiss
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="h-6 flex-1 px-2 text-[11px] text-destructive hover:text-destructive"
              onClick={killSelected}
            >
              Kill
            </Button>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default AttentionRail;
