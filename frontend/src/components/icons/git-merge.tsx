import { splitProps, type ComponentProps } from "solid-js";

/**
 * "Two-into-one" arrow merge — reads more obviously as a merge action than
 * the standard Lucide git-merge glyph (two circles + curve) does at 14 px.
 * Two diagonal feed lines fold into a single straight arrow pointing down.
 */
export const GitMergeIcon = (props: ComponentProps<"svg">) => {
  const [, rest] = splitProps(props, ["class"]);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      aria-hidden="true"
      {...rest}
    >
      {/* Left feed: from top-left, curving in to the trunk at (12, 12) */}
      <path d="M5 3v3a4 4 0 0 0 1.5 3.1L12 12" />
      {/* Right feed: mirrored from top-right */}
      <path d="M19 3v3a4 4 0 0 1-1.5 3.1L12 12" />
      {/* Trunk + arrowhead */}
      <line x1="12" y1="12" x2="12" y2="20" />
      <polyline points="8 17 12 21 16 17" />
    </svg>
  );
};
