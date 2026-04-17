# raum privacy

raum is a local-first, offline-first tool. We make **one** outbound network
call from the app itself.

## The updater check

On launch the Tauri updater plugin fetches
`https://github.com/andremonaco/raum/releases/latest/download/latest.json`
(configured at `src-tauri/tauri.conf.json → plugins.updater.endpoints`).
That request:

- GETs a signed JSON manifest (Tauri updater format).
- Contains the raum version, the current OS/arch, and the user-agent string
  the Tauri updater emits. No user content, no session data, no project
  paths, no agent output.
- Goes to GitHub Releases. We don't operate any raum-specific servers.

If you want to disable the updater entirely, delete the `plugins.updater`
block in `tauri.conf.json` before building from source.

## Everything else stays local

- **Terminal output** is streamed from tmux over a Unix FIFO on your local
  machine, coalesced into the webview process via Tauri IPC (Channel), and
  rendered by xterm.js. It never leaves the host.
- **Hook events** travel over a Unix domain socket at
  `~/.config/raum/state/events.sock`. No TCP, no UDP.
- **OpenCode harness** events reach raum through a loopback-only HTTP
  call to `http://127.0.0.1:<port>/event` (SSE) and the matching POST
  reply to `http://127.0.0.1:<port>/permission/:id/reply`. The port is
  discovered from `$OPENCODE_PORT`, the OpenCode lockfile under
  `$XDG_STATE_HOME/opencode/lockfile`, or falls back to the documented
  default `4096`. raum never opens non-loopback sockets for this path.
- **Project / worktree / layout config** lives under `~/.config/raum/`
  (XDG-aware), created with `0700` permissions.
- **Logs** rotate daily into `~/.config/raum/logs/` with 3-day retention.

Agent harnesses (Claude Code, Codex, OpenCode) talk to their own upstream
services over their own network paths. Those requests are originated by the
harness binary, not by raum. Consult each harness' privacy policy for the
specifics.

## CI-enforced audit

`Notifications` §11.7 integration tests assert that raum performs **no**
outbound network calls during a `waiting`-state notification burst. The
test runs in a network-denying harness in CI.
