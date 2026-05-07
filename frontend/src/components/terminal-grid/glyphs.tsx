import type { JSX } from "solid-js";

export function ChromeButton(props: {
  label: string;
  onClick: (e: MouseEvent) => void;
  children: JSX.Element;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      class="pane-header-chrome-button flex h-4 w-4 items-center justify-center rounded-sm text-foreground-subtle transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease)]"
      classList={{
        "hover:bg-destructive/15 hover:text-destructive": props.danger === true,
        "hover:bg-hover hover:text-foreground": props.danger !== true,
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function PlusGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      class="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    >
      <line x1="6" y1="2" x2="6" y2="10" />
      <line x1="2" y1="6" x2="10" y2="6" />
    </svg>
  );
}

export function MinusGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      class="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    >
      <line x1="2" y1="6" x2="10" y2="6" />
    </svg>
  );
}

export function MaximizeGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      class="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
    >
      <rect x="2" y="2" width="8" height="8" rx="1" />
    </svg>
  );
}

export function RestoreGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      class="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
    >
      <rect x="4" y="2" width="6" height="6" rx="1" />
      <rect x="2" y="4" width="6" height="6" rx="1" />
    </svg>
  );
}

export function CloseGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      class="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
    >
      <line x1="3" y1="3" x2="9" y2="9" />
      <line x1="9" y1="3" x2="3" y2="9" />
    </svg>
  );
}
