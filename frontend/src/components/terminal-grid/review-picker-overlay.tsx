import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import { type AgentKind } from "../../lib/agentKind";
import { spawnReviewerPane } from "../../stores/runtimeLayoutStore";
import { CheckIcon, ChevronDownIcon, HARNESS_ICONS } from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  clearReviewPicker,
  pendingReviewPicker,
  type PendingReviewPicker,
} from "./review-picker-store";

/**
 * Wire shape mirroring `raum_core::harness::HarnessModel`.
 */
interface HarnessModel {
  id: string;
  label: string;
  supportedEfforts: string[];
  defaultEffort?: string;
}

/**
 * Pre-spawn picker for cross-harness review. The dwell-armed snap fires
 * `prepare_review`; instead of spawning the reviewer immediately, we set
 * `pendingReviewPicker` with the snap's target cell and the brief payload.
 * This overlay reads that state, fetches the available models for the
 * reviewer's harness kind via the `list_harness_models` Tauri command, and
 * presents a model + effort picker. Confirm fires the spawn; cancel
 * (Esc / outside-click) drops the review entirely without leaving artefacts.
 *
 * The picker is keyed on the **source pane's** harness kind (carried as
 * `payload.reviewerKind`). Dragging a Claude pane onto a Codex pane shows
 * **Claude** models — because the reviewer that's about to spawn is Claude.
 * That mirrors the existing review-spawn semantics; the target's harness
 * never gets a say in which model the reviewer picks.
 *
 * Mounted from `<LeafFrame>` so it inherits the cell's container query and
 * sizes itself relative to the pane (same approach as `<FileDropOverlay>`,
 * see commit `7c08bbe`).
 */
export const ReviewPickerOverlay: Component<{ cellId: string }> = (props) => {
  const active = createMemo<PendingReviewPicker | null>(() => {
    const p = pendingReviewPicker();
    if (!p) return null;
    return p.targetCellId === props.cellId ? p : null;
  });

  return <Show when={active()}>{(picker) => <PickerBody picker={picker()} />}</Show>;
};

