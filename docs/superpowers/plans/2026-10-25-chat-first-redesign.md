# Chat-first Conversation View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the conversation view so the thread comes first on phone and desktop. Messages, thoughts and collapsed tool runs appear in the order they happened. A one-line status bar sits above the thread, the composer is compact, and on desktop a details panel replaces the tools column.

**Architecture:** A new pure module, `src/lib/thread-model.ts`, turns the SSE/history events into an ordered list of turns and segments. It has no DOM dependencies and is unit-tested with `node:test`. A new DOM module, `src/lib/thread-render.ts`, renders segments and reacts to the model's change records. `src/views/chat.ts` routes events through the model and renderer instead of its current per-type handlers. It also loses the tools column, the BG SHELLS strip and the in-flight strip, and gains the status-bar panel, the desktop details panel, the new composer and the phone header.

**Tech Stack:** Vanilla TypeScript, Vite 5, `node:test` + `tsx`, plain CSS in `src/style.css`. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-chat-first-redesign-design.md`. Read it before starting any task.

## Global Constraints

- Frontend only. No changes to `server.ts`, `lib/` (backend) or the SSE/history wire format.
- Don't add runtime dependencies. React stays confined to `flow.tsx`.
- Phone layout applies at `max-width: 720px`, the existing breakpoint (`CHAT_SPLIT_MOBILE_MAX = 720` in `chat.ts`). Desktop is anything wider.
- All four themes (dark, light, hacker, unicorn) must look right. Use existing CSS custom properties from `src/style.css`, never hard-coded colours.
- Phone textarea font size is at least 16px, so iOS doesn't zoom.
- Every tool call's input and output, every thought and every message must stay reachable (spec anti-goal: no information loss).
- History replay and live events go through the same model code path.
- Keep the change scoped to the conversation view so it rebases cleanly onto a fast-moving `upstream/main`.
- Each task ends green: `npm run typecheck` and `npm test` pass.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01RdJvxUioQcAreaXKt9pkBz
  ```

## Dev loop (used by every UI task)

- Backend: the pm2 instance `grok-remote` on `127.0.0.1:7910`. Don't restart it during development. It serves the user's live dashboard from `dist/`.
- Frontend: `npm run dev` in the repo starts Vite on `127.0.0.1:7911` and proxies `/api` to 7910. Start it in the background once and reuse it.
- Screenshots: `SCRATCH=/tmp/claude-1000/-home-jono-claude/ecba42ec-ab2e-4d66-a586-83a0f44f644f/scratchpad node /tmp/claude-1000/-home-jono-claude/ecba42ec-ab2e-4d66-a586-83a0f44f644f/scratchpad/shot.mjs <url> <out.png> <w> <h> <waitMs> [mobile]`
  - Phone: `390 844 7000 mobile`
  - Desktop: `1440 900 7000`
- Real test conversation: agent `78c92d2f-b1dc-47b1-9a07-8d562f915671` (about 1,400 events). URL: `http://127.0.0.1:7911/#/agents/78c92d2f-b1dc-47b1-9a07-8d562f915671`.
- **Never send a prompt to that agent.** It is the user's live work. View and replay only.
- For live-turn testing, create a throwaway agent through the dashboard on 7911, prompt it, and delete it afterwards. To remove one completely, stop pm2, `rm -rf ~/.grok-remote/agents/<id>`, then start pm2 again; the existing delete bug recreates the directory otherwise. Do this only at the end of a task, never while the user may be mid-turn.

## Review Focus

1. **Huge real histories.** The test conversation has turns with more than 270 segments and thoughts up to 7.8k characters. Expected: replay renders in under about 1s on desktop, thoughts collapse to one line, and nothing freezes. Owner: Task 3 (render-performance check step).
2. **Resumed/imported sessions** replay past prompts as `user_message_chunk`, with no `user_message` and no `prompt_complete`. Expected: one turn per past prompt, each with a user bubble. Owner: Task 1 (`replayed user_message_chunk starts turns`).
3. **Self-started turns.** After `prompt_complete`, grok streams thoughts and messages with no new user message. Expected: a separate turn with a "background update" marker, and nothing appended to the finished turn's footer. Owner: Task 1 (`events after prompt_complete start a background turn`).
4. **Tool update before its `tool_call`**, or a `tool_call_delta_chunk` for an unknown id. Expected: the call is created in the current run and never throws. Owner: Task 1 (`update for unknown toolCallId creates the call`).
5. **Scrolled up while grok streams.** Expected: the view doesn't move, and "jump to latest" appears. Expanding a run near the bottom while following doesn't yank the view. Owner: Task 3 (manual check step).

