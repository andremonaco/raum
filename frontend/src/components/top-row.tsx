/**
 * §8 — Top row navigation.
 *
 * Layout (left → right):
 *   [raum brand] [project tabs… +] [search] [working · awaiting · completed]
 *
 * The working / awaiting / completed counters on the right double as
 * cross-project view toggles: clicking one paints every matching pane across
 * projects; clicking again returns to the active project's grid.
 */

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "solid-sonner";
import {
  activeProjectSlug,
  projectBySlug,
  refreshProjects,
  reopenProject,
  setActiveProjectSlug,
  setProjectHidden,
  subscribeProjectEvents,
  upsertProject,
  type ProjectListItem,
} from "../stores/projectStore";
import { otherProjects, visibleProjects } from "../stores/projectVisibility";
import { clearPendingAddProject, openProjectFromCli, pendingAddProjectPath } from "../lib/cliOpen";
import { markStart } from "../lib/perf";
import {
  refreshAgents,
  setAdapters,
  subscribeAgentEvents,
  type AgentListItem,
} from "../stores/agentStore";
import {
  activeCount,
  harnessCountsForProject,
  idleCount,
  refreshTerminals,
  seedLastPromptsFromAgents,
  setTerminals,
  subscribeTerminalEvents,
  terminalStore,
  unreadCompletedForProject,
  type TerminalListItem,
  type TerminalRecord,
} from "../stores/terminalStore";
import { placedSessionIds, subscribePaneActivity } from "../stores/runtimeLayoutStore";
import { startTerminalAutoDock } from "../stores/terminalAutoDock";
import { subscribeReviewLinkEvents } from "../stores/reviewLinkStore";
import { attentionQueue, waitingByBlockedLongest } from "../stores/agentStore";
import {
  broadcastActive,
  broadcastMemberIds,
  broadcastScope,
  setBroadcastScope,
  toggleBroadcast,
  type BroadcastScope,
} from "../lib/broadcastStore";
import { useKeymap } from "../lib/keymapContext";
import { PROJECT_COLOR_PALETTE } from "../lib/projectColors";
import { PROJECT_SIGIL_PALETTE, SIGIL_RESET, deriveSigilFromSlug } from "../lib/projectSigils";
import { toggleSidebarHidden } from "../lib/sidebarVisibility";
import { setPreviewOnboarding } from "../lib/devOnboardingPreview";
import { closeSpotlight, setTopBarQuery, spotlightOpen } from "../lib/spotlightState";
import { AddProjectModal } from "./add-project-modal";
import { KeymapSettingsModal } from "./keymap-settings-modal";
import { SettingsModal } from "./settings-modal";
import type { SectionId } from "./settings-modal/types";
import { runUpdateCheck, type OpenSettingsDetail } from "../lib/updateNotifier";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
} from "./ui/dialog";
import { HoverCard, HoverCardContent, HoverCardPortal, HoverCardTrigger } from "./ui/hover-card";
import { Popover, PopoverContent, PopoverPortal, PopoverTrigger } from "./ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { CloseGlyph } from "./terminal-grid/glyphs";
import { Scrollable } from "./ui/scrollable";
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from "./ui/tooltip";
import {
  ActivityIcon,
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  GitBranchIcon,
  HARNESS_ICONS,
  type HarnessIconKind,
  KeyboardIcon,
  LoaderIcon,
  PlusIcon,
  RaumLogo,
  SearchIcon,
} from "./icons";
import {
  branchForProject,
  subscribeWorktreeBranchEvents,
  subscribeWorktreeStatusEvents,
} from "../stores/worktreeStore";
import { resolveSpawnWorktree } from "../lib/resolveSpawnWorktree";
import { ProjectSettingsDialog } from "./project-settings-dialog";
import { AttentionRail } from "./attention-rail";

// Internal value kept as "needs-input" so the keymap wiring (§8.5) and the
// grid-side consumer don't have to rename. UI surfaces the label "Waiting".
export type TopRowFilter = "active" | "needs-input" | "recent";

const [selectedFilter, setSelectedFilter] = createSignal<TopRowFilter>("recent");
export { selectedFilter, setSelectedFilter };

/**
 * Cross-project "spotlight" view. When non-null, raum paints only the panes
 * matching this mode (awaiting / completed / working) across every project and
 * each pane's header glows with its owning project's color. `null` = normal
 * single-project grid. Mutually exclusive with `selectedFilter`, which stays
 * project-scoped.
 */
export type CrossProjectViewMode = "awaiting" | "completed" | "working";
const [crossProjectViewMode, setCrossProjectViewMode] = createSignal<CrossProjectViewMode | null>(
  null,
);
export { crossProjectViewMode, setCrossProjectViewMode };

/** Drive a terminal-launch (`raum <dir>`) open and reconcile the surrounding
 *  view: when an existing project is focused, leave any cross-project view and
 *  reset the filter (mirroring a manual tab click); surface a toast on error. */
async function handleCliOpen(path: string): Promise<void> {
  const result = await openProjectFromCli(path);
  if (result === "focused") {
    setSelectedFilter("active");
    setCrossProjectViewMode(null);
  } else if (result === "error") {
    toast.error("Couldn't open directory", { description: path });
  }
}

// On macOS decorum sets TitleBarStyle::Overlay — native traffic lights, drag,
// and zoom animation are all handled by the OS. On Linux/Windows we use our
// own buttons and startDragging().
const isMacOS = /Mac/.test(navigator.platform);

type SpawnKind = "shell" | "claude-code" | "codex" | "opencode";
interface SpawnDef {
  kind: SpawnKind;
  label: string;
  action: string;
}
const SPAWN_DEFS: SpawnDef[] = [
  { kind: "shell", label: "Shell", action: "spawn-shell" },
  { kind: "claude-code", label: "Claude", action: "spawn-claude-code" },
  { kind: "codex", label: "Codex", action: "spawn-codex" },
  { kind: "opencode", label: "OpenCode", action: "spawn-opencode" },
];

// Broadcast scope choices, in the order the scope picker lists them. "manual"
// is intentionally omitted: there is no per-pane "add to broadcast" UI yet, so
// the manual member set can never be populated — selecting it would arm
// broadcast with zero members (every keystroke goes nowhere). Re-add once a
// membership affordance exists (broadcastStore already has the setters).
const BROADCAST_SCOPES: BroadcastScope[] = ["all-visible", "active-project"];

function prettifyAccel(accel: string | undefined): string {
  if (!accel) return "";
  return accel
    .replace(/CmdOrCtrl/g, "⌘")
    .replace(/Cmd/g, "⌘")
    .replace(/Ctrl/g, "⌃")
    .replace(/Shift/g, "⇧")
    .replace(/Alt/g, "⌥")
    .replace(/Option/g, "⌥")
    .replace(/\+/g, "");
}

// ---- Project tab -----------------------------------------------------------

interface ProjectTabProps {
  project: ProjectListItem;
  active: boolean;
  compact: boolean;
  onSelect: () => void;
  onRemove: () => void;
  /** Non-destructive shelve — drops the tab from the bar; sessions keep
   *  running and the project moves to the "+" → "Other projects" list. */
  onHide: () => void;
}

