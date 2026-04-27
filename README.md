<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="raum" width="140">
  </picture>

  <h1>raum</h1>

  <p><strong>The agentic coding workbench IDE.</strong></p>
  <p>Run Claude Code, Codex, and OpenCode side-by-side in a crash-safe grid of terminals. Surface permission prompts immediately and jump straight to the right pane.</p>

  <p>
    <a href="https://github.com/andremonaco/raum/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/andremonaco/raum?style=flat-square"></a>
    <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square"></a>
    <img alt="platforms" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey?style=flat-square">
  </p>
</div>

---

## Why raum

- **One workbench for every agent.** Spawn Claude Code, Codex, OpenCode, or a plain shell into resizable panes and work them in parallel.
- **Crash-safe by design.** Every pane runs inside a dedicated tmux socket (`-L raum`). Quit or crash the app, reopen it — your agents are still running, your scrollback is intact.
- **Stay in flow on permission prompts.** raum hooks into each harness's notification surface, pops a notification when a pane needs permission, and focuses the right terminal so you can answer in-context.
- **Git worktrees that hydrate themselves.** Create a worktree from the UI; raum copies or symlinks the dotfiles, caches, and env files you've marked — no manual `cp -r node_modules` ever again.
- **Global scrollback search.** `⌘F` opens a spotlight dock that searches scrollback across every open pane (10 000 lines deep), jumps to project files, and switches harness sessions.
- **Your config, your files.** Everything lives in plain TOML under `~/.config/raum/`. Commit a `.raum.toml` to a repo to share worktree and hydration defaults with your team.

## Install

### macOS — Homebrew

```sh
brew install --cask andremonaco/raum/raum
```

That's it. The tap is auto-added, `tmux` is pulled in as a dependency, and `brew upgrade` keeps you on the latest release.

### Linux

Grab the `.deb` (Debian/Ubuntu) or `.AppImage` (anything with FUSE) from the [releases page][releases].

```sh
sudo apt install tmux git
sudo dpkg -i raum_*.deb
```

### Agent harnesses (optional, detected at launch)

Install any subset you want to drive from raum:

| Harness | Binary | Get it |
|---|---|---|
| Claude Code | `claude` | <https://github.com/anthropics/claude-code> |
| Codex | `codex` | OpenAI Codex CLI |
| OpenCode | `opencode` | <https://github.com/opencode-ai/opencode> |

[releases]: https://github.com/andremonaco/raum/releases/latest

## Quickstart

1. **Launch raum.** The onboarding wizard checks `tmux` and `git`, probes for installed harnesses, then asks you to pick a project directory.
2. **Spawn an agent.** Use `⌘⇧C` (Claude Code), `⌘⇧X` (Codex), `⌘⇧O` (OpenCode), or `⌘⇧T` (shell). The pane drops into the project root.
3. **Open more side-by-side.** Drag pane edges to resize; drop one pane header onto another to swap or split.
4. **Crash test.** `⌘Q` the app and reopen it — every agent is still running exactly where you left it.

Full walkthrough: [`docs/quickstart.md`](docs/quickstart.md).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘⇧T` | New shell pane |
| `⌘⇧C` | New Claude Code pane |
| `⌘⇧X` | New Codex pane |
| `⌘⇧O` | New OpenCode pane |
| `⌘T` | New tab in the focused pane (same harness) |
| `⌘⇧M` | Maximize / restore the focused pane |
| `⌘F` | Global search (scrollback + sessions + project files) |
| `⌘/` | Cheat-sheet of every shortcut |
| `⌘⇧N` | New worktree · `⌘P` Switch worktree |
| `⌘B` | Toggle sidebar |
| `⌘⌥R` | Focus raum window (global) · `⌘⌥T` Spawn shell in active worktree (global) |

Remappable in Settings → Keybindings, or directly in `~/.config/raum/keybindings.toml`.

## Documentation

- [Quickstart](docs/quickstart.md) — five-minute tour.
- [Configuration reference](docs/config.md) — every TOML key and default.
- [Harness integration](docs/harness-integration.md) — how raum writes hooks and the `<raum-managed>` block.
- [Harness matrix](docs/harnesses.md) — what raum observes and replies to, per harness.
- [Privacy](docs/privacy.md) — what raum reads, writes, and sends (spoiler: just a single update check, no telemetry).

## Build from source

```sh
# prerequisites: Rust stable (1.85+), bun, tmux 3.2+, git 2.30+, Task (https://taskfile.dev)
git clone https://github.com/andremonaco/raum.git
cd raum

task install        # bun install + fetch bundled fonts
task dev            # hot-reload dev build (cargo tauri dev with the dev config)
task build          # release bundle (.app / .deb / .AppImage)
```

Contributor tooling (formatters, linters, pre-commit hooks, split target dirs) all lives behind the `task` runner — see [`AGENTS.md`](AGENTS.md) for the full task list.

## Acknowledgements

raum is inspired by [daintree](https://github.com/daintreehq/daintree).

## License

MIT — see [LICENSE](LICENSE).
