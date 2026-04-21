import type { ComponentProps, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";
import { Checkbox as CheckboxPrimitive } from "@kobalte/core/checkbox";
import type { VariantProps } from "cva";

import { cva, cx } from "~/lib/cva";

export const checkboxControlVariants = cva({
  base: [
    "shrink-0 rounded-sm border border-border bg-background shadow-[var(--shadow-xs)]",
    "data-[checked]:border-ring data-[checked]:bg-ring data-[checked]:text-primary-foreground",
    "data-invalid:border-destructive",
    "data-disabled:cursor-not-allowed data-disabled:opacity-45",
    "transition-[background-color,border-color,box-shadow] duration-[var(--motion-fast)] ease-[var(--motion-ease)]",
    "peer-focus-visible:shadow-[0_0_0_1px_var(--background),0_0_0_3px_color-mix(in_oklab,var(--ring)_55%,transparent)]",
    "outline-none",
  ],
  variants: {
    size: {
      sm: "size-3.5",
      default: "size-4",
    },
  },
  defaultVariants: { size: "default" },
});

export type CheckboxProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof CheckboxPrimitive<T>
>;

export const Checkbox = <T extends ValidComponent = "div">(props: CheckboxProps<T>) => {
  return <CheckboxPrimitive data-slot="checkbox" {...props} />;
};

export type CheckboxLabelProps<T extends ValidComponent = "label"> = ComponentProps<
  typeof CheckboxPrimitive.Label<T>
>;

export const CheckboxLabel = <T extends ValidComponent = "label">(props: CheckboxLabelProps<T>) => {
  const [, rest] = splitProps(props as CheckboxLabelProps, ["class"]);

  return (
    <CheckboxPrimitive.Label
      data-slot="checkbox-label"
      class={cx(
        "flex items-center gap-2 text-xs leading-none select-none",
        "data-[disabled]:pointer-events-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45",
        "data-[invalid]:text-destructive",
        props.class,
      )}
      {...rest}
    />
  );
};

export type CheckboxDescriptionProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof CheckboxPrimitive.Description<T>
>;

export const CheckboxDescription = <T extends ValidComponent = "div">(
  props: CheckboxDescriptionProps<T>,
) => {
  const [, rest] = splitProps(props as CheckboxDescriptionProps, ["class"]);

  return (
    <CheckboxPrimitive.Description
      data-slot="checkbox-description"
      class={cx("text-foreground-subtle text-[11px] data-[disabled]:opacity-45", props.class)}
      {...rest}
    />
  );
};

export type CheckboxInputProps<T extends ValidComponent = "input"> = ComponentProps<
  typeof CheckboxPrimitive.Input<T>
>;

export const CheckboxInput = <T extends ValidComponent = "input">(props: CheckboxInputProps<T>) => {
  const [, rest] = splitProps(props as CheckboxInputProps, ["class"]);

  return (
    <CheckboxPrimitive.Input data-slot="checkbox-input" class={cx("peer", props.class)} {...rest} />
  );
};

export type CheckboxControlProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof CheckboxPrimitive.Control<T>
> &
  VariantProps<typeof checkboxControlVariants>;

export const CheckboxControl = <T extends ValidComponent = "div">(
  props: CheckboxControlProps<T>,
) => {
  const [, rest] = splitProps(props as CheckboxControlProps, ["class", "size"]);

  return (
    <CheckboxPrimitive.Control
      data-slot="checkbox-control"
      class={checkboxControlVariants({ size: props.size, class: props.class })}
      {...rest}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        class="flex items-center justify-center text-current transition-none"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="size-3.5" viewBox="0 0 24 24">
          <path
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M20 6L9 17l-5-5"
          />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Control>
  );
};
