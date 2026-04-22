import type { ComponentProps, ValidComponent } from "solid-js";
import { For, Match, Switch, splitProps } from "solid-js";
import { TextField as TextFieldPrimitive } from "@kobalte/core/text-field";
import type { VariantProps } from "cva";

import { cva, cx } from "~/lib/cva";

const textFieldFieldVariants = cva({
  base: [
    "flex w-full rounded-md border border-border bg-background/60 px-2 py-1 text-xs text-foreground",
    "placeholder:text-foreground-dim",
    "selection:bg-primary selection:text-primary-foreground",
    "shadow-[var(--shadow-xs)]",
    "transition-[color,background-color,border-color,box-shadow] duration-[var(--motion-fast)] ease-[var(--motion-ease)]",
    "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45",
    "focus-visible:border-ring focus-visible:outline-none",
    "focus-visible:shadow-[0_0_0_1px_var(--background),0_0_0_3px_color-mix(in_oklab,var(--ring)_55%,transparent)]",
    "aria-invalid:border-destructive",
    "aria-invalid:focus-visible:shadow-[0_0_0_1px_var(--background),0_0_0_3px_color-mix(in_oklab,var(--destructive)_40%,transparent)]",
  ],
  variants: {
    kind: {
      input:
        "h-7 file:text-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-xs",
      textarea: "min-h-16",
    },
  },
  defaultVariants: { kind: "input" },
});

export type TextFieldProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof TextFieldPrimitive<T>
>;

export const TextField = <T extends ValidComponent = "div">(props: TextFieldProps<T>) => {
  const [, rest] = splitProps(props as TextFieldProps, ["class"]);

  return (
    <TextFieldPrimitive
      data-slot="text-field"
      class={cx("grid w-full gap-2", props.class)}
      {...rest}
    />
  );
};

export type TextFieldInputProps<T extends ValidComponent = "input"> = ComponentProps<
  typeof TextFieldPrimitive.Input<T>
> &
  VariantProps<typeof textFieldFieldVariants>;

export const TextFieldInput = <T extends ValidComponent = "input">(
  props: TextFieldInputProps<T>,
) => {
  const [, rest] = splitProps(props as TextFieldInputProps, ["class"]);

  return (
    <TextFieldPrimitive.Input
      data-slot="text-field-input"
      class={textFieldFieldVariants({ kind: "input", class: props.class })}
      {...rest}
    />
  );
};

export type TextFieldTextAreaProps<T extends ValidComponent = "textarea"> = ComponentProps<
  typeof TextFieldPrimitive.TextArea<T>
>;

export const TextFieldTextArea = <T extends ValidComponent = "textarea">(
  props: TextFieldTextAreaProps<T>,
) => {
  const [, rest] = splitProps(props as TextFieldTextAreaProps, ["class"]);

  return (
    <TextFieldPrimitive.TextArea
      data-slot="text-field-textarea"
      class={textFieldFieldVariants({ kind: "textarea", class: props.class })}
      {...rest}
    />
  );
};

export type TextFieldLabelProps<T extends ValidComponent = "label"> = ComponentProps<
  typeof TextFieldPrimitive.Label<T>
>;

export const TextFieldLabel = <T extends ValidComponent = "label">(
  props: TextFieldLabelProps<T>,
) => {
  const [, rest] = splitProps(props as TextFieldLabelProps, ["class"]);

  return (
    <TextFieldPrimitive.Label
      data-slot="text-field-label"
      class={cx(
        "text-xs font-medium select-none text-foreground",
        "data-[disabled]:pointer-events-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45",
        "data-[invalid]:text-destructive",
        props.class,
      )}
      {...rest}
    />
  );
};

export type TextFieldErrorMessageProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof TextFieldPrimitive.ErrorMessage<T>
> & {
  errors?: ({ message?: string } | undefined)[];
};

export const TextFieldErrorMessage = <T extends ValidComponent = "div">(
  props: TextFieldErrorMessageProps<T>,
) => {
  const [, rest] = splitProps(props as TextFieldErrorMessageProps, ["class", "errors", "children"]);

  const uniqueErrors = () => [
    ...new Map(props.errors?.map((error) => [error?.message, error])).values(),
  ];

  return (
    <TextFieldPrimitive.ErrorMessage
      data-slot="text-field-error-message"
      class={cx("text-destructive text-xs", props.class)}
      {...rest}
    >
      <Switch
        fallback={
          <ul class="ml-4 flex list-disc flex-col gap-1">
            <For each={uniqueErrors()}>{(error) => <li>{error?.message}</li>}</For>
          </ul>
        }
      >
        <Match when={props.children}>{props.children}</Match>
        <Match when={!props.errors?.length}>{null}</Match>
        <Match when={uniqueErrors().length == 1}>{uniqueErrors()[0]?.message}</Match>
      </Switch>
    </TextFieldPrimitive.ErrorMessage>
  );
};

export type TextFieldDescriptionProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof TextFieldPrimitive.Description<T>
>;

export const TextFieldDescription = <T extends ValidComponent = "div">(
  props: TextFieldDescriptionProps<T>,
) => {
  const [, rest] = splitProps(props as TextFieldDescriptionProps, ["class"]);

  return (
    <TextFieldPrimitive.Description
      data-slot="text-field-description"
      class={cx("text-foreground-subtle text-[11px]", props.class)}
      {...rest}
    />
  );
};
