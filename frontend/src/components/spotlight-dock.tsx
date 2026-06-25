/**
 * Spotlight-style command dock.
 *
 * Triggered by `⌘F` (or `⌘.` for backwards compatibility). Shows recent
 * searches and all project harnesses when the input is empty; as the user
 * types, shows:
 *   - matching harness sessions (click → focus pane) — each row renders
 *     `<harness icon> <tab label> <project sigil> <project name> <state>`,
 *     reusing the tab-strip label so users never see the raw tmux session
 *     id,
 *   - scrollback matches across every live harness on every project — each
 *     row shows `<harness icon> <tab-label> <line-with-highlighted-match>`
 *     and activating one jumps to the owning project, focuses the pane,
 *     and scrolls xterm to the match when the hit came from xterm's own
 *     buffer (tmux-only hits just focus the pane),
 *   - project file matches across all worktrees of the active project
 *     (click → open in FileEditorModal).
 *
 * Keyboard nav: ↑/↓ to select, Enter to activate, Escape to close.
 */

import {
  Component,
  For,
  Match,
  Show,
  Suspense,
  Switch,
  type JSX,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  clearSpotlightPendingQuery,
  closeSpotlight,
  spotlightOpen,
  spotlightPendingQuery,
  spotlightTopBarDriven,
  spotlightTopBarQuery,
  toggleSpotlight,
} from "../lib/spotlightState";
import { addRecentSearch, clearRecentSearch, recentSearches } from "../lib/recentSearchStore";
import { listHarnessSessions } from "../stores/terminalStore";
import { activeProjectSlug, projectBySlug, setActiveProjectSlug } from "../stores/projectStore";
import { resolveSessionTabLabel } from "../lib/harnessTabLabel";
import { resolveSpawnWorktree } from "../lib/resolveSpawnWorktree";
import { useKeymap, useKeymapAction } from "../lib/keymapContext";
import {
  buildPreviewParts,
  runScrollbackSearch,
  type ScrollbackMatch,
} from "../lib/scrollbackSearch";
import { listTerminals, type TerminalBufferKind } from "../lib/terminalRegistry";
import {
  compactTree,
  equalizeAllRatios,
  focusedPaneId,
  tileAll,
  toggleMaximize,
} from "../stores/runtimeLayoutStore";
// STORE lane (lib/layoutPresets.ts) — imported by exact name; may not exist
// until that sibling lands. Listed as a consumed contract.
import { LAYOUT_PRESETS, applyLayoutPreset } from "../lib/layoutPresets";
import { setPreviewOnboarding } from "../lib/devOnboardingPreview";
import { emit as emitTauriEvent } from "@tauri-apps/api/event";
const FileEditorModal = lazy(() =>
  import("./file-editor-modal").then((m) => ({ default: m.FileEditorModal })),
);
import { Badge } from "./ui/badge";
import {
  ClockIcon,
  KeyboardIcon,
  PlayIcon,
  SearchIcon,
  HARNESS_ICONS,
  type HarnessIconKind,
} from "./icons";
import { Scrollable } from "./ui/scrollable";
import { FileTypeIcon } from "../lib/fileTypeIcon";
import type { Worktree } from "../stores/worktreeStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileHit {
  path: string;
  relPath: string;
  name: string;
  score: number;
}

interface WorktreeFileHit extends FileHit {
  worktreeBranch: string;
  worktreePath: string;
}

type RecentItem = { type: "recent"; query: string };
type HarnessItem = {
  type: "harness";
  sessionId: string;
  kind: HarnessIconKind;
  workingState: string;
  /** Same label the grid's tab strip shows for this session. */
  tabLabel: string;
  projectSlug: string | null;
  projectName: string | null;
  projectSigil: string | null;
};
type FileItem = { type: "file"; hit: WorktreeFileHit };
type ScrollbackItem = { type: "scrollback"; match: ScrollbackMatch };
/**
 * A runnable verb in the palette. Sourced from two places (see
 * `commandItems`): every rebindable keymap entry (so the palette doubles as a
 * shortcut launcher), plus a curated list of mouse-only actions that have no
 * accelerator. `run()` performs the action; `accelerator` is the live binding
 * shown as a trailing kbd (undefined for mouse-only verbs).
 */
type CommandItem = {
  type: "command";
  /** Stable id used as the fuzzy-match haystack key and dedupe key. */
  id: string;
  title: string;
  accelerator: string | undefined;
  run: () => void;
};
type ResultItem = RecentItem | HarnessItem | FileItem | ScrollbackItem | CommandItem;

