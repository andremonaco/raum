# raum

Lightning-fast, recoverable terminals for AI agent harnesses. Tauri + Rust + Solid.js.

`raum` orchestrates terminals and agent CLIs (Claude Code, Codex, OpenCode) on macOS and Linux. Every pty lives inside a tmux session, so agents survive app restarts and crashes.

> Status: pre-v0.1 bootstrap. See `openspec/changes/raum-bootstrap/` for the design.

## Prerequisites

- `tmux` ≥ 3.2
- `git` ≥ 2.30
- `bun` (latest)
- Rust stable (`rustup` recommended)
- One or more agent CLIs (optional, detected at runtime): `claude`, `codex`, `opencode`

## Repo layout

```
crates/
  raum-core/        # config, project model, agent adapter trait, state types
  raum-tmux/        # tmux multiplexer wrapper, output stream coalescer
  raum-hydration/   # speck-style copy/symlink hydration, path-pattern model
  raum-hooks/       # hook-script writer, event socket
src-tauri/          # the `raum` binary (Tauri host)
frontend/           # Vite + Solid.js + TypeScript (bun)
docs/               # quickstart, config, harness-integration, privacy, release
```

## Build

```sh
# install JS deps (latest stable, locked via bun.lock)
cd frontend && bun install --frozen-lockfile && cd ..

# Rust workspace
cargo build --locked
```

## Run (dev)

```sh
cargo tauri dev
```

## Test

```sh
cargo test --workspace
cd frontend && bun run test
```

## Lint & hooks

Raum uses [`prek`](https://prek.j178.dev/) (Rust-native drop-in for
pre-commit) to orchestrate every static check. Configs live in
`prek.toml`, `.oxlintrc.json`, `.oxfmtrc.json`, `taplo.toml`,
`_typos.toml`, and `deny.toml`.

```sh
# one-time: install prek and the Rust toolbelt
brew install prek
cargo install --locked typos-cli taplo-cli cargo-deny cargo-machete

# register git hooks (pre-commit + pre-push)
task hooks:install

# run every check against every file
task hooks
```

The frontend stack is the full [oxc](https://oxc.rs) toolchain —
`oxlint` replaces ESLint (with `eslint-plugin-solid` loaded via oxlint's
JS-plugin bridge), and `oxfmt` replaces Prettier.

## License

MIT — see [LICENSE](LICENSE).
