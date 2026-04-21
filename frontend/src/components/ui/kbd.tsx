import { splitProps, type ComponentProps } from "solid-js";

import { cx } from "~/lib/cva";

export type KbdProps = ComponentProps<"kbd">;

export const Kbd = (props: KbdProps) => {
  const [, rest] = splitProps(props, ["class"]);

  return (
    <kbd
      data-slot="kbd"
      class={cx(
        "bg-surface-raised text-foreground-subtle border border-border-subtle pointer-events-none inline-flex h-[18px] w-fit min-w-[18px] items-center justify-center gap-1 rounded-sm px-1.5 font-sans text-[10px] font-medium select-none",
        "[&_svg:not([class*='size-'])]:size-3",
        props.class,
      )}
      {...rest}
    />
  );
};

export type KbdGroupProps = ComponentProps<"div">;

export const KbdGroup = (props: KbdGroupProps) => {
  const [, rest] = splitProps(props, ["class"]);

  return (
    <div
      data-slot="kbd-group"
      class={cx("inline-flex items-center gap-1", props.class)}
      {...rest}
    />
  );
};