// ---------------------------------------------------------------------------
// Command verbs
// ---------------------------------------------------------------------------

/** Spawn-harness verbs — dispatched as the same window event TopRow emits. */
const SPAWN_COMMAND_DEFS: { kind: string; label: string }[] = [
  { kind: "shell", label: "Spawn shell" },
  { kind: "claude-code", label: "Spawn Claude Code" },
  { kind: "codex", label: "Spawn Codex" },
  { kind: "opencode", label: "Spawn OpenCode" },
];

/**
 * Human-friendly titles for the keymap actions we surface as palette rows.
 * Actions not in this map are skipped — the keymap exposes low-level ids
 * (e.g. "focus-pane-left") that would just be noise in a command list, so we
 * opt actions in explicitly rather than dumping the whole table.
 */
const KEYMAP_COMMAND_TITLES: Record<string, string> = {
  "split-pane-right": "Split pane right",
  "split-pane-down": "Split pane down",
  "close-pane": "Close pane",
  "minimize-pane": "Minimize pane",
  "maximize-pane": "Maximize focused pane",
  "undo-layout": "Undo layout change",
  "new-worktree": "New worktree",
  // Intentionally omitted: "global-search" (the palette IS the search — a row
  // for it would close+reopen the dock and wipe the query), and
  // "switch-worktree" (no worktree-switcher UI exists yet, so the row + its
  // ⌘P accelerator are dead — surface it only once a handler is wired).
  "cheat-sheet": "Show keyboard shortcuts",
  "toggle-broadcast": "Toggle synchronize-input",
  "focus-next-waiting": "Focus next waiting harness",
  "reset-harness": "Reset harness",
};

/**
 * Lightweight subsequence fuzzy match: every char of `needle` must appear in
 * `haystack` in order. Returns a score (lower = better) favouring early/dense
 * matches, or -1 for no match. Mirrors the ordering the harness/file lists
 * already rely on (best first).
 */
function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let hi = 0;
  let score = 0;
  let prevMatch = -1;
  for (let ni = 0; ni < n.length; ni++) {
    const ch = n[ni]!;
    const found = h.indexOf(ch, hi);
    if (found === -1) return -1;
    // Penalise gaps between consecutive matched chars and a late first hit.
    if (prevMatch >= 0) score += found - prevMatch - 1;
    else score += found;
    prevMatch = found;
    hi = found + 1;
  }
  return score;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stateColor(state: string): string {
  if (state === "working") return "bg-success/20 text-success";
  if (state === "waiting") return "bg-warning/20 text-warning";
  return "bg-muted text-muted-foreground";
}

function stateLabel(state: string): string {
  if (state === "working") return "active";
  if (state === "waiting") return "waiting";
  return "idle";
}

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

/**
 * Pretty-print an accelerator string ("CmdOrCtrl+Shift+D") into platform
 * glyphs ("⌘⇧D" on macOS, "Ctrl+Shift+D" elsewhere). Self-contained so the
 * palette doesn't depend on the keymap-settings modal's internal helpers.
 */
function formatAccelerator(accel: string): string {
  const tokens = accel
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);
  const glyph = (t: string): string => {
    if (IS_MAC) {
      switch (t) {
        case "Meta":
        case "CmdOrCtrl":
        case "Cmd":
        case "Command":
          return "⌘";
        case "Ctrl":
        case "Control":
          return "⌃";
        case "Alt":
        case "Option":
          return "⌥";
        case "Shift":
          return "⇧";
      }
    }
    switch (t) {
      case "Meta":
      case "CmdOrCtrl":
      case "Cmd":
      case "Command":
        return IS_MAC ? "⌘" : "Ctrl";
      case "Control":
        return "Ctrl";
      case "Up":
        return "↑";
      case "Down":
        return "↓";
      case "Left":
        return "←";
      case "Right":
        return "→";
    }
    return t;
  };
  const parts = tokens.map(glyph);
  // macOS convention packs modifiers with no separator; other platforms join
  // with "+" for readability.
  return IS_MAC ? parts.join("") : parts.join("+");
}

/** Icon for a command row, keyed off its stable id prefix. */
function commandIcon(id: string): typeof PlayIcon {
  if (id.startsWith("spawn:")) {
    const kind = id.slice("spawn:".length) as HarnessIconKind;
    return HARNESS_ICONS[kind] ?? HARNESS_ICONS["shell" as HarnessIconKind];
  }
  if (id.startsWith("keymap:")) return KeyboardIcon;
  return PlayIcon;
}

