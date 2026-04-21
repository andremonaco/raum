import { render, screen, fireEvent } from "@solidjs/testing-library";
import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { GlobalSearchPanel } from "./global-search-panel";
import { registerTerminal, __clearRegistryForTests } from "../lib/terminalRegistry";
import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";

function fakeTerminal(lines: string[]): Terminal {
  const bufferView = {
    type: "normal" as const,
    length: lines.length,
    getLine(y: number) {
      const text = lines[y];
      if (text === undefined) return undefined;
      return {
        translateToString: (_trimRight?: boolean) => text,
      };
    },
  };
  const buffer = {
    active: bufferView,
    normal: bufferView,
  };
  return { buffer } as unknown as Terminal;
}

describe("<GlobalSearchPanel>", () => {
  beforeEach(() => {
    __clearRegistryForTests();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "terminal_capture_text") return [];
      if (cmd === "project_find_files") return [];
      return [];
    });
  });

  it("renders nothing when closed", () => {
    render(() => <GlobalSearchPanel open={false} onClose={() => undefined} />);
    expect(screen.queryByTestId("global-search-panel")).toBeNull();
  });

  it("groups matches by pane when open", async () => {
    registerTerminal({
      paneId: "pane-1",
      sessionId: "s-1",
      kind: "shell",
      projectSlug: null,
      worktreeId: null,
      terminal: fakeTerminal(["hello world", "another hello line", "no match here"]),
      search: {} as SearchAddon,
      revealBufferLine: () => undefined,
      focus: () => undefined,
    });

    render(() => <GlobalSearchPanel open={true} onClose={() => undefined} />);

    const input = screen.getByPlaceholderText(
      /search all terminal scrollback/i,
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "hello" } });

    // Let the microtask-yielding search complete.
    await new Promise<void>((r) => setTimeout(r, 20));

    const hits = await screen.findAllByRole("button", { name: /hello/i });
    // 2 match buttons + the close button; assert at least the two matches.
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces tmux-only matches from the backend capture", async () => {
    // xterm alt-screen frame has scrolled the old output off; tmux still
    // holds it in its history-limit. The panel must walk that capture.
    registerTerminal({
      paneId: "pane-1",
      sessionId: "s-1",
      kind: "claude-code",
      projectSlug: null,
      worktreeId: null,
      terminal: fakeTerminal(["current frame without the word"]),
      search: {} as SearchAddon,
      revealBufferLine: () => undefined,
      focus: () => undefined,
    });

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "terminal_capture_text") {
        return [
          {
            sessionId: "s-1",
            normal: "older line with NEEDLE inside\nunrelated tail\n",
            alternate: null,
          },
        ];
      }
      if (cmd === "project_find_files") return [];
      return [];
    });

    render(() => <GlobalSearchPanel open={true} onClose={() => undefined} />);
    const input = screen.getByPlaceholderText(
      /search all terminal scrollback/i,
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "NEEDLE" } });

    // runSearch awaits the IPC result, so give it a tick or two to settle.
    await new Promise<void>((r) => setTimeout(r, 30));

    const hit = await screen.findByRole("button", { name: /NEEDLE/i });
    expect(hit.textContent).toMatch(/tmux/);
  });
});
