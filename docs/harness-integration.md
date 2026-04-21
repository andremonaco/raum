# raum harness integration

raum spawns four kinds of panes: **shell**, **Claude Code**, **Codex**, and
**OpenCode**. The three agent panes (Claude / Codex / OpenCode) each have an
adapter in `raum-core` that handles version detection, event ingestion, and
where required — editing the harness' own config file to install raum's
event hook.

## Event socket + hook scripts

On startup raum binds a Unix domain socket at
`~/.config/raum/state/events.sock` (§7.6). Every spawned harness gets
`RAUM_EVENT_SOCK=<path>` in its environment.

The shell-script dispatchers that talk to that socket are written **per
harness install**, not at startup. Every adapter's
`NotificationSetup::plan()` emits a `SetupAction::WriteShellScript` for
each dispatcher it needs; `SetupExecutor::apply()` drops them under
`~/.config/raum/hooks/` as part of the same atomic plan that writes the
harness config entries referencing them:

| Harness      | Script(s) written                                             |
| ------------ | ------------------------------------------------------------- |
| Claude Code  | `hooks/claude-code.sh`                                        |
| Codex        | `hooks/codex.sh` + `hooks/codex-notify.sh`                    |
| OpenCode     | *(none — notifications arrive live via SSE, see below)*       |

Each script is `0700`, starts with the header comment
`# raum-managed — do not edit; regenerated on launch`, opens
`$RAUM_EVENT_SOCK`, writes exactly one JSON line, and exits. The
`PermissionRequest` path keeps the connection open long enough to
read a decision back (`allow` / `deny` / `ask`) so Claude Code and
Codex can block their own tool call until raum's UI has decided.

If `~/.config/raum/hooks/` is not writable (§7.11), the install plan
reports failed actions in the Harness Health panel; detection for the
affected harness falls back to the silence heuristic.

## Claude Code adapter

`ClaudeCodeAdapter` writes the hook block into the project's
`<project>/.claude/settings.local.json` — the officially-documented
personal, auto-gitignored settings layer. This keeps raum's
machine-specific hook paths out of the repo's shared
`.claude/settings.json`, which is the team-checked-in layer. Prior
raum versions wrote into `settings.json`; the plan now sweeps any
stale raum-managed entries out of both `.claude/settings.json` and
`~/.claude/settings.json` on every install so upgrading is silent.

