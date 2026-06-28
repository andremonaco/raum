import { Component, For, Show, createEffect, createMemo, createSignal } from "solid-js";

import { type AgentKind } from "../../lib/agentKind";
import { resolveDisplayedTabLabel } from "../../lib/terminalTabLabel";
import { agentStore, isAcknowledgedReactive } from "../../stores/agentStore";
import type { AgentState } from "../../stores/agentStore";
import {
  runtimeLayoutStore,
  setActiveTabId,
  setTabLabel,
  type CellTab,
} from "../../stores/runtimeLayoutStore";
import { terminalStore } from "../../stores/terminalStore";
import { HARNESS_ICONS } from "../icons";
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from "../ui/tooltip";
import { KIND_LABELS } from "./constants";
import { CloseGlyph } from "./glyphs";
import { startReviewFromDrop } from "./review-spawn";

export const TabItem: Component<{
  cellId: string;
  tab: CellTab;
  kind: string;
  isActive: boolean;
  showClose: boolean;
  onClose: (e: MouseEvent) => void;
}> = (props) => {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuX, setMenuX] = createSignal(0);
  const [menuY, setMenuY] = createSignal(0);
  // "main" shows Rename + Review with → ; "review" shows the picker.
  const [menuMode, setMenuMode] = createSignal<"main" | "review">("main");

  /** Other open agent panes (excluding this tab's own pane and shells). The
   *  context menu's "Review with →" submenu lists these as targets. */
  const reviewCandidates = createMemo<Array<{ cellId: string; kind: AgentKind; label: string }>>(
    () => {
      const out: Array<{ cellId: string; kind: AgentKind; label: string }> = [];
      runtimeLayoutStore.cells.forEach((cell, idx) => {
        if (cell.id === props.cellId) return;
        if (cell.kind === "empty" || cell.kind === "shell") return;
        const sessionId = cell.tabs.find((t) => t.id === cell.activeTabId)?.sessionId;
        if (!sessionId) return; // can't review a pane that hasn't spawned yet
        const harnessLabel = KIND_LABELS[cell.kind] ?? cell.kind;
        out.push({
          cellId: cell.id,
          kind: cell.kind as AgentKind,
          label: `P${idx} · ${harnessLabel}`,
        });
      });
      return out;
    },
  );
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const tabLabel = () => resolveDisplayedTabLabel(props.tab);

  const tabState = (): AgentState | null =>
    agentStore.sessions[props.tab.sessionId ?? ""]?.state ?? null;

  const [bumping, setBumping] = createSignal(false);
  let prevTabState: AgentState | null = null;
  createEffect(() => {
    const s = tabState();
    const transitioned =
      (s === "waiting" && prevTabState !== "waiting") ||
      (s === "completed" && prevTabState === "working");
    if (transitioned) {
      setBumping(true);
      setTimeout(() => setBumping(false), 400);
    }
    prevTabState = s;
  });

  const harnessAnimating = () => {
    const s = tabState();
    return s === "working" || s === "waiting";
  };

  // True while the harness has completed its turn AND the user hasn't
  // implicitly "read" the result by focusing this tab inside its pane.
  // Drives the calm green chrome — quiet bg differentiation, matching the
  // existing waiting-state pattern.
  const isUnreadCompleted = () => {
    if (tabState() !== "completed") return false;
    const sid = props.tab.sessionId;
    if (!sid) return false;
    return !isAcknowledgedReactive(sid);
  };

  const HarnessIcon = () => {
    const Icon = HARNESS_ICONS[props.kind as keyof typeof HARNESS_ICONS];
    if (!Icon) return null;
    return <Icon class="h-3 w-3 shrink-0" classList={{ "harness-pulse": harnessAnimating() }} />;
  };

  const lastPromptText = (): string | undefined => {
    const sid = props.tab.sessionId;
    if (!sid) return undefined;
    const text = terminalStore.byId[sid]?.lastPrompt?.text;
    if (!text) return undefined;
    return text;
  };

  function openMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenuX(e.clientX);
    setMenuY(e.clientY);
    setMenuMode("main");
    setMenuOpen(true);
  }

  function closeMenu() {
    setMenuOpen(false);
    setMenuMode("main");
  }

  function pickReviewTarget(targetCellId: string) {
    closeMenu();
    void startReviewFromDrop(props.cellId, targetCellId);
  }

  function startRename() {
    setDraft(props.tab.label ?? props.tab.autoLabel ?? "");
    setEditing(true);
    closeMenu();
  }

  function commitRename() {
    if (!editing()) return;
    setTabLabel(props.cellId, props.tab.id, draft());
    setEditing(false);
  }

  function cancelRename() {
    setEditing(false);
  }

  return (
    <Tooltip>
      <TooltipTrigger
        as="div"
        class="pane-header-tab group relative flex h-[22px] min-w-[120px] max-w-[300px] grow basis-[180px] cursor-pointer select-none items-center gap-1.5 rounded-md px-2.5 text-[10px] uppercase leading-none tracking-wide transition-colors duration-150"
        classList={{
          "bg-selected text-foreground font-medium":
            props.isActive && tabState() !== "waiting" && !isUnreadCompleted(),
          "bg-selected text-warning font-medium": props.isActive && tabState() === "waiting",
          "bg-selected text-success font-medium":
            props.isActive && tabState() !== "waiting" && isUnreadCompleted(),
          "text-foreground-subtle hover:bg-hover hover:text-foreground":
            !props.isActive && tabState() !== "waiting" && !isUnreadCompleted(),
          "bg-warning/15 text-warning hover:bg-warning/25":
            !props.isActive && tabState() === "waiting",
          "bg-success/15 text-success hover:bg-success/25":
            !props.isActive && tabState() !== "waiting" && isUnreadCompleted(),
          wiggle: bumping(),
        }}
        onClick={(e: MouseEvent) => {
          if (editing()) return;
          e.stopPropagation();
          setActiveTabId(props.cellId, props.tab.id);
        }}
        onContextMenu={openMenu}
        onDblClick={(e: MouseEvent) => {
          e.stopPropagation();
          startRename();
        }}
      >
        <HarnessIcon />
        <Show when={editing()}>
          <input
            type="text"
            class="h-4 w-28 rounded-sm border border-border bg-background px-1 text-[10px] uppercase tracking-wide text-foreground outline-none focus:border-ring"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelRename();
              }
            }}
            onBlur={commitRename}
            ref={(el) => {
              queueMicrotask(() => {
                el.focus();
                el.select();
              });
            }}
          />
        </Show>
        <Show when={!editing() && tabLabel()}>
          <span class="min-w-0 flex-1 truncate normal-case">{tabLabel()}</span>
        </Show>
        <Show when={props.showClose && !editing()}>
          <button
            type="button"
            aria-label="Close tab"
            class="pane-header-tab-close pointer-events-none ml-auto shrink-0 rounded p-0.5 opacity-0 transition-opacity duration-150 hover:bg-hover hover:text-foreground group-hover:pointer-events-auto group-hover:opacity-100"
            onClick={(e) => {
              props.onClose(e);
            }}
          >
            <CloseGlyph />
          </button>
        </Show>

        <Show when={menuOpen()}>
          <div
            class="floating-surface fixed z-50 w-48 rounded-xl border border-border bg-popover p-1 text-xs normal-case"
            role="menu"
            style={{ left: `${menuX()}px`, top: `${menuY()}px` }}
            onMouseLeave={closeMenu}
            onClick={(e) => e.stopPropagation()}
          >
            <Show when={menuMode() === "main"}>
              <button
                type="button"
                class="block w-full rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                onClick={startRename}
              >
                Rename…
              </button>
              <Show when={props.kind !== "shell" && props.kind !== "empty"}>
                <button
                  type="button"
                  class="flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                  disabled={reviewCandidates().length === 0}
                  onClick={() => setMenuMode("review")}
                  title={
                    reviewCandidates().length === 0
                      ? "No other harness panes are open"
                      : "Pick a pane whose work this harness should review"
                  }
                >
                  <span>Review with</span>
                  <span aria-hidden="true">→</span>
                </button>
              </Show>
            </Show>
            <Show when={menuMode() === "review"}>
              <div class="mb-1 flex items-center justify-between px-2 py-1 text-foreground-subtle">
                <button
                  type="button"
                  class="hover:text-foreground"
                  onClick={() => setMenuMode("main")}
                  aria-label="Back"
                >
                  ←
                </button>
                <span class="text-[10px] uppercase tracking-wide">Review which pane?</span>
                <span aria-hidden="true" class="w-3" />
              </div>
              <For each={reviewCandidates()}>
                {(c) => {
                  const Icon = HARNESS_ICONS[c.kind as keyof typeof HARNESS_ICONS];
                  return (
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                      onClick={() => pickReviewTarget(c.cellId)}
                    >
                      {Icon ? <Icon class="h-3 w-3 shrink-0" /> : null}
                      <span class="truncate">{c.label}</span>
                    </button>
                  );
                }}
              </For>
            </Show>
          </div>
        </Show>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent class="max-w-md">
          <Show when={tabLabel()}>
            <div class="text-[10px] font-medium uppercase tracking-wide">{tabLabel()}</div>
          </Show>
          <Show when={lastPromptText()}>
            <div
              class="whitespace-pre-wrap text-[11px] leading-snug text-popover-foreground/85"
              classList={{ "mt-1": !!tabLabel() }}
            >
              {lastPromptText()}
            </div>
          </Show>
        </TooltipContent>
      </TooltipPortal>
    </Tooltip>
  );
};
