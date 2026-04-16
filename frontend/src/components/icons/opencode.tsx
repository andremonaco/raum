import { splitProps, type ComponentProps } from "solid-js";

export const OpenCodeIcon = (props: ComponentProps<"svg">) => {
  const [, rest] = splitProps(props, ["class"]);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 240 300"
      fill="none"
      class={props.class}
      aria-hidden="true"
      {...rest}
    >
      <path d="M180 240H60V120H180V240Z" fill="currentColor" opacity="0.6" />
      <path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="currentColor" />
    </svg>
  );
};