const ProjectTab: Component<ProjectTabProps> = (props) => {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [swatchOpen, setSwatchOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [hexInput, setHexInput] = createSignal("");

  const branch = createMemo(() => branchForProject(props.project.slug, props.project.rootPath));

  // Per-project attention counts driving the small status dots on the
  // project tab. `waiting` mirrors the cross-project "needs input"
  // counter; `unreadCompleted` mirrors the pane-level green
  // unread-completed chrome — both clear automatically as the user
  // focuses panes inside the project.
  const waitingForProject = createMemo(() => harnessCountsForProject(props.project.slug).waiting);
  const unreadCompletedForProj = createMemo(() => unreadCompletedForProject(props.project.slug));
  const attentionTooltip = () => {
    const parts: string[] = [];
    const w = waitingForProject();
    const c = unreadCompletedForProj();
    if (w > 0) parts.push(`${w} need${w === 1 ? "s" : ""} input`);
    if (c > 0) parts.push(`${c} completed (unread)`);
    return parts.join(" · ");
  };

  // Persist a new color. The popover stays open so the user can keep
  // tweaking (mirrors the sigil picker behaviour below).
  async function pickColor(hex: string) {
    try {
      const updated = await invoke<ProjectListItem>("project_update", {
        update: { slug: props.project.slug, color: hex },
      });
      upsertProject(updated);
    } catch (e) {
      console.warn("project_update color failed", e);
    }
  }

  // Persist a new sigil; pass `SIGIL_RESET` ("") to clear back to the
  // slug-derived value. The popover stays open so the user can keep tweaking.
  async function pickSigil(glyph: string) {
    try {
      const updated = await invoke<ProjectListItem>("project_update", {
        update: { slug: props.project.slug, sigil: glyph },
      });
      upsertProject(updated);
    } catch (e) {
      console.warn("project_update sigil failed", e);
    }
  }

  return (
    <div
      class="group relative flex h-7 items-stretch rounded-md transition-colors duration-150"
      classList={{
        "bg-selected": props.active,
        "hover:bg-selected/40": !props.active,
      }}
      data-project-slug={props.project.slug}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
    >
      <Show
        when={props.compact}
        fallback={
          <>
            {/* The color swatch owns its own Popover for quick color changes.
                Clicking the tab text itself (when active) opens the full settings
                dialog with color, hydration, and in-repo toggle. */}
            <Popover open={swatchOpen()} onOpenChange={setSwatchOpen}>
              <PopoverTrigger
                as="button"
                type="button"
                class="inline-flex select-none items-center pl-2.5 pr-1 font-mono text-[13px] leading-none tabular-nums rounded-l-md transition-opacity"
                classList={{
                  "opacity-100": props.active,
                  "opacity-60 group-hover:opacity-100": !props.active,
                }}
                style={{ color: props.project.color }}
                aria-label={`Project sigil ${props.project.sigil} — click to edit color and sigil`}
                onClick={(e: MouseEvent) => e.stopPropagation()}
              >
                {props.project.sigil}
              </PopoverTrigger>
              <PopoverPortal>
                <PopoverContent class="w-60 p-2">
                  <div class="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    Color
                  </div>
                  <div class="flex flex-wrap gap-1">
                    <For each={PROJECT_COLOR_PALETTE}>
                      {(hex) => (
                        <button
                          type="button"
                          class="h-5 w-5 rounded border border-border"
                          style={{ background: hex }}
                          onClick={() => void pickColor(hex)}
                          aria-label={`Pick ${hex}`}
                        />
                      )}
                    </For>
                  </div>
                  <label class="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground">
                    <span>Hex</span>
                    <input
                      type="text"
                      class="flex-1 rounded border border-input bg-background px-1 py-0.5 font-mono text-foreground"
                      placeholder="#aabbcc"
                      value={hexInput()}
                      onInput={(e) => setHexInput(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          const v = e.currentTarget.value.trim();
                          if (/^#[0-9a-fA-F]{3,8}$/.test(v)) {
                            void pickColor(v);
                          }
                        }
                      }}
                    />
                  </label>

                  <div class="mt-3 border-t border-border pt-2">
                    <div class="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                      Sigil
                    </div>
                    <div class="grid grid-cols-8 gap-px">
                      <For each={PROJECT_SIGIL_PALETTE}>
                        {(g) => (
                          <button
                            type="button"
                            class="inline-flex h-5 w-5 items-center justify-center rounded font-mono text-xs leading-none hover:bg-muted"
                            classList={{
                              "bg-muted ring-1 ring-border": g === props.project.sigil,
                            }}
                            style={{ color: props.project.color }}
                            onClick={() => void pickSigil(g)}
                            aria-label={`Pick sigil ${g}`}
                          >
                            {g}
                          </button>
                        )}
                      </For>
                    </div>
                    <button
                      type="button"
                      class="mt-1 text-[10px] text-muted-foreground hover:text-foreground"
                      onClick={() => void pickSigil(SIGIL_RESET)}
                    >
                      ↻ Reset to derived ({deriveSigilFromSlug(props.project.slug)})
                    </button>
                  </div>
                </PopoverContent>
              </PopoverPortal>
            </Popover>

            <button
              type="button"
              class="flex items-center gap-1.5 pl-0.5 pr-3 text-xs transition-colors rounded-r-md"
              classList={{
                "text-foreground font-medium": props.active,
                "text-muted-foreground group-hover:text-foreground": !props.active,
              }}
              onClick={() => {
                if (props.active) {
                  setSettingsOpen(true);
                } else {
                  props.onSelect();
                }
              }}
            >
              <span class="truncate">{props.project.name || props.project.slug}</span>
              <Show when={waitingForProject() > 0 || unreadCompletedForProj() > 0}>
                <span
                  class="inline-flex shrink-0 items-center gap-1"
                  aria-label={attentionTooltip()}
                  title={attentionTooltip()}
                >
                  <Show when={waitingForProject() > 0}>
                    <span class="inline-block h-1.5 w-1.5 rounded-full bg-warning animate-pulse" />
                  </Show>
                  <Show when={unreadCompletedForProj() > 0}>
                    <span class="inline-block h-1.5 w-1.5 rounded-full bg-success" />
                  </Show>
                </span>
              </Show>
              <Show when={branch()}>
                <span
                  class="inline-flex items-center gap-0.5 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] transition-colors"
                  classList={{
                    "text-foreground": props.active,
                    "text-muted-foreground group-hover:text-foreground": !props.active,
                  }}
                >
                  <GitBranchIcon class="size-2.5" />
                  <span class="max-w-[12ch] truncate">{branch()}</span>
                </span>
              </Show>
            </button>

            {/* Hover-reveal shelve button. Non-destructive: hides the tab and
                moves the project to the "+" → "Other projects" list; any
                running sessions keep going. */}
            <button
              type="button"
              aria-label={`Hide ${props.project.name || props.project.slug}`}
              data-testid={`hide-project-${props.project.slug}`}
              class="mr-1 hidden shrink-0 items-center self-center rounded-sm p-0.5 text-muted-foreground hover:bg-hover hover:text-foreground group-hover:flex"
              onClick={(e) => {
                e.stopPropagation();
                props.onHide();
              }}
            >
              <CloseGlyph />
            </button>
          </>
        }
      >
        {/* Compact mode — icon-only with tooltip */}
        <Tooltip>
          <TooltipTrigger
            as="button"
            type="button"
            class="relative inline-flex h-7 w-7 select-none items-center justify-center rounded-md font-mono text-[13px] leading-none tabular-nums transition-opacity"
            classList={{
              "opacity-100": props.active,
              "opacity-60 group-hover:opacity-100": !props.active,
            }}
            style={{ color: props.project.color }}
            aria-label={props.project.name || props.project.slug}
            onClick={() => {
              if (props.active) {
                setSettingsOpen(true);
              } else {
                props.onSelect();
              }
            }}
          >
            {props.project.sigil}
            {/* Waiting takes precedence — it represents a harness blocked on
                the user; unread completed is the gentler nudge. Only one
                dot in compact mode so the sigil stays legible. */}
            <Show when={waitingForProject() > 0}>
              <span
                aria-hidden="true"
                class="pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-warning animate-pulse group-hover:hidden"
              />
            </Show>
            <Show when={waitingForProject() === 0 && unreadCompletedForProj() > 0}>
              <span
                aria-hidden="true"
                class="pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-success group-hover:hidden"
              />
            </Show>
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent>
              {props.project.name || props.project.slug}
              <Show when={attentionTooltip()}>
                <span class="ml-1 opacity-70">· {attentionTooltip()}</span>
              </Show>
            </TooltipContent>
          </TooltipPortal>
        </Tooltip>
      </Show>

      {/* Compact mode: hover-reveal shelve X in the corner — mirrors the
          expanded tab's hide button. It swaps in where the attention dot sits
          (the dot is `group-hover:hidden`), so the 28 px tab never shows both.
          Sibling of the trigger (not nested — can't nest buttons) and absolutely
          positioned within the `relative` wrapper. */}
      <Show when={props.compact}>
        <button
          type="button"
          aria-label={`Hide ${props.project.name || props.project.slug}`}
          data-testid={`hide-project-${props.project.slug}`}
          class="absolute right-0 top-0 z-10 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-popover text-muted-foreground shadow-sm ring-1 ring-border hover:bg-hover hover:text-foreground group-hover:flex"
          onClick={(e) => {
            e.stopPropagation();
            props.onHide();
          }}
        >
          <CloseGlyph />
        </button>
      </Show>

      <Show when={menuOpen()}>
        <div
          class="floating-surface absolute left-0 top-full z-50 mt-1 w-48 rounded-xl border border-border bg-popover p-1 text-xs"
          role="menu"
          onMouseLeave={() => setMenuOpen(false)}
        >
          <button
            type="button"
            class="block w-full rounded px-2 py-1 text-left hover:bg-hover"
            onClick={() => {
              setMenuOpen(false);
              props.onHide();
            }}
          >
            Hide project
          </button>
          <div aria-hidden="true" class="my-1 h-px bg-border" />
          <button
            type="button"
            class="block w-full rounded px-2 py-1 text-left text-destructive hover:bg-destructive/10"
            onClick={() => {
              setMenuOpen(false);
              props.onRemove();
            }}
          >
            Remove project…
          </button>
        </div>
      </Show>

      <ProjectSettingsDialog
        project={props.project}
        open={settingsOpen()}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
};

export const TopRow: Component = () => {
  const keymap = useKeymap();
  const [modalOpen, setModalOpen] = createSignal(false);
  // Terminal launcher (`raum <dir>`) for an unregistered directory: open the
  // Add-Project modal pre-filled with the requested path.
  createEffect(() => {
    if (pendingAddProjectPath()) setModalOpen(true);
  });
  const [appSettingsOpen, setAppSettingsOpen] = createSignal(false);
  // Section the settings modal should jump to on open. `undefined` keeps the
  // last-viewed section (the plain gear / Cmd+, path); set explicitly when a
  // deep link — e.g. the update toast's "Install…" — wants a specific tab.
  const [settingsInitialSection, setSettingsInitialSection] = createSignal<SectionId | undefined>(
    undefined,
  );
  const openAppSettings = (section?: SectionId) => {
    setSettingsInitialSection(section);
    setAppSettingsOpen(true);
  };
  const [keymapSettingsOpen, setKeymapSettingsOpen] = createSignal(false);
  const [confirmRemove, setConfirmRemove] = createSignal<ProjectListItem | undefined>(undefined);
  const [orphanSweepResult, setOrphanSweepResult] = createSignal<
    | { count: number; ids?: string[]; error?: undefined }
    | { count: 0; ids?: undefined; error: string }
    | null
  >(null);

  // Backend sessions with no on-screen home: live tmux sessions the reconcile
  // pass adopted (or that outlived their pane) but which aren't bound to any
  // grid tab. These are the "harnesses I can't see" — surfaced so the user can
  // close them. Closing one calls `terminal_kill`, which kills the tmux
  // session, prunes `sessions.toml`, and emits `terminal-session-removed`, so
  // this list (and the counter) shrink live without a reload.
  //
  // A freshly-spawned session lands in `byId` (the backend emits the upsert
  // mid-`terminal_spawn`) BEFORE the frontend resolves `terminal_spawn` and
  // binds the new id to its tab — so for the spawn round-trip it is briefly
  // "unplaced." Without a guard it would flash into this list and the user
  // could close their own new session. The `ORPHAN_GRACE_SECS` floor on
  // `created_unix` (seconds; set to spawn time) skips that window; a slow
  // `nowSec` tick re-evaluates so a genuinely-old orphan still surfaces.
  const ORPHAN_GRACE_SECS = 20;
  const [nowSec, setNowSec] = createSignal(Math.floor(Date.now() / 1000));
  onMount(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 5000);
    onCleanup(() => clearInterval(t));
  });
  const orphanedSessions = createMemo<TerminalRecord[]>(() => {
    const placed = placedSessionIds();
    const cutoff = nowSec() - ORPHAN_GRACE_SECS;
    return Object.values(terminalStore.byId)
      .filter(
        (t) => !placed.has(t.session_id) && (t.created_unix === 0 || t.created_unix <= cutoff),
      )
      .sort((a, b) => a.created_unix - b.created_unix);
  });

  async function closeOrphan(sessionId: string): Promise<void> {
    try {
      await invoke("terminal_kill", { sessionId });
    } catch (e) {
      console.warn("[top-row] terminal_kill (orphan) failed", e);
    }
  }

  async function closeAllOrphans(): Promise<void> {
    const ids = orphanedSessions().map((t) => t.session_id);
    let killed = 0;
    for (const id of ids) {
      try {
        await invoke("terminal_kill", { sessionId: id });
        killed += 1;
      } catch (e) {
        console.warn("[top-row] terminal_kill (orphan) failed", e);
      }
    }
    setOrphanSweepResult({ count: killed, ids });
  }

  // Attention rail pin: the rail anchors off the awaiting counter as a
  // click-to-open Popover. Default-open whenever something is waiting so the
  // user lands in mission-control without a click; they can dismiss it and it
  // stays closed until the next time `waitingCount` rises from zero.
  const [railOpen, setRailOpen] = createSignal(false);
  // Drive the pin off the FULL attention queue (waiting + errored +
  // completed-unread), not just `waitingCount` — otherwise an agent that
  // ERRORS populates the rail but never auto-surfaces it, and a failed agent
  // sits unseen behind a "0" badge, undercutting the who-needs-me promise.
  const attentionCount = createMemo(() => attentionQueue().length);
  let prevAttention = 0;
  createEffect(() => {
    const n = attentionCount();
    if (n > 0 && prevAttention === 0) setRailOpen(true);
    if (n === 0) setRailOpen(false);
    prevAttention = n;
  });

  // Round-robin cursor for "focus-next-waiting": each press advances through
  // the wait-duration-sorted queue (oldest-blocked first). Stored as the last
  // focused session id rather than an index so list churn between presses
  // doesn't skip or repeat an entry.
  const [lastFocusedWaitingId, setLastFocusedWaitingId] = createSignal<string | null>(null);
  function focusNextWaiting(): void {
    const queue = waitingByBlockedLongest();
    if (queue.length === 0) return;
    const last = lastFocusedWaitingId();
    const lastIdx = last ? queue.findIndex((s) => s.session_id === last) : -1;
    const next = queue[(lastIdx + 1) % queue.length]!;
    const id = next.session_id;
    if (!id) return;
    setLastFocusedWaitingId(id);
    window.dispatchEvent(
      new CustomEvent("terminal-focus-requested", { detail: { sessionId: id } }),
    );
  }

  const [compactTabs, setCompactTabs] = createSignal(false);
  let tabsScrollRef: HTMLElement | undefined;
  let headerRef: HTMLElement | undefined;
  let leftSectionRef: HTMLDivElement | undefined;
  let rightSectionRef: HTMLDivElement | undefined;
  // Remember tabs' natural full-mode width so we can evaluate whether full mode
  // would still fit even while we're currently rendering in compact mode.
  let lastFullTabsWidth = 0;

  // Top-bar search input — controlled so we can clear it when the spotlight closes.
  const [topBarSearchValue, setTopBarSearchValue] = createSignal("");
  let topBarInputEl: HTMLInputElement | undefined;
  let topBarBlurTimer: ReturnType<typeof setTimeout> | null = null;

  // Clear and blur the top-bar input whenever the spotlight closes (e.g. user
  // hits Esc, activates a result, or toggles via ⌘F).
  createEffect(() => {
    if (!spotlightOpen()) {
      setTopBarSearchValue("");
      topBarInputEl?.blur();
    }
  });

  onCleanup(() => {
    if (topBarBlurTimer !== null) clearTimeout(topBarBlurTimer);
  });

  onMount(() => {
    let unlistenProject: UnlistenFn | undefined;
    let unlistenAgent: UnlistenFn | undefined;
    let unlistenTerminal: UnlistenFn | undefined;
    let unlistenBranches: UnlistenFn | undefined;
    let unlistenWorktreeStatus: UnlistenFn | undefined;
    let unlistenMenu: UnlistenFn | undefined;
    let unlistenPaneActivity: UnlistenFn | undefined;
    let unlistenReviewLinks: UnlistenFn | undefined;
    let unlistenCliOpen: UnlistenFn | undefined;

    listen<string>("menu-action", (ev) => {
      if (ev.payload === "open-settings") {
        openAppSettings();
      } else if (ev.payload === "check-updates") {
        void runUpdateCheck({ interactive: true });
      } else if (ev.payload === "install-cli") {
        void invoke<{ path: string; onPath: boolean }>("cli_install_shim")
          .then((res) => {
            if (res.onPath) {
              toast.success("Installed 'raum' command", {
                description: `${res.path} — run \`raum <dir>\` to open a project from the terminal.`,
              });
            } else {
              toast.warning("Installed 'raum' — add it to your PATH", {
                description: `${res.path} is not on your PATH. Add its directory to PATH, then run \`raum <dir>\`.`,
              });
            }
          })
          .catch((e) => {
            toast.error("Couldn't install 'raum' command", {
              description: e instanceof Error ? e.message : String(e),
            });
          });
      }
    })
      .then((u) => {
        unlistenMenu = u;
      })
      .catch(() => {
        /* Tauri context unavailable (tests). */
      });

    // Deep link to a settings tab (e.g. the update toast's "Install…" action).
    const onOpenSettings = (ev: Event) => {
      openAppSettings((ev as CustomEvent<OpenSettingsDetail>).detail?.section);
    };
    window.addEventListener("raum:open-settings", onOpenSettings);

    subscribeProjectEvents()
      .then((u) => {
        unlistenProject = u;
      })
      .catch(() => {
        /* Tauri context unavailable (tests). */
      });
    subscribeAgentEvents()
      .then((u) => {
        unlistenAgent = u;
      })
      .catch(() => {
        /* Tauri context unavailable (tests). */
      });
    subscribeTerminalEvents()
      .then((u) => {
        unlistenTerminal = u;
      })
      .catch(() => {
        /* Tauri context unavailable (tests). */
      });
    subscribeReviewLinkEvents()
      .then((u) => {
        unlistenReviewLinks = u;
      })
      .catch(() => {
        /* Tauri context unavailable (tests). */
      });
    subscribePaneActivity()
      .then((u) => {
        unlistenPaneActivity = u;
      })
      .catch(() => {
        /* Tauri context unavailable (tests). */
      });
    // Start the inactivity auto-dock clock (the effects are already live from
    // module import; this just starts time moving so an idle app still docks
    // tabs once they cross the threshold). No-op unless the setting is enabled.
    startTerminalAutoDock();

    // Terminal launcher (`raum <dir>`), already-running case: a second
    // invocation emits this with the resolved absolute directory path.
    listen<string>("cli-open-project", (ev) => {
      void handleCliOpen(ev.payload);
    })
      .then((u) => {
        unlistenCliOpen = u;
      })
      .catch(() => {
        /* Tauri context unavailable (tests). */
      });

    void refreshProjects().then(() => {
      // Cold-start case: drain the directory captured before the window
      // mounted. After the project list is loaded so an existing project is
      // recognised rather than re-prompted.
      void invoke<string | null>("cli_take_pending_open")
        .then((path) => {
          if (path) void handleCliOpen(path);
        })
        .catch(() => {
          /* Tauri context unavailable (tests). */
        });
    });
    // Atomic rehydration: seed both stores from a single snapshot so
    // memos don't render `0 0 0` for the window between `refreshAgents`
    // and `refreshTerminals` settling. Subscriptions above attach
    // first, so any `agent-state-changed` / `terminal-session-upserted`
    // event that races the snapshot still lands on the fresh state
    // (listeners apply the transition; `reconcile` in setAdapters /
    // setTerminals is idempotent when the snapshot repeats it).
    void invoke<{ agents: AgentListItem[]; terminals: TerminalListItem[] }>("agent_snapshot")
      .then((snap) => {
        setAdapters(snap.agents);
        setTerminals(snap.terminals);
        seedLastPromptsFromAgents(snap.agents);
      })
      .catch((e) => {
        // Fallback for older backends / test harnesses without the
        // snapshot command: fall back to the two-invoke path.
        console.warn("agent_snapshot failed, falling back", e);
        void refreshAgents()
          .catch(() => {
            /* fall through to terminal refresh */
          })
          .then(() => refreshTerminals())
          .catch(() => {
            /* Tauri context unavailable (tests). */
          });
      });

    // Reconcile the live tmux socket with raum's records on (re)mount. The
    // Rust bootstrap reconciles once per process; a Cmd+R webview reload does
    // NOT re-run it, so without this an orphan that appeared mid-session would
    // never surface after a reload. `terminal_reconcile` adopts any unknown
    // live session and emits upserts; refresh once after so the list settles.
    void invoke("terminal_reconcile")
      .then(() => refreshTerminals())
      .catch(() => {
        /* Tauri context unavailable (tests) / older backend. */
      });
    subscribeWorktreeBranchEvents()
      .then((u) => {
        unlistenBranches = u;
      })
      .catch(() => {
        /* Tauri context unavailable (tests). */
      });
    subscribeWorktreeStatusEvents()
      .then((u) => {
        unlistenWorktreeStatus = u;
      })
      .catch(() => {
        /* Tauri context unavailable (tests). */
      });

    onCleanup(() => {
      unlistenProject?.();
      unlistenAgent?.();
      unlistenTerminal?.();
      unlistenBranches?.();
      unlistenWorktreeStatus?.();
      unlistenMenu?.();
      unlistenPaneActivity?.();
      unlistenReviewLinks?.();
      unlistenCliOpen?.();
      window.removeEventListener("raum:open-settings", onOpenSettings);
    });
  });

  // Measure the actual widths of every header section and decide whether the
  // full-mode tab row would fit. This is more accurate than hardcoded
  // thresholds because it accounts for the user's real project names, icon
  // set, and search-box width — exactly the signal that determines whether
  // the RIGHT section is about to get pushed off-screen.
  const estimateFullTabsWidth = () => {
    // Fallback when no prior measurement exists (app just launched in compact).
    // Estimates per-tab width from the actual project name length: sigil (28)
    // + padding/gap (~44) + name text at monospace ~8px/char + branch badge (~48).
    let total = 0;
    const shown = visibleProjects();
    for (const p of shown) {
      const nameLen = (p.name || p.slug).length;
      total += 28 + 44 + nameLen * 8 + 48;
    }
    // inter-tab gap-0.5 (2px) + trailing "+" add-project button (~28px)
    return total + Math.max(0, shown.length - 1) * 2 + 28;
  };

  const evaluateCompact = () => {
    if (!headerRef || !leftSectionRef || !rightSectionRef || !tabsScrollRef) {
      return;
    }
    const tabCount = visibleProjects().length;
    if (tabCount === 0) return;
    const headerWidth = headerRef.clientWidth;
    const leftWidth = leftSectionRef.scrollWidth;
    const rightWidth = rightSectionRef.scrollWidth;
    // If currently rendering full mode, the tabs' scrollWidth IS the natural
    // full width — capture it. In compact mode fall back to the last captured
    // value, or to a size-based estimate when we've never seen full mode.
    let tabsWidth: number;
    if (!compactTabs()) {
      tabsWidth = tabsScrollRef.scrollWidth;
      lastFullTabsWidth = tabsWidth;
    } else {
      tabsWidth = lastFullTabsWidth > 0 ? lastFullTabsWidth : estimateFullTabsWidth();
    }
    // grid gap-2 between header columns = 16px.
    const GAPS = 16;
    const requiredForFull = leftWidth + tabsWidth + rightWidth + GAPS;
    if (!compactTabs() && requiredForFull > headerWidth) {
      setCompactTabs(true);
    } else if (compactTabs() && requiredForFull + 40 <= headerWidth) {
      // Small buffer (40px) prevents flicker right at the threshold.
      setCompactTabs(false);
    }
  };

  onMount(() => {
    if (!headerRef || typeof ResizeObserver === "undefined") return;
    const obs = new ResizeObserver(evaluateCompact);
    obs.observe(headerRef);
    onCleanup(() => obs.disconnect());
  });

  // Re-evaluate when the visible tab set changes — ResizeObserver won't fire
  // since the center section's width doesn't change with tab count.
  createEffect(() => {
    void visibleProjects().length;
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(evaluateCompact);
    } else {
      evaluateCompact();
    }
  });

  createEffect(() => {
    const slug = activeProjectSlug();
    if (!tabsScrollRef || !slug) return;
    const el = tabsScrollRef.querySelector<HTMLElement>(`[data-project-slug="${slug}"]`);
    el?.scrollIntoView({ inline: "nearest", block: "nearest" });
  });

  createEffect(() => {
    const slug = activeProjectSlug();
    const color = slug ? projectBySlug().get(slug)?.color : undefined;
    if (color) {
      document.documentElement.style.setProperty("--project-accent", color);
    }
  });

  onMount(() => {
    const unregs: Array<() => void> = [];
    unregs.push(keymap.register("cycle-tab-next", cycleTab(1)));
    unregs.push(keymap.register("cycle-tab-prev", cycleTab(-1)));
    unregs.push(keymap.register("select-filter-active", () => setSelectedFilter("active")));
    unregs.push(
      keymap.register("select-filter-needs-input", () => setSelectedFilter("needs-input")),
    );
    unregs.push(keymap.register("select-filter-recent", () => setSelectedFilter("recent")));
    for (let i = 1; i <= 9; i++) {
      const idx = i - 1;
      unregs.push(
        keymap.register(`select-project-${i}`, () => {
          const target = visibleProjects()[idx];
          if (target) {
            setActiveProjectSlug(target.slug);
            setSelectedFilter("active");
          }
        }),
      );
    }
    for (const def of SPAWN_DEFS) {
      unregs.push(keymap.register(def.action, () => void spawn(def.kind)));
    }
    // FLEET mission-control hotkeys.
    unregs.push(keymap.register("focus-next-waiting", () => focusNextWaiting()));
    unregs.push(keymap.register("toggle-broadcast", () => toggleBroadcast()));
    // First-run CTA: the empty grid's "Add a project" button (TerminalGrid)
    // dispatches this event; open the Add-Project modal in response so the
    // button is functional from a zero-project cold start.
    const onAddProjectRequested = (): void => {
      setModalOpen(true);
    };
    window.addEventListener("raum:add-project-requested", onAddProjectRequested);
    unregs.push(() =>
      window.removeEventListener("raum:add-project-requested", onAddProjectRequested),
    );
    onCleanup(() => {
      for (const fn of unregs) fn();
    });
  });

  function cycleTab(dir: 1 | -1): () => void {
    return () => {
      const items = visibleProjects();
      if (items.length === 0) return;
      const current = activeProjectSlug();
      const idx = items.findIndex((p) => p.slug === current);
      const next = idx === -1 ? 0 : (idx + dir + items.length) % items.length;
      setActiveProjectSlug(items[next]!.slug);
      setSelectedFilter("active");
    };
  }

  function spawn(kind: SpawnKind) {
    const slug = activeProjectSlug();
    if (kind !== "shell" && !slug) {
      setModalOpen(true);
      return;
    }
    const worktreeId = slug ? resolveSpawnWorktree(slug) : undefined;
    window.dispatchEvent(
      new CustomEvent("raum:spawn-requested", {
        detail: { kind, projectSlug: slug, worktreeId },
      }),
    );
  }

  async function removeProjectFlow(project: ProjectListItem) {
    setConfirmRemove(undefined);
    try {
      const terminals =
        await invoke<Array<{ session_id: string; project_slug: string | null }>>("terminal_list");
      for (const t of terminals) {
        if (t.project_slug === project.slug) {
          try {
            await invoke("terminal_kill", { sessionId: t.session_id });
          } catch (e) {
            console.warn("terminal_kill failed", e);
          }
        }
      }
      await invoke("project_remove", { slug: project.slug });
      await refreshProjects();
    } catch (e) {
      console.warn("project_remove failed", e);
    }
  }

  // Bring a suspended/shelved (or freshly-registered) project into the
  // foreground: make it active AND drop any cross-project spotlight / non-active
  // filter, mirroring a normal tab click. Without the filter+spotlight reset the
  // grid would keep painting the previous (cross-project) view and the project
  // the user just reopened would never actually surface.
  function reopenAndFocus(slug: string): void {
    reopenProject(slug);
    setSelectedFilter("active");
    setCrossProjectViewMode(null);
  }

  // Toggle a cross-project view from a clickable counter on the right side of
  // the header. Re-clicking the active mode returns to the single-project grid.
  function toggleCrossProjectView(mode: CrossProjectViewMode) {
    const next = crossProjectViewMode() === mode ? null : mode;
    if (next) markStart(`filter-click:${next}`);
    setCrossProjectViewMode(next);
  }

  return (
    <>
      <header
        data-tauri-drag-region
        ref={(el) => (headerRef = el)}
        class="grid h-10 shrink-0 select-none grid-cols-[auto_1fr_auto] items-center gap-2 bg-background px-3 text-sm"
      >
        {/* LEFT — window controls + brand + spawn icons */}
        <div
          data-tauri-drag-region
          ref={(el) => (leftSectionRef = el)}
          class={`flex items-center gap-1.5 justify-self-start${isMacOS ? " pl-[72px]" : ""}`}
        >
          <Show when={!isMacOS}>
            <div class="group mr-1.5 flex items-center gap-2">
              <button
                type="button"
                aria-label="Close window"
                class="size-3 focus-visible:outline-none"
                onClick={() => void getCurrentWindow().close()}
              >
                <svg viewBox="0 0 85.4 85.4" class="size-full" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="42.7" cy="42.7" r="42.7" fill="#e24b41" />
                  <circle cx="42.7" cy="42.7" r="39.1" fill="#ed6a5f" />
                  <g
                    class="opacity-0 transition-opacity group-hover:opacity-100"
                    fill="#460804"
                    fill-rule="evenodd"
                    clip-rule="evenodd"
                  >
                    <path d="m22.5 57.8 35.3-35.3c1.4-1.4 3.6-1.4 5 0l.1.1c1.4 1.4 1.4 3.6 0 5l-35.3 35.3c-1.4 1.4-3.6 1.4-5 0l-.1-.1c-1.3-1.4-1.3-3.6 0-5z" />
                    <path d="m27.6 22.5 35.3 35.3c1.4 1.4 1.4 3.6 0 5l-.1.1c-1.4 1.4-3.6 1.4-5 0l-35.3-35.3c-1.4-1.4-1.4-3.6 0-5l.1-.1c1.4-1.3 3.6-1.3 5 0z" />
                  </g>
                </svg>
              </button>

              <button
                type="button"
                aria-label="Minimize window"
                class="size-3 focus-visible:outline-none"
                onClick={() => void getCurrentWindow().minimize()}
              >
                <svg viewBox="0 0 85.4 85.4" class="size-full" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="42.7" cy="42.7" r="42.7" fill="#e1a73e" />
                  <circle cx="42.7" cy="42.7" r="39.1" fill="#f6be50" />
                  <path
                    class="opacity-0 transition-opacity group-hover:opacity-100"
                    d="m17.8 39.1h49.9c1.9 0 3.5 1.6 3.5 3.5v.1c0 1.9-1.6 3.5-3.5 3.5h-49.9c-1.9 0-3.5-1.6-3.5-3.5v-.1c0-1.9 1.5-3.5 3.5-3.5z"
                    fill="#90591d"
                    fill-rule="evenodd"
                    clip-rule="evenodd"
                  />
                </svg>
              </button>

              <button
                type="button"
                aria-label="Maximize window"
                class="size-3 focus-visible:outline-none"
                onClick={() => void getCurrentWindow().toggleMaximize()}
              >
                <svg viewBox="0 0 85.4 85.4" class="size-full" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="42.7" cy="42.7" r="42.7" fill="#2dac2f" />
                  <circle cx="42.7" cy="42.7" r="39.1" fill="#61c555" />
                  <path
                    class="opacity-0 transition-opacity group-hover:opacity-100"
                    d="m54.2 20.8h-26.7c-3.6 0-6.5 2.9-6.5 6.5v26.7zm-23.2 43.7h26.8c3.6 0 6.5-2.9 6.5-6.5v-26.8z"
                    fill="#2a6218"
                    fill-rule="evenodd"
                    clip-rule="evenodd"
                  />
                </svg>
              </button>
            </div>
          </Show>
          <RaumLogo
            class="mr-1 size-5 shrink-0 cursor-default"
            onContextMenu={(e) => {
              // Right-click the brand logo to open the WebView devtools.
              // Global contextmenu suppressor still owns regular right-clicks
              // everywhere else; this stays reachable because the handler
              // bypasses preventDefault by invoking explicitly, and the
              // suppressor never stops propagation.
              e.preventDefault();
              e.stopPropagation();
              void invoke("open_devtools").catch((err) => {
                console.warn("open_devtools invoke failed", err);
              });
            }}
          />
          <button
            type="button"
            aria-label="Open settings"
            class="focus-ring rounded-sm p-1 text-foreground-subtle hover:bg-hover hover:text-foreground"
            onClick={() => openAppSettings()}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="size-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Edit keyboard shortcuts"
            class="focus-ring rounded-sm p-1 text-foreground-subtle hover:bg-hover hover:text-foreground"
            onClick={() => setKeymapSettingsOpen(true)}
          >
            <KeyboardIcon class="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Toggle sidebar"
            class="focus-ring rounded-sm p-1 text-foreground-subtle hover:bg-hover hover:text-foreground"
            onClick={() => toggleSidebarHidden()}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="size-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" />
            </svg>
          </button>
          <Show when={import.meta.env.DEV}>
            <Tooltip>
              <TooltipTrigger
                as="button"
                type="button"
                aria-label="Replay onboarding wizard (dev only)"
                class="focus-ring rounded-sm p-1 text-foreground-subtle hover:bg-hover hover:text-foreground"
                onClick={() => setPreviewOnboarding(true)}
                data-testid="dev-replay-onboarding"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="size-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v5h5" />
                </svg>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent>Replay onboarding (dev)</TooltipContent>
              </TooltipPortal>
            </Tooltip>
          </Show>
          <div aria-hidden="true" class="mx-1 h-4 w-px shrink-0 bg-border" />
          <For each={SPAWN_DEFS}>
            {(def) => {
              const Icon = HARNESS_ICONS[def.kind];
              return (
                <Tooltip>
                  <TooltipTrigger
                    as={Button}
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    class="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => void spawn(def.kind)}
                    aria-label={`Spawn ${def.label}`}
                    data-testid={`spawn-${def.kind}`}
                  >
                    <Icon class="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPortal>
                    <TooltipContent>
                      Spawn {def.label}
                      <Show when={keymap.accelerator(def.action)}>
                        <span class="ml-1 opacity-70">
                          ({prettifyAccel(keymap.accelerator(def.action))})
                        </span>
                      </Show>
                    </TooltipContent>
                  </TooltipPortal>
                </Tooltip>
              );
            }}
          </For>
        </div>

        {/* CENTER — project tabs (scrollable). The inner flex wrapper +
            `min-w-0` lets the tabs column shrink below its natural content
            width, at which point the `Scrollable` host caps at `max-w-full`
            and scrolls inside. */}
        <div data-tauri-drag-region class="flex min-w-0 items-center justify-center">
          <Scrollable axis="x" class="max-w-full" hideScrollbar>
            <nav
              data-tauri-drag-region
              ref={(el) => (tabsScrollRef = el)}
              class="flex flex-none items-stretch gap-0.5"
              aria-label="Projects"
              data-testid="project-tabs"
            >
              <For each={visibleProjects()}>
                {(project) => (
                  <ProjectTab
                    project={project}
                    active={activeProjectSlug() === project.slug}
                    compact={compactTabs()}
                    onSelect={() => {
                      markStart("project-switch:active");
                      setActiveProjectSlug(project.slug);
                      setSelectedFilter("active");
                      setCrossProjectViewMode(null);
                    }}
                    onRemove={() => setConfirmRemove(project)}
                    onHide={() => void setProjectHidden(project.slug, true)}
                  />
                )}
              </For>
              <DropdownMenu>
                <DropdownMenuTrigger
                  as={Button}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  class="h-7 w-7 text-muted-foreground hover:text-foreground"
                  aria-label="Add or reopen projects"
                  data-testid="add-project-button"
                >
                  <PlusIcon class="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuContent class="min-w-52">
                    <DropdownMenuItem onSelect={() => setModalOpen(true)}>
                      <PlusIcon class="size-3.5" />
                      New project…
                    </DropdownMenuItem>
                    <Show when={otherProjects().length > 0}>
                      <DropdownMenuSeparator />
                      <div class="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                        Other projects
                      </div>
                      <For each={otherProjects()}>
                        {(project) => (
                          <DropdownMenuItem onSelect={() => reopenAndFocus(project.slug)}>
                            <span class="font-mono" style={{ color: project.color }}>
                              {project.sigil}
                            </span>
                            <span class="truncate">{project.name || project.slug}</span>
                          </DropdownMenuItem>
                        )}
                      </For>
                    </Show>
                  </DropdownMenuContent>
                </DropdownMenuPortal>
              </DropdownMenu>
            </nav>
          </Scrollable>
        </div>

        {/* RIGHT — search input + status counters */}
        <div
          data-tauri-drag-region
          ref={(el) => (rightSectionRef = el)}
          class="flex items-center gap-2 justify-self-end"
        >
          {/* Separate the center filter nav from the search input so their
              adjacent clock/search icons don't visually merge. */}
          <div aria-hidden="true" class="h-4 w-px bg-border" />
          {/* Inline search affordance — clicking or typing opens the spotlight */}
          <div class="flex items-center gap-1.5 h-7 rounded-md bg-selected px-2 cursor-text transition-colors">
            <SearchIcon class="size-3 shrink-0 text-muted-foreground/40" />
            <input
              ref={(el) => (topBarInputEl = el)}
              type="text"
              placeholder="type or press ⌘F"
              data-testid="search-input-affordance"
              class="w-36 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
              value={topBarSearchValue()}
              onInput={(e) => {
                const v = e.currentTarget.value;
                setTopBarSearchValue(v);
                setTopBarQuery(v);
              }}
              onBlur={() => {
                topBarBlurTimer = setTimeout(() => {
                  topBarBlurTimer = null;
                  closeSpotlight();
                }, 150);
              }}
              onFocus={() => {
                if (topBarBlurTimer !== null) {
                  clearTimeout(topBarBlurTimer);
                  topBarBlurTimer = null;
                }
              }}
            />
          </div>

          <div
            data-tauri-drag-region
            class="flex items-center gap-0.5 rounded-md px-1 py-0.5 text-[10px]"
            data-testid="harness-counters"
          >
            {/* Working — toggles the cross-project working view */}
            {(() => {
              const active = () => crossProjectViewMode() === "working";
              return (
                <Tooltip>
                  <TooltipTrigger
                    as="button"
                    type="button"
                    class="inline-flex items-center gap-1 rounded px-1 py-0.5 font-mono transition-colors"
                    classList={{
                      "bg-selected text-foreground": active(),
                      "text-success": !active() && activeCount() > 0,
                      "text-muted-foreground hover:text-foreground":
                        !active() && activeCount() === 0,
                    }}
                    onClick={() => toggleCrossProjectView("working")}
                    aria-pressed={active()}
                    aria-label="Show working across projects"
                    data-testid="active-count"
                  >
                    <Show when={activeCount() > 0} fallback={<ActivityIcon class="size-3" />}>
                      <LoaderIcon class="size-3 animate-spin" />
                    </Show>
                    {activeCount()}
                  </TooltipTrigger>
                  <TooltipPortal>
                    <TooltipContent>
                      {active() ? "Hide" : "Show"} {activeCount()} working harness
                      {activeCount() === 1 ? "" : "es"} across projects
                    </TooltipContent>
                  </TooltipPortal>
                </Tooltip>
              );
            })()}

            {/* Awaiting — the trigger doubles as the attention-rail anchor.
                Left-click pins the rail (mission control); the small caret
                toggles the cross-project awaiting view so both affordances
                stay reachable from one compact control. */}
            {(() => {
              const active = () => crossProjectViewMode() === "awaiting";
              const has = () => attentionCount() > 0;
              return (
                <Popover open={railOpen()} onOpenChange={setRailOpen}>
                  <div
                    class="inline-flex items-center gap-0.5 rounded-md transition-colors"
                    classList={{
                      "bg-selected": active(),
                      "bg-warning/15": !active() && has(),
                    }}
                  >
                    <PopoverTrigger
                      as="button"
                      type="button"
                      class="inline-flex items-center gap-1 rounded-l-md px-1.5 py-0.5 text-[10px] font-medium transition-colors"
                      classList={{
                        "text-foreground": active(),
                        "text-warning animate-pulse": !active() && has(),
                        "text-muted-foreground hover:text-foreground font-mono":
                          !active() && !has(),
                      }}
                      aria-label="Open attention rail"
                      data-testid="waiting-count"
                    >
                      <AlertCircleIcon class={has() ? "size-3.5 shrink-0" : "size-3 shrink-0"} />
                      <Show when={has()} fallback={<>0</>}>
                        {attentionCount()} need attention
                      </Show>
                    </PopoverTrigger>
                    {/* Caret: cross-project awaiting view toggle (the legacy
                        behaviour). Kept distinct from the rail trigger. */}
                    <button
                      type="button"
                      class="rounded-r-md px-0.5 py-0.5 text-[10px] transition-colors"
                      classList={{
                        "text-foreground": active(),
                        "text-warning": !active() && has(),
                        "text-muted-foreground hover:text-foreground": !active() && !has(),
                      }}
                      onClick={() => toggleCrossProjectView("awaiting")}
                      aria-pressed={active()}
                      aria-label="Show awaiting across projects"
                      data-testid="awaiting-view-toggle"
                    >
                      <ActivityIcon class="size-2.5" />
                    </button>
                  </div>
                  <PopoverPortal>
                    <PopoverContent class="w-80 p-1" data-testid="attention-rail-popover">
                      <AttentionRail onClose={() => setRailOpen(false)} />
                    </PopoverContent>
                  </PopoverPortal>
                </Popover>
              );
            })()}

            {/* Synchronize input (broadcast) — mirror keystrokes from the
                focused pane to the synced set. The toggle exposes the scope
                picker on its caret so the user can target all-visible /
                active-project / manual sets. The visible synced-set count
                doubles as the obviousness affordance the contract calls for. */}
            {(() => {
              const on = () => broadcastActive();
              const count = () => (on() ? broadcastMemberIds().length : 0);
              const scopeLabel = (s: BroadcastScope): string =>
                s === "all-visible"
                  ? "All visible"
                  : s === "active-project"
                    ? "Active project"
                    : "Manual";
              return (
                <Popover>
                  <div
                    class="inline-flex items-center gap-0.5 rounded-md transition-colors"
                    classList={{ "bg-primary/15": on() }}
                    data-broadcast-active={on() ? "true" : undefined}
                  >
                    <Tooltip>
                      <TooltipTrigger
                        as="button"
                        type="button"
                        class="inline-flex items-center gap-1 rounded-l-md px-1.5 py-0.5 font-mono text-[10px] transition-colors"
                        classList={{
                          "text-primary": on(),
                          "text-muted-foreground hover:text-foreground": !on(),
                        }}
                        onClick={() => toggleBroadcast()}
                        aria-pressed={on()}
                        aria-label="Toggle synchronize input"
                        data-testid="broadcast-toggle"
                      >
                        {/* Concentric-ring "broadcast" glyph. */}
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          class="size-3 shrink-0"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <circle cx="12" cy="12" r="2" />
                          <path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14" />
                        </svg>
                        <Show when={on()}>
                          <span class="tabular-nums">{count()}</span>
                        </Show>
                      </TooltipTrigger>
                      <TooltipPortal>
                        <TooltipContent>
                          {on() ? `Synchronizing input → ${count()} panes` : "Synchronize input"}
                          <Show when={keymap.accelerator("toggle-broadcast")}>
                            <span class="ml-1 opacity-70">
                              ({prettifyAccel(keymap.accelerator("toggle-broadcast"))})
                            </span>
                          </Show>
                        </TooltipContent>
                      </TooltipPortal>
                    </Tooltip>
                    <PopoverTrigger
                      as="button"
                      type="button"
                      class="rounded-r-md px-0.5 py-0.5 text-[10px] transition-colors"
                      classList={{
                        "text-primary": on(),
                        "text-muted-foreground hover:text-foreground": !on(),
                      }}
                      aria-label="Broadcast scope"
                      data-testid="broadcast-scope"
                    >
                      <ChevronDownIcon class="size-2.5" />
                    </PopoverTrigger>
                  </div>
                  <PopoverPortal>
                    <PopoverContent class="w-48 p-1 text-xs">
                      <div class="mb-1 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                        Synchronize scope
                      </div>
                      <For each={BROADCAST_SCOPES}>
                        {(s) => (
                          <button
                            type="button"
                            class="flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-hover"
                            onClick={() => setBroadcastScope(s)}
                          >
                            <span>{scopeLabel(s)}</span>
                            <Show when={broadcastScope() === s}>
                              <CheckIcon class="size-3 text-primary" />
                            </Show>
                          </button>
                        )}
                      </For>
                    </PopoverContent>
                  </PopoverPortal>
                </Popover>
              );
            })()}

            {/* Completed — toggles the cross-project completed view; hover-card
                hosts the orphan-sweep tooling. */}
            {(() => {
              const active = () => crossProjectViewMode() === "completed";
              return (
                <HoverCard>
                  <HoverCardTrigger
                    as="button"
                    type="button"
                    class="inline-flex items-center gap-1 rounded px-1 py-0.5 font-mono transition-colors"
                    classList={{
                      "bg-selected text-foreground": active(),
                      "text-muted-foreground hover:text-foreground": !active(),
                    }}
                    onClick={() => toggleCrossProjectView("completed")}
                    aria-pressed={active()}
                    aria-label="Show completed across projects"
                    data-testid="done-count"
                  >
                    <CheckIcon class="size-3" />
                    {idleCount()}
                  </HoverCardTrigger>
                  <HoverCardPortal>
                    <HoverCardContent class="w-72 p-2 text-xs">
                      <div class="text-foreground/90">
                        {idleCount()} completed harness{idleCount() === 1 ? "" : "es"}
                      </div>
                      {/* Orphaned sessions: live tmux sessions raum tracks but
                          which aren't placed in any pane — the "harnesses I
                          can't see". Each row closes via `terminal_kill`. */}
                      <Show when={orphanedSessions().length > 0}>
                        <div class="mt-2 border-t border-border pt-2">
                          <div class="mb-1 flex items-center justify-between gap-2">
                            <span class="text-foreground/90">
                              {orphanedSessions().length} orphaned session
                              {orphanedSessions().length === 1 ? "" : "s"}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              class="h-6 px-2 text-[11px]"
                              onClick={() => void closeAllOrphans()}
                            >
                              Close all
                            </Button>
                          </div>
                          <p class="mb-1.5 text-[10px] leading-snug text-muted-foreground">
                            Live tmux sessions with no pane in your layout. Closing kills the tmux
                            session and removes it.
                          </p>
                          <ul class="max-h-48 space-y-0.5 overflow-y-auto">
                            <For each={orphanedSessions()}>
                              {(t) => {
                                const Icon =
                                  HARNESS_ICONS[t.kind as HarnessIconKind] ??
                                  HARNESS_ICONS["shell" as HarnessIconKind];
                                return (
                                  <li class="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-selected/50">
                                    <Icon class="size-3 shrink-0" />
                                    <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                                      {t.project_slug ?? "—"} · {t.session_id}
                                    </span>
                                    <button
                                      type="button"
                                      class="shrink-0 rounded px-1 text-[10px] text-muted-foreground transition-colors hover:text-destructive"
                                      onClick={() => void closeOrphan(t.session_id)}
                                      aria-label={`Close ${t.session_id}`}
                                    >
                                      Close
                                    </button>
                                  </li>
                                );
                              }}
                            </For>
                          </ul>
                        </div>
                      </Show>
                      <Show when={idleCount() === 0 && orphanedSessions().length === 0}>
                        <p class="mt-1 text-[10px] leading-snug text-muted-foreground">
                          No completed or orphaned sessions.
                        </p>
                      </Show>
                    </HoverCardContent>
                  </HoverCardPortal>
                </HoverCard>
              );
            })()}
          </div>
        </div>
      </header>

      <AddProjectModal
        open={modalOpen()}
        initialRootPath={pendingAddProjectPath()}
        onRegistered={(p) => reopenAndFocus(p.slug)}
        onClose={() => {
          setModalOpen(false);
          clearPendingAddProject();
        }}
      />

      <Dialog
        open={!!confirmRemove()}
        onOpenChange={(isOpen) => {
          if (!isOpen) setConfirmRemove(undefined);
        }}
      >
        <DialogPortal>
          <DialogContent showCloseButton={false} class="sm:max-w-[420px]">
            <Show when={confirmRemove()}>
              {(project) => (
                <>
                  <DialogHeader>
                    <DialogTitle>Remove project?</DialogTitle>
                    <DialogDescription>
                      This removes <strong>{project().name || project().slug}</strong> from raum,
                      kills its tmux sessions, and never touches <code>.raum.toml</code> or the repo
                      on disk.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmRemove(undefined)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => void removeProjectFlow(project())}
                    >
                      Remove
                    </Button>
                  </DialogFooter>
                </>
              )}
            </Show>
          </DialogContent>
        </DialogPortal>
      </Dialog>

      <SettingsModal
        open={appSettingsOpen()}
        initialSection={settingsInitialSection()}
        onClose={() => setAppSettingsOpen(false)}
      />

      <KeymapSettingsModal
        open={keymapSettingsOpen()}
        onClose={() => setKeymapSettingsOpen(false)}
      />

      <Dialog
        open={orphanSweepResult() !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setOrphanSweepResult(null);
        }}
      >
        <DialogPortal>
          <DialogContent showCloseButton={false} class="sm:max-w-[420px]">
            <Show when={orphanSweepResult()}>
              {(res) => (
                <>
                  <DialogHeader>
                    <DialogTitle>
                      <Show when={!res().error} fallback={<>Orphan sweep failed</>}>
                        Orphan sweep complete
                      </Show>
                    </DialogTitle>
                    <DialogDescription>
                      <Show
                        when={!res().error}
                        fallback={<span class="text-destructive">{res().error}</span>}
                      >
                        <Show
                          when={res().count > 0}
                          fallback={<>No orphan tmux sessions to kill.</>}
                        >
                          Killed {res().count} orphan tmux session
                          {res().count === 1 ? "" : "s"}.
                        </Show>
                      </Show>
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setOrphanSweepResult(null)}
                    >
                      OK
                    </Button>
                  </DialogFooter>
                </>
              )}
            </Show>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    </>
  );
};

export default TopRow;
