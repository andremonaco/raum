import { splitProps, type ComponentProps } from "solid-js";

/**
 * Raum logo — 2×2 grid with three rays from the top-right corner,
 * each targeting a different corner intersection of the grid.
 */
export const RaumLogo = (props: ComponentProps<"svg">) => {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      stroke-width="3.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={`text-black dark:text-white ${local.class ?? ""}`}
      aria-hidden="true"
      {...rest}
    >
      {/* Outer border */}
      <rect x="2" y="2" width="96" height="96" />

      {/* Interior grid lines — 1 vertical, 1 horizontal */}
      <line x1="50" y1="2" x2="50" y2="98" />
      <line x1="2" y1="50" x2="98" y2="50" />

      {/* 3 rays from top-right corner (98, 2) to 3 different grid corners */}
      <line x1="98" y1="2" x2="2" y2="50" />
      <line x1="98" y1="2" x2="2" y2="98" />
      <line x1="98" y1="2" x2="50" y2="98" />
    </svg>
  );
};
