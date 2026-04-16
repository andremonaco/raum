import { render, screen, fireEvent } from "@solidjs/testing-library";
import { describe, it, expect, beforeEach } from "vitest";
import { GlobalSearchPanel } from "./global-search-panel";
import { registerTerminal, __clearRegistryForTests } from "../lib/terminalRegistry";
import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";

function fakeTerminal(lines: string[]): Terminal {
  const buffer = {
    active: {
      length: lines.length,
      getLine(y: number) {
        const text = lines[y];
        if (text === undefined) return undefined;
        return {
          translateToString: (_trimRight?: boolean) => text,
        };
      },
    },
  };
  return { buffer } as unknown as Terminal;
}

describe("<GlobalSearchPanel>", () => {
  beforeEach(() => {
    __clearRegistryForTests();
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
      scrollToLine: () => undefined,
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
});
