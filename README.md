```
  ██████╗ ██████╗
 ██╔════╝ ██╔══██╗
 ██║  ███╗██████╔╝
 ██║   ██║██╔══██╗
 ╚██████╔╝██║  ██║
  ╚═════╝ ╚═╝  ╚═╝
  ·  g r o k   r e m o t e  ·  v0.1.0
```

# grok-remote

Run **grok agents** on one machine. Drive them from any device on your **tailnet**. Multiple conversations in parallel, a live web UI that streams every thought / tool call / response, durable on disk, reachable from your phone.

One command sets it up. PM2 keeps the server alive. Tailscale handles the networking. The dashboard speaks the **Agent Client Protocol** (ACP) directly to `grok agent stdio`, so you see exactly what the agent sees and does in real time.

> Not affiliated with xAI, grok, or Tailscale.

> **Work in progress.** I'm pushing every change as I make it. Expect minor options to be broken at any given moment. Core agent features (spawn, chat, tool calls, bg processes, history) are functional.

---

## What it does

- **Multi-agent control plane.** Spawn as many independent `grok agent` processes as you want. Each gets its own working directory under `~/.grok-remote/agents/<id>/cwd/`. Click `+ new` and the conversation starts immediately; the first turn auto-names it.
- **Full ACP host.** Implements the client side of ACP (terminal/*, fs/*, request_permission) so the agent can actually run shell commands, read files, and write files. Without this every tool call would silently fail.
- **Live streaming.** Server-Sent Events forward every `session/update` event from the agent to the browser: thought chunks, tool-call cards with status pills (Pending → Running → Completed / Failed), streamed terminal output, the final assistant message, and the token-usage footer.
- **Conversations persist across restarts.** Each agent has a `meta.json` on disk with `lastSessionId`. After a server reboot, agents appear as `disconnected`; sending a new message transparently reconnects via ACP `session/load` so grok keeps the same conversation memory.
- **Star, archive, delete-forever.** The familiar trash-bin pattern: closing an active conversation **archives** it (soft); restore or **delete-forever** lives in the archived view.
- **Image attachments work.** Drop or paste an image in the composer; the bytes land at `<agent.cwd>/uploads/`, the prompt carries both an inline ACP `image` content block AND a `resource_link` plus the absolute path. The model sees the image directly.
- **Files tab.** Browse the agent's workspace, preview text with line numbers, HTML (sandboxed iframe + open-in-new-tab), images, video, audio. Backend serves binary files via a `Range`-aware streaming endpoint.
- **Mobile + PWA.** Installable as a standalone app on iOS and Android. Sidebar collapses to a slide-in drawer, 44px tap targets, safe-area-inset padding, dynamic-viewport sizing so the composer stays pinned on iOS Safari.
- **Themes.** Dark (default), light, hacker (phosphor green), unicorn. Persisted per browser. Topbar quick-toggle cycles them; settings has a picker.
- **A `gr` CLI on your PATH.** From any directory: `gr` opens the dashboard, `gr status` shows PM2 state, `gr install` re-runs the installer, etc.

---

## Requirements

- macOS or Linux
- Node.js 20+ (installer can install it via Homebrew on macOS)
- Homebrew on macOS (only used if Node, or Tailscale for tailnet mode, are missing)
- A Tailscale account, free for personal use at [tailscale.com](https://tailscale.com), if you want tailnet access
- `grok` CLI installed and authenticated (the dashboard spawns `grok agent stdio` per conversation)

---

## Install

```sh
git clone https://github.com/daniel-farina/grok-remote.git
cd grok-remote
./install.sh
```

To run only on the current machine without Tailscale:

```sh
./install.sh --local
```

The installer walks through, with animated `[ OK ]` / `[skip]` / `[warn]` / `[FAIL]` badges per step:

1. verify node >= 20
2. ensure pm2 (process manager)
3. ensure tailscale
4. start tailscaled (daemon)
5. check tailscale auth
6. resolve tailnet url
7. install app dependencies (`npm install`)
8. build dashboard (`vite build`)
9. write pm2 ecosystem config
10. start under pm2
11. save pm2 process list
12. install `gr` command (global shortcut)
13. open dashboard in Chrome

Auto-open can be skipped with `--no-open`, `NO_OPEN=1`, `CI=1`, or when the installer detects you're over SSH.

If a step warns about Tailscale auth, run `tailscale up` and open the URL it prints. On macOS, open `Tailscale.app` once if `tailscaled` isn't running. Then re-run `./install.sh` — every step is idempotent.

For local-only installs, re-run setup with `./install.sh --local` or `gr install --local`. This keeps the server bound to `127.0.0.1` and does not touch existing conversations under `~/.grok-remote/agents`.

---

## Use

### Start a conversation

Click `+ new` in the sidebar. An agent process is spawned in the background; you land on its (empty) conversation immediately. Type a message. The first response triggers an auto-name from grok's own `session_summary_generated` event, and the sidebar relabels the item from `agent-abc12345` to something descriptive within a few seconds.

### Attach images and files

Three ways:
- Drag a file onto the composer
- Paste from clipboard (Cmd+V / Ctrl+V)
- Click `attach image`

Limits: 5 attachments per turn, 5 MB each, png / jpeg / webp / gif. The file is saved to `~/.grok-remote/agents/<id>/cwd/uploads/<name>` and the agent receives:

- The absolute path in the text
- An ACP `image` content block (the inline base64)
- An ACP `resource_link` content block (formal reference)

Vision-capable models describe the image; non-vision models still have it on disk to inspect with shell tools.

### Files tab

Each conversation has a **Files** tab that browses its working directory. Click into folders, preview text files (line-numbered), HTML files (sandboxed Source / Preview toggle + open-in-new-tab), images (with checkered background), video / audio (HTML5 controls). The backend serves binary files via a `Range`-aware `/files/raw` endpoint so seeking works.

### Slash commands

Typing `/` at the start of the composer opens a palette of grok's currently-available commands (`/compact`, `/always-approve`, `/context`, `/session-info`, plus anything grok adds via `available_commands_update`). Arrow keys + Enter to commit; Esc to dismiss.

### Disconnect / reconnect

Each conversation has a `disconnect` button (in the sidebar and in the chat tabs row). Disconnect kills the grok process but keeps the conversation: history, files, settings, the grok `sessionId`. Send another message anytime; the backend transparently respawns the agent and `session/load`s the saved session so grok's own memory continues.

You can also resume on the CLI. The Info tab shows the resume commands:

```
grok -p "<follow-up>" -r <sessionId>       # one-shot, headless
cd <cwd> && grok --resume <sessionId>      # interactive TUI
```

with copy buttons for both.

### Star, archive, delete

Per sidebar item:
- `☆ / ★` toggle: starred conversations sort to the top
- `×` archives (soft removal). The agent process is shut down, but the disk record survives. The archived item moves under the collapsible `archived (N)` toggle.
- In the archived view, `restore` brings it back; `delete` is the only path to permanent removal (history + uploaded files are wiped).

### Themes

Topbar quick-toggle cycles `dark → light → hacker → unicorn → dark`. Settings has a full picker. The choice is persisted in localStorage and applied pre-DOM so there's no flash on reload.

### Copy entire conversation

The chat tabs row has a `copy conversation` button. Serializes all turns (user prompts, thought summaries, tool calls + their output, assistant messages) to clean plain text and puts it on the clipboard. Useful for pasting into bug reports, notebooks, or another agent.

### Debug controls (optional)

Settings → `debug controls` toggle. When on, a `{ payload }` button appears in the composer. Clicking it opens an inspector showing:

- the composer **draft** (what would be sent now)
- the **last sent request body** (what your browser actually POSTed)
- the **server response** (echoed back: composed text, ACP `promptBlocks`, `savedFiles`, sessionId, supportsImage flag)

Base64 image data is truncated in the visible `<pre>` for readability; the per-section `copy` button copies the FULL payload to the clipboard. Handy when something isn't behaving and you want to see exactly what grok is receiving.

### Mobile + PWA

Open the URL on your phone over your tailnet. The sidebar collapses to a slide-in drawer (hamburger top-left). On supported browsers an install banner offers to add it to your home screen; on iOS Safari it shows the manual "Share → Add to Home Screen" hint. Once installed it runs as a standalone app with the status bar tinted to match the theme.

---

## The `gr` command

After `./install.sh` the installer symlinks `gr` into `/usr/local/bin` (or `~/.local/bin` with a PATH hint as fallback). Run it from any directory.

| Command       | What it does                                                          |
|---------------|-----------------------------------------------------------------------|
| `gr`          | Ensure the server is healthy, show the URL, and offer to open it.      |
| `gr status`   | PM2 status, uptime, restarts, memory, cpu, tailnet URL.               |
| `gr open`     | Start the server if needed, then open the dashboard.                  |
| `gr url`      | Print only the URL on stdout (pipe-friendly).                         |
| `gr start`    | `pm2 start ecosystem.config.cjs` from the install dir. Pass `--local` to bind localhost. |
| `gr stop`     | `pm2 stop grok-remote`.                                               |
| `gr restart`  | `pm2 restart grok-remote`.                                            |
| `gr logs`     | `pm2 logs grok-remote --lines 100`.                                   |
| `gr install`  | Re-run the installer (idempotent). Pass `--local` to keep local-only mode. |
| `gr version`  | Print the grok-remote version.                                        |
| `gr help`     | Show the subcommand table.                                            |

Set `GR_HOME` to override how `gr` locates the project; otherwise it follows the symlink back to the install directory.

---

## How it works

```
+----------------------+   tailnet   +-----------------------+   ACP over     +------------+
|   Browser / iPhone   |  <-------> |  grok-remote server   |   stdio JSON-  |  grok       |
|   /  dashboard (PWA)  |            |   :7910                |   RPC          |  agent      |
+----------------------+    SSE     |                        |  <----------> |  (one per   |
                                    |  - REST + SSE          |                |   convo)    |
                                    |  - ACP client/host     |                +------------+
                                    |  - meta + history      |
                                    |    on disk             |
                                    +-----------------------+
```

### Per-conversation state on disk

```
~/.grok-remote/
├── settings.json                       # global server settings
└── agents/
    └── <agent-uuid>/
        ├── meta.json                   # name, starred, archived, lastSessionId, ...
        ├── history.jsonl               # append-only event log (every SSE event)
        └── cwd/                        # the agent's working directory
            └── uploads/                # files attached via the composer
```

`history.jsonl` is the durable record. On reload, the UI fetches the last 50 turns from this file (paginated: `?turns=50` default, `?all=1` to expand). The "load all earlier turns (N more)" pill appears at the top of the conversation when there's more.

### REST API surface

| Method | Path                              | Purpose |
|--------|-----------------------------------|---------|
| GET    | `/api/agents`                     | list (active + archived; UI filters)                                  |
| POST   | `/api/agents`                     | spawn a new agent. body `{ name?, model?, cwd? }`                     |
| GET    | `/api/agents/:id`                 | full record (handshake meta, capabilities, sessionId)                 |
| PATCH  | `/api/agents/:id`                 | partial update. body any of `{ name, starred, archived }`             |
| DELETE | `/api/agents/:id`                 | delete forever (kills process, scrubs the on-disk record)             |
| POST   | `/api/agents/:id/prompt`          | body `{ text, attachments? }`. Returns 202 + a debug echo.            |
| POST   | `/api/agents/:id/cancel`          | cancel an in-flight turn                                              |
| POST   | `/api/agents/:id/connect`         | spawn the grok process and resume the session                         |
| POST   | `/api/agents/:id/disconnect`      | kill the grok process; conversation survives                          |
| GET    | `/api/agents/:id/history`         | JSONL replay. `?turns=N` or `?all=1`. Headers: `X-Total-Turns`, `X-Returned-Turns` |
| GET    | `/api/agents/:id/stream`          | SSE stream of every event for that agent                              |
| GET    | `/api/agents/:id/files`           | list a directory or read a text file. `?path=<rel>`                   |
| GET    | `/api/agents/:id/files/raw`       | stream a file with `Range` support (images, video, audio, anything)   |
| GET, PATCH | `/api/settings`               | global settings (defaultModel, defaultCwd, autoApprove, debug, theme) |
| GET    | `/api/hello`                      | tailscale identity + version                                          |
| GET    | `/api/health`                     | liveness                                                              |

See [PROTOCOL.md](./PROTOCOL.md) for the full ACP + SSE wire contract.

---

## Manage

PM2 is the system supervisor. The installer wired it for you; useful direct commands:

```sh
pm2 logs grok-remote       # follow logs
pm2 status                 # all PM2 processes
pm2 restart grok-remote    # restart
pm2 stop grok-remote       # stop
pm2 delete grok-remote     # remove from PM2
```

To survive reboot:

```sh
pm2 save
pm2 startup           # follow the instructions it prints
```

The server itself handles SIGTERM / SIGINT gracefully: it disconnects every live agent (saves their `lastSessionId`) before exiting, so a restart never loses the conversation thread.

---

## Develop

```sh
npm install
npm start             # backend on :7910 (serves dist/ + /api/*)
npm run dev           # Vite dev server on :7911, proxies /api → 7910
```

- Frontend lives under `src/`. Vanilla JS + Vite. Views: `src/views/{agents,chat,settings,files}.js`. Helpers: `src/lib/{api,sse,render,themes,copy,slash-palette,attach-images,pwa}.js`.
- Backend is plain Node http. Modules: `lib/{acp-client,agent-manager,terminal-host,fs-host,permission-host,sse,history,settings}.js`.
- No external runtime deps. Vite is the only devDependency.

`experiments/probe.js` is a small standalone ACP client (~120 lines) that talks to `grok agent stdio` and dumps every JSON-RPC frame to a log file. Run it to regenerate the traces summarized in [PROTOCOL.md](./PROTOCOL.md):

```sh
node experiments/probe.js "Reply with the word ack." exp1.log
node experiments/probe.js "Run \`ls\` and tell me what you see." exp2.log
```

---

## Layout

```
grok-remote/
├── install.sh                  # bash bootstrap (verifies Node, hands off)
├── installer.js                # animated 13-step installer
├── bin/gr                      # the gr CLI
├── server.js                   # Node http server + REST/SSE
├── ecosystem.config.cjs        # PM2 config
├── vite.config.js              # Vite dev server config
├── index.html                  # dashboard entry
├── lib/                        # backend modules (ACP host + persistence)
│   ├── acp-client.js
│   ├── agent-manager.js
│   ├── terminal-host.js
│   ├── fs-host.js
│   ├── permission-host.js
│   ├── sse.js
│   ├── history.js
│   └── settings.js
├── src/                        # frontend modules
│   ├── main.js                 # router + intro animation
│   ├── style.css               # palette + dashboard CSS
│   ├── views/
│   │   ├── agents.js
│   │   ├── chat.js
│   │   ├── settings.js
│   │   └── files.js
│   └── lib/
│       ├── api.js              # fetch wrapper
│       ├── sse.js              # EventSource helper
│       ├── render.js           # tiny DOM builder + markdown-light
│       ├── themes.js
│       ├── copy.js
│       ├── slash-palette.js
│       ├── attach-images.js
│       └── pwa.js
├── public/                     # PWA assets (manifest, sw, icons)
├── experiments/                # ACP protocol traces + probe.js
├── PROTOCOL.md                 # wire format + rendering rules
└── package.json
```

---

## What's next

- Per-agent model picker (use a vision-capable model for one conversation, a fast model for another).
- Server-side OCR fallback so non-vision models can still see text inside attached images.
- Optional bearer-token auth on top of Tailscale's perimeter.
- Auto-archive after N days of inactivity (configurable in settings).

---

## License

MIT. See [LICENSE](./LICENSE).
