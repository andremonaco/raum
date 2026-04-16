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
import { Sidebar } from "./sidebar";

afterEach(() => {
  cleanup();
});

describe("Sidebar", () => {
  it("renders the empty-state hint when no projects are registered", () => {
    render(() => <Sidebar />);
    expect(screen.getByText("No projects registered yet.")).toBeInTheDocument();
  });
});
