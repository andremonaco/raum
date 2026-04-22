/**
 * Cross-project spotlight overlay.
 *
 * Mounted above the terminal grid whenever `crossProjectViewMode()` is set
 * by one of the header filter icons. Renders a responsive grid of cards —
 * one per matching harness session across every project — so the user can
 * see everything that is awaiting, recently active, or currently working at
 * a glance, without having to cycle through project tabs.
 *
 * Each card's top bar is painted with the owning project's color (soft
 * gradient + glow) so projects stay visually distinct in the grid. Clicking
 * a card:
 *   1. Closes the overlay.
 *   2. Switches `activeProjectSlug` to the card's project.
 *   3. Dispatches `terminal-focus-requested` so the pane hosting that
 *      session scrolls into view and claims focus — the same event the
 *      notification toast/OS notification click path uses.
 *
 * The overlay dismisses on Escape, on a background click, or when the user
 * clicks the same filter icon again (which clears the mode signal).
 */

import { Component, For, Show, createMemo, onCleanup, onMount } from "solid-js";

import { crossProjectViewMode, setCrossProjectViewMode } from "./top-row";
import type { CrossProjectViewMode } from "./top-row";
import {
  activeProjectSlug,
  projectStore,
  projectColor,
  setActiveProjectSlug,
} from "../stores/projectStore";
import { terminalStore } from "../stores/terminalStore";
import type { TerminalRecord } from "../stores/terminalStore";
import { agentStore } from "../stores/agentStore";
import type { AgentState } from "../stores/agentStore";
import { AlertCircleIcon, ClockIcon, HARNESS_ICONS, LoaderIcon } from "./icons";

// Max cards shown in the "recent" view — matches the cap the user asked for.
const RECENT_CAP = 9;

interface MatchedSession {
  terminal: TerminalRecord;
  state: AgentState | null;
  projectName: string;
  projectColor: string;
  lastActivity: number;
}

function projectName(slug: string | null | undefined): string {
  if (!slug) return "unknown";
  return projectStore.items.find((p) => p.slug === slug)?.name ?? slug;
}

function matches(mode: CrossProjectViewMode, state: AgentState | null | undefined): boolean {
  if (mode === "awaiting") return state === "waiting";
  if (mode === "working") return state === "working";
  return true; // recent — any state, capped later
}

function headerLabel(mode: CrossProjectViewMode): string {
  if (mode === "awaiting") return "Awaiting across projects";
  if (mode === "working") return "Working across projects";
  return "Recent across projects";
}

function headerIcon(mode: CrossProjectViewMode): typeof AlertCircleIcon {
  if (mode === "awaiting") return AlertCircleIcon;
  if (mode === "working") return LoaderIcon;
  return ClockIcon;
}

function stateChip(state: AgentState | null): { label: string; tone: string } {
  if (state === "working") return { label: "Working", tone: "bg-success/15 text-success" };
  if (state === "waiting") return { label: "Waiting", tone: "bg-warning/15 text-warning" };
  if (state === "errored") return { label: "Errored", tone: "bg-danger/15 text-danger" };
  if (state === "completed")
    return { label: "Completed", tone: "bg-muted/30 text-foreground-subtle" };
  return { label: "Idle", tone: "bg-muted/30 text-foreground-subtle" };
}

