/**
 * `<PromptOverlay>` — render-branch and dedup coverage.
 *
 * Mocks the `firstPromptCache` module so we can drive the lazy first
 * prompt synchronously without spinning up a Tauri channel. The
 * `lastPrompt` half is fed through the real `setLastPrompt` helper
 * since `terminalStore` has no test-only injection seam and going
 * through the public API exercises the index updates the same way the
 * production event flow does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";

vi.mock("../lib/firstPromptCache", () => {
  const cache: Record<string, string | null> = {};
  return {
    firstPromptForSession: (id: string | null | undefined) => (id ? cache[id] : undefined),
    ensureFirstPromptLoaded: () => {},
    __setFirstPromptForTests: (id: string, text: string | null) => {
      cache[id] = text;
    },
    __clearFirstPromptForTests: () => {
      for (const key of Object.keys(cache)) delete cache[key];
    },
  };
});

// The vi.mock above replaces this module with the in-memory cache.
// Cast to the mock's shape since the production module doesn't expose
// these test-only setters.
import * as firstPromptCache from "../lib/firstPromptCache";
const mockedCache = firstPromptCache as unknown as {
  __setFirstPromptForTests: (id: string, text: string | null) => void;
  __clearFirstPromptForTests: () => void;
};
const __setFirstPromptForTests = mockedCache.__setFirstPromptForTests;
const __clearFirstPromptForTests = mockedCache.__clearFirstPromptForTests;
import PromptOverlay from "./prompt-overlay";
import { removeTerminal, setLastPrompt, upsertTerminal } from "../stores/terminalStore";

const SESSION = "test-session";

function seedSession(): void {
  upsertTerminal({
    session_id: SESSION,
    project_slug: "p",
    worktree_id: null,
    kind: "claude-code",
    created_unix: 0,
  });
}

describe("<PromptOverlay>", () => {
  beforeEach(() => {
    __clearFirstPromptForTests();
    seedSession();
  });

  afterEach(() => {
    cleanup();
    removeTerminal(SESSION);
  });

  it("renders nothing when neither prompt is known", () => {
    const { container } = render(() => <PromptOverlay sessionId={SESSION} visible={true} />);
    expect(container.querySelector('[data-testid="prompt-overlay"]')).toBeNull();
  });

  it("renders nothing on a fresh harness with a stale cached first prompt", () => {
    // Regression: the backend resolves "first prompt" by picking the
    // newest jsonl in the worktree. For a brand-new pane that hasn't
    // submitted any prompt yet, that file belongs to a *different*
    // session. Without the live `lastPrompt` gate, the overlay would
    // surface another harness's task. The cache is pre-seeded here to
    // simulate that stale lookup result.
    __setFirstPromptForTests(SESSION, "leftover task from a previous session");
    const { container } = render(() => <PromptOverlay sessionId={SESSION} visible={true} />);
    expect(container.querySelector('[data-testid="prompt-overlay"]')).toBeNull();
  });

  it("renders only Task when first prompt is known and equals the latest", () => {
    __setFirstPromptForTests(SESSION, "investigate the leak");
    setLastPrompt(SESSION, { text: "investigate the leak", submittedAtMs: 1 });
    render(() => <PromptOverlay sessionId={SESSION} visible={true} />);
    const overlay = screen.getByTestId("prompt-overlay");
    expect(overlay.textContent).toContain("Task");
    expect(overlay.textContent).toContain("investigate the leak");
    expect(overlay.textContent).not.toContain("Latest");
    // Lone Task spans the whole grid in 2-col mode; otherwise wide
    // panes show the prompt squeezed into the left column with empty
    // space on the right.
    const cell = overlay.querySelector('[class*="min-w-0"]');
    expect(cell?.className).toContain("@[480px]:col-span-2");
  });

  it("does not span both columns when Task and Latest are both present", () => {
    __setFirstPromptForTests(SESSION, "investigate the leak");
    setLastPrompt(SESSION, { text: "now add tests", submittedAtMs: 1 });
    render(() => <PromptOverlay sessionId={SESSION} visible={true} />);
    const overlay = screen.getByTestId("prompt-overlay");
    const cells = overlay.querySelectorAll('[class*="min-w-0"]');
    expect(cells.length).toBe(2);
    cells.forEach((cell) => {
      expect(cell.className).not.toContain("col-span-2");
    });
  });

  it("renders Task + Latest when both prompts are known and differ", () => {
    __setFirstPromptForTests(SESSION, "investigate the leak");
    setLastPrompt(SESSION, { text: "now add a regression test", submittedAtMs: 1 });
    render(() => <PromptOverlay sessionId={SESSION} visible={true} />);
    const overlay = screen.getByTestId("prompt-overlay");
    expect(overlay.textContent).toContain("Task");
    expect(overlay.textContent).toContain("investigate the leak");
    expect(overlay.textContent).toContain("Latest");
    expect(overlay.textContent).toContain("now add a regression test");
  });

  it("dedups when last prompt equals first prompt", () => {
    __setFirstPromptForTests(SESSION, "investigate the leak");
    setLastPrompt(SESSION, { text: "  investigate   the leak  ", submittedAtMs: 1 });
    render(() => <PromptOverlay sessionId={SESSION} visible={true} />);
    const overlay = screen.getByTestId("prompt-overlay");
    expect(overlay.textContent).toContain("Task");
    expect(overlay.textContent).not.toContain("Latest");
  });

  it("falls back to labeling last as Task when first is unknown", () => {
    setLastPrompt(SESSION, { text: "fix the typo", submittedAtMs: 1 });
    render(() => <PromptOverlay sessionId={SESSION} visible={true} />);
    const overlay = screen.getByTestId("prompt-overlay");
    expect(overlay.textContent).toContain("Task");
    expect(overlay.textContent).toContain("fix the typo");
    expect(overlay.textContent).not.toContain("Latest");
  });

  it("declares itself a CSS container so column count tracks pane width", () => {
    // Layout responsiveness lives entirely in CSS container queries
    // (no JS observer); guard against a regression that drops
    // `@container` and silently breaks the wide-pane two-column mode.
    __setFirstPromptForTests(SESSION, "investigate the leak");
    setLastPrompt(SESSION, { text: "now add a regression test", submittedAtMs: 1 });
    render(() => <PromptOverlay sessionId={SESSION} visible={true} />);
    const overlay = screen.getByTestId("prompt-overlay");
    expect(overlay.className).toContain("@container");
    // The grid switches to 2 cols at the @[480px] breakpoint.
    const gridChild = overlay.querySelector("div");
    expect(gridChild?.className).toContain("@[480px]:grid-cols-2");
  });

  it("toggles opacity classes from the visible prop", () => {
    __setFirstPromptForTests(SESSION, "task");
    setLastPrompt(SESSION, { text: "task", submittedAtMs: 1 });
    const { unmount } = render(() => <PromptOverlay sessionId={SESSION} visible={false} />);
    let overlay = screen.getByTestId("prompt-overlay");
    expect(overlay.className).toContain("opacity-0");
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    unmount();

    render(() => <PromptOverlay sessionId={SESSION} visible={true} />);
    overlay = screen.getByTestId("prompt-overlay");
    expect(overlay.className).toContain("opacity-100");
    expect(overlay.getAttribute("aria-hidden")).toBe("false");
  });
});
