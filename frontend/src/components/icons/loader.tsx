import { splitProps, type ComponentProps } from "solid-js";

/** Lucide Loader2 — a ring with one visible gap. Pair with `animate-spin`. */
export const LoaderIcon = (props: ComponentProps<"svg">) => {
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
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
};
