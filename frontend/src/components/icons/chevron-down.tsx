import { splitProps, type ComponentProps } from "solid-js";

export const ChevronDownIcon = (props: ComponentProps<"svg">) => {
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
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
};
