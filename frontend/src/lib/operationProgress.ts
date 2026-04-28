/**
 * Step-list state machine + Tauri Channel adapter for streaming long-running
 * backend operations (worktree create / delete / unlink). Mirrors the wire
 * shape produced by `src-tauri/src/commands/worktree_progress.rs`.
 *
 * Usage:
 *
 *   const op = createOperationProgress(CREATE_STEPS);
 *   async function submit() {
 *     const channel = op.start();
 *     await invoke("worktree_create", { ..., onProgress: channel });
 *   }
 *   // JSX:
 *   <OperationProgress steps={op.steps()} counter={op.counter()} failure={op.failure()} />
 */
import { Channel } from "@tauri-apps/api/core";
import { type Accessor, createSignal } from "solid-js";

export type StepStatus = "pending" | "running" | "completed" | "skipped" | "failed";

export interface StepTemplate {
  id: string;
  label: string;
}

export interface Step extends StepTemplate {
  status: StepStatus;
  detail?: string;
}

export interface CounterState {
  id: string;
  current: number;
  total: number;
}

export type ProgressEvent =
  | { kind: "step"; id: string; label: string; status: StepStatus; detail?: string }
  | { kind: "counter"; id: string; current: number; total: number }
  | { kind: "done" }
  | { kind: "failed"; message: string };

export interface OperationProgressApi {
  steps: Accessor<Step[]>;
  counter: Accessor<CounterState | null>;
  failure: Accessor<string | null>;
  /**
   * Reset all reactive state and return a fresh `Channel` to hand to `invoke`.
   * Call this immediately before each backend invocation; reusing a channel
   * across two `invoke` calls is not supported by Tauri.
   */
  start: () => Channel<ProgressEvent>;
}

export function createOperationProgress(template: readonly StepTemplate[]): OperationProgressApi {
  const seed = (): Step[] => template.map((t) => ({ id: t.id, label: t.label, status: "pending" }));

  const [steps, setSteps] = createSignal<Step[]>(seed());
  const [counter, setCounter] = createSignal<CounterState | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);

  const start = (): Channel<ProgressEvent> => {
    setSteps(seed());
    setCounter(null);
    setFailure(null);

    const channel = new Channel<ProgressEvent>();
    channel.onmessage = (ev) => {
      if (ev.kind === "step") {
        setSteps((prev) =>
          prev.map((s) =>
            s.id === ev.id
              ? { ...s, status: ev.status, label: ev.label, detail: ev.detail ?? s.detail }
              : s,
          ),
        );
        // Clear stale counter when a step transitions away from `running`.
        if (ev.status !== "running") {
          setCounter((c) => (c && c.id === ev.id ? null : c));
        }
      } else if (ev.kind === "counter") {
        setCounter({ id: ev.id, current: ev.current, total: ev.total });
      } else if (ev.kind === "failed") {
        setFailure(ev.message);
      }
      // "done" — nothing to update; caller resolves the invoke Promise next.
    };
    return channel;
  };

  return { steps, counter, failure, start };
}
