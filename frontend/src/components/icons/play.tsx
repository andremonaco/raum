import { splitProps, type ComponentProps } from "solid-js";

export const PlayIcon = (props: ComponentProps<"svg">) => {
  const [, rest] = splitProps(props, ["class"]);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      stroke-width="1"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      aria-hidden="true"
      {...rest}
    >
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
};
