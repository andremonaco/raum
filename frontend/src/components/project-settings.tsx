/**
 * §5.6 — Project settings.
 *
 * Renders the effective (merged) project config: root path, worktree path
 * pattern, and branch prefix mode. The hydration picker lives in the settings
 * dialog; this component is used as a compact read-only summary elsewhere
 * (e.g. sidebar panels).
 */

import { Component, Show, createMemo, createResource } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

interface EffectiveProjectDto {
  slug: string;
  name: string;
  color: string;
  rootPath: string;
  hydration: { copy: string[]; symlink: string[] };
  worktree: {
    pathPattern: string;
    branchPrefixMode: "none" | "username" | "custom";
    branchPrefixCustom: string | null;
  };
}

export interface ProjectSettingsProps {
  projectSlug: string;
}

async function fetchEffective(slug: string): Promise<EffectiveProjectDto | null> {
  if (!slug) return null;
  return await invoke<EffectiveProjectDto | null>("project_config_effective", {
    slug,
  });
}

export const ProjectSettings: Component<ProjectSettingsProps> = (props) => {
  const slug = createMemo(() => props.projectSlug);
  const [effective] = createResource(slug, fetchEffective);

  return (
    <section class="flex flex-col gap-3 p-3 text-xs text-foreground" data-testid="project-settings">
      <header>
        <h3 class="text-xs font-medium">
          <Show when={effective()} fallback="Project settings">
            {(eff) => <>Project settings — {eff().name || eff().slug}</>}
          </Show>
        </h3>
      </header>

      <Show when={effective()} fallback={<p class="text-muted-foreground">Loading…</p>}>
        {(eff) => (
          <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <dt>Root</dt>
            <dd class="truncate font-mono text-foreground">{eff().rootPath}</dd>
            <dt>Path pattern</dt>
            <dd class="truncate font-mono text-foreground">{eff().worktree.pathPattern}</dd>
            <dt>Branch prefix</dt>
            <dd class="truncate font-mono text-foreground">
              {eff().worktree.branchPrefixMode}
              <Show when={eff().worktree.branchPrefixCustom}>
                {" "}
                <span class="text-muted-foreground">({eff().worktree.branchPrefixCustom})</span>
              </Show>
            </dd>
          </dl>
        )}
      </Show>
    </section>
  );
};

export default ProjectSettings;
