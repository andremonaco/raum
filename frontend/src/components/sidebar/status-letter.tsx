/**
 * §9 — single-letter git status badge (M/A/D/R/U/C/T) in a fixed-width
 * column. Small colored monospace letters, not chips — the restrained
 * variant of VS Code's SCM decorations.
 */

import { Component } from "solid-js";

import { STATUS_LETTER } from "../../lib/gitChangeDisplay";
import type { StatusLetterProps } from "./types";

export const StatusLetter: Component<StatusLetterProps> = (props) => {
  return (
    <span
      class={`w-3 shrink-0 select-none text-center font-mono text-[10px] font-semibold leading-none ${STATUS_LETTER[props.kind].colorClass}`}
      title={props.kind}
      aria-label={props.kind}
    >
      {STATUS_LETTER[props.kind].letter}
    </span>
  );
};