---

### Task 1: Thread model (pure segment grouping)

**Files:**
- Create: `src/lib/thread-model.ts`
- Modify: `src/lib/render.ts`. Export the existing `readStatus` as `export function readToolStatus(payload)`. Keep the internal name as an alias so nothing else changes.
- Test: `test/thread-model.test.ts`

**Interfaces:**
- Consumes: `unwrap`, `extractText` from `src/lib/acp-payload.ts`; `isTodoWriteToolCall`, `readToolStatus` from `src/lib/render.ts`.
- Produces:
  ```ts
  export type ToolStatus = 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Canceled';
  export interface RunTool    { type: 'tool'; toolCallId: string; kind: string; title: string; status: ToolStatus }
  export interface RunThought { type: 'thought'; id: string; text: string }
  export type RunItem = RunTool | RunThought;
  export type Segment =
    | { id: string; type: 'user'; text: string; attachments: unknown[]; ts: number }
    | { id: string; type: 'marker'; text: string }                  // "background update"
    | { id: string; type: 'message'; text: string; ts: number }
    | { id: string; type: 'thought'; text: string }
    | { id: string; type: 'run'; items: RunItem[]; open: boolean }
    | { id: string; type: 'plan'; toolCallId: string }
    | { id: string; type: 'error'; text: string }
    | { id: string; type: 'compacted'; text: string }
    | { id: string; type: 'footer'; meta: Record<string, unknown> };
  export interface Turn { id: string; segments: Segment[]; running: boolean; background: boolean }
  export interface ModelChange {
    turnId: string | null;
    added: string[];      // segment ids appended, in order
    updated: string[];    // segment ids whose content changed
    removed: string[];    // segment ids removed (a thought absorbed into a run)
    newTurn: boolean;
  }
  export class ThreadModel {
    turns: Turn[];
    apply(name: string, payload: unknown, opts?: { ts?: number }): ModelChange;
    segment(id: string): Segment | undefined;
    runOf(toolCallId: string): Extract<Segment, { type: 'run' }> | undefined;
    activeTurn(): Turn | null;
    isRunning(): boolean;            // agent_status-driven
    reset(): void;
  }
  ```
- Rules (from the spec, "Thread model" and "Tool runs absorb thoughts"):
  - A new segment starts whenever the segment type changes.
  - `user_message` starts a turn. So does `user_message_chunk`, but consecutive `user_message_chunk` events join one bubble. A `user_message` whose text equals the open turn's user text, where that turn has no other segments yet, is ignored. This keeps the live-send dedup in `chat.ts`.
  - A `tool_call` absorbs an immediately preceding top-level thought (`removed: [thoughtId]`, the thought becomes `items[0]`). An open run absorbs subsequent thoughts. A run closes (`open: false`) on a message, user message, error, plan, footer or turn end.
  - A TodoWrite call creates one `plan` segment the first time. Later TodoWrite calls (`rawInput.merge`) produce `updated` for that same plan segment and never a new segment. Plan segments close the open run.
  - `agent_status` `running` sets `running = true`. `idle`, `errored` and `killed` set it to `false` and close any open run.
  - After a turn has a `footer`, or `running` has gone false, any thought, message or tool event that arrives with no new user event starts a new turn with `background: true`, whose first segment is `{ type: 'marker', text: 'background update' }`.
  - `prompt_complete` appends a `footer` with `payload._meta ?? payload`.
  - `error` appends an `error` segment. `session_summary_generated` appends a `compacted` segment.
  - `tool_call_update` and `tool_call_delta_chunk` update the matching `RunTool` by `toolCallId`. If none exists, create it in the open run, or a new run.
  - Segment ids are stable strings (`s1`, `s2`, …), unique within the model.

