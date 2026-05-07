import { Component, createEffect, createMemo } from "solid-js";

import { kindDisplayLabel, type AgentKind } from "../../lib/agentKind";
import { resolveHarnessAutoLabel } from "../../lib/terminalTabLabel";
import { setTabAutoLabel } from "../../stores/runtimeLayoutStore";
import { terminalStore } from "../../stores/terminalStore";
import { worktreesByProject } from "../../stores/worktreeStore";
import { SHELL_IDLE_COMMANDS } from "./constants";
import { type AutoLabelBinderProps } from "./types";

// AutoLabelBinder: synthesizes the tab autoLabel.
//
// Harness panes: react to the backend's live tmux pane/window title stream
// and prefer the richest title the inner CLI publishes. When tmux only
// exposes generic names (for example `node` or a bare version), fall back to
// the existing `kind · project/branch` synthesis from raum-side state.
//
// Shell panes: the inner command/cwd IS the interesting signal, so the global
// shell context poller writes paneContext into terminalStore and this binder
// composes `"Shell · <cwd-basename> · <command>"` from the cached value.
//
// Returns null — the effect is the side effect.

export const AutoLabelBinder: Component<AutoLabelBinderProps> = (props) => {
  const harnessFallbackLabel = createMemo(() => {
    if (props.kind === "empty") return "Empty";
    if (props.kind === "shell") return kindDisplayLabel("shell");
    const kind = props.kind as AgentKind;
    const slug = props.projectSlug;
    const worktreePath = props.worktreeId;
    const kindPart = kindDisplayLabel(kind);

    let label = kindPart;
    if (slug) {
      const worktrees = worktreesByProject()[slug];
      const wt = worktreePath ? worktrees?.find((w) => w.path === worktreePath) : undefined;
      const branch =
        wt?.branch ?? wt?.baseBranch ?? wt?.upstream?.replace(/^origin\//, "") ?? undefined;
      return branch ? `${kindPart} · ${slug}/${branch}` : `${kindPart} · ${slug}`;
    }

    return label;
  });

  const livePaneContext = createMemo(() =>
    props.sessionId ? terminalStore.byId[props.sessionId]?.paneContext : undefined,
  );

  // Harness-pane branch: react to the live tmux pane/window titles, but keep
  // the raum-side project/branch label as a fallback whenever tmux only
  // exposes generic process names.
  createEffect(() => {
    if (props.kind === "shell" || props.kind === "empty") return;
    const sid = props.sessionId;
    const fallback = harnessFallbackLabel();

    if (!sid) {
      setTabAutoLabel(props.cellId, props.tabId, fallback);
      return;
    }
    const ctx = livePaneContext();
    const label = resolveHarnessAutoLabel({
      kind: props.kind as AgentKind,
      paneTitle: ctx?.paneTitle,
      windowName: ctx?.windowName,
      currentCommand: ctx?.currentCommand,
      fallbackLabel: fallback,
    });
    setTabAutoLabel(props.cellId, props.tabId, label);
  });

  // Shell-pane branch: globally-polled tmux context.
  createEffect(() => {
    if (props.kind !== "shell") return;
    const sid = props.sessionId;
    if (!sid) {
      setTabAutoLabel(props.cellId, props.tabId, kindDisplayLabel("shell"));
      return;
    }

    const ctx = livePaneContext();
    if (!ctx) return;
    const basename = ctx.currentPath ? ctx.currentPath.split("/").pop() || "" : "";
    const cmd = ctx.currentCommand.trim();
    const showCmd = cmd && !SHELL_IDLE_COMMANDS.has(cmd);
    const parts = ["Shell"];
    if (basename) parts.push(basename);
    if (showCmd) parts.push(cmd);
    setTabAutoLabel(props.cellId, props.tabId, parts.join(" · "));
  });

  return null;
};
