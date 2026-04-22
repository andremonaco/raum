import { splitProps, type ComponentProps, type ValidComponent } from "solid-js";
import { Switch as SwitchPrimitive } from "@kobalte/core/switch";
import type { VariantProps } from "cva";

import { cva, cx } from "~/lib/cva";

export const switchControlVariants = cva({
  base: [
    "inline-flex items-center rounded-full border border-transparent bg-input shadow-[var(--shadow-xs)]",
    "data-[checked]:bg-ring",
    "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45",
    "transition-[background-color,box-shadow] duration-[var(--motion-base)] ease-[var(--motion-ease)]",
    "peer-focus-visible/switch-input:shadow-[0_0_0_1px_var(--background),0_0_0_3px_color-mix(in_oklab,var(--ring)_55%,transparent)]",
    "outline-none",
  ],
  variants: {
    size: {
      default: "h-4.5 w-8",
    },
  },
  defaultVariants: { size: "default" },
});

export const switchThumbVariants = cva({
  base: [
    "pointer-events-none rounded-full bg-foreground shadow-[var(--shadow-xs)]",
    "data-[checked]:translate-x-[calc(100%-2px)] data-[checked]:bg-primary-foreground",
    "transition-transform duration-[var(--motion-base)] ease-[var(--motion-ease)]",
  ],
  variants: {
    size: {
      default: "size-4",
    },
  },
  defaultVariants: { size: "default" },
});

export type SwitchProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof SwitchPrimitive<T>
>;

export const Switch = <T extends ValidComponent = "div">(props: SwitchProps<T>) => {
  return <SwitchPrimitive data-slot="switch" {...props} />;
};

export type SwitchControlProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof SwitchPrimitive.Control<T>
> &
  VariantProps<typeof switchControlVariants>;

export const SwitchControl = <T extends ValidComponent = "div">(props: SwitchControlProps<T>) => {
  const [, rest] = splitProps(props as SwitchControlProps, ["class", "size"]);

  return (
    <SwitchPrimitive.Control
      data-slot="switch-control"
      class={switchControlVariants({ size: props.size, class: props.class })}
      {...rest}
    />
  );
};

export type SwitchThumbProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof SwitchPrimitive.Thumb<T>
> &
  VariantProps<typeof switchThumbVariants>;

export const SwitchThumb = <T extends ValidComponent = "div">(props: SwitchThumbProps<T>) => {
  const [, rest] = splitProps(props as SwitchThumbProps, ["class", "size"]);

  return (
    <SwitchPrimitive.Thumb
      data-slot="switch-thumb"
      class={switchThumbVariants({ size: props.size, class: props.class })}
      {...rest}
    />
  );
};

export type SwitchInputProps<T extends ValidComponent = "input"> = ComponentProps<
  typeof SwitchPrimitive.Input<T>
>;

export const SwitchInput = <T extends ValidComponent = "input">(props: SwitchInputProps<T>) => {
  const [, rest] = splitProps(props as SwitchInputProps, ["class"]);

  return (
    <SwitchPrimitive.Input
      data-slot="switch-input"
      class={cx("peer/switch-input", props.class)}
      {...rest}
    />
  );
};

export type SwitchLabelProps<T extends ValidComponent = "label"> = ComponentProps<
  typeof SwitchPrimitive.Label<T>
>;

export const SwitchLabel = <T extends ValidComponent = "label">(props: SwitchLabelProps<T>) => {
  const [, rest] = splitProps(props as SwitchLabelProps, ["class"]);

  return (
    <SwitchPrimitive.Label
      data-slot="switch-label"
      class={cx(
        "text-xs select-none",
        "data-[disabled]:pointer-events-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45",
        "data-[invalid]:text-destructive",
        props.class,
      )}
      {...rest}
    />
  );
};

export type SwitchErrorMessageProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof SwitchPrimitive.ErrorMessage<T>
>;

export const SwitchErrorMessage = <T extends ValidComponent = "div">(
  props: SwitchErrorMessageProps<T>,
) => {
  const [, rest] = splitProps(props as SwitchErrorMessageProps, ["class"]);

  return (
    <SwitchPrimitive.ErrorMessage
      data-slot="switch-error-message"
      class={cx("text-destructive text-xs", props.class)}
      {...rest}
    />
  );
};

export type SwitchDescriptionProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof SwitchPrimitive.Description<T>
>;

export const SwitchDescription = <T extends ValidComponent = "div">(
  props: SwitchDescriptionProps<T>,
) => {
  const [, rest] = splitProps(props as SwitchDescriptionProps, ["class"]);

  return (
    <SwitchPrimitive.Description
      data-slot="switch-description"
      class={cx("text-foreground-subtle text-xs", props.class)}
      {...rest}
    />
  );
};
