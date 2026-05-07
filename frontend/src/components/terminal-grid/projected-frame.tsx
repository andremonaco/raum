import { Component, Show, createMemo } from "solid-js";

import { kindDisplayLabel } from "../../lib/agentKind";
import { type Rect } from "../../lib/layoutTree";
import { resolveHarnessAutoLabel } from "../../lib/terminalTabLabel";
import { agentStore } from "../../stores/agentStore";
import { projectBySlug } from "../../stores/projectStore";
import { terminalStore } from "../../stores/terminalStore";
import { HARNESS_ICONS } from "../icons";
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from "../ui/tooltip";
import { rectStyle } from "./utils";

export const ProjectedSessionFrame: Component<{ sessionId: string; rect: Rect | null }> = (
  props,
) => {
  const terminal = createMemo(() => terminalStore.byId[props.sessionId]);
  const project = createMemo(() => {
    const slug = terminal()?.project_slug;
    return slug ? projectBySlug().get(slug) : undefined;
  });
  const state = () => agentStore.sessions[props.sessionId]?.state ?? null;
  const HarnessIcon = () => {
    const kind = terminal()?.kind;
    if (!kind) return null;
    const I = HARNESS_ICONS[kind as keyof typeof HARNESS_ICONS];
    if (!I) return null;
    const animating = () => {
      const s = state();
      return s === "working" || s === "waiting";
    };
    return <I class="size-3.5 shrink-0" classList={{ "harness-pulse": animating() }} />;
  };
  const label = createMemo(() => {
    const current = terminal();
    const ctx = current?.paneContext;
    const kind = current?.kind;
    if (!kind || kind === "shell") return kind ? kindDisplayLabel(kind) : "";
    return resolveHarnessAutoLabel({
      kind,
      paneTitle: ctx?.paneTitle,
      windowName: ctx?.windowName,
      currentCommand: ctx?.currentCommand,
      fallbackLabel: kindDisplayLabel(kind),
    });
  });
  const headerStyle = () =>
    ({
      "box-shadow": `inset 0 1px 0 color-mix(in oklab, ${project()?.color ?? "#6b7280"} 26%, transparent)`,
      "background-image": `linear-gradient(180deg, color-mix(in oklab, ${project()?.color ?? "#6b7280"} 7%, transparent) 0%, transparent 100%)`,
    }) as Record<string, string>;
  const projectedSubtitle = (): string | undefined => {
    const text = terminal()?.lastPrompt?.text;
    if (!text) return undefined;
    const idx = text.indexOf("\n");
    return idx >= 0 ? text.slice(0, idx) : text;
  };

  return (
    <Show when={terminal()}>
      {(currentTerminal) => (
        <Show when={props.rect}>
          {(rect) => (
            <div
              class="leaf-frame terminal-chrome-frame flex min-h-0 min-w-0 flex-col"
              data-session-id={props.sessionId}
              data-testid={`projected-session-${props.sessionId}`}
              style={rectStyle(rect())}
              title={currentTerminal().project_slug ?? ""}
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("terminal-focus-requested", {
                    detail: { sessionId: props.sessionId },
                  }),
                );
              }}
            >
              <div
                class="flex h-8 shrink-0 items-center border-b border-border-subtle"
                style={headerStyle()}
              >
                <div class="no-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto pl-1.5">
                  <Tooltip>
                    <TooltipTrigger
                      as="div"
                      class="pane-header-tab relative flex min-w-[120px] max-w-[300px] grow basis-[180px] flex-col justify-center rounded-md px-2 text-[10px] uppercase leading-none tracking-wide text-foreground"
                      classList={{
                        "h-[26px]": !!projectedSubtitle(),
                        "h-[18px]": !projectedSubtitle(),
                      }}
                    >
                      <div class="flex min-w-0 items-center gap-1">
                        <HarnessIcon />
                        <span class="min-w-0 flex-1 truncate normal-case">{label()}</span>
                      </div>
                      <Show when={projectedSubtitle()}>
                        <div class="mt-px min-w-0 truncate pl-[18px] text-[9px] font-normal normal-case tracking-normal opacity-85">
                          {projectedSubtitle()}
                        </div>
                      </Show>
                    </TooltipTrigger>
                    <TooltipPortal>
                      <TooltipContent class="max-w-md">
                        <Show when={label()}>
                          <div class="text-[10px] font-medium uppercase tracking-wide">
                            {label()}
                          </div>
                        </Show>
                        <Show when={terminal()?.lastPrompt?.text}>
                          <div
                            class="whitespace-pre-wrap text-[11px] leading-snug text-popover-foreground/85"
                            classList={{ "mt-1": !!label() }}
                          >
                            {terminal()?.lastPrompt?.text}
                          </div>
                        </Show>
                      </TooltipContent>
                    </TooltipPortal>
                  </Tooltip>
                </div>
              </div>
              <div class="terminal-chrome-body relative min-h-0 min-w-0 flex-1 overflow-hidden" />
            </div>
          )}
        </Show>
      )}
    </Show>
  );
};