- [ ] **Step 1: Write the failing tests** in `test/thread-model.test.ts`. Build events with small helpers, e.g. `thought(text) => ['agent_thought_chunk', { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } }]`. Tests:
  - `message, tool, message produce three segments`: types `['user','message','run','message']`.
  - `consecutive message chunks join one segment`: two chunks `'Hello '`, `'world'` give a single message with `text === 'Hello world'`.
  - `tool_call absorbs the preceding thought`: user, thought, tool → segment types `['user','run']`; the run has `items[0].type === 'thought'`; the change for the tool event has `removed` containing the thought id.
  - `open run absorbs thoughts between tools`: thought, tool, thought, tool, thought, tool, message → types `['user','run','message']`; the run has 6 items, alternating `thought`/`tool`.
  - `thought followed by message stays top-level`: types `['user','thought','message']`.
  - `tool_call_update changes status`: tool `t1` Pending, then update `{ toolCallId:'t1', status:'completed' }` → `RunTool.status === 'Completed'`, change `updated` contains the run id.
  - `update for unknown toolCallId creates the call`: update with no prior tool_call → a run with one tool, no throw.
  - `delta for unknown id does not throw`.
  - `replayed user_message_chunk starts turns`: chunk A, message, chunk B, message → 2 turns, user texts `'A'`, `'B'`.
  - `user_message echo is deduped`: `user_message` `'hi'` twice in a row → 1 turn.
  - `events after prompt_complete start a background turn`: user, message, prompt_complete, thought, message → 2 turns; turn 2 has `background === true`, first segment `marker`, and turn 1's last segment is `footer`.
  - `agent_status idle closes the open run`: after tool + `agent_status {status:'idle'}`, run `open === false`, `isRunning() === false`.
  - `TodoWrite calls share one plan segment`: two TodoWrite tool_calls → exactly one `plan` segment; the second call's change has `updated` containing it.
  - `error and compacted segments`: an `error` event adds `error`; `session_summary_generated` adds `compacted`.
