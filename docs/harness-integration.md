# raum harness integration

raum spawns four kinds of panes: **shell**, **Claude Code**, **Codex**, and
**OpenCode**. The three agent panes (Claude / Codex / OpenCode) each have an
adapter in `raum-core` that handles version detection, event ingestion, and
where required — editing the harness' own config file to install raum's
event hook.

## Event socket + hook scripts

On startup raum:

1. Binds a Unix domain socket at
   `~/.config/raum/state/events.sock` (§7.6). Every spawned harness gets
   `RAUM_EVENT_SOCK=<path>` in its environment.
2. Regenerates one hook script per harness under
   `~/.config/raum/hooks/`:
   - `hooks/claude-code.sh`
   - `hooks/opencode.sh`
   - `hooks/codex.sh`
   Each script is `0700`, starts with the header comment
   `# raum-managed — do not edit; regenerated on launch`, opens
   `$RAUM_EVENT_SOCK`, writes exactly one JSON line, and exits.

If `~/.config/raum/hooks/` is not writable (§7.11), raum disables
hook-based detection for affected harnesses, falls back to the silence
heuristic, and shows a single notification explaining the degradation.

## Claude Code adapter

`ClaudeCodeAdapter` reads `~/.claude/settings.json` and installs a raum
block delimited by marker sentinels. The markers are encoded as JSON
**keys**, not inline comments, so the file stays valid JSON:

```json
{
  "hooks": {
    "<raum-managed>":  "do-not-edit",
    "PostToolUse": [
      { "type": "command", "command": "/Users/you/.config/raum/hooks/claude-code.sh" }
    ],
    "Stop": [
      { "type": "command", "command": "/Users/you/.config/raum/hooks/claude-code.sh" }
    ],
    "</raum-managed>": "do-not-edit"
  }
}
```

The two `"<raum-managed>"` / `"</raum-managed>"` keys are the
**JSON-sentinel-key encoding workaround** — a pair of otherwise-unused
object keys that stand in for the XML-style comment markers used by
adapters whose config files support them (TOML/YAML). raum parses the file,
locates the key pair, replaces every entry between them, and writes atomic.
Nothing outside the sentinels is touched, so user-managed hooks, MCP
servers, models, and permissions are preserved byte-for-byte.

The install is idempotent: running raum twice produces the same file.

## OpenCode adapter

`OpenCodeAdapter` writes an analogous block into OpenCode's hooks config
location, pointing at `~/.config/raum/hooks/opencode.sh`. The same
sentinel-key scheme is used for JSON configs; YAML/TOML variants use
`# <raum-managed>` / `# </raum-managed>` comment markers.

## Codex adapter

Codex doesn't support external hooks, so `CodexAdapter` sets the flags and
environment variables that enable Codex's own stdout JSON event stream,
then parses those events from the pane's output. No config file is
modified. Detection works without touching any shared config.

## Agent state machine

Every session moves through `idle → working → waiting → completed` (or
`errored`). Transitions are driven by:

- Hook events delivered through `RAUM_EVENT_SOCK` (for hooks-capable
  harnesses).
- Parsed stdout events (Codex).
- A silence-heuristic fallback: per-harness threshold in ms (default 500;
  overridable via `agent_defaults.silence_threshold_ms`). If the pane has
  been silent longer than the threshold and the agent isn't explicitly in
  `waiting`, raum infers `waiting` from silence alone.

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
2. Open the harness' config file (e.g. `~/.claude/settings.json`).
3. Delete the `"<raum-managed>"` key, the `"</raum-managed>"` key, and
   every entry between them. For comment-based configs (YAML/TOML), delete
   the `# <raum-managed>` line, the `# </raum-managed>` line, and
   everything between them.
4. Delete `~/.config/raum/hooks/` if you want to drop the scripts too.

raum never writes to any config file it didn't install, and never deletes
a file it didn't create.
