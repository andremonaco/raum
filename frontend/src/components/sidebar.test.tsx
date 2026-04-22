/**
 * §9 — Sidebar unit tests.
 *
 * We keep the suite focused on the pieces that *don't* require Tauri:
 *  • the dirty-indicator heuristic on the WorktreeStatus payload.
 *  • the "no projects" fallback render.
 *
 * Tauri-dependent behaviour (status polling, openPath, terminal_spawn) is
 * covered by Rust-side tests + the Wave 3A integration harness.
 */

import { render, screen, cleanup } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { Sidebar, buildCommitCommand, shellQuote } from "./sidebar";

afterEach(() => {
  cleanup();
});

describe("Sidebar", () => {
  it("renders the empty-state hint when no projects are registered", () => {
    render(() => <Sidebar />);
    expect(screen.getByText("No projects registered yet.")).toBeInTheDocument();
  });
});

describe("shellQuote", () => {
  it("wraps a plain string in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes using the POSIX '\\'' idiom", () => {
    expect(shellQuote("it's a test")).toBe("'it'\\''s a test'");
  });

  it("preserves double quotes and special characters untouched", () => {
    expect(shellQuote('say "hi" $PATH')).toBe(`'say "hi" $PATH'`);
  });
});

describe("buildCommitCommand", () => {
  it("returns an empty string for an empty or whitespace-only draft", () => {
    expect(buildCommitCommand("")).toBe("");
    expect(buildCommitCommand("   \n\n  ")).toBe("");
  });

  it("builds a single -m command for a subject-only draft", () => {
    expect(buildCommitCommand("fix the bug")).toBe("git commit -m 'fix the bug'");
  });

  it("splits paragraphs on blank lines into separate -m flags", () => {
    expect(buildCommitCommand("subject\n\nbody line one\n\nbody line two")).toBe(
      "git commit -m 'subject' -m 'body line one' -m 'body line two'",
    );
  });

  it("escapes single quotes inside paragraphs", () => {
    expect(buildCommitCommand("it's working")).toBe("git commit -m 'it'\\''s working'");
  });
});
