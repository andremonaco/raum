# raum privacy

raum is a local-first, offline-first tool. The app process itself makes
**one** kind of outbound network call: the update check below. Everything
else that touches the network runs as a separate binary you installed and
authenticated yourself — the agent harnesses, and the optional GitHub
integration through the `gh` CLI. raum spawns those as subprocesses the same
way it spawns `git`; it holds no tokens and opens no sockets of its own.

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

## GitHub integration (opt-in, via gh)

The pull-request, checks, deployments, releases and merge features are
**off** until two things are true: GitHub's own `gh` CLI is on your `PATH`,
and `gh auth status` reports a logged-in host. Settings → Harnesses →
Prerequisites shows the probe result. If either is missing, raum never
spawns `gh` and the GitHub chrome stays hidden.

When it is on, raum runs `gh` as a subprocess — exactly how it already runs
`git` — and reads the JSON on stdout. The HTTPS request is made by the `gh`
binary with the token `gh auth login` stored in your keychain. raum never
sees, copies or persists that token, and no HTTP client crate is linked into
the app.

**What is sent to GitHub** (as arguments to `gh`, and from there into the
GitHub API):

- The repository owner and name, which `gh` derives from the `origin` remote
  of the worktree it runs in.
- Branch names, pull-request numbers and merge options you pick in the merge
  sheet.
- The text you type into the Spotlight PR search.

**What is never sent:** terminal output, pane or session contents, agent
prompts and replies, file contents, project paths, and your raum config.

**Polling cadence.** raum polls, because GitHub offers no client-side push
channel. The rate follows the state: every 10 s while checks or deployments
are still running, every 90 s for a settled open PR, every 2–5 min for
settled deployments and releases, and every 5 min for branches with no PR.
Polling is paused whenever the raum window is unfocused, and runs only for
the active project.

**How to disable it.** Run `gh auth logout`, or uninstall `gh`. The next
probe finds no authenticated host and the integration goes dark; nothing
needs to be reset inside raum.

**GitHub Enterprise.** raum compares the host of your `origin` remote against
the hosts `gh auth status` lists, so an Enterprise host works as soon as
`gh auth login --hostname <host>` succeeds. Worktrees whose remote is not a
host `gh` is logged into are skipped entirely.

## CI-enforced audit

`Notifications` §11.7 integration tests assert that raum performs **no**
outbound network calls during a `waiting`-state notification burst. The
test runs in a network-denying harness in CI.

`crates/raum-core/tests/no_outbound_network.rs` additionally rejects any
direct HTTP dependency (`reqwest`, `hyper`, `octocrab`, …) outside the
updater plugin and the loopback-only OpenCode path. The GitHub integration
adds no crate to that list — it shells out to `gh` instead, so the test is
unchanged.
