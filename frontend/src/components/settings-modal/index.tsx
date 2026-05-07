/**
 * General settings modal for raum.
 *
 * Two-pane layout (inspired by Canopy):
 *   - Left  — narrow nav sidebar listing settings sections
 *   - Right — content panel for the active section
 *
 * Sections:
 *   - Appearance    — theme picker + per-pane prompt overlay toggle
 *   - Notifications — OS permission + when-to-notify toggles + sound
 *   - Harnesses     — per-harness extra CLI flags appended at spawn time
 *   - Worktrees     — worktree path-pattern preset + custom editor
 *   - Updates       — in-app updater + release-channel hooks
 */

import { Component, For, createSignal } from "solid-js";
import { Dialog as DialogPrimitive } from "@kobalte/core/dialog";

import { cx } from "~/lib/cva";

import { Scrollable } from "../ui/scrollable";

import { AppearanceSection } from "./appearance";
import { HarnessesSection } from "./harnesses";
import { NotificationsSection } from "./notifications";
import { SECTIONS } from "./nav";
import type { SectionId } from "./types";
import { UpdatesSection } from "./updates";
import { WorktreesSection } from "./worktrees";

// ---------------------------------------------------------------------------
// Section router
// ---------------------------------------------------------------------------

/**
 * All sections are always mounted while the modal is open and toggled via
 * `hidden`. Mounting either section the first time involves a non-trivial
 * amount of JSX (4 harness cards, multiple `<Show>` blocks, text inputs) and
 * an IPC round-trip — doing that work on every tab click made switching feel
 * laggy. Paying it once on modal open keeps subsequent tab switches at the
 * cost of a CSS class flip.
 */
const SectionContent: Component<{ section: SectionId; open: boolean }> = (props) => {
  return (
    <>
      <div class={cx(props.section === "appearance" ? "" : "hidden")}>
        <AppearanceSection />
      </div>
      <div class={cx(props.section === "notifications" ? "" : "hidden")}>
        <NotificationsSection active={props.section === "notifications"} open={props.open} />
      </div>
      <div class={cx(props.section === "harnesses" ? "" : "hidden")}>
        <HarnessesSection active={props.section === "harnesses"} />
      </div>
      <div class={cx(props.section === "worktrees" ? "" : "hidden")}>
        <WorktreesSection active={props.section === "worktrees"} />
      </div>
      <div class={cx(props.section === "updates" ? "" : "hidden")}>
        <UpdatesSection />
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export const SettingsModal: Component<SettingsModalProps> = (props) => {
  const [activeSection, setActiveSection] = createSignal<SectionId>("appearance");

  return (
    <DialogPrimitive open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogPrimitive.Portal>
        {/* Overlay */}
        <DialogPrimitive.Overlay class="data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 fixed inset-0 z-50 bg-scrim-strong" />

        {/* Modal shell */}
        <DialogPrimitive.Content class="floating-surface data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95 fixed top-[50%] left-[50%] z-50 flex h-[min(780px,calc(100vh-2rem))] max-h-[780px] w-[min(1000px,calc(100vw-2rem))] max-w-[1000px] translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden rounded-xl border border-border-subtle bg-popover duration-200 focus:outline-none">
          {/* Title row (visually hidden, for accessibility) */}
          <DialogPrimitive.Title class="sr-only">Settings</DialogPrimitive.Title>

          {/* Body: left sidebar + right content */}
          <div class="flex min-h-0 flex-1 overflow-hidden">
            {/* Left nav sidebar */}
            <div class="flex w-40 shrink-0 flex-col border-r border-border-subtle bg-panel">
              {/* Sidebar header */}
              <div class="flex h-9 items-center px-3">
                <span class="text-xs text-foreground">Settings</span>
              </div>

              {/* Nav items */}
              <Scrollable class="min-h-0 flex-1 px-1.5 pb-1.5">
                <p class="mb-0.5 px-1.5 pt-2 text-[9px] uppercase tracking-wider text-muted-foreground/50">
                  General
                </p>
                <For each={SECTIONS}>
                  {(section) => (
                    <button
                      type="button"
                      class={cx(
                        "flex w-full items-center gap-2 rounded px-1.5 py-1 text-[11px] transition-colors focus:outline-none focus-visible:outline-none",
                        activeSection() === section.id
                          ? "bg-accent text-accent-foreground font-medium"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                      onClick={() => setActiveSection(section.id)}
                    >
                      {section.icon()}
                      {section.label}
                    </button>
                  )}
                </For>
              </Scrollable>
            </div>

            {/* Right content */}
            <div class="flex min-w-0 flex-1 flex-col">
              {/* Content header bar */}
              <div class="flex h-9 shrink-0 items-center justify-between border-b border-border px-4">
                <span class="text-xs text-foreground">
                  {SECTIONS.find((s) => s.id === activeSection())?.label}
                </span>
                <DialogPrimitive.CloseButton
                  class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Close settings"
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
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </DialogPrimitive.CloseButton>
              </div>

              {/* Scrollable content area */}
              <Scrollable class="min-h-0 flex-1 px-4 py-4">
                <SectionContent section={activeSection()} open={props.open} />
              </Scrollable>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive>
  );
};

export default SettingsModal;
