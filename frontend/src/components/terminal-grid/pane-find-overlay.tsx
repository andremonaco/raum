/**
 * In-pane find box (⌘F when a terminal is focused).
 *
 * A small floating control mounted inside a `<TerminalPane>` that drives the
 * pane's own `SearchAddon` (`findNext` / `findPrevious`). It is deliberately
 * scoped to ONE terminal: the global cross-pane spotlight dock owns the app-wide
 * ⌘F search, but when an xterm textarea has focus the pane intercepts ⌘F first
 * (see `terminal-pane.tsx`) and opens this local box instead, so the keystroke
 * acts like a browser's find-in-page on the focused buffer.
 *
 * Match counts come from the addon's `onDidChangeResults` event, which only
 * fires when the search runs with `decorations` enabled — the pane passes a
 * decoration recipe through on every find so the count stays live and matches
 * get highlighted in the buffer + overview ruler.
 */

import { Component, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { SearchAddon, ISearchOptions } from "@xterm/addon-search";

import { cx } from "~/lib/cva";
import { SearchIcon } from "../icons";

export interface PaneFindOverlayProps {
  /** The pane's loaded SearchAddon. `null` until xterm finishes initialising
   *  (jsdom tests never mount it), in which case the box renders inert. */
  search: SearchAddon | null;
  /** Match-highlight colors so decorations read against the active theme. The
   *  pane derives these from CSS vars; we forward them verbatim to the addon. */
  decorations?: ISearchOptions["decorations"];
  /** Close the box and hand focus back to the terminal. */
  onClose: () => void;
}

/**
 * The find box. Self-focuses its input on mount; ⌘F is handled by the parent
 * pane (which toggles the box's mounted state), so this component only owns the
 * in-box keys: Enter / Shift+Enter to step matches, Esc to close.
 */
export const PaneFindOverlay: Component<PaneFindOverlayProps> = (props) => {
  let input: HTMLInputElement | undefined;
  const [query, setQuery] = createSignal("");
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  // -1 active index means "no current match" (threshold exceeded or no hits).
  const [resultIndex, setResultIndex] = createSignal(-1);
  const [resultCount, setResultCount] = createSignal(0);

  const options = (): ISearchOptions => ({
    caseSensitive: caseSensitive(),
    decorations: props.decorations,
  });

  // Re-run the search whenever the query or case toggle changes so the count
  // and active-match highlight track the box live (incremental, like a
  // browser's find-as-you-type). Empty query clears the addon's decorations.
  createEffect(() => {
    const q = query();
    const addon = props.search;
    if (!addon) return;
    if (q.length === 0) {
      try {
        addon.clearDecorations();
      } catch {
        /* best-effort */
      }
      setResultIndex(-1);
      setResultCount(0);
      return;
    }
    try {
      addon.findNext(q, { ...options(), incremental: true });
    } catch {
      /* addon may be mid-dispose */
    }
  });

  const findNext = (): void => {
    const q = query();
    if (!props.search || q.length === 0) return;
    try {
      props.search.findNext(q, options());
    } catch {
      /* best-effort */
    }
  };
  const findPrevious = (): void => {
    const q = query();
    if (!props.search || q.length === 0) return;
    try {
      props.search.findPrevious(q, options());
    } catch {
      /* best-effort */
    }
  };

  const onInputKeyDown = (e: KeyboardEvent): void => {
    // Keep terminal-bound shortcuts from leaking out of the box while the user
    // is typing a query; the box owns the keyboard until it closes.
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) findPrevious();
      else findNext();
      return;
    }
    // ⌘F again while the box is open is a no-op (the box is already here);
    // swallow it so it doesn't bubble to the global dock.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  onMount(() => {
    const addon = props.search;
    if (addon) {
      const disposable = addon.onDidChangeResults((ev) => {
        setResultIndex(ev.resultIndex);
        setResultCount(ev.resultCount);
      });
      onCleanup(() => {
        try {
          disposable.dispose();
        } catch {
          /* best-effort */
        }
        // Drop any lingering match highlights when the box closes.
        try {
          addon.clearDecorations();
        } catch {
          /* best-effort */
        }
      });
    }
    // Defer focus a frame so the box is laid out before we steal focus from
    // the terminal textarea (avoids a focus/scroll jump on open).
    requestAnimationFrame(() => input?.focus());
  });

  const countLabel = (): string => {
    if (query().length === 0) return "";
    if (resultCount() === 0) return "0/0";
    // `resultIndex` is -1 when the match count exceeds the addon's highlight
    // threshold; show just the total in that case rather than a bogus index.
    if (resultIndex() < 0) return `${resultCount()}`;
    return `${resultIndex() + 1}/${resultCount()}`;
  };

  const hasNoMatch = (): boolean => query().length > 0 && resultCount() === 0;

  return (
    <div
      class="floating-surface absolute right-3 top-3 z-30 flex items-center gap-1 rounded-lg border border-border-subtle bg-popover px-1.5 py-1 text-popover-foreground shadow-[var(--shadow-md)]"
      data-testid="pane-find-overlay"
      // Clicks inside the box must not bubble to the terminal (which would
      // re-focus xterm and blur the input mid-search).
      onMouseDown={(e) => e.stopPropagation()}
    >
      <SearchIcon class="ml-1 h-3.5 w-3.5 text-muted-foreground" />
      <input
        ref={(el) => {
          input = el;
        }}
        type="text"
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={onInputKeyDown}
        placeholder="Find in pane"
        spellcheck={false}
        autocapitalize="off"
        autocomplete="off"
        class={cx(
          "focus-ring w-40 rounded-sm bg-transparent px-1 py-0.5 font-mono text-[12px] text-foreground placeholder:text-foreground-subtle",
          hasNoMatch() && "text-destructive",
        )}
      />
      <span class="min-w-[3.5rem] select-none px-1 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {countLabel()}
      </span>
      <button
        type="button"
        class="focus-ring flex h-6 w-6 items-center justify-center rounded-sm text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        onClick={findPrevious}
      >
        <span aria-hidden="true" class="text-[13px] leading-none">
          &uarr;
        </span>
      </button>
      <button
        type="button"
        class="focus-ring flex h-6 w-6 items-center justify-center rounded-sm text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
        title="Next match (Enter)"
        aria-label="Next match"
        onClick={findNext}
      >
        <span aria-hidden="true" class="text-[13px] leading-none">
          &darr;
        </span>
      </button>
      <button
        type="button"
        class={cx(
          "focus-ring flex h-6 items-center justify-center rounded-sm px-1.5 font-mono text-[11px] font-semibold transition-colors",
          caseSensitive()
            ? "bg-active text-foreground"
            : "text-foreground-subtle hover:bg-hover hover:text-foreground",
        )}
        title="Match case"
        aria-label="Match case"
        aria-pressed={caseSensitive()}
        onClick={() => setCaseSensitive((v) => !v)}
      >
        Aa
      </button>
      <button
        type="button"
        class="focus-ring flex h-6 w-6 items-center justify-center rounded-sm text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
        title="Close (Esc)"
        aria-label="Close find"
        onClick={() => props.onClose()}
      >
        <span aria-hidden="true" class="text-[13px] leading-none">
          &times;
        </span>
      </button>
    </div>
  );
};

export default PaneFindOverlay;