- [ ] **Step 2: Run tests and confirm they fail.** Run `node --import tsx --test test/thread-model.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `ThreadModel`** in `src/lib/thread-model.ts` per the interfaces and rules above. Export `readToolStatus` from `render.ts`. Map its capitalised output onto `ToolStatus`, defaulting to `'Pending'`. Title comes from the same logic as `inferToolTitle` in `render.ts`: export that as `inferToolTitle` and reuse it.
- [ ] **Step 4: Run the tests** (`npm test`) and `npm run typecheck`. Expected: all pass.
- [ ] **Step 5: Real-data smoke check.** Write a throwaway script in the scratchpad (not the repo). It feeds `~/.grok-remote/agents/78c92d2f-b1dc-47b1-9a07-8d562f915671/history.jsonl` through `ThreadModel` using `ev.event` and `ev.data`, the same as `refreshHistory` does. Print the turn count and the segment-type sequence of the last 3 turns. Expected: more than 15 turns, every non-background turn starts with `user`, and no two adjacent `run` segments.
- [ ] **Step 6: Commit.** `feat(thread): pure thread model grouping events into ordered segments`

### Task 2: Run summary and captions

**Files:**
- Modify: `src/lib/thread-model.ts`
- Test: `test/thread-model.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function summarizeRun(items: RunItem[]): string;      // collapsed line text
  export function runCaption(items: RunItem[]): string | null; // latest thought, first line, ≤120 chars + '…'
  export function thoughtPreview(text: string): string;        // first line, ≤100 chars + '…'
  export function runIsActive(items: RunItem[]): boolean;      // any tool Pending|Running
  export function runFailedCount(items: RunItem[]): number;
  ```
- Wording, grouped by kind in order of first appearance, joined with `, `, first letter capitalised:
  - `execute`: `ran N command(s)`
  - `read`: `read N file(s)`
  - `edit`: `edited N file(s)`
  - `delete`: `deleted N file(s)`
  - `move`: `moved N file(s)`
  - `search`: `ran N search(es)`
  - `fetch`: `fetched N URL(s)`
  - anything else (including `think`, `other`, missing): `used N tool(s)`
  
  Then append ` · N thought(s)` if there are any thoughts and ` · N failed` if anything failed. A run with only thoughts reads `N thought(s)`, capitalised.

- [ ] **Step 1: Write the failing tests:**
  - `summarizeRun([exec,exec,read])` → `'Ran 2 commands, read 1 file'`
  - `summarizeRun([read,exec,thought,thought])` → `'Read 1 file, ran 1 command · 2 thoughts'`
  - `summarizeRun([exec(Failed),exec])` → `'Ran 2 commands · 1 failed'`
  - `summarizeRun([other,think])` → `'Used 2 tools'`
  - `summarizeRun([thought])` → `'1 thought'`
  - `runCaption` returns the last thought's first line: for thoughts `'a'`, `'b\nmore'` → `'b'`; a 200-char line → 120 chars plus `'…'`; no thoughts → `null`.
  - `thoughtPreview('x'.repeat(150))` has length 101 and ends with `'…'`.
  - `runIsActive` is true with a Running tool and false when all are Completed or Failed.
- [ ] **Step 2: Run and confirm failure.** `node --import tsx --test test/thread-model.test.ts`
- [ ] **Step 3: Implement** the five functions.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: pass.
- [ ] **Step 5: Commit.** `feat(thread): run summary, caption and thought preview helpers`

### Task 3: Thread renderer wired into the chat view (tools column removed)

**Files:**
- Create: `src/lib/thread-render.ts`
- Modify: `src/views/chat.ts`
  - `handleEvent` (≈2268)
  - `onUserMessage`, `onMessageChunk`, `onThoughtChunk`, `onToolCall`, `onToolCallUpdate`, `onToolCallDelta`, `onPromptComplete`, `onAgentStatus`, `onError`, `onSessionSummary` (≈2288–2590)
  - `refreshHistory` (≈1236)
  - `startTurn`/`endTurn`/`ensureTurn` (≈1341–1385)
  - the constructor pane assembly (≈249–269)
  - `_ensureToolsGroup`, `_buildToolsColHeader`, `_initChatSplit`, `_scrollToolsToBottom`
  - the `send()` path that calls `startTurn`
- Modify: `src/lib/sse.ts`. Add `'user_message'` and `'user_message_chunk'` to `KNOWN_EVENTS` if the live stream needs them. Check whether `onAny` already receives them before changing.
- Modify: `src/style.css`. Add new thread classes. Delete the tools-column and split rules only when nothing references them any more.

**Interfaces:**
- Consumes: `ThreadModel`, `ModelChange`, `Segment`, `summarizeRun`, `runCaption`, `thoughtPreview`, `runIsActive`, `runFailedCount` (Tasks 1–2); `renderUserBubble`, `renderMarkdownLight`, `renderToolCard`, `renderTodoWriteCard`, `renderTokenFooter`, `renderErrorBanner`, `renderCompactedPill`, `el` from `render.ts`.
- Produces:
  ```ts
  export interface ThreadRendererOpts {
    container: HTMLElement;                 // the scrolling thread element (existing streamEl)
    model: ThreadModel;
    agentId: () => string | null;
    animate: () => boolean;                 // false during history replay
    onRunActivate?: (runId: string) => boolean; // return true if handled (desktop panel); else expand inline
  }
  export class ThreadRenderer {
    constructor(opts: ThreadRendererOpts);
    apply(change: ModelChange, name: string, payload: unknown): void; // also forwards raw tool payloads to ToolCards
    toolCard(toolCallId: string): ToolCard | undefined;               // for the details panel (Task 6)
    runItemsView(runId: string): HTMLElement;                         // interleaved thoughts + tool cards for a run, reused by Task 6
    clear(): void;
    liveLine(text: string | null): void;                              // spinner row at the bottom; null removes it
  }
  ```
- Rendering, per spec "Thread item design":
  - User segments are right-aligned bubbles (reuse `renderUserBubble`).
  - Message segments are plain left-aligned text rendered with `renderMarkdownLight`. There's no bubble chrome; keep a muted timestamp.
  - Top-level thoughts are one grey italic line using `thoughtPreview` with ▸, and tap toggles the full text.
  - Marker segments are a small muted line, "grok · background update".
  - Run segments are one line: `summarizeRun` + ▸/▾. While `runIsActive` or the run is open in a running turn, show a spinner and `runCaption` under the line. `runFailedCount > 0` adds the error colour to the "· N failed" part.
  - Tapping a run calls `onRunActivate(runId)`. If that returns false or is absent, expand inline: `runItemsView(runId)`, with thoughts as collapsible grey text and tool calls as the existing `renderToolCard` cards, collapsed.
  - Plan segments reuse the existing TodoWrite card, created with `renderTodoWriteCard` and updated on later TodoWrite events. Move `_maybeRouteTodoToolCall`'s merge logic into the model and renderer, or have it delegate there.
  - `footer`, `error` and `compacted` use the existing renderers.
  - Keep one `ToolCard` instance per `toolCallId`, created lazily the first time the run is expanded. On every `tool_call`/`tool_call_update`/`tool_call_delta_chunk`, if the card exists, forward the raw payload (`applyUpdate`/`appendDelta`). Otherwise keep the latest merged payload so the card can be built later with full content. Not building hundreds of cards up front is what keeps big histories fast.
  - The live line: `chat.ts` calls `liveLine('Thinking…')` while `model.isRunning()` and the last segment isn't an open run, and `liveLine(null)` otherwise.
- `chat.ts` changes:
  - `handleEvent` calls `const ch = this.model.apply(name, payload, { ts })`, then `this.thread.apply(ch, name, payload)`, then `scrollToBottom()`. Keep the side effects that aren't about rendering:
    - tokens pill
    - `currentAgent` session and model capture
    - the files-changed `CustomEvent`
    - available commands
    - handshake
    - toasts
  - Remove the tools column (`toolsStreamEl`, the split, the tools/files header) from the pane. The Files-beside-chat view moves into the desktop panel in Task 6, so until then Files stays reachable through its tab.
  - `this.turns` is still used by copy. Leave it until Task 4 replaces copy, keeping a minimal shim if `serializeConversation` still needs it, and delete it in Task 4.
- **Scrolling** (spec "Scrolling"): keep `scrollToBottom`, `_initAutoScroll` and the jump button, applied to the thread only. When expanding a run or thought, if `_autoScroll` is true and the expanded element is within 60px of the bottom, call `scrollToBottom({ force: true })` after layout. Otherwise don't scroll.

- [ ] **Step 1: Implement `ThreadRenderer`** in `src/lib/thread-render.ts`.
- [ ] **Step 2: Wire it into `chat.ts`** as above, removing the tools column, split and per-type DOM handlers.
- [ ] **Step 3: Add CSS** for `.thread-user`, `.thread-msg`, `.thread-thought`, `.thread-run`, `.thread-run__caption`, `.thread-run__items`, `.thread-marker`, `.thread-live`, using theme variables. Use a readable sans-serif for message text and monospace for runs, matching the mockups. Keep `content-visibility:auto` on turn roots.
- [ ] **Step 4: Typecheck and tests.** `npm run typecheck && npm test`. Expected: pass.
- [ ] **Step 5: Desktop and phone screenshots** of the real conversation on 7911 (see Dev loop). Expected:
  - the thread shows user bubbles, plain messages, and one-line runs like "Ran N commands … · N thoughts"
  - no tools column
  - the last turn is visible at the bottom
  
  Look at both images.
- [ ] **Step 6: Render-performance check.** In the dev page, time `refreshHistory({ all: true })` for the real conversation, either with a temporary `console.time` or a `Runtime.evaluate` in `shot.mjs`. Expected: under 1000ms. Remove any temporary timing code.
- [ ] **Step 7: Live check** with a throwaway agent. Send "List the files here, then read one of them, then say done." Expected:
  - a run appears with a spinner and caption while working
  - it collapses to a summary when done
  - the final message follows the run
  - the view sticks to the bottom
  
  Then scroll up mid-turn on a second prompt. Expected: the view doesn't move, and "jump to latest" shows. Delete the throwaway agent.
- [ ] **Step 8: Commit.** `feat(chat): render conversation as ordered thread segments; drop tools column`

### Task 4: Copy conversation from the model

**Files:**
- Modify: `src/lib/copy.ts` (`serializeConversation`, ≈130)
- Modify: `src/views/chat.ts` (`copyConversation`, ≈545). Remove the leftover `this.turns` bookkeeping.
- Test: `test/copy.test.ts`

**Interfaces:**
- Produces: `export function serializeThread(turns: Turn[], toolText: (toolCallId: string) => string, ctx?: ConvoCtx | null): string` in `copy.ts`.
  - It keeps the existing header (agent/resume lines) and the existing section style.
  - It outputs segments in order: user prompts, messages, thoughts (full text), and runs (each tool's title, status and output via `toolText`, with thoughts in order).
  - `serializeConversation` stays exported until nothing uses it, then delete it along with its tests.
- `toolText` in `chat.ts` returns the output text the existing serializer pulls from a card node. Build the card on demand if it doesn't exist yet (Task 3's lazy cards).

- [ ] **Step 1: Write failing tests** in `test/copy.test.ts`:
  - `serializeThread keeps segment order`: user, message, run (one tool, `toolText` → `'ok'`), message → the output contains the user text, then first message, then the tool title and `'ok'`, then second message, in that order (check with `indexOf`).
  - `serializeThread marks background turns`: a background turn's output contains `'background update'`.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement** `serializeThread` and switch `copyConversation` to it. Remove `this.turns` and the obsolete per-turn fields from `chat.ts`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: pass.
- [ ] **Step 5: Commit.** `feat(copy): serialize conversation from thread model`

### Task 5: Status bar with drop-down panel

**Files:**
- Create: `src/lib/status-bar.ts` (pure summary function plus DOM component)
- Modify: `src/views/chat.ts`
  - `showStatus` (≈1323)
  - `openStreamForCurrent` (≈1306)
  - `_renderBgTermsStrip` (≈2046)
  - `_addInFlight`/`_removeInFlight`/`_clearAllInFlight`/`_resyncInFlightStrip`
  - the pane assembly (removes `bgTermsStripEl`, `inFlightStripEl`)
  - `convoSkillsStripEl`: move to the ⋯ menu in Task 8, or the Info pane. Decide after reading what it shows.
- Test: `test/status-bar.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ConnState = 'connected' | 'reconnecting' | 'disconnected';
  export interface StatusInput {
    conn: ConnState; agentStatus: string | null;   // 'running' | 'idle' | 'errored' | 'killed' | other
    activity: string | null;                       // newest running tool title, or 'thinking', or null
    toolsThisTurn: number; bgRunning: number;
  }
  export function statusSummary(s: StatusInput): { dot: 'ok' | 'warn' | 'fail' | 'idle'; text: string };
  export class StatusBar {
    constructor(host: HTMLElement);
    render(s: StatusInput): void;
    setPanelContent(bg: HTMLElement, tools: HTMLElement): void;  // bg shells list + this turn's tool rows
    open(): void; close(): void; isOpen(): boolean;
  }
  ```
- Text format: `<state>[ · <activity>][ · N tools][ · bg N]`.
  - State words are `working`, `idle`, `reconnecting`, `disconnected`, `errored`, `killed`.
  - `conn` other than `connected` takes priority over the agent state.
  - Dot colours: `warn` for working/reconnecting, `ok` for idle, `fail` for errored/killed/disconnected.
- **Reconnect delay:** the EventSource `onerror` sets `conn = 'reconnecting'` only if the stream hasn't reopened within 3000ms. `onOpen` cancels the pending timer and sets `connected`. "connecting…" and "connected" are never shown as text.
- **Panel:** tap the bar (or its chevron) to open. It drops down over the thread with a dimmed backdrop and is absolutely positioned; it does not push the thread down.
  - The bg shells section reuses the existing chip and "view all (+N exited)" rendering from `_renderBgTermsStrip`, re-homed into the panel. The 2s polling stays as is.
  - The "this turn" section lists the active turn's `RunTool`s (title and status), newest last. Tapping a row closes the panel and activates that tool's run (`onRunActivate` on desktop, inline expand on phone).
  - Close on backdrop tap, bar tap, or Esc.

- [ ] **Step 1: Write failing tests** for `statusSummary`:
  - `{conn:'connected', agentStatus:'running', activity:'curl -s', toolsThisTurn:14, bgRunning:1}` → `{dot:'warn', text:'working · curl -s · 14 tools · bg 1'}`
  - `{conn:'connected', agentStatus:'idle', activity:null, toolsThisTurn:0, bgRunning:0}` → `{dot:'ok', text:'idle'}`
  - `{conn:'reconnecting', agentStatus:'running', …}` → text starts with `'reconnecting'`, dot `'warn'`
  - `{conn:'connected', agentStatus:'errored', …}` → dot `'fail'`, text starts with `'errored'`
  - `1 tools` reads `'1 tool'`
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement** `statusSummary` and `StatusBar`. Wire them into `chat.ts`, removing the BG SHELLS strip, the in-flight strip and their CSS. Keep the topbar `bg: N` button as is on desktop.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: pass.
- [ ] **Step 5: Screenshots**, phone and desktop, panel closed and open. For the open state, add a temporary `?statusOpen=1` dev hook, or use `Runtime.evaluate` to click the bar, then remove the hook. Expected:
  - one-line bar
  - panel overlays the thread with a backdrop
  - bg shells listed
- [ ] **Step 6: Commit.** `feat(chat): one-line status bar with drop-down panel; drop bg and in-flight strips`

### Task 6: Desktop details panel (Tool run / Files)

**Files:**
- Create: `src/lib/details-panel.ts`
- Modify: `src/views/chat.ts` (pane assembly, `ThreadRenderer` `onRunActivate`, action row in `buildTabs` ≈366–428)
- Modify: `src/style.css`

**Interfaces:**
- Consumes: `ThreadRenderer.runItemsView(runId)` (Task 3), the existing `mountFilesTab` (currently used by `_buildToolsColHeader`).
- Produces:
  ```ts
  export class DetailsPanel {
    constructor(host: HTMLElement, opts: { mountFiles: (into: HTMLElement) => void });
    showRun(title: string, content: HTMLElement): void;  // opens on the "Tool run" tab
    showFiles(): void;                                   // opens on the "Files" tab
    close(): void; isOpen(): boolean;
  }
  ```
- Desktop only (`> 720px`, checked with `matchMedia('(max-width: 720px)')` at activation time). `onRunActivate` returns `true` after calling `showRun(summarizeRun(items), runItemsView(runId))`. On a phone it returns `false`.
- Layout: a right-hand column 380px wide (clamped 320–420), closed by default, with × in its header and two tabs, **Tool run** and **Files**. Clicking another run swaps the content. The thread column stays centred, with `max-width: 720px` on the reading column and composer.
- Add a **Files** button to the desktop action row that calls `showFiles()`. Keep the existing Files tab too.
- While a shown run is still live, its tool cards keep updating, because they are the same `ToolCard` instances the renderer forwards to.

- [ ] **Step 1: Implement** `DetailsPanel` and wire `onRunActivate` and the Files button.
- [ ] **Step 2: Typecheck and tests.** `npm run typecheck && npm test`. Expected: pass.
- [ ] **Step 3: Desktop screenshots:** panel closed; panel open on a run (via `Runtime.evaluate` click on a `.thread-run`); panel on Files. Expected:
  - closed by default
  - the run's thoughts and tool cards are interleaved in the panel
  - Files lists the workspace
- [ ] **Step 4: Phone screenshot** after tapping a run. Expected: inline expansion, no panel.
- [ ] **Step 5: Commit.** `feat(chat): desktop details panel with tool run and files tabs`

### Task 7: Compact composer

**Files:**
- Modify: `src/views/chat.ts` (`buildComposer` ≈652–722, the send/cancel enablement in `onAgentStatus` and `endTurn`, the `{ payload }` debug button)
- Modify: `src/style.css` (composer rules ≈1851 and the mobile block ≈3012–3165)
- Test: `test/composer-keys.test.ts`

**Interfaces:**
- Produces: `export function enterAction(ev: { key: string; shiftKey: boolean; isComposing?: boolean }, coarsePointer: boolean): 'send' | 'newline'` in a new `src/lib/composer-keys.ts`.
  - When `coarsePointer` is true (`matchMedia('(pointer: coarse)')`, i.e. a touch device), Enter → `'newline'`.
  - Otherwise Enter without Shift → `'send'`, and Shift+Enter → `'newline'`.
  - `isComposing` (IME) is always `'newline'`.
- Layout, one row: ＋ (attach, opens the existing image picker) | auto-growing textarea (1 row min, about 5 rows max; 16px font on a phone) | a round send button that becomes stop (■, calls the existing cancel) while `model.isRunning()`.
  - The separate "cancel turn" button goes away.
  - `{ payload }` moves to the ⋯ menu (Task 8) when debug is on. Keep it in the composer row on desktop only until Task 8 lands.
  - Slash palette, paste/drop images and attachment chips keep working.
  - Placeholder: `Message grok…`
  - On desktop the composer matches the reading-column width.

- [ ] **Step 1: Write failing tests** for `enterAction`:
  - desktop Enter → `'send'`
  - desktop Shift+Enter → `'newline'`
  - touch Enter → `'newline'`
  - composing → `'newline'`
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement** `enterAction` and the new composer.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: pass.
- [ ] **Step 5: Screenshots**, phone and desktop, idle and with a throwaway agent mid-turn. Expected:
  - a single compact row
  - stop shows while running
  - the textarea grows with multi-line text
  
  Check that the slash palette opens on `/`.
- [ ] **Step 6: Commit.** `feat(chat): compact one-row composer with send/stop toggle`

### Task 8: Phone header, drawer nav and ⋯ menu; desktop rail tidy

**Files:**
- Modify: `index.html` (topbar markup ≈19–44)
- Modify: `src/main.ts` (`buildLeftRail` ≈154, drawer/hamburger wiring, topbar pills)
- Modify: `src/views/chat.ts` (`buildTabs` ≈366–428, `switchTab` ≈571)
- Modify: `src/style.css` (mobile block, `@media (max-width:720px)` rail rules ≈4389–4410)
- Create if useful: `src/lib/overflow-menu.ts`, a small accessible popover menu (button + list, Esc and outside-click close)

**Interfaces:**
- Produces: `export function overflowMenu(button: HTMLElement, items: Array<{ label: string; onSelect: () => void; hidden?: () => boolean }>): { refresh(): void; close(): void }`
- **Phone (≤720px):** the header is one row: ☰ | conversation title (ellipsis) | ⋯.
  - ☰ opens the existing slide-in drawer. Add the nav pages (chats, memory, leaders, sessions, health, settings) to the drawer, so the horizontal nav row is hidden on phones.
  - ⋯ items: Files, Info, Trace, Flow, Star/Unstar, Connect/Disconnect, Copy conversation, `N tok` (display only), Theme, `{ payload }` (only when debug is on).
  - Choosing a pane switches to it full-screen, with a "‹ Conversation" back control in the header.
  - The topbar pills (`tailnet up`, `bg: N`, theme) and the tab/action row are hidden on phones. Tailnet state goes into the drawer footer, and bg state is already in the status bar.
- **Desktop:** keep the tab row and action row.
  - Move the left icon rail's pages (memory, leaders, sessions, health) into the topbar as icon buttons, so the sidebar shows only conversations. *(Spec marks this as my guess. If moving it breaks other pages' navigation in a way that needs more than this task, keep the rail and note it in the PR description.)*
  - Remove the ⋯ items that duplicate visible desktop buttons from the desktop menu, or hide the menu on desktop.

- [ ] **Step 1: Implement** `overflowMenu` and the header, drawer and rail changes.
- [ ] **Step 2: Typecheck and tests.** `npm run typecheck && npm test`. Expected: pass.
- [ ] **Step 3: Screenshots.** Phone: conversation view, drawer open, ⋯ open, Files pane with the back control. Desktop: conversation view, plus a visit to memory/sessions/health from the topbar. Expected:
  - on the phone, only header + status bar + thread + composer show by default
  - every page is still reachable
- [ ] **Step 4: Commit.** `feat(ui): phone header with drawer nav and overflow menu; desktop rail into topbar`

### Task 9: Theme pass, full verification, rebase and push

**Files:** Only `src/style.css` fixes found during this pass.

- [ ] **Step 1: Theme screenshots.** Phone and desktop, in each of dark, light, hacker and unicorn. Switch themes with `Runtime.evaluate`, setting the same localStorage key `themes.ts` uses, then reload. Expected: readable text, visible state dots, and no hard-coded dark colours in light. Fix anything that fails.
- [ ] **Step 2: Spec walk-through.** Go through every section of the spec, from Goals 1–6 to the Composer, and confirm each one against the screenshots and the code. List anything that isn't met, and fix it or report it.
- [ ] **Step 3: Full checks.** `npm run typecheck && npm test && npm run build`. Expected: all pass, and the build writes `dist/`.
- [ ] **Step 4: Rebase onto upstream.**
  ```bash
  git fetch upstream && git rebase upstream/main
  ```
  Resolve conflicts, keeping upstream behaviour outside the conversation view. Re-run Step 3.
- [ ] **Step 5: Push the branch to the fork.** `git push -u origin mobile-chat-redesign`. Expected: the branch appears at github.com/jonathanhoskin/grok-remote. Don't open the upstream PR. That is the user's call after they've tried it.
- [ ] **Step 6: Report.** Give the user the screenshot paths and what was verified. Some things headless screenshots can't show need checking on their iPhone after deploy:
  - the keyboard opening keeps the last message visible above the composer
  - PWA standalone mode (home-screen app) layout and safe areas
  - backgrounding the app and returning doesn't flash "reconnecting" Offer to deploy the build to the live instance (`npm run build && pm2 restart grok-remote`) so they can try it on their iPhone. Don't restart pm2 without their go-ahead.
