# raum harnesses

raum observes three coding-agent harnesses (Claude Code, Codex, OpenCode)
via their documented notification surfaces — hook scripts, SSE event
streams, OSC 9 terminal escapes — and, where the harness exposes a
reply channel, can answer an inline permission prompt from a raum
notification without leaving the app. The **native harness TUI stays
authoritative**: raum is an observer and an optional reply proxy, never
the chat UI itself.

This page summarises what raum does per harness, where it writes, what
you see when things degrade, and how to uninstall cleanly.

## Reliability / reply matrix

| Harness      | Observe                                                           | Reply | Reply transport                          | TUI behaviour when raum replies                      |
| ------------ | ----------------------------------------------------------------- | ----- | ---------------------------------------- | ---------------------------------------------------- |
| Claude Code  | `PermissionRequest` / `Notification` hooks → UDS socket           | Yes   | Synchronous hook response                | TUI prompt not shown (hook returned answer)          |
| OpenCode     | SSE `permission.asked` on `GET /event`                            | Yes   | Compatibility HTTP reply to local server | TUI dialog closes when server state updates          |
| Codex        | hooks + `notify` + live OSC 9 from the attached pane             | No    | n/a — observation-only                   | TUI prompt unchanged; user answers in pane           |
| Shell        | (out of scope)                                                    | No    | n/a                                      | n/a                                                  |

**Reliability badges.** Each channel publishes a reliability signal that
the dock renders as a solid, dashed, or dotted ring on the Waiting
state badge:

- **Deterministic** — the harness told us directly over a structured
  channel (Claude Code hook script, OpenCode SSE).
- **Event-driven** — structured events with a heuristic mapping
  (OpenCode `session.status`, Codex OSC 9).
- **Heuristic** — inferred from indirect signals, e.g. stdout silence.

## What raum writes on project bind

raum stages every setup side effect into a [`SetupPlan`] and applies it
through a single [`SetupExecutor`] so every harness shares one
"write config safely" path: atomic tempfile + rename, parent dir
creation, explicit mode bits on shell scripts. The per-action outcome
is rendered in the **Harness Health** panel of the Settings modal.

[`SetupPlan`]: ../crates/raum-core/src/harness/setup.rs
[`SetupExecutor`]: ../crates/raum-core/src/harness/setup.rs

### Claude Code

- **Script**: writes `~/.config/raum/hooks/claude-code.sh` (mode `0700`).
- **Config**: edits `<project>/.claude/settings.local.json` — the
  officially-documented personal, auto-gitignored settings layer, so
  raum never pollutes the repo's shared `.claude/settings.json`. The
  `_raum_managed_marker: "<raum-managed>"` sentinel key tags every raum
  entry so reinstalling leaves user-authored hooks untouched. Legacy
  installs under `~/.claude/settings.json` or `<project>/.claude/settings.json`
  are swept on every reinstall.
- **Hook events covered**: `PermissionRequest` (synchronous),
  `Notification`, `Stop`, `UserPromptSubmit`, `StopFailure`.