// ---------------------------------------------------------------------------
// SpotlightDock
// ---------------------------------------------------------------------------

export const SpotlightDock: Component = () => {
  const [query, setQuery] = createSignal("");
  const [fileHits, setFileHits] = createSignal<WorktreeFileHit[]>([]);
  const [scrollbackHits, setScrollbackHits] = createSignal<ScrollbackMatch[]>([]);
  const [selectedIdx, setSelectedIdx] = createSignal(-1);
  const [editorPath, setEditorPath] = createSignal<string | null>(null);

  let inputRef: HTMLInputElement | undefined;
  let fileSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let fileToken = 0;
  let scrollbackSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollbackCancel: { aborted: boolean } | null = null;

  const keymap = useKeymap();

  // ⌘. — backwards-compat shortcut via keymap system
  useKeymapAction("spotlight", toggleSpotlight);

  // ⌘F — primary trigger, flowing through the single keymap pipeline (so the
  // binding stays rebindable). When the user is inside a terminal, ⌘F means
  // "find in THIS terminal", not "open the global dock" — so we detect terminal
  // focus and hand off to the focused pane via `raum:pane-find-requested`
  // (TerminalPane listens and opens its in-pane find). This replaces the old
  // capture-phase race between the pane listener and the dock; routing both
  // intents through the one global-search handler makes the outcome
  // deterministic regardless of mount order. ⌘F anywhere else opens the dock.
  const openSearch = (): void => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(".terminal-chrome-frame")) {
      window.dispatchEvent(new CustomEvent("raum:pane-find-requested"));
      return;
    }
    toggleSpotlight();
  };
  useKeymapAction("global-search", openSearch);

  // On open in modal-mode: consume pendingQuery, reset state, steal focus.
  // In top-bar-driven mode: reset state but do NOT steal focus — the top-bar
  // input stays focused and drives the query via the effect below.
  createEffect(() => {
    if (spotlightOpen()) {
      if (spotlightTopBarDriven()) {
        // Query comes from the top-bar; just reset the result lists.
        setFileHits([]);
        setScrollbackHits([]);
        setSelectedIdx(-1);
      } else {
        const initial = spotlightPendingQuery();
        clearSpotlightPendingQuery();
        setQuery(initial);
        setFileHits([]);
        setScrollbackHits([]);
        setSelectedIdx(-1);
        if (initial) scheduleSearch(initial);
        requestAnimationFrame(() => {
          inputRef?.focus();
          if (initial) {
            inputRef?.setSelectionRange(initial.length, initial.length);
          }
        });
      }
    }
  });

  // While top-bar-driven, keep the local query in sync with whatever the
  // top-bar input is typing and re-run the search on each change.
  createEffect(() => {
    if (!spotlightTopBarDriven()) return;
    const q = spotlightTopBarQuery();
    setQuery(q);
    setSelectedIdx(-1);
    scheduleSearch(q);
  });

  // ---------------------------------------------------------------------------
  // Worktree-aware file search
  // ---------------------------------------------------------------------------

  function scheduleSearch(q: string): void {
    if (fileSearchTimer !== null) clearTimeout(fileSearchTimer);
    fileSearchTimer = setTimeout(() => {
      fileSearchTimer = null;
      void runWorktreeFileSearch(q);
    }, 120);

    // Scrollback walk is heavier (tmux IPC + per-line scan), so debounce it
    // a bit longer to avoid thrashing while the user is still typing.
    if (scrollbackSearchTimer !== null) clearTimeout(scrollbackSearchTimer);
    if (scrollbackCancel) scrollbackCancel.aborted = true;
    scrollbackSearchTimer = setTimeout(() => {
      scrollbackSearchTimer = null;
      void runScrollback(q);
    }, 180);
  }

  async function runScrollback(q: string): Promise<void> {
    if (!q.trim()) {
      setScrollbackHits([]);
      return;
    }
    const cancel = { aborted: false };
    scrollbackCancel = cancel;
    try {
      const hits = await runScrollbackSearch({ query: q, cancel });
      if (!cancel.aborted) setScrollbackHits(hits);
    } catch {
      if (!cancel.aborted) setScrollbackHits([]);
    } finally {
      if (scrollbackCancel === cancel) scrollbackCancel = null;
    }
  }

  async function runWorktreeFileSearch(q: string): Promise<void> {
    const slug = activeProjectSlug();
    if (!slug || !q.trim()) {
      setFileHits([]);
      return;
    }
    const token = ++fileToken;
    try {
      const worktrees = await invoke<Worktree[]>("worktree_list", {
        projectSlug: slug,
      });
      if (token !== fileToken) return;

      const perWorktree = await Promise.all(
        worktrees.map(async (wt) => {
          try {
            const hits = await invoke<FileHit[]>("search_files_in_path", {
              path: wt.path,
              query: q,
            });
            const branch =
              wt.branch?.replace(/^refs\/heads\//, "") ?? wt.path.split("/").at(-1) ?? "main";
            return hits.map(
              (h): WorktreeFileHit => ({
                ...h,
                worktreeBranch: branch,
                worktreePath: wt.path,
              }),
            );
          } catch {
            return [] as WorktreeFileHit[];
          }
        }),
      );

      if (token !== fileToken) return;
      const merged = perWorktree
        .flat()
        .sort((a, b) => b.score - a.score)
        .slice(0, 50);
      setFileHits(merged);
    } catch {
      if (token === fileToken) setFileHits([]);
    }
  }

  function handleQueryChange(v: string): void {
    setQuery(v);
    setSelectedIdx(-1);
    scheduleSearch(v);
  }

  // ---------------------------------------------------------------------------
  // Harness results — scoped to active project, show worktree label
  // ---------------------------------------------------------------------------

  const harnessMatches = createMemo<HarnessItem[]>(() => {
    const q = query().toLowerCase().trim();
    const slug = activeProjectSlug();
    const projects = projectBySlug();
    return listHarnessSessions(slug)
      .map((t): HarnessItem => {
        const project = t.project_slug ? (projects.get(t.project_slug) ?? null) : null;
        return {
          type: "harness" as const,
          sessionId: t.session_id,
          kind: t.kind as HarnessIconKind,
          workingState: t.workingState,
          tabLabel: resolveSessionTabLabel(t.session_id),
          projectSlug: t.project_slug,
          projectName: project?.name ?? null,
          projectSigil: project?.sigil ?? null,
        };
      })
      .filter(
        (item) =>
          !q ||
          item.tabLabel.toLowerCase().includes(q) ||
          item.kind.toLowerCase().includes(q) ||
          (item.projectName?.toLowerCase().includes(q) ?? false),
      )
      .slice(0, 8);
  });

  // ---------------------------------------------------------------------------
  // Flat navigation list
  // ---------------------------------------------------------------------------

  const scrollbackItems = createMemo<ScrollbackItem[]>(() =>
    scrollbackHits().map((match): ScrollbackItem => ({ type: "scrollback", match })),
  );

  // ---------------------------------------------------------------------------
  // Command verbs — keymap actions + curated mouse-only verbs
  // ---------------------------------------------------------------------------

  /** Dispatch a keymap action's top-of-stack handler, then close the dock. */
  function runKeymapAction(action: string): void {
    closeSpotlight();
    keymap.dispatch(action);
  }

  /** The full, unfiltered command catalogue. */
  const commandCatalogue = createMemo<CommandItem[]>(() => {
    const cmds: CommandItem[] = [];

    // Spawn-harness verbs (mouse-only — no dedicated accelerator).
    for (const def of SPAWN_COMMAND_DEFS) {
      cmds.push({
        type: "command",
        id: `spawn:${def.kind}`,
        title: def.label,
        accelerator: undefined,
        run: () => {
          const slug = activeProjectSlug();
          closeSpotlight();
          // Mirror TopRow.spawn(): a harness needs a project, so when none is
          // active, guide the user to add one (TopRow listens for this and
          // opens the Add-Project modal) instead of dispatching a spawn the
          // grid silently drops. Shells spawn with no project. Reuse the
          // pinned-worktree resolver so a palette spawn lands where the
          // top-bar spawn would.
          if (def.kind !== "shell" && !slug) {
            window.dispatchEvent(new CustomEvent("raum:add-project-requested"));
            return;
          }
          window.dispatchEvent(
            new CustomEvent("raum:spawn-requested", {
              detail: {
                kind: def.kind,
                projectSlug: slug,
                worktreeId: slug ? resolveSpawnWorktree(slug) : undefined,
              },
            }),
          );
        },
      });
    }

    // Layout verbs — call the store ops directly (no keymap binding).
    cmds.push(
      {
        type: "command",
        id: "layout:equalize",
        title: "Equalize panes",
        accelerator: undefined,
        run: () => {
          closeSpotlight();
          equalizeAllRatios();
        },
      },
      {
        type: "command",
        id: "layout:tile",
        title: "Tile panes",
        accelerator: undefined,
        run: () => {
          closeSpotlight();
          tileAll();
        },
      },
      {
        type: "command",
        id: "layout:compact",
        title: "Compact panes",
        accelerator: undefined,
        run: () => {
          closeSpotlight();
          compactTree();
        },
      },
    );

    // Layout presets (STORE lane). Content-agnostic tree-shape templates.
    for (const preset of LAYOUT_PRESETS) {
      cmds.push({
        type: "command",
        id: `preset:${preset.id}`,
        title: `Apply layout: ${preset.label}`,
        accelerator: undefined,
        run: () => {
          closeSpotlight();
          applyLayoutPreset(preset.id);
        },
      });
    }

    // Maximize — prefer the keymap action (rebindable) but fall back to the
    // store op directly so the verb works even if nothing registered a handler.
    cmds.push({
      type: "command",
      id: "verb:maximize-pane",
      title: KEYMAP_COMMAND_TITLES["maximize-pane"] ?? "Maximize focused pane",
      accelerator: keymap.accelerator("maximize-pane"),
      run: () => {
        closeSpotlight();
        if (!keymap.dispatch("maximize-pane")) {
          const id = focusedPaneId();
          if (id) toggleMaximize(id);
        }
      },
    });

    // App-level verbs with no keymap binding.
    cmds.push(
      {
        type: "command",
        id: "app:settings",
        title: "Open Settings",
        accelerator: undefined,
        run: () => {
          closeSpotlight();
          // TopRow listens on the Tauri `menu-action` bus for "open-settings"
          // (same payload the native menu emits), so we reuse it rather than
          // adding a new command.
          void emitTauriEvent("menu-action", "open-settings").catch(() => {
            /* event bus unavailable (tests / SSR) */
          });
        },
      },
      {
        type: "command",
        id: "app:replay-onboarding",
        title: "Replay onboarding",
        accelerator: undefined,
        run: () => {
          closeSpotlight();
          // Shared dev-preview signal that force-mounts the OnboardingWizard
          // (same store the TopRow debug button drives).
          setPreviewOnboarding(true);
        },
      },
    );

    // Keymap-derived verbs — surfaced with their live accelerator so the
    // palette doubles as a rebindable shortcut launcher. We opt actions in via
    // KEYMAP_COMMAND_TITLES (the raw table holds low-level ids that would just
    // be noise here). Maximize is handled above with its fallback.
    const seen = new Set(["maximize-pane"]);
    for (const entry of keymap.entries()) {
      const title = KEYMAP_COMMAND_TITLES[entry.action];
      if (!title || seen.has(entry.action)) continue;
      seen.add(entry.action);
      cmds.push({
        type: "command",
        id: `keymap:${entry.action}`,
        title,
        accelerator: entry.accelerator,
        run: () => runKeymapAction(entry.action),
      });
    }

    return cmds;
  });

  /** Commands matching the current query, best-fuzzy-match first. */
  const commandMatches = createMemo<CommandItem[]>(() => {
    const q = query().trim();
    if (!q) return [];
    return commandCatalogue()
      .map((cmd) => ({ cmd, score: fuzzyScore(cmd.title, q) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, 8)
      .map((r) => r.cmd);
  });

  const allItems = createMemo<ResultItem[]>(() => {
    const q = query().trim();
    if (!q) {
      // Empty query: recent searches first, then all project harnesses
      const recents = recentSearches().map((r): RecentItem => ({ type: "recent", query: r }));
      return [...recents, ...harnessMatches()];
    }
    return [
      ...commandMatches(),
      ...fileHits().map((hit): FileItem => ({ type: "file", hit })),
      ...harnessMatches(),
      ...scrollbackItems(),
    ];
  });

  function activateItem(item: ResultItem): void {
    if (item.type === "recent") {
      setQuery(item.query);
      setSelectedIdx(-1);
      scheduleSearch(item.query);
      return;
    }
    if (item.type === "command") {
      // `run()` is responsible for closing the dock (most do it before an
      // async dispatch so focus lands on the target, not the palette).
      item.run();
      return;
    }
    if (item.type === "harness") {
      window.dispatchEvent(
        new CustomEvent("terminal-focus-requested", {
          detail: { sessionId: item.sessionId },
        }),
      );
      closeSpotlight();
      return;
    }
    if (item.type === "scrollback") {
      addRecentSearch(query());
      activateScrollbackMatch(item.match);
      closeSpotlight();
      return;
    }
    // file
    addRecentSearch(query());
    setEditorPath(item.hit.path);
    closeSpotlight();
  }

  function activateScrollbackMatch(m: ScrollbackMatch): void {
    // Cross-project jump: switching `activeProjectSlug` remounts the grid
    // and the target pane's `<TerminalPane>`, which then reacts to the
    // `terminal-focus-requested` event we dispatch below (same pattern the
    // notification toasts and cross-project overlay use).
    const needsProjectSwitch = Boolean(m.projectSlug && m.projectSlug !== activeProjectSlug());
    if (needsProjectSwitch) setActiveProjectSlug(m.projectSlug!);

    const finish = (): void => {
      const reg = listTerminals().find((t) => t.sessionId === m.sessionId);
      // Tmux-sourced matches live outside xterm.js's scrollback (their row
      // indices don't map 1:1 into xterm's buffer), so we only scroll for
      // xterm-sourced hits — otherwise we'd snap the viewport somewhere
      // misleading.
      if (reg && (m.buffer === "normal" || m.buffer === "alternate")) {
        reg.revealBufferLine(m.buffer as TerminalBufferKind, m.row);
      }
      reg?.focus();
      try {
        window.dispatchEvent(
          new CustomEvent("terminal-focus-requested", {
            detail: { sessionId: m.sessionId },
          }),
        );
      } catch {
        /* non-DOM env (tests / SSR) */
      }
    };

    if (needsProjectSwitch) queueMicrotask(finish);
    else finish();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!spotlightOpen()) return;
    const items = allItems();
    if (e.key === "Escape") {
      e.preventDefault();
      closeSpotlight();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, items.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, -1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = items[selectedIdx()];
      if (item) activateItem(item);
    }
  }

  window.addEventListener("keydown", onKeyDown, { capture: true });
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown, { capture: true });
    if (fileSearchTimer !== null) clearTimeout(fileSearchTimer);
    if (scrollbackSearchTimer !== null) clearTimeout(scrollbackSearchTimer);
    if (scrollbackCancel) scrollbackCancel.aborted = true;
  });

  // ---------------------------------------------------------------------------
  // Section metadata for rendering
  // ---------------------------------------------------------------------------

  const sections = createMemo(() => {
    const items = allItems();
    const q = query().trim();
    const hasRecent = !q && recentSearches().length > 0;
    const hasHarnesses = harnessMatches().length > 0;
    const fileCount = fileHits().length;
    const scrollbackCount = scrollbackHits().length;
    const commandCount = commandMatches().length;
    return {
      hasRecent,
      hasHarnesses,
      harnessCount: harnessMatches().length,
      fileCount,
      scrollbackCount,
      commandCount,
      items,
    };
  });

  return (
    <>
      <Show when={spotlightOpen()}>
        {/* Backdrop — dims the app without blurring it */}
        <div
          class="fixed inset-0 z-50 flex items-start justify-center pt-[16vh] bg-scrim"
          onClick={closeSpotlight}
        >
          {/* Panel — solid background so the app behind stays crisp */}
          <div
            class="floating-surface animate-in fade-in zoom-in-95 duration-150 w-full max-w-[640px] mx-4 overflow-hidden rounded-2xl border border-border bg-popover"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Search input — hidden when the top-bar input is driving the query */}
            <Show when={!spotlightTopBarDriven()}>
              <div class="flex items-center gap-3 px-4 py-3.5">
                <SearchIcon class="size-4 shrink-0 text-muted-foreground/60" />
                <input
                  ref={(el) => (inputRef = el)}
                  type="text"
                  class="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
                  placeholder="Search files and terminals…"
                  value={query()}
                  onInput={(e) => handleQueryChange(e.currentTarget.value)}
                />
                <Show when={query()}>
                  <button
                    type="button"
                    class="rounded p-0.5 text-muted-foreground/50 hover:text-foreground"
                    onClick={() => {
                      setQuery("");
                      setFileHits([]);
                      setScrollbackHits([]);
                      setSelectedIdx(-1);
                    }}
                    aria-label="Clear"
                  >
                    <XIcon class="size-3.5" />
                  </button>
                </Show>
                {/* Shortcuts affordance — opens the cheat-sheet so users can
                    discover gestures/keys without already knowing ⌘/. */}
                <button
                  type="button"
                  class="focus-ring flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    closeSpotlight();
                    keymap.dispatch("cheat-sheet");
                  }}
                  title={
                    keymap.accelerator("cheat-sheet")
                      ? `Keyboard shortcuts (${formatAccelerator(keymap.accelerator("cheat-sheet")!)})`
                      : "Keyboard shortcuts"
                  }
                  aria-label="Show keyboard shortcuts"
                >
                  ?
                </button>
                <kbd class="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  ⌘F
                </kbd>
              </div>
            </Show>

            {/* Results */}
            <Show
              when={
                sections().items.length > 0 ||
                (query().trim().length > 0 &&
                  sections().commandCount === 0 &&
                  sections().harnessCount === 0 &&
                  sections().scrollbackCount === 0 &&
                  sections().fileCount === 0)
              }
            >
              <div class="border-t border-white/5" />
              <Scrollable class="max-h-[480px] pb-1 pt-1">
                {/* No-results message */}
                <Show
                  when={
                    query().trim().length > 0 &&
                    sections().commandCount === 0 &&
                    sections().harnessCount === 0 &&
                    sections().scrollbackCount === 0 &&
                    sections().fileCount === 0
                  }
                >
                  <p class="px-4 py-3 text-xs text-muted-foreground/60">
                    No results for <span class="text-foreground/80">"{query()}"</span>
                  </p>
                </Show>

                {/* Section headers */}
                <Show when={sections().hasRecent}>
                  <SectionHeader label="Recent" />
                </Show>
                <Show when={!query().trim() && sections().hasHarnesses}>
                  <SectionHeader label="Terminals" />
                </Show>

                <For each={sections().items}>
                  {(item, idx) => {
                    const isFirstCommand = createMemo(
                      () =>
                        item.type === "command" &&
                        (idx() === 0 || sections().items[idx() - 1]?.type !== "command"),
                    );
                    const isFirstFile = createMemo(
                      () =>
                        item.type === "file" &&
                        (idx() === 0 || sections().items[idx() - 1]?.type !== "file"),
                    );
                    const isFirstHarness = createMemo(
                      () =>
                        item.type === "harness" &&
                        (idx() === 0 || sections().items[idx() - 1]?.type !== "harness"),
                    );
                    const isFirstScrollback = createMemo(
                      () =>
                        item.type === "scrollback" &&
                        (idx() === 0 || sections().items[idx() - 1]?.type !== "scrollback"),
                    );
                    return (
                      <>
                        <Show when={isFirstCommand()}>
                          <SectionHeader label="Commands" count={sections().commandCount} />
                        </Show>
                        <Show when={isFirstFile()}>
                          <SectionHeader label="Files" count={sections().fileCount} />
                        </Show>
                        <Show when={query().trim() && isFirstHarness()}>
                          <SectionHeader label="Terminals" count={sections().harnessCount} />
                        </Show>
                        <Show when={isFirstScrollback()}>
                          <SectionHeader label="Scrollback" count={sections().scrollbackCount} />
                        </Show>
                        <ResultRow
                          selected={selectedIdx() === idx()}
                          onRowClick={() => activateItem(item)}
                          onRowMouseEnter={() => setSelectedIdx(idx())}
                        >
                          <ItemContent item={item} onClearRecent={clearRecentSearch} />
                        </ResultRow>
                      </>
                    );
                  }}
                </For>
              </Scrollable>
            </Show>
          </div>
        </div>
      </Show>

      {/* File editor: lazy-loaded so CodeMirror doesn't ship in the initial chunk */}
      <Show when={editorPath() !== null}>
        <Suspense>
          <FileEditorModal open={true} path={editorPath()} onClose={() => setEditorPath(null)} />
        </Suspense>
      </Show>
    </>
  );
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const SectionHeader: Component<{ label: string; count?: number }> = (props) => (
  <div class="flex items-center gap-2 px-4 pb-1 pt-2">
    <span class="text-[10px] uppercase tracking-widest text-muted-foreground/50">
      {props.label}
    </span>
    <Show when={props.count !== undefined && props.count > 0}>
      <span class="text-[10px] text-muted-foreground/40">{props.count}</span>
    </Show>
  </div>
);

