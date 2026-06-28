/**
 * §9 — one changed-file row, shared by the Changes tab and the History
 * tab's expanded commits: status letter | file-type icon | bright name +
 * dim directory | per-file +/− counts | optional trailing action (passed
 * as children, hover-revealed via the `group/file` scope on this row).
 */

import { Component, JSX, Show, createMemo } from "solid-js";

import { FileTypeIcon } from "../../lib/fileTypeIcon";
import { STATUS_LETTER, splitPath } from "../../lib/gitChangeDisplay";
import { StatusLetter } from "./status-letter";
import type { FileChangeRowProps } from "./types";

export const FileChangeRow: Component<FileChangeRowProps & { children?: JSX.Element }> = (
  props,
) => {
  const parts = createMemo(() => splitPath(props.path));
  const hoverTitle = () =>
    props.title ?? (props.origPath ? `${props.origPath} → ${props.path}` : props.path);

  // Restrained status tint on the filename: reuse the StatusLetter color token
  // family (success/warning/destructive/info) but dampen it to a quiet,
  // muted intensity so it reads as differentiation, not bright decoration.
  // Emphasized (staged) rows stay on plain `text-foreground` — no tint.
  const nameClass = () =>
    props.emphasized === true ? undefined : `${STATUS_LETTER[props.kind].colorClass} opacity-80`;

  return (
    <li class="group/file flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-hover">
      <StatusLetter kind={props.kind} />
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-[11px] hover:text-foreground"
        classList={{
          "text-foreground": props.emphasized === true,
          "text-muted-foreground": props.emphasized !== true,
        }}
        title={hoverTitle()}
        onClick={() => props.onOpen()}
        onContextMenu={(e) => {
          if (!props.onContextMenu) return;
          e.preventDefault();
          props.onContextMenu(e);
        }}
      >
        <FileTypeIcon name={props.path} class="size-3.5 shrink-0 opacity-75" />
        <span class="min-w-0 flex-1 truncate">
          <span class={nameClass()}>{parts().name}</span>
          <Show when={parts().dir !== ""}>
            <span class="ml-1.5 text-[10px] text-foreground-dim">{parts().dir}</span>
          </Show>
        </span>
      </button>
      <Show when={(props.insertions ?? 0) > 0 || (props.deletions ?? 0) > 0}>
        <span class="shrink-0 select-none font-mono text-[9px] tabular-nums">
          <Show when={(props.insertions ?? 0) > 0}>
            <span class="text-success">+{props.insertions}</span>
          </Show>
          <Show when={(props.deletions ?? 0) > 0}>
            <span class="ml-1 text-destructive">−{props.deletions}</span>
          </Show>
        </span>
      </Show>
      {props.children}
    </li>
  );
};