- **Reply flow**: Claude Code spawns the hook; the script opens the UDS
  socket, writes the request JSON, **blocks** reading for a decision
  line up to `RAUM_HOOK_TIMEOUT_SECS` (default 55 s — 5 s headroom below
  Claude's 60 s hook timeout). raum currently surfaces a focus-only
  notification; the user answers in Claude's own TUI after jumping to
  the pane. On timeout the script emits `permissionDecision: "ask"` so
  Claude's native prompt fires — **graceful degradation is the default**.

### Codex

- **Scripts**: writes `~/.config/raum/hooks/codex.sh` and a sibling
  `~/.config/raum/hooks/codex-notify.sh` (both `0700`).
- **Config**: edits `~/.codex/config.toml` (managed block setting
  `notify = ["<path to codex-notify.sh>"]`, enabling
  `tui.notifications = true` and `tui.notification_method = "osc9"`
  unconditionally so approval prompts emit OSC 9, and — only on Codex
  ≥ 0.119 — flipping `[features] codex_hooks = true`) and
  `<project>/.codex/hooks.json` (managed entries under
  `UserPromptSubmit` and `Stop` only; `SessionStart` is deliberately
  not subscribed to avoid silence-heuristic `Idle → Working`
  promotion on Codex boot).
- **Version gate**: Codex hooks first shipped in v0.119; older binaries
  get `notify` + OSC 9 only. The version is probed via `codex --version`
  at plan time. raum does **not** assume a released `PermissionRequest`
  hook yet; supported builds derive waiting-state from OSC 9 approval
  notifications instead.
- **OSC 9 scrape**: raum parses the live PTY bytes of the attached Codex pane for
  `\x1b]9;<payload>\x07`; `approval-requested` → `PermissionNeeded`,
  `agent-turn-complete` → `TurnEnd`.
- **Notify mapping**: the managed `notify` script is treated as a turn-end
  signal only. `agent-turn-complete` becomes `TurnEnd`; unknown notify
  payloads are ignored rather than being treated as generic waiting-state.
- **Reply**: none. Click on the notification focuses the Codex pane;
  the user answers in Codex's own TUI.

### OpenCode

- **No config write.** OpenCode exposes its bus on `GET /event`
  unconditionally; raum subscribes directly. Phase 4 flipped the
  integration away from the old hook-injection approach. The only
  setup action is a `RemoveManagedJsonEntries` migration that strips
  stale `<raum-managed>` entries from
  `$XDG_CONFIG_HOME/opencode/config.json` if they exist.
- **Port discovery**: `$OPENCODE_PORT` →
  `$XDG_STATE_HOME/opencode/lockfile` → default `4096`.
- **Channel**: [`OpenCodeSseChannel`] parses the SSE stream, translates
  `permission.asked` → `PermissionNeeded` (with OpenCode's `id` as the
  raum `request_id`), `permission.replied` → `TurnEnd`, and
  `session.status` with `status.type == "idle"` → `TurnEnd`. Reconnects
  with exponential backoff (500 ms → 30 s) on disconnect.
- **Reply**: [`HttpReplyReplier`] POSTs
  `{"reply": "once" | "always" | "reject"}` to
  `http://127.0.0.1:<port>/permission/:id/reply`. The public OpenCode
  docs currently describe a session-scoped permissions route; raum keeps
  the request-scoped compatibility path that still matches the current
  server implementation. Two-surface by design — the OpenCode TUI and
  the raum notification are both valid answer surfaces; whichever
  arrives first wins.

[`OpenCodeSseChannel`]: ../crates/raum-core/src/harness/opencode_sse.rs
[`HttpReplyReplier`]: ../crates/raum-core/src/harness/opencode_reply.rs

## Transport fallback chain

The hook scripts forward events over the Unix event socket using a
three-tier fallback chain:

1. **`socat`** — preferred; honours explicit read-side timeouts on the
   blocking `PermissionRequest` path.
2. **`nc -U`** — OpenBSD / BSD / macOS nc. On macOS make sure you're
   on the Apple-shipped `nc`; `brew install netcat` installs a GNU
   variant that behaves differently with Unix sockets.
3. **`python3`** — universal fallback. Any CPython 3 on `$PATH`
   works; the script uses the `socket` stdlib module (no third-party
   imports).

If **none** of these are present, raum falls back to the silence
heuristic on its own (the hook script simply exits 0 without writing)
and the Harness Health panel surfaces a persistent warning. The
`notification_roundtrip` integration test in
`crates/raum-core/tests/notification_roundtrip.rs` exercises the
transport chain end-to-end on every `task test:all` run; the CI matrix
additionally runs the suite on a runner with `socat` and `nc`
stripped out so the `python3` fallback path is continuously verified.

## Troubleshooting

### No events arrive on the dock

1. Check `~/.config/raum/state/events.sock` exists. If not, raum failed
   to bind the socket — inspect the tracing log at
   `~/.config/raum/logs/`.
2. Confirm at least one of `socat`, `nc`, or `python3` is on `$PATH`
   **inside the harness's environment**. Some shell-rc setups strip
   `/usr/local/bin` when a non-interactive shell spawns.
3. Re-run the **Harness Health** selftest in Settings. A passing
   selftest confirms the event socket is reachable from raum's own
   process.

### OpenCode reliability ring stays dotted (server not running)

OpenCode must be started with its HTTP server enabled:
`opencode serve --port <N>`. raum's SSE channel retries with
exponential backoff (500 ms → 30 s); the dock flips from dotted to
solid when the connection succeeds. If your OpenCode runs on a
non-standard port, set `OPENCODE_PORT` in the launch environment
before spawning the harness.

### Codex reliability ring stays dotted (below hooks minimum version)

Codex hooks first shipped in v0.119. On older releases raum falls back
to `notify` + OSC 9 only, which covers turn-end reliably but leaves
approval prompts on a heuristic signal. Upgrade Codex, then re-bind the
project so raum re-writes `hooks.json`.

### Blocking hook times out and Claude's TUI prompt fires instead

This is the documented failure-safe path: if raum is closed, crashed,
or just slow to surface the notification, the hook script hits
`RAUM_HOOK_TIMEOUT_SECS` (default 55 s), emits
`permissionDecision: "ask"`, and Claude shows its own TUI. Nothing is
lost. You can raise the timeout via env var, but keep it below 60 s —
Claude Code's default hook timeout is 60 s and the script needs
headroom to print stdout and exit.

## Uninstalling

raum never writes to a config file it didn't install, and never
deletes a file it didn't create. To remove raum from a harness config:

1. Quit raum.
2. Open the harness's config file (e.g.
   `<project>/.claude/settings.local.json`, `<project>/.codex/hooks.json`,
   `~/.codex/config.toml`).
3. Delete the raum entries: for JSON configs drop every array entry
   whose `_raum_managed_marker` is `"<raum-managed>"`; for TOML the
   managed block is framed by `# <raum-managed>` / `# </raum-managed>`
   comment lines.
4. Delete `~/.config/raum/hooks/` to drop the hook scripts themselves.

The managed-block tooling (`crates/raum-core/src/config_io/`) is
idempotent: the scripted entries can be removed cleanly by rebinding
the project with every harness deselected, or by calling
`SetupAction::RemoveManagedJsonEntries` manually.

## Privacy

Every harness integration is local-only. Hook events travel over a
Unix domain socket, OpenCode's SSE / reply endpoints are loopback
(`http://127.0.0.1:<port>/…`). No outbound network call leaves the
host from the harness layer. See [`docs/privacy.md`](./privacy.md) for
the full audit and the single whitelisted outbound call (the Tauri
updater's release-manifest fetch).

## Further reading

- [Claude Code hooks docs](https://code.claude.com/docs/en/hooks)
- [Codex hooks + config advanced](https://developers.openai.com/codex/hooks)
- [OpenCode server + permissions](https://opencode.ai/docs/server/)
- [`docs/harness-integration.md`](./harness-integration.md) — the
  original marker / sentinel scheme and the state machine.
