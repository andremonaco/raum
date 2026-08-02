/**
 * Shared find / replace bar.
 *
 * Purely presentational: it owns the query text boxes, the option toggles and
 * the in-box keys, and reports every intent through callbacks. Matching is the
 * host's business — the file editor drives `@codemirror/search`, the diff
 * viewer drives a plain text scan — so the same control serves both.
 *
 * Styling mirrors the terminal's in-pane find box (`pane-find-overlay.tsx`) so
 * the two read as one control in different places. The replace row only
 * renders when the host wires the replace callbacks.
 *
 * Escape is swallowed here on purpose: both host modals close themselves on
 * Escape, and the first Escape must only close the bar.
 */

import { Component, Show, createSignal, onMount } from "solid-js";

import { cx } from "~/lib/cva";
import { ChevronDownIcon, ChevronRightIcon, SearchIcon } from "../icons";

export interface FindBarHandle {
  /** Focus and select the query input (⌘F while the bar is already open). */
  focus: () => void;
}

export interface FindBarProps {
  query: string;
  onQueryChange: (value: string) => void;
  placeholder?: string;

  caseSensitive: boolean;
  onToggleCaseSensitive: () => void;
  regexp: boolean;
  onToggleRegexp: () => void;

  /** Total matches (a lower bound when `capped`). */
  count: number;
  /** 0-based index of the active match, or -1 when none is current. */
  index: number;
  capped?: boolean;
  /** Tooltip explaining what the `n+` count means for this host — the two
   *  hosts cap different things (counting vs. the navigable set). */
  capNote?: string;
  /** True when `regexp` is on and the pattern doesn't compile. */
  invalid?: boolean;

  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;

  /** Replace support. Omit `onReplaceChange` to render a find-only bar. */
  replace?: string;
  onReplaceChange?: (value: string) => void;
  showReplace?: boolean;
  onToggleReplace?: () => void;
  onReplaceOne?: () => void;
  onReplaceAll?: () => void;

  ref?: (handle: FindBarHandle) => void;
}

