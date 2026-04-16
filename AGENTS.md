# AGENTS.md

## What is raum?

**raum** is a lightning-fast, recoverable terminal orchestrator for AI agent harnesses (Claude Code, Codex, OpenCode). Every pseudo-terminal runs inside a tmux session (`-L raum` socket) so the app can crash-restart without killing agents. Built with Tauri v2 (Rust backend), Solid.js (frontend), and xterm.js (terminal renderer). Target platforms: macOS and Linux.

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri v2 |
| Backend language | Rust (edition 2024, MSRV 1.85, stable) |
| Frontend framework | Solid.js + TypeScript (ES2022) |
| Frontend build | Vite + bun |
| Styling | Tailwind CSS + Kobalte UI primitives + CVA |
| Terminal renderer | xterm.js (10 000-line scrollback) |
| Code editor | CodeMirror v6 |
| Grid layout | gridstack |
| Async runtime | Tokio (full features) |
| File watching | notify (macOS kqueue) |
| Package manager | bun (frontend), Cargo workspace resolver v2 |

## Repository Layout

```
crates/
  raum-core/       # shared types, config model, AgentAdapter trait, state machine
  raum-tmux/       # tmux session lifecycle, PTY output coalescer (12 ms tick / 16 KB flush)
  raum-hydration/  # worktree creation, copy/symlink manifests, path-pattern grammar
  raum-hooks/      # harness hook-script writer, Unix domain IPC socket server
src-tauri/
  src/
    lib.rs         # Tauri setup + command registration
    state.rs       # AppHandleState (ConfigStore, adapters, …)
    commands/      # Tauri IPC handlers: agent, config, files, hotkeys, layouts,
                   #   notifications, project, search, terminal, worktree
frontend/
  src/
    app.tsx        # root component, rehydrates runtime layout from TOML on launch
    stores/        # Solid.js reactive stores (agent, project, terminal, worktree, layout)
    components/    # UI tree: TopRow, Sidebar, TerminalGrid, TerminalPane, OnboardingWizard, …
    lib/           # keymapContext, notificationCenter, helpers
docs/              # quickstart, config reference, harness integration, release process
.github/workflows/ # ci.yml (lint + test), release.yml (release-plz + notarization)
```

## Taskfile — primary entry points

Install the `task` CLI, then:

```bash
task install        # bun install --frozen-lockfile (run once, or after lock changes)
task dev            # cargo tauri dev  (hot reload)
task build          # cargo tauri build  (release bundle .app / .deb / .AppImage)

task check:all      # typecheck + cargo check + clippy + oxlint + taplo + typos + machete
task fmt            # rustfmt + oxfmt + taplo (write in place)
task fmt:check      # same, CI read-only

task test           # vitest (frontend unit tests)
task test:rust      # cargo test (workspace)
task test:all       # both

task clippy         # cargo clippy -D warnings
task typecheck      # tsc --noEmit (frontend)
task lint           # oxlint (frontend)
task lint:toml      # taplo format --check

task typos          # typos spell-check
task deps:unused    # cargo-machete
task deps:audit     # cargo-deny check

task hooks:install  # wire prek pre-commit + pre-push git hooks
task hooks          # run all prek hooks against every file (dry-run equivalent)
```

## Code Quality & Formatting

- **Rust:** `rustfmt` (edition 2024, `max_width = 100`); clippy pedantic with `unsafe` denied globally
- **TypeScript/JSX:** oxlint + oxfmt (print width 100, 2-space indent) — replaces ESLint/Prettier
- **TOML:** taplo
- **Spelling:** typos-cli (ignores hex/SHA patterns; project-specific allow-list in `_typos.toml`)
- **Pre-commit:** prek (Rust-native; configured in `prek.toml`) runs fmt, clippy, machete, deny, taplo, typos, oxlint, oxfmt

Install hooks once with `task hooks:install` so the chain runs automatically on commit.

## Architecture: how the pieces connect

1. **Config & Projects** (`raum-core`) — `ConfigStore` debounces TOML writes (500 ms) and performs atomic file swaps. Projects have worktrees defined in the TOML; config is reloaded by the file-watcher.
2. **Terminals** (`raum-tmux`) — `TmuxManager` owns the tmux socket. Each PTY is a named tmux window. `StreamCoalescer` batches output (12 ms tick, 16 KB flush) before forwarding to the Tauri event bus.
3. **Hook injection** (`raum-hooks`) — `HookScriptWriter` injects `<raum-managed>…</raum-managed>` JSON blocks into harness config files (Claude Code `settings.json`, Codex config, etc.) so hooks survive edits outside raum.
4. **Worktree hydration** (`raum-hydration`) — copies or symlinks files into new git worktrees using a path-pattern DSL; branch slugs derived from a configurable prefix (none / username / custom).
5. **Tauri IPC** (`src-tauri/commands/`) — thin handlers that delegate to the four crates via `AppHandleState`. Frontend talks exclusively through `invoke()` calls.
6. **Frontend** (`frontend/`) — Solid.js stores mirror backend state. `TerminalGrid` uses gridstack for drag-and-resize pane layout. `TerminalPane` wraps xterm.js and streams PTY output via Tauri events.

## CI

`ci.yml` runs on every push to `main` and on PRs:
- **hooks job** (ubuntu): prek full suite (format, clippy, lint, typos, deps)
- **rust job** (matrix: macOS ARM64/x86_64, Linux x86_64/ARM64): `cargo build --locked` + `cargo test`
- **frontend job** (ubuntu): `tsc --noEmit` + vitest

`release.yml` uses release-plz to open a release PR and, on merge, creates a GitHub Release + builds signed/notarized macOS bundles and Linux deb/AppImage.

## Key constants

| Constant | Value | Location |
|---|---|---|
| Coalesce tick | 12 ms | `raum-tmux` |
| Flush threshold | 16 384 bytes | `raum-tmux` |
| Silence threshold | 500 ms | `raum-core` |
| Config write debounce | 500 ms | `raum-core` |
| xterm scrollback | 10 000 lines | frontend |
| Quickfire history | 100 entries | frontend |

## Dependencies & Licensing

`deny.toml` enforces allowed licenses (MIT, Apache-2.0, BSD-2/3, ISC, Unicode-3.0, etc.) and blocks unmaintained/yanked crates via cargo-deny. Run `task deps:audit` to check. `cargo-machete` (`task deps:unused`) flags unused Cargo dependencies.
