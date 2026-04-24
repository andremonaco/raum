# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2](https://github.com/andremonaco/raum/releases/tag/v0.1.2) - 2026-04-24

### Added

- *(sidebar)* native open-file via OS handler, in-app CodeMirror editor, click-to-switch branch badge with dirty-tree guard, dir-based GitHeadWatcher that survives macOS atomic HEAD rename ([#20](https://github.com/andremonaco/raum/pull/20))

### Fixed

- *(release)* re-enable automatic release pipeline — replace release-plz release-pr (which silently no-ops on publish=false workspaces because crates.io lookup 404s) with a repo-local `propose-release` workflow that opens the bump PR from conventional commits; marks internal crates as publish=false so the tag cargo-package path is consistent

## [0.1.1](https://github.com/andremonaco/raum/releases/tag/v0.1.1) - 2026-04-23

### Added

- *(notifications)* banner master switch + native macOS auth probe + focus-gated toasts
- *(homebrew)* strip quarantine in cask postflight ([#13](https://github.com/andremonaco/raum/pull/13))

### Fixed

- *(terminal)* smaller reattach threshold + restore Option-char composition + honour xterm hotkeys
- *(sidebar)* drop duplicated Agents list; surface ahead/behind + stash count
- *(dialogs)* widen destructive + settings modals and normalise padding
- *(macos)* force-hide NSWindow title after switching to overlay titlebar
- *(worktree)* replace stale `{root}` token with `{repo-root}` and validate custom patterns
- *(vite)* exclude overlayscrollbars-solid from dep optimizer ([#11](https://github.com/andremonaco/raum/pull/11))
- *(bundle)* emit DMG so Homebrew cask bump can hash + link it ([#5](https://github.com/andremonaco/raum/pull/5))
- *(release)* use gh release download for draft-asset sha256 ([#7](https://github.com/andremonaco/raum/pull/7))
- *(release)* drop empty APPLE_* env vars so macOS build falls back to ad-hoc sign ([#4](https://github.com/andremonaco/raum/pull/4))

### Other

- *(grid)* in-place cross-project projection + shared tab-label lookup
- *(onboarding)* 4 steps → intro + 3 steps with harness check merged into prereqs
- *(build)* strip third-party debug symbols + add `task target:sweep`
- *(dev)* separate product identity for dev builds
- *(release)* cross-compile macOS x86_64 on arm64 runner ([#6](https://github.com/andremonaco/raum/pull/6))
- *(hydration)* retry hook exec on ETXTBSY for parallel-test races ([#12](https://github.com/andremonaco/raum/pull/12))
- *(tmux)* pin server-lifetime options before new-session via tmux command chain ([#10](https://github.com/andremonaco/raum/pull/10))
- *(tmux)* pin exit-empty/exit-unattached off in capture-pane tests ([#8](https://github.com/andremonaco/raum/pull/8))

## [0.1.0](https://github.com/andremonaco/raum/releases/tag/v0.1.0) - 2026-04-22

### Added

- *(hooks)* blocking PermissionRequest handler + session-scoped events
- in-app updater UI, periodic update checks, and Homebrew distribution

### Fixed

- *(hooks)* preserve trailing newline when sending event-socket frames
- *(clippy)* align with rust 1.95 stable
- quell more rust 1.95 clippy lints
- quell clippy::map_unwrap_or (rust 1.95 lint)

### Other

- *(release)* ad-hoc macOS sign + pin tauri-action@v0.6.2 ([#2](https://github.com/andremonaco/raum/pull/2))
- *(icons)* grow squircle background to 900x900 (88% canvas fill)
- *(icons)* regenerate app assets from updated RaumLogo mark
- *(hooks)* capture sh -x traces from hook-script subprocesses
- snapshot socat fix, project-scoped grid, event-sound playback
- snapshot cross-project spotlight, notification probe, harness polish
- snapshot in-progress work across harness, tmux, and frontend
- *(harness)* split AgentAdapter into identity + setup + runtime traits
- initial commit
