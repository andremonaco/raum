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

Install raum itself:

- **macOS** — `brew install --cask andremonaco/raum/raum`. The cask strips
  Gatekeeper's quarantine flag so the ad-hoc-signed bundle launches directly;
  direct `.dmg` downloads from the [latest release][releases] currently
  require `xattr -dr com.apple.quarantine /Applications/raum.app` once after
  installing, until Developer ID notarization lands.
- **Linux** — install the `.deb` (Ubuntu/Debian) or run the `.AppImage`
  (anything with FUSE) from the [latest release][releases].

[releases]: https://github.com/andremonaco/raum/releases/latest

## 2. Register your first project

1. Launch raum. On first run the **onboarding wizard** opens.
2. Step 1 verifies tmux/git. If either is missing, install it and press
   *Re-check*.
3. Step 2 opens a directory picker. Select the root of any repo. raum
   derives a slug from the folder name and writes
   `~/.config/raum/projects/<slug>/project.toml`. If the repo already
   contains a committed `.raum.toml`, raum turns on **in-repo settings**
   for hydration + worktree overrides. Project settings (click the active
   top-row tab) also expose optional **setup hooks** — pre- and post-create
   executables that run around `git worktree add` (see
   [Worktree lifecycle hooks](./config.md#worktree-lifecycle-hooks)).
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

Output is rendered by xterm.js with a 10 000-line scrollback. xterm.js owns
scrollback end-to-end via three tmux server options working together:

- `terminal-overrides "*:smcup@:rmcup@"` — tmux never sends alt-screen
  enter/exit to the attached xterm.js client, so xterm stays in the normal
  buffer where wheel-to-scrollback works natively.
- `mouse off` — wheel/click events reach xterm.js untouched; tmux's own
  copy-mode is unreachable (it's unreliable with TUIs anyway).
- `alternate-screen off` — inner Ink-based TUIs (Claude Code, Codex,
  OpenCode) render directly into the pane's main buffer using their
  log-update pattern (cursor positioning + `\r`, in-place rewrites). Without
  this, a SIGWINCH-triggered full repaint would accumulate ghost frames in
  the user's scroll history on every resize. Trade-off: a TUI's last frame
  stays visible after exit instead of being replaced by pre-TUI content.

Use `⌘⇧F` to run a global scrollback search across every open pane at
once.

## 4. System notifications on macOS

macOS registers an app with the Notification Center (so you can grant
permission in **System Settings → Notifications**) only when it's
launched from a signed, bundled `.app`. `task dev` runs the unbundled
binary, which the OS can't track — `requestPermission()` silently
fails and raum never shows up in the notifications list.

- **Production use** — download the notarized release or run `task
  build`, then launch `target/release/bundle/macos/raum.app`. On first
  run macOS prompts for notification permission; grant it once and
  raum appears in System Settings going forward.
- **`task dev`** — raum detects the unavailable notification center
  and falls back to **in-app banners + configurable sound**. No OS
  notifications fire, but the sidebar counters, dock badge, and
  banners all behave identically.

Linux follows freedesktop conventions and works the same way in dev
and production — no bundling step is required.

## 5. Recovery after a crash

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

See [`config.md`](./config.md) for the full TOML reference,
[`harnesses.md`](./harnesses.md) for the per-harness reliability / reply
matrix, and [`harness-integration.md`](./harness-integration.md) for how
hooks and the `<raum-managed>` block work.
