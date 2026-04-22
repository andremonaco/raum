import { splitProps, type ComponentProps } from "solid-js";

export const GridTileIcon = (props: ComponentProps<"svg">) => {
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
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <line x1="10" y1="3" x2="10" y2="21" />
      <line x1="17" y1="3" x2="17" y2="21" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="3" y1="17" x2="21" y2="17" />
    </svg>
  );
};