const ResultRow: Component<{
  selected: boolean;
  onRowClick: () => void;
  onRowMouseEnter: () => void;
  children: JSX.Element;
}> = (props) => (
  <button
    type="button"
    class="group flex w-full items-center gap-2.5 px-4 py-2 text-left text-xs transition-colors duration-75"
    classList={{
      "bg-white/8 text-foreground": props.selected,
      "text-foreground hover:bg-white/5": !props.selected,
    }}
    onClick={() => props.onRowClick()}
    onMouseEnter={() => props.onRowMouseEnter()}
  >
    {props.children}
  </button>
);

const ItemContent: Component<{
  item: ResultItem;
  onClearRecent: (q: string) => void;
}> = (props) => (
  <Switch>
    <Match when={props.item.type === "command" && (props.item as CommandItem)}>
      {(cmd) => {
        const Icon = commandIcon(cmd().id);
        return (
          <>
            <Icon class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="flex-1 truncate text-foreground/90">{cmd().title}</span>
            <Show when={cmd().accelerator}>
              <kbd class="ml-1 shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {formatAccelerator(cmd().accelerator!)}
              </kbd>
            </Show>
          </>
        );
      }}
    </Match>
    <Match when={props.item.type === "recent" && (props.item as RecentItem)}>
      {(recent) => (
        <>
          <ClockIcon class="size-3.5 shrink-0 text-muted-foreground/60" />
          <span class="flex-1 truncate text-foreground/90">{recent().query}</span>
          <button
            type="button"
            class="ml-1 rounded p-0.5 text-muted-foreground/40 opacity-0 hover:text-foreground group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              props.onClearRecent(recent().query);
            }}
            aria-label={`Remove "${recent().query}" from recent`}
          >
            <XIconSmall />
          </button>
        </>
      )}
    </Match>
    <Match when={props.item.type === "harness" && (props.item as HarnessItem)}>
      {(harness) => {
        const Icon = HARNESS_ICONS[harness().kind] ?? HARNESS_ICONS["shell" as HarnessIconKind];
        return (
          <>
            <Icon class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="flex-1 truncate text-foreground/90">{harness().tabLabel}</span>
            <Show when={harness().projectName}>
              <span class="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/70">
                <Show when={harness().projectSigil}>
                  <span class="font-mono text-muted-foreground/60">{harness().projectSigil}</span>
                </Show>
                <span class="truncate">{harness().projectName}</span>
              </span>
            </Show>
            <Badge
              class={`ml-1 shrink-0 px-1.5 py-0.5 text-[9px] font-medium ${stateColor(harness().workingState)}`}
            >
              {stateLabel(harness().workingState)}
            </Badge>
          </>
        );
      }}
    </Match>
    <Match when={props.item.type === "file" && (props.item as FileItem)}>
      {(file) => (
        <>
          <FileTypeIcon name={file().hit.name} class="size-3.5 shrink-0 text-muted-foreground/60" />
          <span class="truncate text-sm text-foreground/90">{file().hit.name}</span>
          <span class="ml-1 min-w-0 flex-1 truncate text-[10px] text-muted-foreground/50">
            {file().hit.relPath}
          </span>
          <Badge class="shrink-0 bg-white/5 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground/70">
            {file().hit.worktreeBranch}
          </Badge>
        </>
      )}
    </Match>
    <Match when={props.item.type === "scrollback" && (props.item as ScrollbackItem)}>
      {(sb) => {
        const Icon =
          HARNESS_ICONS[sb().match.kind as HarnessIconKind] ??
          HARNESS_ICONS["shell" as HarnessIconKind];
        const parts = createMemo(() =>
          buildPreviewParts(sb().match.line, sb().match.col, sb().match.length),
        );
        return (
          <>
            <Icon class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="shrink-0 max-w-[30%] truncate text-foreground/90">
              {sb().match.tabLabel}
            </span>
            <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/80">
              <Show when={parts().leadingEllipsis}>
                <span class="text-muted-foreground/40">…</span>
              </Show>
              {parts().before}
              <mark class="rounded-sm bg-yellow-300/30 px-0.5 text-foreground">
                {parts().match}
              </mark>
              {parts().after}
              <Show when={parts().trailingEllipsis}>
                <span class="text-muted-foreground/40">…</span>
              </Show>
            </span>
          </>
        );
      }}
    </Match>
  </Switch>
);

function XIcon(props: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function XIconSmall() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="size-3"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export default SpotlightDock;
