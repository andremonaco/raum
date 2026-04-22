# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

- *(icons)* grow squircle background to 900x900 (88% canvas fill)
- *(icons)* regenerate app assets from updated RaumLogo mark
- *(hooks)* capture sh -x traces from hook-script subprocesses
- snapshot socat fix, project-scoped grid, event-sound playback
- snapshot cross-project spotlight, notification probe, harness polish
- snapshot in-progress work across harness, tmux, and frontend
- *(harness)* split AgentAdapter into identity + setup + runtime traits
- initial commit
