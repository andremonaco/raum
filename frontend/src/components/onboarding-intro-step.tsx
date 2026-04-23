/**
 * §13.0 — Onboarding intro (Step 0).
 *
 * Welcome screen shown before the prerequisites check. Renders a small mock
 * of the raum app shell (top bar + sidebar + pane grid) that narrates how
 * the grid grows and contracts as harnesses are spawned and closed: the
 * pane count oscillates 1 → 2 → 3 → 4 → 3 → 2 → 1 → … as a seamless
 * palindrome. Additions use BSP-style splits (vertical first, then right
 * horizontal, then left horizontal) and removals run the same transitions
 * in reverse. There is no hard reset — the loop never snaps.
 *
 * On `prefers-reduced-motion: reduce` the loop is skipped entirely and the
 * mock renders statically at its final 4-pane layout.
 */

import { Component, For, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { HARNESS_ICONS, type HarnessIconKind } from "./icons";
import { RaumLogo } from "./icons/raum-logo";

const TOPBAR_HARNESSES: HarnessIconKind[] = ["claude-code", "codex", "opencode"];
const PANE_HARNESSES: HarnessIconKind[] = ["claude-code", "codex", "opencode", "shell"];
const BAR_WIDTHS = ["60%", "85%", "42%", "72%"];

type PaneRect = readonly [x: number, y: number, w: number, h: number];

// BSP-style splits, mirroring how the real TerminalGrid grows:
//   count=1: A fills
//   count=2: A | B  (vertical split)
//   count=3: A | B / C  (right side splits horizontally)
//   count=4: A / D | B / C  (left side splits horizontally too)
function paneLayout(paneIndex: number, count: number): PaneRect {
  switch (paneIndex) {
    case 0:
      if (count <= 1) return [0, 0, 100, 100];
      if (count <= 3) return [0, 0, 50, 100];
      return [0, 0, 50, 50];
    case 1:
      if (count === 2) return [50, 0, 50, 100];
      return [50, 0, 50, 50];
    case 2:
      return [50, 50, 50, 50];
    case 3:
    default:
      return [0, 50, 50, 50];
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const OnboardingIntroStep: Component = () => {
  const [count, setCount] = createSignal(0);

  onMount(() => {
    if (prefersReducedMotion()) {
      setCount(4);
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    const schedule = (delay: number, fn: () => void) => {
      timer = window.setTimeout(() => {
        if (cancelled) return;
        fn();
      }, delay);
    };

    // Dwell slightly longer on the endpoints (1 and 4) so the eye registers
    // the "empty" and "full" framings before the loop turns.
    const dwellFor = (c: number): number => (c === 1 || c === 4 ? 2200 : 1600);

    const tick = (c: number, direction: 1 | -1) => {
      if (cancelled) return;
      setCount(c);
      let nextC = c + direction;
      let nextDir: 1 | -1 = direction;
      if (nextC > 4) {
        nextC = 3;
        nextDir = -1;
      } else if (nextC < 1) {
        nextC = 2;
        nextDir = 1;
      }
      schedule(dwellFor(c), () => tick(nextC, nextDir));
    };

    schedule(200, () => tick(1, 1));

    onCleanup(() => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    });
  });

  const paneStyle = (paneIndex: number): JSX.CSSProperties => {
    const c = count();
    const effective = Math.max(c, 1);
    const visible = paneIndex < c;
    const [x, y, w, h] = paneLayout(paneIndex, effective);
    return {
      left: `calc(${x}% + 3px)`,
      top: `calc(${y}% + 3px)`,
      width: `calc(${w}% - 6px)`,
      height: `calc(${h}% - 6px)`,
      opacity: visible ? 1 : 0,
      transform: visible ? "scale(1)" : "scale(0.92)",
    };
  };

  return (
    <div data-testid="onboarding-intro">
      <div class="raum-mock" aria-hidden="true">
        <div class="raum-mock__topbar">
          <RaumLogo class="raum-mock__logo" />
          <For each={TOPBAR_HARNESSES}>
            {(kind) => {
              const Icon = HARNESS_ICONS[kind];
              return (
                <span class="raum-mock__spawn">
                  <Icon class="raum-mock__spawn-icon" />
                </span>
              );
            }}
          </For>
          <span class="raum-mock__spacer" />
          <span class="raum-mock__pill" />
          <span class="raum-mock__pill" />
        </div>
        <div class="raum-mock__body">
          <div class="raum-mock__sidebar">
            <For each={[0, 1, 2, 3, 4]}>{() => <span class="raum-mock__row" />}</For>
          </div>
          <div class="raum-mock__grid">
            <For each={PANE_HARNESSES}>
              {(kind, i) => {
                const Icon = HARNESS_ICONS[kind];
                return (
                  <div class="raum-mock__pane" style={paneStyle(i())}>
                    <div class="raum-mock__pane-header">
                      <span class="raum-mock__pane-icon">
                        <Icon class="raum-mock__pane-icon-svg" />
                      </span>
                      <span class="raum-mock__pane-dot" />
                      <span class="raum-mock__pane-dot" />
                    </div>
                    <div class="raum-mock__pane-body">
                      <For each={BAR_WIDTHS}>
                        {(width, bi) => (
                          <span
                            class="raum-mock__bar"
                            style={{ width, "--bar-index": String(bi()) }}
                          />
                        )}
                      </For>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </div>
      </div>

      <h3 class="raum-intro-bullet mt-5 text-base font-medium" style={{ "--i": 0 }}>
        raum is your productivity agent workbench.
      </h3>
      <p class="raum-intro-bullet mt-1 text-sm text-muted-foreground" style={{ "--i": 1 }}>
        One IDE-shaped surface for the CLI agents you already use.
      </p>
      <ul class="mt-4 space-y-2 text-sm">
        <For
          each={[
            "Keyboard-first — every action has a shortcut",
            "OS notifications when an agent needs you",
            "Global search across sessions, files, and projects (⌘F)",
            "Worktrees with copy or symlink hydration",
            "Stage and unstage from the sidebar",
            "Edit files in-app with a real editor",
          ]}
        >
          {(text, i) => (
            <li class="raum-intro-bullet flex gap-2" style={{ "--i": i() + 2 }}>
              <span class="text-muted-foreground" aria-hidden="true">
                •
              </span>
              <span>{text}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
};

export default OnboardingIntroStep;
