/**
 * Step-list panel rendered inside long-running operation modals (worktree
 * create / delete, project unlink). Visual states map 1:1 to `StepStatus`
 * from `lib/operationProgress.ts` — pending circle, spinner, green checkmark,
 * dash for skipped, red alert for failed.
 *
 * Restrained chrome on purpose: a thin `border-border-subtle` container with
 * the same typography as the surrounding modal. No glows, no colored stripes.
 */
import { Component, For, Show, splitProps, type ComponentProps } from "solid-js";

import { AlertCircleIcon, CheckIcon, LoaderIcon } from "./icons";
import type { CounterState, Step } from "../lib/operationProgress";

export interface OperationProgressProps {
  steps: Step[];
  counter?: CounterState | null;
  failure?: string | null;
}

export const OperationProgress: Component<OperationProgressProps> = (props) => {
  return (
    <div
      class="rounded-md border border-border-subtle bg-card/50 px-3 py-2.5 text-sm"
      data-slot="operation-progress"
    >
      <ul class="flex flex-col gap-1.5">
        <For each={props.steps}>
          {(step) => (
            <li class="flex items-start gap-2.5">
              <span class="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                <StepIcon status={step.status} />
              </span>
              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span
                  class="truncate font-mono text-xs"
                  classList={{
                    "text-foreground": step.status === "running" || step.status === "completed",
                    "text-muted-foreground": step.status === "pending" || step.status === "skipped",
                    "text-destructive": step.status === "failed",
                  }}
                >
                  {step.label}
                </span>
                <Show when={step.status === "running" && props.counter?.id === step.id}>
                  {(_) => {
                    const c = props.counter!;
                    const pct = c.total > 0 ? Math.min(100, (c.current / c.total) * 100) : 0;
                    return (
                      <div class="flex flex-col gap-1 pt-0.5">
                        <div class="h-0.5 w-full overflow-hidden rounded-full bg-border-subtle">
                          <div
                            class="h-full bg-foreground/60 transition-all duration-150 ease-out"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span class="font-mono text-[10px] text-muted-foreground tabular-nums">
                          {c.current} / {c.total}
                        </span>
                      </div>
                    );
                  }}
                </Show>
                <Show when={step.detail && step.status === "failed"}>
                  <span class="font-mono text-[11px] leading-snug text-destructive/85 [word-break:break-word] whitespace-pre-wrap">
                    {step.detail}
                  </span>
                </Show>
                <Show when={step.detail && step.status === "skipped"}>
                  <span class="font-mono text-[11px] leading-snug text-muted-foreground [word-break:break-word]">
                    {step.detail}
                  </span>
                </Show>
              </div>
            </li>
          )}
        </For>
      </ul>
      <Show when={props.failure}>
        <div class="mt-2 border-t border-border-subtle pt-2 text-[11px] text-destructive [word-break:break-word]">
          {props.failure}
        </div>
      </Show>
    </div>
  );
};

const StepIcon: Component<{ status: Step["status"] }> = (props) => {
  return (
    <Show when={props.status === "running"} fallback={<NonRunningStepIcon status={props.status} />}>
      <LoaderIcon class="size-3.5 animate-spin text-foreground" />
    </Show>
  );
};

const NonRunningStepIcon: Component<{ status: Step["status"] }> = (props) => {
  return (
    <>
      <Show when={props.status === "pending"}>
        <PendingDot />
      </Show>
      <Show when={props.status === "completed"}>
        <CompletedCheck />
      </Show>
      <Show when={props.status === "skipped"}>
        <SkippedDash />
      </Show>
      <Show when={props.status === "failed"}>
        <AlertCircleIcon class="size-3.5 text-destructive" />
      </Show>
    </>
  );
};

const PendingDot: Component<ComponentProps<"svg">> = (props) => {
  const [, rest] = splitProps(props, ["class"]);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="size-3 text-muted-foreground/60"
      aria-hidden="true"
      {...rest}
    >
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
};

const CompletedCheck: Component = () => {
  return (
    <span
      class="inline-flex size-3.5 items-center justify-center rounded-full bg-success/15 text-success"
      aria-hidden="true"
    >
      <CheckIcon class="size-2.5" />
    </span>
  );
};

const SkippedDash: Component<ComponentProps<"svg">> = (props) => {
  const [, rest] = splitProps(props, ["class"]);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="size-3 text-muted-foreground/70"
      aria-hidden="true"
      {...rest}
    >
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
};
