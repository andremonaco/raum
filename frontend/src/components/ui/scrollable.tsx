import { OverlayScrollbarsComponent } from "overlayscrollbars-solid";
import type { JSX, ParentComponent } from "solid-js";

interface ScrollableProps {
  /** Classes applied to the OUTER scroll host (sizing / layout). */
  class?: string;
  /** Overflow behavior per axis. Matches Tailwind's `overflow-*-auto`. */
  axis?: "x" | "y" | "both";
  /** Hidden by default; "auto" mirrors native `overflow: auto`. */
  style?: JSX.CSSProperties;
}

const AXIS_OPTIONS: Record<
  Required<ScrollableProps>["axis"],
  { x: "scroll" | "hidden"; y: "scroll" | "hidden" }
> = {
  x: { x: "scroll", y: "hidden" },
  y: { x: "hidden", y: "scroll" },
  both: { x: "scroll", y: "scroll" },
};

/**
 * Drop-in replacement for `<div class="overflow-y-auto">` that renders a
 * cross-platform custom scrollbar (WKWebView / WebKitGTK / Chromium).
 *
 * The native `::-webkit-scrollbar` pseudo-element is a no-op on WebKit
 * builds that ship with Tauri on macOS and Linux, so styling is handled
 * here by OverlayScrollbars (real DOM scrollbar, preserves native scroll
 * physics). Theme is the project-accent "glow thread" defined in styles.css.
 */
export const Scrollable: ParentComponent<ScrollableProps> = (props) => {
  const overflow = () => AXIS_OPTIONS[props.axis ?? "y"];
  return (
    <OverlayScrollbarsComponent
      defer
      class={props.class}
      style={props.style}
      options={{
        scrollbars: {
          theme: "os-theme-raum",
          /* Always visible when content overflows — the thread is subtle
             enough to read as a quiet rail rather than an interruption. */
          autoHide: "never",
          visibility: "auto",
        },
        overflow: overflow(),
      }}
    >
      {props.children}
    </OverlayScrollbarsComponent>
  );
};
