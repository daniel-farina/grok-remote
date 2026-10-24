# Backlog

Follow-ups to pick up right after the chat-first conversation redesign
(`docs/superpowers/specs/2026-10-25-chat-first-redesign-design.md`).
All five were agreed on 2026-10-25.

## 1. Push notifications when grok finishes or needs you

Long turns run while the phone is in a pocket. Send a web push notification
when a turn finishes, fails, or is waiting on a permission prompt.

- iOS supports web push only for PWAs added to the home screen (iOS 16.4+).
  The app already has a manifest and service worker (`public/`).
- Needs VAPID keys, a subscribe flow in settings, subscription storage on the
  server, and a sender hooked to `prompt_complete` / `error` /
  `request_permission`.
- Notification text: conversation name plus the first line of grok's final
  message, or "needs approval".

## 2. Previews of files grok creates, hidden until tapped

When a tool call writes or produces an image, video or audio file (for example
`analysis/extend_9ed2ce1d/extended_dyn.mp4`), offer a preview in the thread.

- **Collapsed by default, always.** Show only a disclosure line such as
  "▸ extended_dyn.mp4 (video, 12 MB)". Nothing loads or renders until the user
  taps it. No auto-play, no thumbnails fetched in advance.
- Use the existing `Range`-aware `/api/agents/:id/files/raw` endpoint and the
  Files tab's previewers.

## 3. Plan progress in the status bar

grok keeps a to-do list on longer tasks (TodoWrite, already merged into a live
"plan" card). Show it in the status bar as "step 3 of 7" and list the full
checklist in the status bar's drop-down panel.

## 4. Type and queue messages while grok is working

Keep the composer usable during a turn. A message sent mid-turn goes into
grok's queue (`x.ai/queue/changed` events already exist) and shows in the
thread as "queued" until grok picks it up. Stop remains available. Check how
grok's ACP side accepts a prompt while one is in flight before building.

## 5. Quieter reconnects

iOS drops the SSE connection whenever the app is backgrounded, which shows
"stream error · reconnecting". On reconnect, silently catch up on missed events
(the stream already has event ids; use `Last-Event-ID` or a history fetch
since the last seen id) and only show a warning if the connection has been
down for more than a few seconds.
