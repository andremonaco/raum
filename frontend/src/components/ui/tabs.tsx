import type { ComponentProps, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";
import { Tabs as TabsPrimitive } from "@kobalte/core/tabs";

import { cx } from "~/lib/cva";

export type TabsProps<T extends ValidComponent = "div"> = ComponentProps<typeof TabsPrimitive<T>>;

export const Tabs = <T extends ValidComponent = "div">(props: TabsProps<T>) => {
  const [, rest] = splitProps(props as TabsProps, ["class"]);

  return (
    <TabsPrimitive
      data-slot="tabs"
      class={cx("flex flex-col gap-2", "data-[orientation=vertical]:flex-row", props.class)}
      {...rest}
    />
  );
};

export type TabsListProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof TabsPrimitive.List<T>
>;

export const TabsList = <T extends ValidComponent = "div">(props: TabsListProps<T>) => {
  const [, rest] = splitProps(props as TabsListProps, ["class"]);

  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      class={cx(
        "bg-panel text-foreground-subtle relative flex h-[calc(var(--spacing)*7)] w-fit items-center justify-center rounded-lg border border-border-subtle p-[3px]",
        "data-[orientation=vertical]:size-full data-[orientation=vertical]:flex-col",
        props.class,
      )}
      {...rest}
    />
  );
};

export type TabsTriggerProps<T extends ValidComponent = "button"> = ComponentProps<
  typeof TabsPrimitive.Trigger<T>
>;

export const TabsTrigger = <T extends ValidComponent = "button">(props: TabsTriggerProps<T>) => {
  const [, rest] = splitProps(props as TabsTriggerProps, ["class"]);

  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      class={cx(
        "text-foreground-subtle data-[selected]:text-foreground peer relative z-10 inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap",
        "hover:text-foreground transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease)]",
        "focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        props.class,
      )}
      {...rest}
    />
  );
};

export type TabsContentProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof TabsPrimitive.Content<T>
>;

export const TabsContent = <T extends ValidComponent = "div">(props: TabsContentProps<T>) => {
  const [, rest] = splitProps(props as TabsContentProps, ["class"]);

  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      class={cx("flex-1 outline-none", props.class)}
      {...rest}
    />
  );
};

export type TabsIndicatorProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof TabsPrimitive.Indicator<T>
>;

export const TabsIndicator = <T extends ValidComponent = "div">(props: TabsIndicatorProps<T>) => {
  const [, rest] = splitProps(props as TabsIndicatorProps, ["class"]);

  return (
    <TabsPrimitive.Indicator
      data-slot="tabs-indicator"
      class={cx(
        "bg-surface-raised border border-border-subtle shadow-[var(--shadow-xs)] absolute inset-[3px] rounded-md transition-[transform,width,height] duration-[var(--motion-base)] ease-[var(--motion-ease)]",
        "peer-focus-visible:shadow-[var(--shadow-xs),0_0_0_1px_var(--background),0_0_0_3px_color-mix(in_oklab,var(--ring)_55%,transparent)]",
        props.class,
      )}
      {...rest}
    />
  );
};
