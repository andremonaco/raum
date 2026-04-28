# Last-prompt display per pane

**Status:** proposal — not yet implemented
**Author:** discussion notes, 2026-04-27

## Problem

While an agent is running, the user can no longer see the prompt that
triggered the work — the input line is gone and the scrollback is full of
the agent's output. With several panes running in parallel, it becomes
hard to remember "what did I ask each one?".

Goal: at a glance, on each pane, the user can see the last prompt they
manually submitted to that harness.

## Constraint

Must be **always visible on each pane**. No global panels, dropdowns, or
hotkey-only views — those defeat the "at a glance across all running
agents" use case.

## Data source

`raum-hooks` already receives `UserPromptSubmit` from Claude Code (and
the equivalents from Codex / OpenCode). Capture the prompt there, store
`last_prompt: Option<String>` keyed by pane on the backend, push to the
frontend store. The display layer is the open question — that's what
this doc is about.

## Proposals

Ten ambient, per-pane variations. ASCII mocks below.

### 1. Two-line header (title + prompt as equal citizens)

Title bar is two rows. Top row = identity, bottom row = last prompt.

```
┌───────────────────────────────────────────────────┐
│ claude · feature/auth                  ● 2m  ⋯    │
│ ↳ refactor the session middleware to use jose     │
├───────────────────────────────────────────────────┤
│ ⏺ Reading src/auth/session.ts                     │
│ ⏺ Editing session.ts (+12 -8)                     │
```

Costs one extra row of chrome, always visible, zero interaction.

### 2. Inline in the title row, after a separator

Same line as the title; the title becomes the prompt context.

```
┌─ claude · auth │ ↳ refactor session middleware to use jose ── ● ─┐
│ ⏺ Reading src/auth/session.ts                                    │
│ ⏺ Editing session.ts                                             │
```

Zero extra rows. Truncates aggressively in narrow panes.

### 3. Footer strip (status-bar style, inside the pane)

Bottom row of the pane, styled like an editor status bar.

```
│ ⏺ Editing session.ts                              │
│ ⏺ Running tests…                                  │
├───────────────────────────────────────────────────┤
│ you ▸ refactor session middleware to use jose · 2m│
└───────────────────────────────────────────────────┘
```

Reads as "what triggered all this output above" — natural reading order.

### 4. Prompt rendered into the top border

Use the box-drawing border itself as the label slot.

```
┌─ claude · auth ─┤ ↳ refactor session middleware ├──── ● ──┐
│                                                           │
│ ⏺ Reading src/auth/session.ts                             │
│ ⏺ Editing session.ts                                      │
└───────────────────────────────────────────────────────────┘
```

Beautiful when it fits. Works only with a hard length cap (~40 chars).

### 5. Left gutter / rail

A 2–3 char wide stripe on the left edge with the prompt as vertical text.

```
┌─┬─ claude · feature/auth ─────────── ● 2m ────┐
│↳│                                             │
│r│ ⏺ Reading src/auth/session.ts               │
│e│ ⏺ Reading src/auth/jwt.ts                   │
│f│ ⏺ Editing session.ts                        │
│a│                                             │
│c│                                             │
│t│                                             │
│…│                                             │
└─┴─────────────────────────────────────────────┘
```

Distinctive but vertical text is a readability tax. Probably skip.

### 6. Right corner sticky note

Always-on absolutely-positioned card pinned to the top-right inside the
pane, above the terminal canvas.

```
┌─ claude · feature/auth ───────────────────────────┐
│                              ╭──────────────────╮ │
│ ⏺ Reading session.ts         │ ↳ refactor the   │ │
│ ⏺ Reading jwt.ts             │   session mid-   │ │
│ ⏺ Editing session.ts         │   dleware to use │ │
│                              │   jose · 2m ago  │ │
│                              ╰──────────────────╯ │
│ ⏺ Running tests…                                  │
└───────────────────────────────────────────────────┘
```

Up to 3 lines visible. Eats a corner of terminal output — fine for agent
narration, awkward for actual TUI apps.

### 7. Header expands on prompt change, settles to one line

Header is one line by default. On new prompt, animates open to 2–3 lines
for ~5s, then collapses to a single truncated line. Always shows
something; spotlights what's new.

