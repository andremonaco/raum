# raum configuration reference

Every raum setting lives in a TOML file under `~/.config/raum/` (XDG-aware,
created with `0700` permissions on first launch). This page documents every
key, every default, and every accelerator action.

- [`config.toml`](#configtoml) — user-global settings.
- [`projects/<slug>/project.toml`](#projectsslugprojecttoml) — per-project
  registration.
- [`.raum.toml`](#raumtoml) — optional, committed repo-level overrides.
- [`layouts.toml`](#layoutstoml) — named layout presets.
- [`state/worktree-presets.toml`](#stateworktree-presetstoml) — per-worktree
  last-used preset pointer.
- [`keybindings.toml`](#keybindingstoml) — accelerator overrides.
- [Action reference](#action-reference) — every accelerator action name.

Path-pattern grammar and the hydration manifest shape are summarised at the
end.

---

## `config.toml`

Top-level primitives, followed by nested tables. Missing keys fall back to
the defaults below; unknown keys are preserved on round-trip and logged at
INFO.

```toml
onboarded  = false      # flipped to true on wizard finish / skip (§13.2)
multiplexer = "tmux"    # only "tmux" is supported today

[worktreeConfig]
pathPattern       = "{parent-dir}/{base-folder}-worktrees/{branch-slug}"
branchPrefixMode  = "none"          # "none" | "username" | "custom"
# branchPrefixCustom  = "feat/"      # required when branchPrefixMode = "custom"

[rendering]
webgl_on_linux = false   # opt-in: WebGL on WebKitGTK is off by default (§4.3)

[notifications]
# sound = "/System/Library/Sounds/Glass.aiff"  # optional; OS sound or custom path (§11.5)
notifications_hint_shown = false   # set true after the "permission denied" banner

[sidebar]
width_px  = 280
collapsed = false

[keybindings]
# overrides is an action-name -> accelerator map; see "keybindings.toml" below.
[keybindings.overrides]
# "global-search" = "CmdOrCtrl+K"
```

### Key table

| Key                                       | Default                                                          | Meaning |
| ----------------------------------------- | ---------------------------------------------------------------- | ------- |
| `onboarded`                               | `false`                                                          | Wizard has completed or been skipped (§13.2). |
| `multiplexer`                             | `"tmux"`                                                         | Only tmux is supported. |
| `worktreeConfig.pathPattern`              | `"{parent-dir}/{base-folder}-worktrees/{branch-slug}"`           | Template for new worktrees (see [Path patterns](#path-patterns)). |
| `worktreeConfig.branchPrefixMode`         | `"none"`                                                         | `none` / `username` / `custom`. |
| `worktreeConfig.branchPrefixCustom`       | _unset_                                                          | Required when `branchPrefixMode = "custom"`. |
| `rendering.webgl_on_linux`                | `false`                                                          | Opt-in WebGL on WebKitGTK (§4.3). |
| `notifications.sound`                     | _unset_                                                          | Path to an audio file played on `waiting`. Settings UI offers a dropdown of OS-bundled sounds (`/System/Library/Sounds/*.aiff` on macOS, `/usr/share/sounds/freedesktop/stereo/*.oga` on Linux) or a custom path (§11.5). |
| `notifications.notifications_hint_shown`  | `false`                                                          | Marks the one-time in-app banner as shown. |
| `sidebar.width_px`                        | `280`                                                            | Persisted drag width (§9.7). |
| `sidebar.collapsed`                       | `false`                                                          | Persisted collapse toggle. |
| `keybindings.overrides`                   | `{}`                                                             | Accelerator overrides; see below. |

Internal constants (not exposed as keys, documented here for reference):

| Constant                         | Value    | Purpose |
| -------------------------------- | -------- | ------- |
| `DEFAULT_COALESCE_INTERVAL_MS`   | `12`     | Output-coalescer tick (§3.3). |
| `DEFAULT_COALESCE_BYTES`         | `16384`  | Coalescer flush threshold (§3.3). |
| `DEFAULT_SILENCE_THRESHOLD_MS`   | `500`    | Silence-heuristic fallback (§7.7). |
| `DEFAULT_DEBOUNCE_MS`            | `500`    | TOML write debounce (§10.9). |
| `XTERM_SCROLLBACK_LINES`         | `10000`  | xterm.js scrollback cap (§3.8). |
| `QUICKFIRE_HISTORY_LIMIT`        | `100`    | Quick-fire history size (§9.6). |

---

## `projects/<slug>/project.toml`

Written by `project_register`. Never contains paths outside
`~/.config/raum/projects/<slug>/`.

```toml
slug              = "acme"
name              = "Acme"
root_path         = "/Users/you/src/acme"
color             = "#7dd3fc"      # pseudo-random palette pick on register
in_repo_settings  = false          # flipped true if .raum.toml was detected

[hydration]
copy    = []    # files / dirs copied into new worktrees
symlink = []    # files / dirs symlinked (win over duplicates in `copy`)

[worktree]
pathPattern       = "{parent-dir}/{base-folder}-worktrees/{branch-slug}"
branchPrefixMode  = "none"

[agent_defaults]
# default = "claude-code"
# [agent_defaults.silence_threshold_ms]
# claude-code = 500
```

Defaults mirror `config.toml` for the `worktree` table. The `color` default
is a palette pick (not a fixed hex) so tabs stay visually distinct on the
top row.

---

## `.raum.toml`

Committed, repo-level overrides. Deep-merges over `project.toml`. Allowed
top-level keys:

```toml
[hydration]
copy    = [".env", "config/secrets.local.toml"]
symlink = ["node_modules"]

[worktree]
pathPattern      = "../{base-folder}-trees/{branch-slug}"
branchPrefixMode = "username"

[agent_defaults]
default = "claude-code"
```

Unknown keys at the top level are tolerated and logged at INFO (§2.6).
raum only writes to `.raum.toml` when `in_repo_settings = true` is set on
the project.

---

## `layouts.toml`

Array-of-tables of named presets (§10.2).

```toml
[[preset]]
name       = "pair"
created_at = 1731500000   # optional, unix seconds
  [[preset.cells]]
  x = 0
  y = 0
  w = 6
  h = 12
  kind = "claude-code"
  title = "planner"
  [[preset.cells]]
  x = 6
  y = 0
  w = 6
  h = 12
  kind = "shell"
```

`kind` is one of `shell`, `claude-code`, `codex`, `opencode`, `empty`.
Preset names are unique.

---

## `state/worktree-presets.toml`

Flat `worktree-id -> preset-name` map (§10.5). Cleared entries are removed
when the referenced preset is deleted.

```toml
"acme:feat-auth"  = "pair"
"acme:feat-billing" = "solo"
```

---

## `keybindings.toml`

Action-name to accelerator string overrides. Invalid accelerators and
unknown actions are logged (WARN) and dropped; the default keymap stays in
place (§12.2).

```toml
[overrides]
"global-search"    = "CmdOrCtrl+K"
"spawn-claude-code" = "CmdOrCtrl+Shift+J"
```

Accelerator grammar: one or more modifiers (`Cmd`, `Command`, `Super`,
`Meta`, `Ctrl`, `Control`, `CmdOrCtrl`, `CommandOrControl`, `Alt`, `Option`,
`AltGr`, `Shift`) joined by `+`, followed by exactly one key token
(single character, arrow, `F1`–`F24`, `Space`, `Tab`, `Enter`, `Escape`,
`Backspace`, `Delete`, `Home`, `End`, `PageUp`, `PageDown`, `Insert`,
`CapsLock`, `NumLock`, `ScrollLock`, `PrintScreen`, `Pause`, `Plus`,
`Minus`, `Equal`, `Comma`, `Period`, `Slash`, `Backslash`, `Semicolon`,
`Quote`, `BracketLeft`, `BracketRight`, `Backquote`).

---

## Action reference

Source of truth: `src-tauri/src/keymap.rs::DEFAULTS`. Global rows fire as
OS-level shortcuts via `tauri-plugin-global-shortcut`; everything else is
an app-level handler.

### Spawn

| Action               | Default accelerator     | Description |
| -------------------- | ----------------------- | ----------- |
| `spawn-shell`        | `CmdOrCtrl+Shift+T`     | Spawn a shell pane |
| `spawn-claude-code`  | `CmdOrCtrl+Shift+C`     | Spawn a Claude Code pane |
| `spawn-codex`        | `CmdOrCtrl+Shift+X`     | Spawn a Codex pane |
| `spawn-opencode`     | `CmdOrCtrl+Shift+O`     | Spawn an OpenCode pane |

### Top-row navigation

| Action                      | Default accelerator     | Description |
| --------------------------- | ----------------------- | ----------- |
| `cycle-tab-next`            | `CmdOrCtrl+Alt+Right`   | Cycle to next top-row tab |
| `cycle-tab-prev`            | `CmdOrCtrl+Alt+Left`    | Cycle to previous top-row tab |
| `select-project-1`          | `CmdOrCtrl+Shift+1`     | Select project tab 1 |
| `select-project-2`          | `CmdOrCtrl+Shift+2`     | Select project tab 2 |
| `select-project-3`          | `CmdOrCtrl+Shift+3`     | Select project tab 3 |
| `select-project-4`          | `CmdOrCtrl+Shift+4`     | Select project tab 4 |
| `select-project-5`          | `CmdOrCtrl+Shift+5`     | Select project tab 5 |
| `select-project-6`          | `CmdOrCtrl+Shift+6`     | Select project tab 6 |
| `select-project-7`          | `CmdOrCtrl+Shift+7`     | Select project tab 7 |
| `select-project-8`          | `CmdOrCtrl+Shift+8`     | Select project tab 8 |
| `select-project-9`          | `CmdOrCtrl+Shift+9`     | Select project tab 9 |
| `select-filter-active`      | `CmdOrCtrl+1`           | Filter: Active |
| `select-filter-needs-input` | `CmdOrCtrl+2`           | Filter: Needs input |
| `select-filter-recent`      | `CmdOrCtrl+3`           | Filter: Recent |

### Panes

| Action                | Default accelerator     | Description |
| --------------------- | ----------------------- | ----------- |
| `focus-pane-1`        | `CmdOrCtrl+Alt+1`       | Focus pane 1 |
| `focus-pane-2`        | `CmdOrCtrl+Alt+2`       | Focus pane 2 |
| `focus-pane-3`        | `CmdOrCtrl+Alt+3`       | Focus pane 3 |
| `focus-pane-4`        | `CmdOrCtrl+Alt+4`       | Focus pane 4 |
| `focus-pane-5`        | `CmdOrCtrl+Alt+5`       | Focus pane 5 |
| `focus-pane-6`        | `CmdOrCtrl+Alt+6`       | Focus pane 6 |
| `focus-pane-7`        | `CmdOrCtrl+Alt+7`       | Focus pane 7 |
| `focus-pane-8`        | `CmdOrCtrl+Alt+8`       | Focus pane 8 |
| `focus-pane-9`        | `CmdOrCtrl+Alt+9`       | Focus pane 9 |
| `cycle-focus-forward` | `CmdOrCtrl+]`           | Cycle focus forward |
| `cycle-focus-back`    | `CmdOrCtrl+[`           | Cycle focus back |
| `maximize-pane`       | `CmdOrCtrl+Shift+M`     | Toggle maximize the focused pane |

### Chrome

| Action                | Default accelerator     | Description |
| --------------------- | ----------------------- | ----------- |
| `toggle-sidebar`      | `CmdOrCtrl+B`           | Collapse/expand sidebar |
| `toggle-quick-fire`   | `CmdOrCtrl+Shift+K`     | Toggle quick-fire input |
| `focus-quick-fire`    | `CmdOrCtrl+K`           | Focus quick-fire input |
| `global-search`       | `CmdOrCtrl+Shift+F`     | Global scrollback search |
| `open-grid-builder`   | `CmdOrCtrl+Shift+G`     | Open the grid builder |
| `cheat-sheet`         | `CmdOrCtrl+/`           | Show keymap cheat-sheet |

### Worktrees

| Action                   | Default accelerator     | Description |
| ------------------------ | ----------------------- | ----------- |
| `new-worktree`           | `CmdOrCtrl+Shift+N`     | Create a new worktree |
| `switch-worktree`        | `CmdOrCtrl+P`           | Switch worktree |
| `apply-last-used-preset` | `CmdOrCtrl+Shift+L`     | Apply last-used preset |

### Global (OS-level)

| Action                       | Default accelerator | Description |
| ---------------------------- | ------------------- | ----------- |
| `focus-raum`                 | `CmdOrCtrl+Alt+R`   | Focus raum window |
| `spawn-shell-global`         | `CmdOrCtrl+Alt+T`   | Spawn a shell in the active worktree (global) |

---

## Path patterns

The worktree path pattern resolves with the precedence chain
`.raum.toml → project.toml → config.toml → built-in default`. The built-in
default is `"{parent-dir}/{base-folder}-worktrees/{branch-slug}"`.

Substitutions:

| Token             | Expands to                                          |
| ----------------- | --------------------------------------------------- |
| `{parent-dir}`    | parent directory of the project root                |
| `{base-folder}`   | basename of the project root                        |
| `{branch-slug}`   | slugified branch name (`/` → `-`, non-alnum dropped)|
| `{branch-name}`   | raw branch name (no slugging)                       |
| `{project-slug}`  | project slug from `project.toml`                    |

Validation rejects any pattern without a branch token.

## Hydration manifests

The `hydration` table accepts two lists. `copy` duplicates files or
directories into the new worktree; `symlink` links them instead. If the
same path appears in both, `symlink` wins. Paths are relative to the
project root and must not escape it.
