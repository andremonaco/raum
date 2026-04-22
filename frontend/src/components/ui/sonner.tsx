/**
 * Toaster wrapper around `solid-sonner`.
 *
 * Styling maps Sonner's class hooks onto the project's CSS variables so
 * toasts inherit whatever theme `themeController` has applied to
 * `document.documentElement` (bg-popover / text-foreground / border-border).
 * Sonner ships its own `styles.css` — imported here once so callers just
 * render `<Toaster />`.
 */

import type { Component } from "solid-js";
import { Toaster as SonnerToaster, type ToasterProps } from "solid-sonner";

import "solid-sonner/styles.css";

export const Toaster: Component<ToasterProps> = (props) => {
  return (
    <SonnerToaster
      theme="system"
      position="top-right"
      closeButton
      duration={8_000}
      visibleToasts={4}
      toastOptions={{
        classNames: {
          toast: "!bg-popover !text-foreground !border-border !shadow-lg !rounded-xl",
          title: "!text-foreground !font-medium",
          description: "!text-foreground-subtle",
          actionButton: "!bg-foreground !text-background hover:!opacity-90 !rounded-md",
          closeButton: "!bg-popover !text-foreground-subtle hover:!text-foreground !border-border",
        },
      }}
      {...props}
    />
  );
};