Every raum-managed entry is tagged with a `_raum_managed_marker`
sentinel. Re-running the install replaces them in place without
touching user-authored entries:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "_raum_managed_marker": "<raum-managed>",
        "matcher": ".*",
        "hooks": [
          { "type": "command", "command": "/Users/you/.config/raum/hooks/claude-code.sh PostToolUse" }
        ]
      }
    ]
  }
}
```

The install is idempotent and project-scoped: running the plan twice
produces the same file, and two projects' settings coexist without
clobbering each other. Any user-authored entry without the sentinel
is preserved byte-for-byte.

## Codex adapter

`CodexAdapter` wires three complementary observation channels:

1. **Hooks** (`<project>/.codex/hooks.json`, gated on `[features]
   codex_hooks = true` in `~/.codex/config.toml`). Event-driven; each
   managed entry points at `~/.config/raum/hooks/codex.sh <Event>`.
   Requires Codex ≥ 0.119 — on older builds the plan skips the hooks
   write and leans on the notify script below. The released hook set raum
   installs is intentionally coarse: `UserPromptSubmit` and `Stop` only.
   `SessionStart` is deliberately *not* subscribed — it would arm the
   silence heuristic at harness boot and promote `Idle → Working` off
   Codex's TUI startup redraw. `PreToolUse` and `PostToolUse` are
   Bash-scoped and are not used for visible session status.
2. **`notify` script** (top-level `notify = [...]` in
   `~/.codex/config.toml`). Codex invokes `codex-notify.sh` with the
   payload as `argv[1]`; the script forwards it to
   `$RAUM_EVENT_SOCK` tagged `source: "notify"`. The current managed
   mapping treats this as a turn-end signal (`agent-turn-complete`) and
   ignores unknown notify payloads.
3. **OSC 9 scrape**. Codex's TUI emits `\x1b]9;<payload>\x07` on
   approval / turn-complete when `tui.notifications` is enabled; raum
   parses those escapes out of the live PTY byte stream of the attached
   pane. `approval-requested*` drives waiting-state; `agent-turn-complete`
   drives turn-end.

The managed `config.toml` block also enables `tui.notifications = true`
and sets `tui.notification_method = "osc9"` so the attention-needed
signal comes from Codex's supported TUI notification surface rather than
tool-level hooks.

Codex has no replier today: the hook runtime accepts a
`permissionDecision` field, but the upstream enforcement path is not
wired yet. Observation only — click on the notification focuses the
pane and the user answers in Codex's native TUI.

## OpenCode adapter

`OpenCodeAdapter` does **not** install a shell hook. OpenCode exposes
its internal event bus directly over HTTP as a Server-Sent Events
stream (`GET /event`) on the local OpenCode server, so raum subscribes
to that stream in-process via `OpenCodeSseChannel`. Replies (allow /
deny) go back over the same HTTP server through `HttpReplyReplier`.
raum currently keeps the request-scoped compatibility POST
(`/permission/:id/reply`) even though the public docs describe a newer
session-scoped permissions route.

The only disk action in OpenCode's install plan is a
`RemoveManagedJsonEntries` cleanup that strips any stale
`<raum-managed>` entries a previous raum version wrote into the
OpenCode `config.json`. No raum block is installed in the config — the
SSE bus is the live transport.

Port discovery chains
`$OPENCODE_PORT → $XDG_STATE_HOME/opencode/lockfile → 4096`, so
out-of-band tooling can pin the port via env var or a one-line lockfile.

## Agent state machine

Every session moves through `idle → working → waiting → completed` (or
`errored`). Transitions are driven by:

- Hook events delivered through `RAUM_EVENT_SOCK` (Claude Code, Codex).
- SSE events from the OpenCode HTTP server.
- OSC 9 payloads scraped from the live attached-pane PTY stream (Codex).
- A silence-heuristic fallback: per-harness threshold in ms (default 500;
  overridable via `agent_defaults.silence_threshold_ms`). If the pane has
  been silent longer than the threshold and the harness has no live event
  path, raum falls back to `working → idle` on silence alone.

The waiting-state classifier is payload-aware:

- Claude Code `Notification` only counts as waiting when
  `notification_type` is one of `permission_prompt`, `idle_prompt`, or
  `elicitation_dialog`; non-interactive notifications like
  `auth_success` are ignored.
- Codex `notify` payloads are not treated as generic waiting-state.
- Unknown notifications are ignored rather than being collapsed into
  `waiting`.

State transitions emit `agent-state-changed` on the Tauri event bus, where
the notifications subsystem (§11), the top-row filters (§8), and the
sidebar agent list (§9) subscribe.

## Missing-binary + minimum-version handling

On spawn raum probes the harness binary (`<harness> --version`). If the
binary is absent on `PATH`, raum fires a non-blocking notification with
install instructions and **does not create** a tmux session (§7.9). If the
version is below the adapter's hard-coded minimum, raum fires a
non-blocking warning toast and spawns anyway (§7.10).

## Uninstalling the hooks

To remove raum's hooks from a harness config cleanly:

1. Quit raum.
2. Open the harness' config file (e.g. `<project>/.claude/settings.local.json`).
3. Delete the `"<raum-managed>"` key, the `"</raum-managed>"` key, and
   every entry between them. For comment-based configs (YAML/TOML), delete
   the `# <raum-managed>` line, the `# </raum-managed>` line, and
   everything between them.
4. Delete `~/.config/raum/hooks/` if you want to drop the scripts too.

raum never writes to any config file it didn't install, and never deletes
a file it didn't create.
