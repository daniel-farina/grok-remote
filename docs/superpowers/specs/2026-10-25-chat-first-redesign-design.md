# Chat-first conversation view

Date: 2026-10-25
Status: draft for approval
Branch: `mobile-chat-redesign` on the `jonathanhoskin/grok-remote` fork, intended as a PR back to `daniel-farina/grok-remote`.

## Why

The conversation view is unusable on a phone. Tested on an iPhone 17 Pro: the topbar, the nav row, the tab row, the action row, the status strip and the BG SHELLS strip stack above the thread. Under it, the tools column (`max-height: 40vh` on mobile) holds every tool card. The chat itself gets a sliver of the screen, or none at all. The user asked grok "Progress report?" and couldn't find the answer. Tool cards can't be hidden, minimised or dismissed.

On a phone, what matters is sending a message and reading the conversation, the way the Claude mobile app works. The commands grok ran are secondary. They should be one tap away, not in the way.

The desktop view has the same root problem in a milder form: a 30% tools column lists every call, and the chat is squeezed into the middle.

## Goals

1. **The thread is the main thing on screen**, on phone and desktop. It shows items in chronological order, oldest at the top and newest at the bottom.
2. **The thread follows new content.** It jumps to the bottom when either party posts, unless the user has scrolled up to read. In that case it stays put and shows a "jump to latest" button.
3. **grok's in-between updates appear in the thread where they happened**, as in the Claude app:
   - thoughts (`agent_thought_chunk`)
   - interim messages (`agent_message_chunk` text sent between tool calls)
   - the final answer
4. **Tool calls collapse to a one-line summary** in the thread at the point they happened, such as "Ran 2 commands" or "Read 2 files". A tap or click reveals the details.
5. **A one-line status bar** shows overall state at a glance and opens a fuller panel over the thread.
6. **On a phone, the composer is always reachable** and compact.

## Non-goals

- No backend or protocol changes. Everything needed is already in the SSE stream and `history.jsonl`.
- No changes to the Files, Info, Trace and Flow panes themselves. Only how you reach them changes.
- No changes to other pages (memory, leaders, sessions, health, settings) beyond how you navigate to them.
- The follow-up features in `BACKLOG.md` (push notifications, file previews, plan progress, typing while grok works, quieter reconnects) are out of scope. This design should leave room for them.

## Anti-goals (a failure even if it technically works)

- Tool output shown by default anywhere in the thread.
- The thread scrolling away from what the user is reading when new events arrive.
- Losing information: every tool call, its input and output, every thought and every message must still be reachable.
- Breaking existing conversations. History replay of old `history.jsonl` files must render in the new layout.
- Breaking the four themes (dark, light, hacker, unicorn) or the PWA standalone mode on iOS.

## What the user decided

These choices came from the user, mostly through the mockups in `.superpowers/brainstorm/` (not committed):

- **Thread order and scrolling**: chronological, newest at the bottom, auto-jumps to the bottom when either party posts.
- **Status bar**: reuse the existing status strip (`.chat-status`, the one that currently says "stream error · reconnecting") as a one-line summary. It includes a short status and a tool count, and a control expands it over the top of the other content.
- **In-between updates**: thoughts and interim messages should appear in the thread, like the Claude app.
- **Thread item design** (phone mockup "thread-v2", approved as "looks good"):
  - Your messages are right-aligned bubbles.
  - grok's messages are plain left-aligned text with no bubble. Interim updates and the final answer look the same.
  - Each thought is one grey italic line. Tap it to expand the full text.
  - Each run of consecutive tool calls is one summary line ("Ran 1 command, wrote 1 file ▸"). On a phone, tapping it expands the list inline: one row per call with ✓, a spinner or ✗, and the command or path. Tapping a row shows that call's input and output.
  - While a turn is running, a spinner line at the bottom of the thread says what grok is doing now.
  - When a turn ends, a small footer shows tokens and duration.
- **Desktop, option B**: the same thread as on the phone, in a centred reading column (about 560–720px wide). Clicking a tool-run line opens its calls with full input and output in a right-hand details panel. The panel is closed by default and closes with ×. The permanent tools column goes away.
- **Phone composer**: one row with attach (＋), an auto-growing text box, and a send button that becomes a stop button while a turn is running.

## Design

### Layout, phone (≤ 720px, the existing breakpoint)

From top to bottom:

1. **Header** (one row): ☰ on the left, the conversation title (truncated) in the middle, ⋯ on the right.
   - ☰ opens the existing slide-in drawer. It holds the conversation list plus links to the other pages (memory, leaders, sessions, health, settings), which today live in the horizontal nav row.
   - ⋯ opens a menu: Files, Info, Trace, Flow, star or unstar, connect or disconnect, copy conversation, the token count, theme, and debug `{ payload }` when debug is on. Choosing a pane switches to it full-screen, with a back control to return to the conversation.
2. **Status bar** (one row, details below).
3. **Thread**: fills all remaining height and is the only scrolling region.
4. **Composer** (one row, grows to about 5 lines), with safe-area bottom padding.

