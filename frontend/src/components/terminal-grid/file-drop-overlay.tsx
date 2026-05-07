import { Component, For, Show, createMemo } from "solid-js";

import { type AgentKind } from "../../lib/agentKind";
import { FileTypeIcon } from "../../lib/fileTypeIcon";
import { HARNESS_ICONS } from "../icons";
import { pathBasename } from "./utils";

export const FileDropOverlay: Component<{ active: boolean; kind: AgentKind; paths: string[] }> = (
  props,
) => {
  const visiblePaths = createMemo(() => props.paths.slice(0, 4));
  const extraCount = createMemo(() => Math.max(0, props.paths.length - visiblePaths().length));
  const TargetIcon = createMemo(() => HARNESS_ICONS[props.kind as keyof typeof HARNESS_ICONS]);

  return (
    <Show when={props.active && props.paths.length > 0}>
      <div
        class="terminal-file-drop-overlay pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center text-center"
        data-testid="terminal-file-drop-overlay"
      >
        <div class="terminal-file-drop-preview-stack" aria-hidden="true">
          <For each={visiblePaths()}>
            {(path, index) => (
              <div class="terminal-file-drop-preview-file" style={{ "--file-index": `${index()}` }}>
                <FileTypeIcon
                  name={pathBasename(path)}
                  class="terminal-file-drop-preview-icon"
                  width={28}
                  height={28}
                />
              </div>
            )}
          </For>
        </div>
        <div class="terminal-file-drop-target-icon">
          {(() => {
            const Icon = TargetIcon();
            return Icon ? <Icon class="terminal-file-drop-harness-icon" /> : null;
          })()}
        </div>
        <div class="terminal-file-drop-title">
          {props.paths.length === 1
            ? "Release to attach file"
            : `Release to attach ${props.paths.length} files`}
        </div>
        <div class="terminal-file-drop-files">
          <For each={visiblePaths()}>
            {(path) => (
              <div class="terminal-file-drop-chip">
                <FileTypeIcon
                  name={pathBasename(path)}
                  class="terminal-file-drop-chip-icon"
                  width={18}
                  height={18}
                />
                <span>{pathBasename(path)}</span>
              </div>
            )}
          </For>
          <Show when={extraCount() > 0}>
            <div class="terminal-file-drop-chip terminal-file-drop-chip-more">
              +{extraCount()} more
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
};