```
on submit (3s window):                    after settle:
┌─ claude · feature/auth ─── ● ──┐        ┌─ claude · feature/auth ─── ● ──┐
│ ↳ refactor the session         │        │ ↳ refactor the session middl…  │
│   middleware to use jose       │        ├────────────────────────────────┤
│   and update tests             │        │ ⏺ Reading session.ts           │
├────────────────────────────────┤        │ ⏺ Editing session.ts           │
│ ⏺ Reading session.ts           │
```

Solves the long-prompt truncation problem without permanently spending
3 rows. Costs motion.

### 8. Pinned quote block at the top of the viewport

A styled block above the scrolling region. Terminal owns the rows but
the prompt stays glued in place.

```
┌─ claude · feature/auth ─────────── ● 2m ─────────┐
│ ╭─ you, 2m ago ──────────────────────────────╮   │
│ │ refactor the session middleware to use     │   │
│ │ jose and update the tests                  │   │
│ ╰────────────────────────────────────────────╯   │
│ ───────────────────────────────────────────────  │
│ ⏺ Reading src/auth/session.ts          ▲         │
│ ⏺ Reading src/auth/jwt.ts              │ scrolls │
│ ⏺ Editing session.ts                   ▼         │
└──────────────────────────────────────────────────┘
```

Most "chat-like" — matches how Claude Code itself renders prompts.
Shows 1–4 lines without truncation.

### 9. Ticker / marquee on a single status line

One row of chrome; long prompts scroll horizontally on hover (or always,
slowly).

```
┌─ claude · feature/auth ─── ● 2m ──────────────────┐
│ ↳ ssion middleware to use jose and update test… ◀│   ← scrolling
├───────────────────────────────────────────────────┤
│ ⏺ Editing session.ts                              │
```

Auto-motion in peripheral vision is annoying. Best as hover-only motion
with static truncation by default.

### 10. Two-line header that flips between you-said and agent-summary

Row 1: title. Row 2 shows `you ▸ <prompt>` while running; on completion
flips to `claude ▸ <one-line summary>`. Always one extra row, always
relevant.

```
while running:                              after completion:
┌─ claude · auth ──────── ● running ──┐    ┌─ claude · auth ──────── ✔ done ──┐
│ you ▸ refactor session middleware…  │    │ claude ▸ replaced jsonwebtoken    │
├─────────────────────────────────────┤    │          with jose in 4 files     │
│ ⏺ Reading session.ts                │    ├───────────────────────────────────┤
│ ⏺ Editing session.ts                │    │ ⏺ Editing session.ts              │
```

Solves a related problem: when the agent is idle you see the *result*,
not the stale question. Slight risk of the line feeling overloaded.

## Recommendation

Ship **#1 (two-line header)** as the default and add **#8 (pinned quote
block)** as an opt-in for users who want full prompts visible without
truncation.

- #1 is the safest, most legible, most consistent across pane sizes.
  One extra row of chrome is a fair price.
- #8 is genuinely better for long prompts and matches the chat-thread
  mental model agent users already have, but it costs 3–5 rows. Make it
  a per-user setting:
  ```toml
  [pane]
  prompt_display = "header"   # "header" | "quote_block" | "off"
  ```

Avoid:
- #4 (border text — fragile)
- #5 (vertical gutter — unreadable)
- #9 (marquee — irritating)

## Implementation sketch

1. **Hook capture** (`raum-hooks`) — extend the existing
   `UserPromptSubmit` handler to forward `{ pane_id, prompt, ts }` to
   the core state.
2. **Core state** (`raum-core`) — add `last_prompt: Option<PromptEntry>`
   per pane, where `PromptEntry { text, submitted_at }`.
3. **Tauri event** — emit `pane:prompt_updated` when the field changes.
4. **Frontend store** (`frontend/src/stores/terminal.ts`) — subscribe;
   keep `lastPrompt` reactive.
5. **TerminalPane chrome** — render the second header row when
   `lastPrompt` is set; truncate with CSS, full text in `title=`
   tooltip.
6. **Setting** — add `pane.prompt_display` to the config TOML and the
   settings UI.

Open questions:

- Do we persist `last_prompt` across app restarts? (Probably yes — store
  in the project TOML alongside the layout, so a recovered pane shows
  the same context.)
- Codex / OpenCode hook parity — do both emit a clean
  user-prompt-submitted signal we can rely on, or do we need a fallback
  that scrapes the input line from the PTY?
- How do we handle multi-line prompts (paste of a long brief)? Header
  truncates at the first newline; quote-block preserves them.
