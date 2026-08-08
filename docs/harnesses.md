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
| Codex        | `PermissionRequest` hook + `notify` + live OSC 9 from the pane    | Yes (≥ 0.130) | Synchronous hook response         | TUI prompt not shown (hook returned answer)          |
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
  line up to `RAUM_HOOK_TIMEOUT_SECS` (default 85 s — just under raum's
  90 s socket sweeper, and comfortably inside Claude's 600 s default
  `command`-hook budget, so the managed hook entry needs no explicit
  `timeout` field). Answering in raum sends `allow` or `deny` back down
  the parked socket; on timeout the script prints **nothing** and exits
  0, so Claude's native prompt fires — **graceful degradation is the
  default**.

### Codex

- **Scripts**: writes `~/.config/raum/hooks/codex.sh` and a sibling
  `~/.config/raum/hooks/codex-notify.sh` (both `0700`).
- **Config**: edits `~/.codex/config.toml` (managed block setting
  `notify = ["<path to codex-notify.sh>"]`, enabling
  `tui.notifications = true` and `tui.notification_method = "osc9"`
  unconditionally so approval prompts emit OSC 9, and — only on Codex
  ≥ 0.130 — flipping `[features] hooks = true` plus pre-seeding a
  `[hooks.state."<hooks.json path>:<event>:0:0"].trusted_hash` for
  each raum hook so they bypass Codex's `/hooks` review queue
  introduced in [openai/codex#20321][trust-pr]) and
  `<project>/.codex/hooks.json` (managed entries under
  `PermissionRequest`, `UserPromptSubmit` and `Stop` only;
  `SessionStart` is deliberately not subscribed to avoid
  silence-heuristic `Idle → Working` promotion on Codex boot).
- **Hook events covered**: `PermissionRequest` (synchronous),
  `UserPromptSubmit`, `Stop`.
- **Version gate**: Codex 0.130 renamed `[features].codex_hooks` →
  `[features].hooks` ([#20684][rename-pr]) and gated unmanaged hooks
  behind a `trusted_hash` review ([#20321][trust-pr]); raum's plan
  emits both the renamed flag and the matching hash, so we require
  ≥ 0.130. Older binaries get `notify` + OSC 9 only — no inline reply,
  and waiting-state comes from OSC 9 approval notifications. The
  version is probed via `codex --version` at plan time.
- **`trusted_hash` gotcha**: the hash covers Codex's *normalised* hook
  identity, and `PermissionRequest` is the one raum event that keeps
  its `matcher` through that normalisation (`UserPromptSubmit` and
  `Stop` have theirs forced to `None`). Hash the wrong shape and the
  failure is silent: the entry sits `Untrusted`, never runs, and
  approvals quietly fall back to Codex's own prompt.

[rename-pr]: https://github.com/openai/codex/pull/20684
[trust-pr]: https://github.com/openai/codex/pull/20321
- **OSC 9 scrape**: raum parses the live PTY bytes of the attached Codex pane for
  `\x1b]9;<payload>\x07`; `approval-requested` → `PermissionNeeded`,
  `agent-turn-complete` → `TurnEnd`.
- **Notify mapping**: the managed `notify` script is treated as a turn-end
  signal only. `agent-turn-complete` becomes `TurnEnd`; unknown notify
  payloads are ignored rather than being treated as generic waiting-state.
- **Reply**: synchronous hook response, same shape as Claude Code —
  the dispatcher blocks on the event socket and answers with
  `hookSpecificOutput.decision.behavior`. Codex's output schema is
  `deny_unknown_fields` and knows only `allow` and `deny`: there is no
  `"ask"` behaviour and no remember/always field (an allow maps to a
  one-shot `ReviewDecision::Approved`, so the hook fires again next
  time). "No decision" is therefore expressed by printing **nothing**
  and exiting 0, which sends Codex down its normal approval path.
  Below 0.130 there is no reply at all — clicking the notification
  focuses the pane and the user answers in Codex's own TUI.

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

raum requires Codex ≥ 0.130 for the hooks channel (the rename of
`[features].codex_hooks` → `[features].hooks` and the `trusted_hash`
review gate both landed in that release). On older releases raum falls
back to `notify` + OSC 9 only, which covers turn-end reliably but
leaves approval prompts on a heuristic signal and disables inline
Allow/Deny (there is no hook to answer). Upgrade Codex, then
re-bind the project so raum re-writes `hooks.json` and refreshes the
`[hooks.state]` trust entries in `~/.codex/config.toml`.

### Blocking hook times out and the harness TUI prompt fires instead

This is the documented failure-safe path: if raum is closed, crashed,
or just slow to surface the notification, the hook script hits
`RAUM_HOOK_TIMEOUT_SECS` (default 85 s) and gives up — both harnesses
get empty stdout — and the harness shows its own TUI prompt. Nothing is
lost.

Both harnesses budget 600 s for a `command` hook, so the env var can be
raised, but raum's socket sweeper drops an unanswered request after 90 s
regardless: past that point the parked writer is gone, the script reads
EOF and degrades immediately. The default is deliberately kept below the
sweeper so the client-side wait — the only bound that still applies when
raum itself is hung — is what ends the block.

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