The topbar pills (`tailnet up`, `bg: N`, theme) and the horizontal nav row no longer take their own rows on a phone. Their information moves into the drawer, the status bar or the ⋯ menu.

### Layout, desktop (> 720px)

- **Topbar**: keep it, but it can be tidied up.
- **Left sidebar**: the conversation list. The nav pages (memory, leaders, sessions, health) move from the left icon rail into the topbar or a menu, so the sidebar is only conversations. *(This was my guess. The user saw it in the mockup and didn't object, but didn't explicitly confirm it either. The builder should keep the rail if removing it turns out to be disruptive.)*
- **Tab row**: Conversation / Files / Info / Trace / Flow stays as a tab row on desktop, where there's room. The action buttons (token count, star, settings, connect or disconnect, copy) stay on the right of that row.
- **Main column**: status bar, then the thread (centred reading column), then the composer, matched to the thread's width.
- **Details panel** (option B): appears on the right when a tool-run line is clicked. It has two tabs, **Tool run** and **Files**. The Files tab hosts the existing `mountFilesTab`, replacing the tools column's Files tab today, so you can still browse files beside the chat. A Files button in the action row opens the panel on that tab. *(My call, to avoid removing a feature.)* It shows that run's calls, each with its kind, title, status, duration, and full input and output, using the existing tool card rendering where practical. Clicking another run swaps the panel's content. × closes it. Width is about 320–420px, and resizing is optional.
- **Split.js**: the tools-column split (`_initChatSplit`) is retired.

### Status bar

This reuses `.chat-status`.

- **Collapsed** (always visible), one line with:
  - a coloured state dot
  - a short state: working, idle, disconnected, reconnecting, errored (no "waiting for approval": permissions are always auto-approved today)
  - what's happening now, when working: the title of the newest running tool, or "thinking"
  - counts: tools run this turn, and running background shells ("bg 1")
  - a chevron
- **Expanded** (tap the bar): a panel drops down over the thread with a dimmed backdrop. It does not push the thread down. It shows:
  - Background shells: what the BG SHELLS strip shows today, i.e. the running ones, "Open App" links and "view all (+N exited)".
  - This turn's tool calls, newest last, with status.
  
  Tap outside, tap the bar again, or press Esc to close it.
- **Connection noise**: transient states such as "connecting…" and "connected" should not flash on every reconnect. Show "reconnecting" only after a short delay. A fuller fix is backlog item 5.
- The separate BG SHELLS strip and in-flight strip (`bgTermsStripEl`, `inFlightStripEl`) go away. Their content lives in the status bar and its panel.
- `convoSkillsStripEl`: move it into the ⋯ menu or the Info pane unless it carries something time-critical. **Builder's call** after checking what it shows.

### Thread model

Today a turn renders as one user bubble, a single thinking pane, one assistant bubble with all message chunks concatenated, and tool cards in the separate tools column. The new model is an **ordered list of segments per turn**, appended as events arrive:

| Event | Segment |
|---|---|
| `user_message`, `user_message_chunk` | user bubble (starts a turn). `user_message_chunk` is what grok replays for past prompts when a session is loaded or imported; today it's ignored, so earlier turns merge into one. Consecutive chunks join one bubble. *(My call: in scope.)* |
| `agent_thought_chunk` | thought, which either joins the open tool run or becomes a top-level thought line (see below). Consecutive chunks append to the same thought |
| `agent_message_chunk` | message segment. Consecutive chunks append to the open message segment |
| `tool_call` | tool-run segment (see "Tool runs absorb thoughts" below) |
| `tool_call_update`, `tool_call_delta_chunk` | update the matching call inside whichever tool run holds it, found by `toolCallId` |
| `prompt_complete` | turn footer (tokens, duration) |
| `agent_status` | drives whether a turn is running: `running` shows the live line and status-bar activity, `idle`/`errored`/`killed` ends it. Don't rely on `prompt_complete` alone, because self-started turns never send it. |
| `error` | error banner segment |
| `session_summary_generated` | keep the existing "compacted" pill |

The rule: **a new segment starts whenever the segment type changes.** A message, then a tool, then a message produces three segments, not one merged bubble. This fixes the "status.Nothing is running" run-together seen today.

**Tool runs absorb thoughts (user decision).** grok thinks between almost every tool call: one real turn has about 130 thoughts alternating with about 130 tool calls, averaging about 340 characters each. Giving every thought its own line would make a long alternating column, so:

- A tool run stays open through thoughts. It closes only on a grok message, a user message, an error, or the end of the turn.
- When a tool call arrives and the segment just before it is a thought, that thought moves into the new run as its first item. A thought renders top-level while streaming, then moves into the run if a tool call follows.
- Thoughts not next to any tool call (for example a thought followed directly by a message) stay as top-level grey thought lines.
- Collapsed, a run reads: "Ran 9 commands, read 3 files · 8 thoughts ▸". The counts cover calls by kind, plus the number of thoughts.
- While the run is active, the line shows a spinner, the counts so far, and **the latest thought as a live caption** under it (first line or about 120 characters). Once the run closes, the caption goes away.
- Expanded (inline on a phone, in the details panel on desktop), a run lists its thoughts and tool calls interleaved in the order they happened. Thoughts show as grey italic text, collapsed to their first line and expandable. Tool calls are rows with status that open to show their input and output.

