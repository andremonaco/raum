import { splitProps, type ComponentProps } from "solid-js";

export const ChevronRightIcon = (props: ComponentProps<"svg">) => {
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
      {/* Collapsed tree/commit caret — mirror of ChevronDownIcon for crisp IDE
          disclosure (the expanded state stays ChevronDownIcon). */}
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
};
