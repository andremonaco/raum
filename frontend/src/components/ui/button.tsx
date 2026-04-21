import type { ComponentProps, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";
import { Root as ButtonPrimitive } from "@kobalte/core/button";
import type { VariantProps } from "cva";

import { cva } from "~/lib/cva";

export const buttonVariants = cva({
  base: [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-xs font-medium shrink-0 outline-none",
    "transition-[background-color,color,box-shadow,border-color] duration-[var(--motion-fast)] ease-[var(--motion-ease)]",
    "[&_svg:not([class*=size-])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    "disabled:pointer-events-none disabled:opacity-45 disabled:saturate-50",
    "focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--background),0_0_0_3px_color-mix(in_oklab,var(--ring)_55%,transparent)]",
    "aria-[invalid]:border-destructive aria-[invalid]:shadow-[0_0_0_3px_color-mix(in_oklab,var(--destructive)_30%,transparent)]",
  ],

  variants: {
    variant: {
      default: "bg-primary text-primary-foreground hover:bg-primary/90",
      destructive:
        "bg-destructive text-white hover:bg-destructive/90 focus-visible:shadow-[0_0_0_1px_var(--background),0_0_0_3px_color-mix(in_oklab,var(--destructive)_45%,transparent)]",
      outline:
        "border border-border bg-background shadow-[var(--shadow-xs)] hover:bg-hover hover:text-foreground",
      secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
      ghost: "hover:bg-hover hover:text-foreground",
      link: "text-primary underline-offset-4 hover:underline",
    },
    size: {
      default: "h-8 px-3 text-xs has-[>svg]:px-2.5",
      sm: "h-7 gap-1.5 px-2.5 text-xs has-[>svg]:px-2",
      lg: "h-9 px-4 text-sm has-[>svg]:px-3",
      icon: "size-8",
      "icon-sm": "size-7",
      "icon-lg": "size-9",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

export type ButtonProps<T extends ValidComponent = "button"> = ComponentProps<
  typeof ButtonPrimitive<T>
> &
  VariantProps<typeof buttonVariants>;

export const Button = <T extends ValidComponent = "button">(props: ButtonProps<T>) => {
  const [, rest] = splitProps(props as ButtonProps, ["class", "variant", "size"]);

  return (
    <ButtonPrimitive
      data-slot="button"
      class={buttonVariants({
        variant: props.variant,
        size: props.size,
        class: props.class,
      })}
      {...rest}
    />
  );
};