export const FindBar: Component<FindBarProps> = (props) => {
  let queryInput: HTMLInputElement | undefined;
  const [replaceRef, setReplaceRef] = createSignal<HTMLInputElement | undefined>();

  const canReplace = (): boolean => props.onReplaceChange !== undefined;
  const hasNoMatch = (): boolean =>
    props.query.length > 0 && (props.count === 0 || props.invalid === true);

  const countLabel = (): string => {
    if (props.query.length === 0) return "";
    if (props.invalid) return "!";
    if (props.count === 0) return "0/0";
    if (props.capped) return `${props.count}+`;
    if (props.index < 0) return `${props.count}`;
    return `${props.index + 1}/${props.count}`;
  };

  const focusQuery = (): void => {
    queryInput?.focus();
    queryInput?.select();
  };

  onMount(() => {
    props.ref?.({ focus: focusQuery });
    // Defer a frame so the bar is laid out before it steals focus.
    requestAnimationFrame(focusQuery);
  });

  const onQueryKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) props.onPrev();
      else props.onNext();
      return;
    }
    // ⇥ into the replace box when there is one, so the bar is keyboard-complete.
    if (e.key === "Tab" && !e.shiftKey && props.showReplace && replaceRef()) {
      e.preventDefault();
      replaceRef()?.focus();
      replaceRef()?.select();
    }
  };

  const onReplaceKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey) props.onReplaceAll?.();
      else props.onReplaceOne?.();
    }
  };

  return (
    <div
      class="floating-surface absolute right-3 top-3 z-30 flex items-start gap-1 rounded-lg border border-border-subtle bg-popover px-1.5 py-1 text-popover-foreground shadow-[var(--shadow-md)]"
      data-testid="find-bar"
      // Clicks inside must not reach the host (which would re-focus the editor
      // or terminal and blur the input mid-search).
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Show when={canReplace()}>
        <button
          type="button"
          class="focus-ring mt-0.5 flex h-6 w-4 items-center justify-center rounded-sm text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
          title="Toggle replace (⌥⌘F)"
          aria-label="Toggle replace"
          aria-expanded={props.showReplace === true}
          onClick={() => props.onToggleReplace?.()}
        >
          <Show
            when={props.showReplace}
            fallback={<ChevronRightIcon class="size-3" aria-hidden="true" />}
          >
            <ChevronDownIcon class="size-3" aria-hidden="true" />
          </Show>
        </button>
      </Show>

      <div class="flex flex-col gap-1">
        {/* Find row */}
        <div class="flex items-center gap-1">
          <SearchIcon class="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={(el) => {
              queryInput = el;
            }}
            type="text"
            value={props.query}
            onInput={(e) => props.onQueryChange(e.currentTarget.value)}
            onKeyDown={onQueryKeyDown}
            placeholder={props.placeholder ?? "Find"}
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            aria-label="Find"
            class={cx(
              "focus-ring w-44 rounded-sm bg-transparent px-1 py-0.5 font-mono text-[12px] text-foreground placeholder:text-foreground-subtle",
              hasNoMatch() && "text-destructive",
            )}
          />
          <span
            class="min-w-[3.5rem] select-none px-1 text-right font-mono text-[11px] tabular-nums"
            classList={{
              "text-warning": props.capped === true,
              "text-muted-foreground": props.capped !== true,
            }}
            title={props.capped ? props.capNote : undefined}
          >
            {countLabel()}
          </span>
          <IconButton label="Previous match" title="Previous match (⇧⏎)" onClick={props.onPrev}>
            &uarr;
          </IconButton>
          <IconButton label="Next match" title="Next match (⏎)" onClick={props.onNext}>
            &darr;
          </IconButton>
          <ToggleButton
            label="Match case"
            active={props.caseSensitive}
            onClick={props.onToggleCaseSensitive}
          >
            Aa
          </ToggleButton>
          <ToggleButton
            label="Use regular expression"
            active={props.regexp}
            onClick={props.onToggleRegexp}
          >
            .*
          </ToggleButton>
          <IconButton label="Close find" title="Close (Esc)" onClick={props.onClose}>
            &times;
          </IconButton>
        </div>

        {/* Replace row */}
        <Show when={canReplace() && props.showReplace}>
          <div class="flex items-center gap-1">
            <span
              class="ml-1 w-3.5 shrink-0 select-none text-center font-mono text-[11px] text-muted-foreground"
              aria-hidden="true"
            >
              &#8644;
            </span>
            <input
              ref={setReplaceRef}
              type="text"
              value={props.replace ?? ""}
              onInput={(e) => props.onReplaceChange?.(e.currentTarget.value)}
              onKeyDown={onReplaceKeyDown}
              placeholder="Replace"
              spellcheck={false}
              autocapitalize="off"
              autocomplete="off"
              aria-label="Replace"
              class="focus-ring w-44 rounded-sm bg-transparent px-1 py-0.5 font-mono text-[12px] text-foreground placeholder:text-foreground-subtle"
            />
            <button
              type="button"
              class="focus-ring h-6 rounded-sm px-1.5 text-[11px] text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
              title="Replace (⏎)"
              disabled={props.count === 0}
              onClick={() => props.onReplaceOne?.()}
            >
              Replace
            </button>
            <button
              type="button"
              class="focus-ring h-6 rounded-sm px-1.5 text-[11px] text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
              title="Replace all (⌘⏎)"
              disabled={props.count === 0}
              onClick={() => props.onReplaceAll?.()}
            >
              All
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
};

const IconButton: Component<{
  label: string;
  title: string;
  onClick: () => void;
  children: string;
}> = (props) => (
  <button
    type="button"
    class="focus-ring flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
    title={props.title}
    aria-label={props.label}
    onClick={() => props.onClick()}
  >
    <span aria-hidden="true" class="text-[13px] leading-none">
      {props.children}
    </span>
  </button>
);

const ToggleButton: Component<{
  label: string;
  active: boolean;
  onClick: () => void;
  children: string;
}> = (props) => (
  <button
    type="button"
    class={cx(
      "focus-ring flex h-6 shrink-0 items-center justify-center rounded-sm px-1.5 font-mono text-[11px] font-semibold transition-colors",
      props.active
        ? "bg-active text-foreground"
        : "text-foreground-subtle hover:bg-hover hover:text-foreground",
    )}
    title={props.label}
    aria-label={props.label}
    aria-pressed={props.active}
    onClick={() => props.onClick()}
  >
    {props.children}
  </button>
);

export default FindBar;