export const CrossProjectOverlay: Component = () => {
  const mode = () => crossProjectViewMode();

  const matched = createMemo<MatchedSession[]>(() => {
    const m = mode();
    if (!m) return [];
    const out: MatchedSession[] = [];
    for (const terminal of Object.values(terminalStore.byId)) {
      if (!terminal.project_slug) continue;
      const state = agentStore.sessions[terminal.session_id]?.state ?? null;
      if (!matches(m, state)) continue;
      const color = projectColor(terminal.project_slug) ?? "#6b7280";
      out.push({
        terminal,
        state,
        projectName: projectName(terminal.project_slug),
        projectColor: color,
        lastActivity: terminal.lastOutputMs || terminal.created_unix * 1000,
      });
    }
    out.sort((a, b) => b.lastActivity - a.lastActivity);
    if (m === "recent") return out.slice(0, RECENT_CAP);
    return out;
  });

  function close(): void {
    setCrossProjectViewMode(null);
  }

  function jumpTo(entry: MatchedSession): void {
    const slug = entry.terminal.project_slug;
    if (slug && activeProjectSlug() !== slug) {
      setActiveProjectSlug(slug);
    }
    close();
    // Defer one tick so the project switch has a chance to re-hydrate the
    // grid before the focus request fires; otherwise the matching pane may
    // not yet exist in the DOM.
    queueMicrotask(() => {
      try {
        window.dispatchEvent(
          new CustomEvent("terminal-focus-requested", {
            detail: { sessionId: entry.terminal.session_id },
          }),
        );
      } catch {
        /* non-DOM env — tests / SSR */
      }
    });
  }

  onMount(() => {
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === "Escape" && mode() !== null) {
        ev.preventDefault();
        close();
      }
    }
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <Show when={mode() !== null}>
      {(() => {
        const m = mode()!;
        const Icon = headerIcon(m);
        return (
          <div
            class="absolute inset-0 z-40 flex flex-col bg-background/95 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-label={headerLabel(m)}
            onClick={(ev) => {
              if (ev.target === ev.currentTarget) close();
            }}
          >
            <div class="flex items-center justify-between border-b border-border-subtle px-4 py-2">
              <div class="flex items-center gap-2">
                <Icon class="size-4 text-foreground" />
                <h2 class="text-sm font-medium text-foreground">{headerLabel(m)}</h2>
                <span class="text-xs text-foreground-subtle">
                  {matched().length} {matched().length === 1 ? "session" : "sessions"}
                </span>
              </div>
              <button
                type="button"
                class="rounded px-2 py-0.5 text-xs text-foreground-subtle hover:bg-hover hover:text-foreground"
                onClick={close}
              >
                Close (Esc)
              </button>
            </div>

            <Show
              when={matched().length > 0}
              fallback={
                <div class="flex flex-1 items-center justify-center text-sm text-foreground-subtle">
                  No matching sessions across your projects.
                </div>
              }
            >
              <div class="flex-1 overflow-auto p-4">
                <div class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                  <For each={matched()}>
                    {(entry) => <SessionCard entry={entry} onActivate={() => jumpTo(entry)} />}
                  </For>
                </div>
              </div>
            </Show>
          </div>
        );
      })()}
    </Show>
  );
};

const SessionCard: Component<{
  entry: MatchedSession;
  onActivate: () => void;
}> = (props) => {
  const HarnessIcon = () => {
    const I = HARNESS_ICONS[props.entry.terminal.kind as keyof typeof HARNESS_ICONS];
    return I ? <I class="size-3.5" /> : null;
  };
  const chip = () => stateChip(props.entry.state);

  // The glow/gradient uses the project color at low opacity so it reads as a
  // soft wash rather than a saturated bar. Inline styles because the color
  // is dynamic per project and we'd otherwise need a tailwind safelist.
  const headerStyle = () => {
    const c = props.entry.projectColor;
    return {
      "background-image": `linear-gradient(180deg, ${c}40 0%, ${c}14 60%, transparent 100%)`,
      "box-shadow": `inset 0 1px 0 ${c}66, inset 0 -1px 0 ${c}1f`,
    } as Record<string, string>;
  };

  return (
    <button
      type="button"
      class="group flex flex-col overflow-hidden rounded-md border border-border-subtle bg-background text-left transition-colors hover:border-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onClick={() => props.onActivate()}
    >
      <div class="flex items-center gap-2 px-3 py-2" style={headerStyle()}>
        <span
          class="inline-block size-2 shrink-0 rounded-full"
          style={{ "background-color": props.entry.projectColor }}
        />
        <span class="truncate text-xs font-medium text-foreground">{props.entry.projectName}</span>
        <span class="ml-auto shrink-0 text-[10px] text-foreground-subtle">
          {relativeAgo(props.entry.lastActivity)}
        </span>
      </div>
      <div class="flex items-center gap-2 px-3 py-2">
        <HarnessIcon />
        <span class="truncate text-xs text-foreground">{props.entry.terminal.kind}</span>
        <span class={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium ${chip().tone}`}>
          {chip().label}
        </span>
      </div>
    </button>
  );
};

function relativeAgo(ms: number): string {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}
