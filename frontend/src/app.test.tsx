import { render, screen } from "@solidjs/testing-library";
import { describe, it, expect } from "vitest";
import App, { countRecoveredSessions } from "./app";

describe("App shell", () => {
  it("mounts without crashing", () => {
    render(() => <App />);
    expect(screen.getByRole("banner")).toBeInTheDocument();
  });
});

describe("countRecoveredSessions", () => {
  it("counts live sessions not placed into the hydrated layout", () => {
    const placed = new Set(["mounted"]);
    const live = [
      { session_id: "mounted" },
      { session_id: "orphan-a" },
      { session_id: "orphan-b" },
    ];
    expect(countRecoveredSessions(placed, live)).toBe(2);
  });

  it("ignores dead sessions — those route through the in-pane Recover overlay", () => {
    const placed = new Set<string>();
    const live = [{ session_id: "alive" }, { session_id: "ghost", dead: true }];
    expect(countRecoveredSessions(placed, live)).toBe(1);
  });

  it("returns 0 when every live session is already in the grid", () => {
    const placed = new Set(["a", "b"]);
    const live = [{ session_id: "a" }, { session_id: "b" }];
    expect(countRecoveredSessions(placed, live)).toBe(0);
  });

  it("returns 0 for an empty live list", () => {
    expect(countRecoveredSessions(new Set(["a"]), [])).toBe(0);
  });
});
