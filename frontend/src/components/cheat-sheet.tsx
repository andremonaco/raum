/**
 * §12.6 — cheat-sheet modal.
 *
 * Triggered via the `cheat-sheet` keymap action (default `⌘/`). Lists every
 * action side-by-side with its default accelerator and the effective
 * accelerator (which may be a user override from `keybindings.toml`).
 * Actions with an override render the override in the project accent and
 * keep the default as muted strikethrough.
 *
 * The component registers its open/close handler through
 * `useKeymapAction("cheat-sheet", …)` — there is no button anywhere that
 * opens it; users discover the shortcut via the bundled docs or by typing
 * `⌘/` at any point.
 */

import { createMemo, createSignal, For, Show, type Component } from "solid-js";

import { useKeymap, useKeymapAction, type KeymapEntry } from "../lib/keymapContext";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogPortal,
  DialogTitle,
} from "./ui/dialog";
import { Kbd } from "./ui/kbd";

interface Row {
  action: string;
  description: string;
  defaultAccelerator: string | undefined;
  effectiveAccelerator: string | undefined;
  overridden: boolean;
  global: boolean;
}

function buildRows(effective: KeymapEntry[], defaults: KeymapEntry[]): Row[] {
  const defaultsByAction = new Map<string, KeymapEntry>();
  for (const d of defaults) defaultsByAction.set(d.action, d);
  const effectiveByAction = new Map<string, KeymapEntry>();
  for (const e of effective) effectiveByAction.set(e.action, e);

  const allActions = new Set<string>();
  for (const d of defaults) allActions.add(d.action);
  for (const e of effective) allActions.add(e.action);

  const rows: Row[] = [];
  for (const action of allActions) {
    const def = defaultsByAction.get(action);
    const eff = effectiveByAction.get(action);
    const base = def ?? eff!;
    rows.push({
      action,
      description: base.description,
      defaultAccelerator: def?.accelerator,
      effectiveAccelerator: eff?.accelerator,
      overridden: !!def && !!eff && def.accelerator !== eff.accelerator,
      global: base.global,
    });
  }
  rows.sort((a, b) => a.action.localeCompare(b.action));
  return rows;
}

const AcceleratorPill: Component<{
  accelerator: string | undefined;
  muted?: boolean;
  strikethrough?: boolean;
}> = (props) => {
  const tokens = createMemo(() => (props.accelerator ?? "").split("+").filter(Boolean));
  return (
    <Show when={tokens().length > 0} fallback={<span class="text-muted-foreground/70">—</span>}>
      <span class="inline-flex gap-1">
        <For each={tokens()}>
          {(t) => (
            <Kbd
              class={`font-mono ${
                props.strikethrough ? "line-through opacity-60" : ""
              } ${props.muted ? "opacity-70" : ""}`}
            >
              {t}
            </Kbd>
          )}
        </For>
      </span>
    </Show>
  );
};

export const CheatSheet: Component = () => {
  const keymap = useKeymap();
  const [open, setOpen] = createSignal(false);

  useKeymapAction("cheat-sheet", (e) => {
    e?.preventDefault();
    setOpen((v) => !v);
  });

  const rows = createMemo(() => buildRows(keymap.entries(), keymap.defaults()));
  const conflicts = createMemo(() => keymap.conflicts());

  return (
    <Dialog open={open()} onOpenChange={setOpen}>
      <DialogPortal>
        <DialogContent class="flex max-h-[80vh] w-full max-w-3xl flex-col gap-0 p-0 sm:max-w-3xl">
          <DialogHeader class="border-b border-border px-4 py-3 text-left">
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>
              Override any accelerator in{" "}
              <code class="font-mono text-foreground">~/.config/raum/keybindings.toml</code>.
            </DialogDescription>
          </DialogHeader>

          <Show when={conflicts().length > 0}>
            <Alert variant="destructive" class="rounded-none border-x-0 text-xs">
              <AlertTitle>
                {conflicts().length} accelerator conflict
                {conflicts().length === 1 ? "" : "s"} detected
              </AlertTitle>
              <AlertDescription>
                <ul class="list-inside list-disc">
                  <For each={conflicts()}>
                    {(c) => (
                      <li>
                        <code class="font-mono">{c.accelerator}</code>: {c.actions.join(", ")} —
                        last wins
                      </li>
                    )}
                  </For>
                </ul>
              </AlertDescription>
            </Alert>
          </Show>

          <div class="flex-1 overflow-auto">
            <table class="w-full text-left text-sm">
              <thead class="sticky top-0 bg-card text-xs uppercase text-muted-foreground">
                <tr>
                  <th class="px-4 py-2 font-medium">Action</th>
                  <th class="px-4 py-2 font-medium">Description</th>
                  <th class="px-4 py-2 font-medium">Default</th>
                  <th class="px-4 py-2 font-medium">Effective</th>
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>
                  {(row) => (
                    <tr class="border-t border-border hover:bg-muted/50">
                      <td class="whitespace-nowrap px-4 py-2 font-mono text-xs text-foreground">
                        {row.action}
                        <Show when={row.global}>
                          <Badge variant="secondary" class="ml-2 text-[10px] uppercase">
                            global
                          </Badge>
                        </Show>
                      </td>
                      <td class="px-4 py-2 text-foreground">{row.description}</td>
                      <td class="px-4 py-2">
                        <AcceleratorPill
                          accelerator={row.defaultAccelerator}
                          muted={row.overridden}
                          strikethrough={row.overridden}
                        />
                      </td>
                      <td class="px-4 py-2">
                        <AcceleratorPill accelerator={row.effectiveAccelerator} />
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>

          <footer class="border-t border-border px-4 py-2 text-right text-xs text-muted-foreground">
            Press <Kbd>Esc</Kbd> or click outside to close.
          </footer>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
};

export default CheatSheet;
