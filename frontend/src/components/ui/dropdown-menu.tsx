import type { ComponentProps, ValidComponent } from "solid-js";
import { mergeProps, splitProps } from "solid-js";
import { DropdownMenu as DropdownMenuPrimitive } from "@kobalte/core/dropdown-menu";

import { cx } from "~/lib/cva";

export const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

export type DropdownMenuProps = ComponentProps<typeof DropdownMenuPrimitive>;

export const DropdownMenu = (props: DropdownMenuProps) => {
  const merge = mergeProps<DropdownMenuProps[]>(
    {
      gutter: 4,
    },
    props,
  );

  return <DropdownMenuPrimitive data-slot="dropdown-menu" {...merge} />;
};

export type DropdownMenuTriggerProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof DropdownMenuPrimitive.Trigger<T>
>;

export const DropdownMenuTrigger = <T extends ValidComponent = "div">(
  props: DropdownMenuTriggerProps<T>,
) => {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
};

export type DropdownMenuGroupProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof DropdownMenuPrimitive.Group<T>
>;

export const DropdownMenuGroup = <T extends ValidComponent = "div">(
  props: DropdownMenuGroupProps<T>,
) => {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
};

export type DropdownMenuContentProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof DropdownMenuPrimitive.Content<T>
>;

export const DropdownMenuContent = <T extends ValidComponent = "div">(
  props: DropdownMenuContentProps<T>,
) => {
  const [, rest] = splitProps(props as DropdownMenuContentProps, ["class"]);

  return (
    <DropdownMenuPrimitive.Content
      data-slot="dropdown-menu-content"
      class={cx(
        "bg-popover text-popover-foreground floating-surface data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95 z-50 min-w-[8rem] origin-(--kb-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-xl border border-border-subtle p-1 outline-none",
        "[[data-popper-positioner][style*='--kb-popper-content-transform-origin:_top']>[data-slot=dropdown-menu-content]]:slide-in-from-top-2 [[data-popper-positioner][style*='--kb-popper-content-transform-origin:_bottom']>[data-slot=dropdown-menu-content]]:slide-in-from-bottom-2 [[data-popper-positioner][style*='--kb-popper-content-transform-origin:_left']>[data-slot=dropdown-menu-content]]:slide-in-from-left-2 [[data-popper-positioner][style*='--kb-popper-content-transform-origin:_right']>[data-slot=dropdown-menu-content]]:slide-in-from-right-2",
        props.class,
      )}
      {...rest}
    />
  );
};

export type DropdownMenuItemProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof DropdownMenuPrimitive.Item<T>
> & {
  inset?: boolean;
  variant?: "default" | "destructive";
};

export const DropdownMenuItem = <T extends ValidComponent = "div">(
  props: DropdownMenuItemProps<T>,
) => {
  const [, rest] = splitProps(props as DropdownMenuItemProps, ["class", "inset", "variant"]);

  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={props.inset}
      data-variant={props.variant}
      class={cx(
        "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-hidden select-none",
        "data-[highlighted]:bg-hover data-[highlighted]:text-foreground",
        "data-[variant=destructive]:text-destructive",
        "data-[variant=destructive]:data-[highlighted]:bg-destructive/12 data-[variant=destructive]:data-[highlighted]:text-destructive",
        "data-[variant=destructive]:*:[svg]:!text-destructive",
        "[&_svg:not([class*='text-'])]:text-foreground-subtle",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
        "data-[inset]:pl-8",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease)]",
        props.class,
      )}
      {...rest}
    />
  );
};

export type DropdownMenuSeparatorProps<T extends ValidComponent = "hr"> = ComponentProps<
  typeof DropdownMenuPrimitive.Separator<T>
>;

export const DropdownMenuSeparator = <T extends ValidComponent = "hr">(
  props: DropdownMenuSeparatorProps<T>,
) => {
  const [, rest] = splitProps(props as DropdownMenuSeparatorProps, ["class"]);

  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      class={cx("bg-border-subtle -mx-1 my-1 h-px", props.class)}
      {...rest}
    />
  );
};

export type DropdownMenuShortcutProps = ComponentProps<"span">;

export const DropdownMenuShortcut = (props: DropdownMenuShortcutProps) => {
  const [, rest] = splitProps(props, ["class"]);

  return (
    <span
      data-slot="dropdown-menu-shortcut"
      class={cx("text-foreground-subtle ml-auto text-[10px] tracking-widest", props.class)}
      {...rest}
    />
  );
};
