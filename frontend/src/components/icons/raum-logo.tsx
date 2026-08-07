import { splitProps, type ComponentProps } from "solid-js";

/**
 * Raum logo — square with three rays fanning from the top-left corner,
 * tilted +10°, each ray targeting a different point on the opposite edges.
 */
export const RaumLogo = (props: ComponentProps<"svg">) => {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      stroke-width="5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={`text-[#141418] dark:text-[#f5f5f5] ${local.class ?? ""}`}
      aria-hidden="true"
      {...rest}
    >
      <g transform="translate(50 50) rotate(10) scale(0.85) translate(-50 -50) translate(100 0) scale(-1 1)">
        <rect x="2" y="2" width="96" height="96" />

        {/* 3 rays from the (mirrored) origin corner */}
        <line x1="98" y1="2" x2="2" y2="50" />
        <line x1="98" y1="2" x2="2" y2="98" />
        <line x1="98" y1="2" x2="50" y2="98" />
      </g>
    </svg>
  );
};
