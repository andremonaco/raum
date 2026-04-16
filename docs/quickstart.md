# raum quickstart

A five-minute tour that takes you from a fresh install to a running Claude
Code pane in a worktree.

## 1. Install prerequisites

raum shells out to two external binaries on startup. Both must be on your
`PATH` before you launch the app — the dependency modal blocks the UI
otherwise.

| Tool  | Minimum version | Install                                           |
| ----- | --------------- | ------------------------------------------------- |
| tmux  | 3.2             | `brew install tmux` / `apt install tmux`          |
| git   | 2.30            | `brew install git`  / `apt install git`           |

Optional (only required if you want to spawn the matching harness):

| Harness      | Binary     | Notes                                   |
| ------------ | ---------- | --------------------------------------- |
| Claude Code  | `claude`   | <https://github.com/anthropics/claude-code> |
| Codex        | `codex`    | OpenAI Codex CLI                        |
| OpenCode     | `opencode` | <https://github.com/opencode-ai/opencode> |

Install raum itself via the notarized release for your platform:

- **macOS** — download the `.dmg` from the [latest release][releases] and drag
  the app into `/Applications`.
- **Linux** — install the `.deb` (Ubuntu/Debian) or run the `.AppImage`
  (anything with FUSE).

[releases]: https://github.com/andremonaco/raum/releases/latest

## 2. Register your first project

1. Launch raum. On first run the **onboarding wizard** opens.
2. Step 1 verifies tmux/git. If either is missing, install it and press
   *Re-check*.
3. Step 2 opens a directory picker. Select the root of any repo. raum
   derives a slug from the folder name and writes
   `~/.config/raum/projects/<slug>/project.toml`. If the repo already
   contains a committed `.raum.toml`, raum turns on **in-repo settings**
   for hydration + worktree overrides.
4. Step 3 picks the default harness (Shell / Claude Code / Codex / OpenCode)
   that `⌘⌥A` will spawn.
5. Step 4 spawns the first pane.

You can also skip the wizard at any step — raum flips
`config.onboarded = true` and never reopens it. The "Add project" (`+`) tab
at the top still works afterwards.

## 3. Spawn your first agent

Once a project is selected in the top row:

- `⌘⇧T` — shell.
- `⌘⇧C` — Claude Code.
- `⌘⇧X` — Codex.
- `⌘⇧O` — OpenCode.

The new pane drops into the project root. If the harness binary is missing,
raum shows a non-blocking toast pointing at the install instructions and
skips the spawn.

Output is rendered by xterm.js with a 10 000-line scrollback; `tmux`'s own
history is unlimited, so nothing is ever lost — use `⌘⇧F` to run a global
scrollback search across every open pane at once.

## 4. Recovery after a crash

**Kill the raum app (⌘Q or `kill`), then reopen it.** tmux keeps running on
the `-L raum` socket, so your agents are still alive. On launch raum:

1. Enumerates every session on the socket.
2. Re-attaches each one to an xterm.js pane (eager concurrent attach).
3. Reconciles with `state/sessions.toml` — anything we don't recognise shows
   up under the **Orphaned** group. You can right-click "Reap stale
   sessions" to kill sessions older than a threshold (default 30 days).

If the raum process itself crashed but tmux is still alive, the state is
identical to a clean restart — that's the whole point of the `-L raum`
socket.

## 5. The preset library

A *layout preset* is a named grid of panes (position + size + kind +
optional title). Presets live in `~/.config/raum/layouts.toml`.

1. Press `⌘⇧G` to open the **grid builder**.
2. Drag cells onto the canvas, pick a kind (shell / claude-code / codex /
   opencode / empty) and optional title, then **Save as preset**.
3. From the sidebar's **Preset chooser**, pick the new preset to apply it.
   Applying to a worktree with running agents prompts
   *keep / replace / merge*.
4. raum remembers each worktree's last-used preset in
   `state/worktree-presets.toml` and pre-selects it in the chooser (without
   auto-applying).

See [`config.md`](./config.md) for the full TOML reference and
[`harness-integration.md`](./harness-integration.md) for how hooks and the
`<raum-managed>` block work.