Other segment rules:

- **Self-started turns.** After a turn ends, grok often wakes itself when a background task finishes, then streams thoughts and messages with no `user_message` and no `prompt_complete`. Render these as their own turn with no user bubble: a small muted marker like "grok · background update" where the bubble would be. These turns get no token footer unless a `prompt_complete` arrives. *(My call.)*

- **Tool-run summary text** is built from the kinds of the calls in the run: "Ran 2 commands, read 1 file, edited 3 files". Use ACP kinds (`execute`, `read`, `edit`, `delete`, `move`, `search`, `fetch`, `think`, `other`), with sensible wording for each and "used N tools" as the fallback. While any call in the run is running, show a spinner on the line. If any call failed, show "· 1 failed" in the error colour.
- **TodoWrite / plan calls**: keep the existing merged live checklist card (`_maybeRouteTodoToolCall`), rendered as its own segment in the thread rather than in the tools column. It may start collapsed to one line ("plan · 3/7"). **Builder's call** on the collapsed form. Backlog item 3 later surfaces it in the status bar.
- **Top-level thoughts** (those not absorbed into a run): show the first line (or about 100 characters) in grey italics with ▸. Tap to expand the full text. The existing thinking pane's "active/blinking" state while streaming can be kept as a subtle indicator.
- **Live line**: while a turn is running and no tool run is active, the last row of the thread is a spinner plus "Thinking…" or the current activity. When a tool run is active, its live caption serves this purpose instead, so don't show both. Remove it when the turn ends.
- **Turn footer**: tokens and duration in small muted text.
- **Desktop details panel**: on desktop, tapping a tool-run line opens the details panel instead of expanding inline. On phone, it expands inline.
- **History replay** must build the same segments from `history.jsonl`. Older history files have the same event types. The rendering path for live events and replay should be shared so they can't drift apart.
- **Copy conversation** keeps working. Serialising from the segment list is the natural way, and the existing format is acceptable.

### Scrolling

Keep the existing mechanism (`scrollToBottom`, `_initAutoScroll`, the 60px threshold, the "jump to latest" button). Make sure:

- It applies to the one thread scroller. The separate tools-column scroller goes away.
- Expanding a thought or tool run near the bottom while following does not yank the view.
- On iOS, opening the keyboard keeps the last message visible above the composer. Use `100dvh`, which is already in use, and test it.

### Composer

- **Phone**: one row with ＋ (attach image), an auto-growing textarea (1 to about 5 lines; 16px font so iOS doesn't zoom), and a round send button. While a turn is in flight the button becomes stop, calling the existing cancel. The separate "cancel turn" button goes away. `{ payload }` (debug) moves to the ⋯ menu.
- **Enter key on a phone** inserts a newline, and the send button sends. That matches the Claude app and suits the iOS keyboard. **On desktop**, Enter sends and Shift+Enter inserts a newline, as today. *(My call.)*
- Slash palette, drag-and-drop or paste of images, and attachment chips keep working.
- **Desktop**: the same component, matched to the reading-column width.

### Visual style

Stay within the existing look: monospace UI chrome, the existing palette tokens and the four themes. Message text in the thread may use a more readable font (the mockups used the system sans-serif for messages and monospace for tool rows and the status bar). **Builder's call**, as long as all four themes look right.

## Constraints

- Vanilla TypeScript + Vite, no framework for this view (React is used only by `flow.tsx`). Don't add runtime dependencies.
- `src/views/chat.ts` is about 3,200 lines and `src/style.css` about 9,400. Prefer pulling the new thread-segment logic into a new, unit-testable module, e.g. `src/lib/thread-model.ts` for grouping events into segments and building summary text. Keep DOM rendering in `render.ts` or a new `src/lib/thread-render.ts`.
- Tests use `node --import tsx --test test/*.test.ts`. Add unit tests for the segment grouping and the summary text. Run `npm run typecheck` and `npm test`.
- Upstream is changing quickly (v0.2.0 to v0.2.23 in a day). Keep the change focused on the conversation view so the PR can be rebased. Rebase on `upstream/main` before opening the PR.
- The running instance on this machine (pm2 `grok-remote`, served at https://jono-pc.ewe-bleak.ts.net) builds from this checkout. Check the work with `npm run build` and `pm2 restart grok-remote`, and on an actual iPhone via the tailnet URL.

## Left to the builder

- Exact spacing, sizes, icons and animation.
- Where the desktop nav pages go if they leave the left rail (topbar icons or a menu).
- How the full-screen panes (Files, Info, Trace, Flow) present on a phone and how you get back.
- The collapsed form of the plan card, and where `convoSkillsStripEl` goes.
- Whether the details panel can be resized.
- Wording of state labels and tool-run summaries.
