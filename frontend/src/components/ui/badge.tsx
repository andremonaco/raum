import type { ComponentProps, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";
import { Badge as BadgePrimitive } from "@kobalte/core/badge";
import type { VariantProps } from "cva";

import { cva } from "~/lib/cva";

export const badgeVariants = cva({
  base: [
    "inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 overflow-hidden gap-1",
    "[&>svg]:size-3 [&>svg]:pointer-events-none",
    "transition-[color,background-color,box-shadow] duration-[var(--motion-fast)] ease-[var(--motion-ease)]",
    "focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--background),0_0_0_3px_color-mix(in_oklab,var(--ring)_55%,transparent)]",
    "aria-invalid:border-destructive",
  ],
  variants: {
    variant: {
      default: "border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
      secondary:
        "border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
      destructive:
        "border-transparent bg-destructive/15 text-destructive [a&]:hover:bg-destructive/25",
      outline: "border-border text-foreground [a&]:hover:bg-hover",
      success: "border-transparent bg-success/15 text-success [a&]:hover:bg-success/25",
      warning: "border-transparent bg-warning/15 text-warning [a&]:hover:bg-warning/25",
      info: "border-transparent bg-info/15 text-info [a&]:hover:bg-info/25",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export type BadgeProps<T extends ValidComponent = "span"> = ComponentProps<
  typeof BadgePrimitive<T>
> &
  VariantProps<typeof badgeVariants>;

export const Badge = <T extends ValidComponent = "span">(props: BadgeProps<T>) => {
  const [, rest] = splitProps(props as BadgeProps, ["class", "variant"]);

  return (
    <BadgePrimitive
      data-slot="badge"
      class={badgeVariants({
        variant: props.variant,
        class: props.class,
      })}
      {...rest}
    />
  );
};
