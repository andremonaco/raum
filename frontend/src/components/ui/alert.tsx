import type { ComponentProps, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";
import { Alert as AlertPrimitive } from "@kobalte/core/alert";
import type { VariantProps } from "cva";

import { cva, cx } from "~/lib/cva";

export const alertVariants = cva({
  base: "relative w-full rounded-lg border border-border-subtle px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  variants: {
    variant: {
      default: "bg-card text-card-foreground",
      destructive:
        "border-destructive/30 bg-destructive/10 text-destructive *:data-[slot=alert-description]:text-destructive/90",
      success:
        "border-success/30 bg-success/10 text-success *:data-[slot=alert-description]:text-success/90",
      warning:
        "border-warning/30 bg-warning/10 text-warning *:data-[slot=alert-description]:text-warning/90",
      info: "border-info/30 bg-info/10 text-info *:data-[slot=alert-description]:text-info/90",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export type AlertProps<T extends ValidComponent = "button"> = ComponentProps<
  typeof AlertPrimitive<T>
> &
  VariantProps<typeof alertVariants>;

export const Alert = <T extends ValidComponent = "button">(props: AlertProps<T>) => {
  const [, rest] = splitProps(props as AlertProps, ["class", "variant"]);

  return (
    <AlertPrimitive
      data-slot="alert"
      class={alertVariants({
        variant: props.variant,
        class: props.class,
      })}
      {...rest}
    />
  );
};

export type AlertTitleProps = ComponentProps<"div">;

export const AlertTitle = (props: AlertTitleProps) => {
  const [, rest] = splitProps(props, ["class"]);

  return (
    <div
      data-slot="alert-title"
      class={cx("col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight", props.class)}
      {...rest}
    />
  );
};

export type AlertDescriptionProps = ComponentProps<"div">;

export const AlertDescription = (props: AlertDescriptionProps) => {
  const [, rest] = splitProps(props, ["class"]);

  return (
    <div
      data-slot="alert-description"
      class={cx(
        "text-muted-foreground col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed",
        props.class,
      )}
      {...rest}
    />
  );
};