const PickerBody: Component<{ picker: PendingReviewPicker }> = (props) => {
  const reviewerKind = (): AgentKind => props.picker.payload.reviewerKind;

  const [models] = createResource(reviewerKind, async (kind) => {
    try {
      const out = await invoke<HarnessModel[]>("list_harness_models", { kind });
      return out;
    } catch (e) {
      console.warn("[review-picker] list_harness_models failed", e);
      return [] as HarnessModel[];
    }
  });

  const [selectedModelId, setSelectedModelId] = createSignal<string | null>(null);
  const [selectedEffort, setSelectedEffort] = createSignal<string | null>(null);

  // Default the model to the first list entry once it lands.
  const ensureDefaultSelection = (): void => {
    const list = models();
    if (!list || list.length === 0) return;
    if (selectedModelId() === null) {
      setSelectedModelId(list[0].id);
      setSelectedEffort(list[0].defaultEffort ?? list[0].supportedEfforts[0] ?? null);
    }
  };

  const currentModel = createMemo<HarnessModel | undefined>(() => {
    const list = models();
    if (!list) return undefined;
    return list.find((m) => m.id === selectedModelId());
  });

  // Keep the effort consistent with the selected model: when the user picks a
  // different model, snap to its `defaultEffort` (or first supported), so the
  // segmented control never advertises a level the model doesn't accept.
  const onChangeModel = (id: string): void => {
    setSelectedModelId(id);
    const list = models() ?? [];
    const m = list.find((x) => x.id === id);
    if (!m) return;
    setSelectedEffort(m.defaultEffort ?? m.supportedEfforts[0] ?? null);
  };

  const startReview = (): void => {
    const list = models();
    const id = selectedModelId();
    if (!id || !list) {
      cancel();
      return;
    }
    const effort = selectedEffort();
    const m = list.find((x) => x.id === id);
    const useEffort = m && effort && m.supportedEfforts.includes(effort) ? effort : undefined;
    spawnReviewerPane(props.picker.targetCellId, {
      kind: props.picker.payload.reviewerKind,
      projectSlug: props.picker.payload.projectSlug,
      worktreeId: props.picker.payload.worktreeId ?? undefined,
      initialPrompt: props.picker.payload.initialPrompt,
      reviewedSessionId: props.picker.payload.reviewedSessionId,
      modelOverride: { model: id, effort: useEffort },
    });
    clearReviewPicker();
  };

  // Spawn without an override — used by the "use default" recovery path when
  // discovery fails (e.g. opencode binary missing on PATH).
  const startWithoutOverride = (): void => {
    spawnReviewerPane(props.picker.targetCellId, {
      kind: props.picker.payload.reviewerKind,
      projectSlug: props.picker.payload.projectSlug,
      worktreeId: props.picker.payload.worktreeId ?? undefined,
      initialPrompt: props.picker.payload.initialPrompt,
      reviewedSessionId: props.picker.payload.reviewedSessionId,
    });
    clearReviewPicker();
  };

  const cancel = (): void => {
    clearReviewPicker();
  };

  // Esc cancels, Enter confirms.
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      cancel();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      startReview();
    }
  };

  onMount(() => {
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // The resource resolves async; once it lands, snap to the first entry.
  createEffect(() => {
    if (models() !== undefined) ensureDefaultSelection();
  });

  const Icon = createMemo(() => HARNESS_ICONS[reviewerKind() as keyof typeof HARNESS_ICONS]);

  const refresh = async (): Promise<void> => {
    try {
      await invoke<HarnessModel[]>("list_harness_models_refresh", { kind: reviewerKind() });
    } catch (e) {
      console.warn("[review-picker] refresh failed", e);
      return;
    }
    setSelectedModelId(null);
    setSelectedEffort(null);
  };

  return (
    <div
      class="review-picker-overlay absolute inset-0 z-40 flex flex-col items-center justify-center text-center"
      data-testid="review-picker-overlay"
      onClick={(ev) => {
        // Click on the backdrop (this element, not the inner card) cancels.
        if (ev.target === ev.currentTarget) cancel();
      }}
    >
      <div class="review-picker-card" onClick={(ev) => ev.stopPropagation()}>
        <div class="review-picker-header">
          <div class="review-picker-icon">
            {(() => {
              const I = Icon();
              return I ? <I class="review-picker-harness-icon" /> : null;
            })()}
          </div>
          <div class="review-picker-title">
            <div class="review-picker-eyebrow">Review with</div>
            <div class="review-picker-kind">{reviewerKind()}</div>
          </div>
        </div>

        <Show
          when={!models.loading}
          fallback={<div class="review-picker-skeleton">Loading models…</div>}
        >
          <Show
            when={(models()?.length ?? 0) > 0}
            fallback={
              <div class="review-picker-empty">
                <p>No models discovered for {reviewerKind()}.</p>
                <button class="review-picker-button" type="button" onClick={startWithoutOverride}>
                  Use default config
                </button>
              </div>
            }
          >
            <div class="review-picker-row">
              <span class="review-picker-label">Model</span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  as="button"
                  type="button"
                  class="review-picker-select"
                  aria-label="Select model"
                >
                  <span class="review-picker-select-label">
                    {currentModel()?.label ?? "Select a model…"}
                  </span>
                  <ChevronDownIcon class="review-picker-select-chevron" />
                </DropdownMenuTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuContent class="review-picker-menu">
                    <For each={models() ?? []}>
                      {(m) => (
                        <DropdownMenuItem
                          class="review-picker-menu-item"
                          onSelect={() => onChangeModel(m.id)}
                        >
                          <CheckIcon
                            class="review-picker-menu-check"
                            classList={{ "is-current": selectedModelId() === m.id }}
                          />
                          <span>{m.label}</span>
                        </DropdownMenuItem>
                      )}
                    </For>
                  </DropdownMenuContent>
                </DropdownMenuPortal>
              </DropdownMenu>
              <button
                class="review-picker-icon-button"
                type="button"
                aria-label="Refresh models"
                title="Refresh models"
                onClick={() => void refresh()}
              >
                ↻
              </button>
            </div>

            <Show when={(currentModel()?.supportedEfforts.length ?? 0) > 0}>
              <div class="review-picker-row">
                <label class="review-picker-label">Effort</label>
                <div class="review-picker-segmented" role="radiogroup">
                  <For each={currentModel()?.supportedEfforts ?? []}>
                    {(effort) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selectedEffort() === effort}
                        class="review-picker-segment"
                        classList={{ "is-selected": selectedEffort() === effort }}
                        onClick={() => setSelectedEffort(effort)}
                      >
                        {effort}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </Show>
        </Show>

        <div class="review-picker-actions">
          <button class="review-picker-button is-ghost" type="button" onClick={cancel}>
            Cancel
          </button>
          <button
            class="review-picker-button is-primary"
            type="button"
            onClick={startReview}
            disabled={selectedModelId() === null}
          >
            Start review
          </button>
        </div>
      </div>
    </div>
  );
};
