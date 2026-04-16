import { render, screen } from "@solidjs/testing-library";
import { describe, it, expect } from "vitest";
import App from "./app";

describe("App shell", () => {
  it("mounts without crashing", () => {
    render(() => <App />);
    expect(screen.getByRole("banner")).toBeInTheDocument();
  });
});
