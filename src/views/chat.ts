// Per-agent conversation pane with live SSE streaming.
//
// Rendering rules (from PROTOCOL.md, frontend section):
//   per turn, in chronological order:
//   1. user bubble
//   2. thinking pane (collapsed) from agent_thought_chunk
//   3. tool_call cards, patched by tool_call_update + tool_call_delta_chunk
//   4. assistant message from agent_message_chunk
//   5. token-usage footer from prompt_complete
//
// Plus: available_commands_update, session_summary_generated,
//       _x.ai/session_notification (toast), error (red banner).

import { api } from '../lib/api';
import { openStream } from '../lib/sse';
import { mountFilesTab, unmountFilesTab } from './files';
import { mountTraceTab, unmountTraceTab } from './trace';
import { mountScoped as mountFlowTab, unmount as unmountFlowTab } from './system/flow';
import attachSlashPalette from '../lib/slash-palette';
import { setupImageAttach } from '../lib/attach-images';
import { el, renderToast } from '../lib/render';
import { unwrap } from '../lib/acp-payload.js';
import { copyToClipboard, serializeThread, toolCardText, serializeResumeCommand } from '../lib/copy';
import { ThreadModel } from '../lib/thread-model';
import { ThreadRenderer } from '../lib/thread-render';
import { EventDedup } from '../lib/event-dedup';
import { StatusBar, type ConnState } from '../lib/status-bar';
import type { RunTool } from '../lib/thread-model';
import { iconHtml } from '../lib/icons';
import { fmtTokens } from '../lib/format';
import { playIntro } from '../lib/intro-animation';

export class ChatView {
  static _active: any;
  _autoScroll!: any;
  _bgListViewerEl!: any;
  _bgTermsByCard!: any;
  _bgTermsTimer!: any;
  _bgTermViewerEl!: any;
  _bgTermViewerTimer!: any;
  _chatIntroAbort!: any;
  _chatIntroEl!: any;
  _convoSkills!: any;
  _detachAutoScroll!: any;
  _detachPalette!: any;
  _easedScrollPending!: any;
  _easedScrollRaf!: any;
  _easedScrollTarget!: any;
  _userScrollIntentAt!: number;
  _historyAll!: any;
  _isReplaying!: any;
  _jumpToLatestBtn!: any;
  _knownSkills!: any;
  _lastEasedWrite!: any;
  _lastEventTs!: any;
  _lastPayload!: any;
  _lastRenderedTokens!: any;
  _lastServerEcho!: any;
  _modelDatalist!: any;
  _modelSuggestions!: any;
  _onAgentsRefresh!: any;
  _onSettingsChange!: any;
  _onVisibility!: any;
  _payloadModal!: any;
  _promptCapImage!: any;
  _scrollRaf!: any;
  _sdDirty!: any;
  _sdDirtyNotice!: any;
  _sdFields!: any;
  _sdNameInput!: any;
  _sdNotice!: any;
  _skillCommands!: any;
  _skillsPromise!: any;
  _splitToggleBtn!: any;
  _toolsTabBtns!: any;
  activeTurn!: any;
  agentId!: any;
  availableCommands!: any;
  bgTermsStripEl!: any;
  composerAttachBtn!: any;
  composerCancel!: any;
  composerDebugBtn!: any;
  composerEl!: any;
  composerFileInput!: any;
  composerHint!: any;
  composerSend!: any;
  composerTa!: any;
  connectBtn!: any;
  convoSkillsStripEl!: any;
  copyConvoBtn!: any;
  currentAgent!: any;
  empty!: any;
  filesMounted!: any;
  filesPane!: any;
  flowMounted!: any;
  flowPane!: any;
  imageAttach!: any;
  inflightPill!: any;
  infoPane!: any;
  latestTotalTokens!: any;
  palette!: any;
  root!: any;
  settingsBtn!: any;
  settingsDrawer!: any;
  settingsDrawerOpen!: any;
  starBtn!: any;
  statusEl!: any;
  stream!: any;
  streamEl!: any;
  tabBtns!: any;
  tabsEl!: any;
  tabsState!: any;
  toastHost!: any;
  tokensPill!: any;
  traceMounted!: any;
  tracePane!: any;
  model!: ThreadModel;
  thread!: ThreadRenderer;
  _seenEvents = new EventDedup();
  statusBar!: StatusBar;
  statusToolsEl!: HTMLElement;
  _conn: ConnState = 'connected';
  _connTimer: ReturnType<typeof setTimeout> | null = null;
  _agentStatus: string | null = null;
  _bgRunning = 0;

  constructor() {
    this.agentId = null;
    this.stream  = null;
    this.availableCommands = [];
    this.tabsState = 'conversation';

    // Lazy cache of known skill names (set of strings). Populated on first
    // user message that starts with `/`. Drives the "invoked skill" banner
    // we drop above turns that hit a /name match.
    this._knownSkills = null;
    this._skillCommands = [];
    this._skillsPromise = null;

    this.streamEl  = el('div', { class: 'chat-stream' });
    this.model = new ThreadModel();
    this.thread = new ThreadRenderer({
      container: this.streamEl,
      model: this.model,
      agentId: () => this.agentId,
      animate: () => !this._isReplaying,
      onExpand: (node) => this._pauseFollowAfterExpand(node),
    });
    this.composerEl = this.buildComposer();
    this.tabsEl    = this.buildTabs();
    this.statusBar = new StatusBar();
    this.statusEl  = this.statusBar.el;

    this.filesPane = el('div', { class: 'pane pane--files hidden' });
    this.filesMounted = false;
    this.infoPane  = el('div', { class: 'pane pane--info hidden' }, el('div', { class: 'pane-empty' }, 'no agent selected'));
    this.tracePane = el('div', { class: 'pane pane--trace hidden' });
    this.traceMounted = false;
    this.flowPane = el('div', { class: 'pane pane--flow hidden' });
    this.flowMounted = false;

    this.toastHost = el('div', { class: 'toast-host' });

    // Settings drawer: slides in from the right of the chat. Built lazily
    // when the user clicks the gear icon so the DOM cost is zero otherwise.
    this.settingsDrawer = null;
    this.settingsDrawerOpen = false;
    this._modelSuggestions = null;

    this.empty = el('div', { class: 'chat-empty' },
      el('div', { class: 'chat-empty-headline' }, 'no conversation selected'),
      el('div', { class: 'chat-empty-sub' }, 'pick one from the sidebar or start a new one.'),
      el('div', { class: 'chat-empty-actions' },
        el('button', {
          class: 'btn btn--ghost chat-empty-btn',
          type: 'button',
          onclick: () => {
            // Make sure the sidebar is visible (desktop: dispatch toggle if
            // currently collapsed; mobile: open the drawer).
            try {
              const collapsed = (localStorage.getItem('grok-remote.split.sidebar.collapsed') === '1');
              if (collapsed) document.dispatchEvent(new CustomEvent('grok-remote:sidebar-toggle'));
            } catch { /* ignore */ }
            document.body.setAttribute('data-drawer-open', '1');
          },
        }, 'Select conversation'),
        el('button', {
          class: 'btn btn--primary chat-empty-btn',
          type: 'button',
          onclick: () => {
            // Reuse the sidebar's spawn handler so the same id-then-select
            // flow runs (avoids duplicating the createAgent + navigate code).
            document.dispatchEvent(new CustomEvent('grok-remote:spawn-agent'));
          },
        }, 'New conversation'),
      ),
    );

    // Chat-intro animation state. The hole-to-GR figlet plays inside the
    // chat-stream when an agent with zero turns is opened (i.e. a brand
    // new conversation). _chatIntroAbort cancels the running animation
    // when the first user message lands or the user switches away.
    this._chatIntroAbort = null;
    this._chatIntroEl    = null;

    // Background terminals strip: lists long-running shells launched by the
    // agent ([bg] tool calls). Click a chip to view live output. Polls the
    // /api/agents/:id/terminals endpoint every 2s while an agent is selected.
    this.bgTermsStripEl = el('div', { class: 'bgterms-strip', hidden: true });
    this._bgTermsByCard = new Map(); // tid -> chip element
    this._bgTermsTimer = null;
    this._bgTermViewerEl = null;

    // Per-conversation strip listing skills invoked in this conversation.
    // Populated from _decorateSkill matches; reset on agent switch.
    this.convoSkillsStripEl = el('div', { class: 'convo-skills-strip', hidden: true });
    this._convoSkills = new Map(); // name -> count

    // The status bar's drop-down holds the bg shells, this turn's tool
    // calls and the skills used in this conversation.
    this.statusToolsEl = el('div', { class: 'status-panel__tools' });
    this.statusBar.setPanelContent(this.bgTermsStripEl, this.statusToolsEl, this.convoSkillsStripEl);
    this.statusBar.onOpen = () => this._renderStatusTools();

    this.root = el('section', { class: 'chat' },
      this.tabsEl,
      el('div', { class: 'chat-body' },
        el('div', { class: 'pane pane--conversation' },
          this.statusEl,
          this.streamEl,
          this.composerEl,
        ),
        this.filesPane,
        this.infoPane,
        this.tracePane,
        this.flowPane,
        this.toastHost,
      ),
    );

    this.streamEl.appendChild(this.empty);
    this._setComposerEnabled(false);
    this._attachComposerExtras();
    this._initAutoScroll();

    // visibility change -> refresh history on becoming visible
    this._onVisibility = () => {
      if (document.visibilityState === 'visible' && this.agentId) {
        this.refreshHistory().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    // Sidebar pushes fresh agent records into the chat view on each poll
    // tick. Pick out the one matching our active agent so the chat header,
    // info tab, and connect/disconnect button reflect live state.
    this._onAgentsRefresh = (ev: any) => {
      if (!this.agentId) return;
      const list = (ev && ev.detail) || [];
      const a = list.find((x: any) => x && x.id === this.agentId);
      if (a) this.applyAgentRefresh(a);
    };
    document.addEventListener('grok-remote:agents-refresh', this._onAgentsRefresh);

    // Settings changes (e.g. debug toggle) come in via this custom event.
    this._onSettingsChange = (ev: any) => this.applySettings((ev && ev.detail) || {});
    window.addEventListener('grok-remote:settings-change', this._onSettingsChange);
    // Pull initial settings so the debug button surfaces if already enabled.
    api.getSettings().then((s) => this.applySettings(s || {})).catch(() => {});
  }

  applySettings(s: any) {
    const debug = !!s.debug;
    if (this.composerDebugBtn) this.composerDebugBtn.hidden = !debug;
  }

  mount(parent: any) {
    parent.appendChild(this.root);
    ChatView._active = this;
  }

  destroy() {
    this.closeStream();
    this._cancelChatIntro();
    if (this.filesMounted) {
      unmountFilesTab();
      this.filesMounted = false;
    }
    if (this.traceMounted) {
      unmountTraceTab();
      this.traceMounted = false;
    }
    if (this.flowMounted) {
      unmountFlowTab();
      this.flowMounted = false;
    }
    if (this._detachPalette) { try { this._detachPalette(); } catch { /* ignore */ } this._detachPalette = null; }
    if (this._detachAutoScroll) { try { this._detachAutoScroll(); } catch { /* ignore */ } this._detachAutoScroll = null; }
    this._stopBgTerminalsPolling();
    if (this.imageAttach) { try { this.imageAttach.destroy(); } catch { /* ignore */ } this.imageAttach = null; }
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._onAgentsRefresh) {
      document.removeEventListener('grok-remote:agents-refresh', this._onAgentsRefresh);
      this._onAgentsRefresh = null;
    }
    if (this._onSettingsChange) {
      window.removeEventListener('grok-remote:settings-change', this._onSettingsChange);
      this._onSettingsChange = null;
    }
  }

  buildTabs() {
    const make = (key: any, label: any) => el('button', {
      class: `tab${this.tabsState === key ? ' tab--active' : ''}`,
      dataset: { key },
      onclick: () => this.switchTab(key),
    }, label);
    this.tabBtns = {
      conversation: make('conversation', 'Conversation'),
      files:        make('files',        'Files'),
      info:         make('info',         'Info'),
      trace:        make('trace',        'Trace'),
      flow:         make('flow',         'Flow'),
    };
    const starBtn = el('button', {
      class: 'chat-star tab-action tab-action--icon-only',
      type: 'button',
      title: 'Star this conversation',
      'aria-label': 'star conversation',
      onclick: () => this.toggleStar(),
    });
    starBtn.innerHTML = `<span class="tab-action-ico">${iconHtml('star')}</span>`;
    this.starBtn = starBtn;

    const settingsBtn = el('button', {
      class: 'chat-settings tab-action tab-action--icon-only',
      type: 'button',
      title: 'Per-conversation grok settings (model, reasoning effort, rules, ...)',
      'aria-label': 'open settings drawer',
      onclick: () => this.toggleSettingsDrawer(),
    });
    settingsBtn.innerHTML = `<span class="tab-action-ico">${iconHtml('settings')}</span>`;
    this.settingsBtn = settingsBtn;
    this.connectBtn = el('button', {
      class: 'tab-action tab-action--toggle',
      type: 'button',
      title: 'Disconnect: stop the agent process but keep the conversation.',
      onclick: () => this.toggleConnection(),
    }, 'disconnect');
    this.copyConvoBtn = el('button', {
      class: 'tab-action tab-action--copy',
      type: 'button',
      title: 'Copy entire conversation as plain text',
      onclick: () => this.copyConversation(),
    }, 'copy');
    this.tokensPill = el('span', { class: 'tab-tokens', hidden: true });
    this.inflightPill = el('span', { class: 'tab-inflight', hidden: true });
    return el('nav', { class: 'tabs' },
      this.tabBtns.conversation,
      this.tabBtns.files,
      this.tabBtns.info,
      this.tabBtns.trace,
      this.tabBtns.flow,
      el('span', { class: 'tabs-spacer' }),
      this.inflightPill,
      this.tokensPill,
      el('div', { class: 'tab-actions-group' },
        this.starBtn,
        this.settingsBtn,
        this.connectBtn,
        this.copyConvoBtn,
      ),
    );
  }

  _renderInflightPill() {
    const n = this.currentAgent && this.currentAgent.inFlight;
    if (typeof n === 'number' && n > 0) {
      this.inflightPill.hidden = false;
      this.inflightPill.replaceChildren(
        el('span', { class: 'tab-inflight-dot' }),
        document.createTextNode(`${n} tool${n === 1 ? '' : 's'}`),
      );
      this.inflightPill.title = `${n} tool call${n === 1 ? '' : 's'} in flight`;
    } else {
      this.inflightPill.hidden = true;
      this.inflightPill.replaceChildren();
    }
  }

  _renderTokensPill() {
    // Prefer the live value from prompt_complete / streaming updates over the
    // snapshot we got at setAgent time.
    const live = (typeof this.latestTotalTokens === 'number') ? this.latestTotalTokens : null;
    const snap = this.currentAgent && this.currentAgent.totalTokens;
    const t = (typeof live === 'number' && live > 0) ? live : (typeof snap === 'number' ? snap : 0);
    if (typeof t === 'number' && t > 0) {
      this.tokensPill.hidden = false;
      const prev = (typeof this._lastRenderedTokens === 'number') ? this._lastRenderedTokens : 0;
      const delta = (prev > 0 && t > prev) ? (t - prev) : 0;
      this.tokensPill.replaceChildren(
        document.createTextNode(fmtTokens(t) + ' tok'),
      );
      if (delta > 0) {
        const deltaSpan = el('span', { class: 'tab-tokens-delta' }, ` +${fmtTokens(delta)}`);
        this.tokensPill.appendChild(deltaSpan);
      }
      this.tokensPill.title = `${t.toLocaleString()} tokens in context${delta > 0 ? ` (+${delta.toLocaleString()} this turn)` : ''}`;
      this._lastRenderedTokens = t;
    } else {
      this.tokensPill.hidden = true;
      this.tokensPill.replaceChildren();
      this._lastRenderedTokens = 0;
    }
  }

  async toggleStar() {
    if (!this.agentId) return;
    const cur = !!(this.currentAgent && this.currentAgent.starred);
    this.starBtn.disabled = true;
    try {
      const updated = await api.updateAgent(this.agentId, { starred: !cur });
      this.applyAgentRefresh(updated);
    } catch (e: any) {
      this.showToast(`star failed: ${e.message}`, 'warn');
    } finally {
      this.starBtn.disabled = false;
    }
  }

  _syncStarBtn() {
    if (!this.starBtn) return;
    const on = !!(this.currentAgent && this.currentAgent.starred);
    this.starBtn.classList.toggle('is-on', on);
    // Don't overwrite textContent: the SVG icon lives in the inner
    // .tab-action-ico span. The .is-on class drives the filled vs.
    // outlined visual via CSS.
    this.starBtn.title = on ? 'Unstar this conversation' : 'Star this conversation';
    this.starBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  async toggleConnection() {
    if (!this.agentId) return;
    const a = this.currentAgent;
    const disconnected = !!(a && (a.status === 'disconnected' || a.status === 'exited'));
    this.connectBtn.disabled = true;
    try {
      if (disconnected) {
        await api.connect(this.agentId);
        this.showToast('connecting...', 'info');
      } else {
        await api.disconnect(this.agentId);
        this.showToast('disconnected; sending a message will reconnect.', 'info');
      }
    } catch (e: any) {
      this.showToast(`${disconnected ? 'connect' : 'disconnect'} failed: ${e.message}`, 'warn');
    } finally {
      this.connectBtn.disabled = false;
      // The sidebar's 4 s poll will refresh state shortly; force one quick
      // refresh so the chat header label updates immediately.
      setTimeout(() => {
        api.getAgent(this.agentId).then((fresh) => this.applyAgentRefresh(fresh)).catch(() => {});
      }, 500);
    }
  }

  applyAgentRefresh(a: any) {
    if (!a || a.id !== this.agentId) return;
    this.currentAgent = a;
    this._syncConnectBtn();
    this._syncStarBtn();
    // Re-render info tab if visible so status/sessionId etc. stay current.
    if (this.tabsState === 'info') this.renderInfo(a);
    // Keep the drawer's "reconnect to apply" notice in sync with status.
    if (this.settingsDrawerOpen) this._updateSettingsNotice(a);
    this._renderTokensPill();
    this._renderInflightPill();
  }

  _syncConnectBtn() {
    if (!this.connectBtn) return;
    const a = this.currentAgent;
    const disconnected = !!(a && (a.status === 'disconnected' || a.status === 'exited'));
    this.connectBtn.textContent = disconnected ? 'connect' : 'disconnect';
    this.connectBtn.classList.toggle('tab-action--off', disconnected);
    this.connectBtn.title = disconnected
      ? 'Reconnect: resume the conversation in a fresh agent process.'
      : 'Disconnect: stop the agent process but keep the conversation.';
  }

  async copyConversation() {
    if (!this.agentId) {
      this.showToast('no agent selected', 'warn');
      return;
    }
    const text = serializeThread(
      this.model.turns,
      (id: string) => toolCardText(this.thread.ensureToolCard(id)?.node),
      { agent: this.currentAgent || { id: this.agentId } },
    );
    const ok = await copyToClipboard(text);
    if (ok) {
      this.flashBtnLabel(this.copyConvoBtn, 'copied');
      this.showToast('conversation copied to clipboard.', 'info');
    } else {
      this.showToast('copy failed', 'fail');
    }
  }

  flashBtnLabel(btn: any, tempLabel: any) {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = tempLabel;
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = orig;
      btn.disabled = false;
    }, 1200);
  }

  switchTab(key: any) {
    this.tabsState = key;
    for (const [k, btn] of Object.entries(this.tabBtns)) {
      (btn as any).classList.toggle('tab--active', k === key);
    }
    const convo = this.root.querySelector('.pane--conversation');
    if (convo) convo.classList.toggle('hidden', key !== 'conversation');
    this.filesPane.classList.toggle('hidden', key !== 'files');
    this.infoPane.classList.toggle('hidden', key !== 'info');
    this.tracePane.classList.toggle('hidden', key !== 'trace');
    this.flowPane.classList.toggle('hidden', key !== 'flow');

    if (key === 'files') {
      if (this.agentId) {
        mountFilesTab(this.filesPane, { id: this.agentId });
        this.filesMounted = true;
      } else if (!this.filesMounted) {
        this.filesPane.replaceChildren(el('div', { class: 'pane-empty' }, 'no agent selected'));
      }
    } else if (this.filesMounted) {
      unmountFilesTab();
      this.filesMounted = false;
    }

    // Trace tab: always re-fetch and re-render on every open. The mount
    // function unmounts any prior trace state first, so this is safe.
    if (key === 'trace') {
      if (this.agentId) {
        mountTraceTab(this.tracePane, this.currentAgent || { id: this.agentId });
        this.traceMounted = true;
      } else {
        this.tracePane.replaceChildren(el('div', { class: 'pane-empty' }, 'no agent selected'));
      }
    } else if (this.traceMounted) {
      unmountTraceTab();
      this.traceMounted = false;
    }

    // Flow tab: scoped to just this conversation's agent. Lazily mounts
    // the same ReactFlow component as the global #/flow page but with a
    // filterIds prop so only this agent's node + tool-call satellites show.
    if (key === 'flow') {
      if (this.agentId) {
        mountFlowTab(this.flowPane, [this.agentId]);
        this.flowMounted = true;
      } else {
        this.flowPane.replaceChildren(el('div', { class: 'pane-empty' }, 'no agent selected'));
      }
    } else if (this.flowMounted) {
      unmountFlowTab();
      this.flowMounted = false;
    }

    if (key === 'info') {
      this.renderInfo(this.currentAgent);
    }
  }

  // Snap the chat view to the conversation tab with the tools sidebar
  // collapsed. Called by main.js both on a freshly-created conversation
  // (AgentsSidebar.onCreate) and on a sidebar selection
  // (AgentsSidebar.onSelect) so picking any chat from the list always
  // lands the user looking at the messages, not a leftover Files/Flow
  // tab or a wide tools column from a previous agent.
  focusConversation() {
    this.switchTab('conversation');
  }

  // Back-compat alias for older call sites. New code should use
  // focusConversation().
  beginNewConversation() { this.focusConversation(); }

  buildComposer() {
    const ta = el('textarea', {
      class: 'composer-input',
      rows: '3',
      placeholder: 'message the agent.  enter to send, shift+enter for newline.  type / for commands.',
      onkeydown: (ev: any) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          this.send();
        }
      },
    });
    const sendBtn = el('button', {
      class: 'btn btn--primary composer-send',
      onclick: () => this.send(),
    }, 'send');
    const cancelBtn = el('button', {
      class: 'btn btn--ghost composer-cancel',
      onclick: () => this.cancel(),
    }, 'cancel turn');

    // Hidden file input used by the "attach image" button.
    const fileInput = el('input', {
      type: 'file',
      class: 'composer-file-input',
      accept: 'image/*',
      multiple: '',
      style: { display: 'none' },
    });
    const attachBtn = el('button', {
      class: 'btn btn--ghost composer-attach',
      title: 'Attach image (saved to agent uploads/ folder)',
      onclick: (ev: any) => { ev.preventDefault(); fileInput.click(); },
    }, 'attach image');

    const debugBtn = el('button', {
      class: 'btn btn--ghost composer-debug',
      type: 'button',
      title: 'Preview the exact JSON payload that will be sent (composer + attachments), plus the last server-composed prompt if one exists.',
      onclick: (ev: any) => { ev.preventDefault(); this.openPayloadInspector(); },
    }, '{ payload }');
    // Hidden by default; surfaced when settings.debug is true.
    debugBtn.hidden = true;
    this.composerDebugBtn = debugBtn;

    // Caption row used to show the slash-command hint after a commit.
    const hintCaption = el('div', { class: 'composer-hint hidden' });

    this.composerTa        = ta;
    this.composerSend      = sendBtn;
    this.composerCancel    = cancelBtn;
    this.composerFileInput = fileInput;
    this.composerAttachBtn = attachBtn;
    this.composerHint      = hintCaption;
    // Kept around (hidden) for back-compat with any leftover CSS hooks; the
    // new slash-palette module creates its own floating panel.
    this.palette = el('div', { class: 'command-palette hidden' });

    return el('div', { class: 'composer' },
      this.palette,
      hintCaption,
      ta,
      el('div', { class: 'composer-actions' },
        attachBtn,
        debugBtn,
        fileInput,
        cancelBtn,
        sendBtn,
      ),
    );
  }

  _attachComposerExtras() {
    if (this._detachPalette) {
      try { this._detachPalette(); } catch { /* ignore */ }
      this._detachPalette = null;
    }
    if (this.imageAttach) {
      try { this.imageAttach.destroy(); } catch { /* ignore */ }
      this.imageAttach = null;
    }
    if (!this.composerTa) return;

    this._detachPalette = attachSlashPalette({
      textarea: this.composerTa,
      getCommands: () => this._mergedCommands(),
      onCommit: ({ command, hint }) => {
        if (hint && this.composerHint) {
          this.composerHint.textContent = `usage: /${command.name} ${hint}`;
          this.composerHint.classList.remove('hidden');
        } else if (this.composerHint) {
          this.composerHint.classList.add('hidden');
          this.composerHint.textContent = '';
        }
      },
    });

    this.imageAttach = setupImageAttach({
      container: this.composerEl,
      textarea: this.composerTa,
      fileInput: this.composerFileInput,
      canAttachImages: () => this._canAttachImages(),
      onChange: ({ error }) => {
        if (error) this.showToast(error, 'warn');
        this._syncAttachBtn();
      },
    });
    this._syncAttachBtn();
  }

  _canAttachImages() {
    return !!this._promptCapImage;
  }

  // Lazy-load the set of known skill names. We use it to decorate user
  // messages that start with `/<name>` matching a real skill. Cached for
  // the lifetime of this ChatView instance.
  async _loadSkills() {
    if (this._knownSkills) return this._knownSkills;
    if (this._skillsPromise) return this._skillsPromise;
    this._skillsPromise = (async () => {
      try {
        const data: any = await api.skills.list();
        const set = new Set();
        const palette = [];
        const seenNames = new Set();
        for (const s of ((data && data.skills) || [])) {
          if (!s || typeof s.name !== 'string' || !s.name) continue;
          set.add(s.name);
          // Deduplicate by name so the same skill from multiple scopes only
          // shows once in the palette (scope shadowing: cwd > repo > user).
          if (seenNames.has(s.name)) continue;
          seenNames.add(s.name);
          palette.push({
            name: s.name,
            description: s.description || s.title || '',
            kind: 'skill',
            scope: s.scope || '',
          });
        }
        this._knownSkills = set;
        this._skillCommands = palette;
        return set;
      } catch {
        this._knownSkills = new Set();
        this._skillCommands = [];
        return this._knownSkills;
      }
    })();
    return this._skillsPromise;
  }

  // Attach an "invoked skill" banner to the turn root when the user
  // message starts with /name and `name` matches a known skill. Banner
  // links to #/skills so the user can jump straight to the skill page.
  _decorateSkill(turn: any) {
    if (!turn || !turn.userText) return;
    const m = turn.userText.match(/^\s*\/([A-Za-z][\w-]*)\b/);
    if (!m) return;
    const name = m[1];
    Promise.resolve(this._knownSkills || this._loadSkills()).then((set) => {
      if (!set || !set.has(name)) return;
      // Record into the per-conversation set (idempotent, count via Map).
      const prior = this._convoSkills.get(name) || 0;
      this._convoSkills.set(name, prior + 1);
      this._renderConvoSkillsStrip();
      // Fire-and-forget usage metric bump. Don't block paint.
      try { api.skills.use(name, this.agentId).catch(() => {}); } catch { /* ignore */ }

      if (turn._skillBanner) return;
      const banner = el('div', { class: 'skill-banner', title: 'invoked skill (click to open the Skills page)' });
      banner.innerHTML = `
        <span class="skill-banner-ico">${iconHtml('skills')}</span>
        <span class="skill-banner-label">invoked skill</span>
        <a class="skill-banner-name" href="#/settings/skills">/${name}</a>
      `;
      turn._skillBanner = banner;
      // Banner sits ABOVE the user bubble so the chronology reads:
      //   skill chip then user message then assistant turn.
      turn.root.insertBefore(banner, turn.user);
    });
  }

  _renderConvoSkillsStrip() {
    if (!this.convoSkillsStripEl) return;
    const entries = Array.from(this._convoSkills.entries()) as any[];
    if (!entries.length) {
      this.convoSkillsStripEl.replaceChildren();
      this.convoSkillsStripEl.hidden = true;
      return;
    }
    this.convoSkillsStripEl.replaceChildren();
    this.convoSkillsStripEl.hidden = false;
    const label = el('span', { class: 'convo-skills-label' });
    label.innerHTML = `<span class="convo-skills-ico">${iconHtml('skills')}</span><span>skills</span>`;
    this.convoSkillsStripEl.appendChild(label);
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, count] of entries) {
      const chip = el('a', {
        href: '#/skills',
        class: 'convo-skills-chip',
        title: `invoked ${count}× in this conversation`,
      }, `/${name}`);
      this.convoSkillsStripEl.appendChild(chip);
    }
  }

  _captureAgentCaps(agent: any) {
    // Images are now always allowed: the backend saves attachments to the
    // agent's uploads/ folder, so any model can use them via its own tools.
    // We still track the model's native image capability for informational
    // purposes (Info tab), but it no longer gates the attach button.
    this._promptCapImage = true;
    void agent;
    this._syncAttachBtn();
    if (this.imageAttach) this.imageAttach.refreshSupport();
  }

  _syncAttachBtn() {
    if (!this.composerAttachBtn) return;
    this.composerAttachBtn.disabled = false;
    this.composerAttachBtn.classList.remove('is-disabled');
  }

  setAvailableCommands(list: any) {
    if (!Array.isArray(list)) return;
    this.availableCommands = list;
  }

  _mergedCommands() {
    // Merge agent-advertised commands with the filesystem-discovered skills.
    // Skills are deduplicated by name across scopes so the user sees each
    // once. Agent commands win on name conflict (they're the live API).
    const agentNames = new Set();
    const out = [];
    for (const c of (this.availableCommands || [])) {
      if (!c || typeof c.name !== 'string') continue;
      agentNames.add(c.name);
      out.push(c);
    }
    for (const s of (this._skillCommands || [])) {
      if (!s || agentNames.has(s.name)) continue;
      out.push(s);
    }
    return out;
  }

  _setComposerEnabled(enabled: any) {
    if (!this.composerTa) return;
    this.composerTa.disabled = !enabled;
    this.composerSend.disabled = !enabled;
    this.composerCancel.disabled = enabled; // only enable mid-turn... toggled in send()
  }

  setAgent(agent: any) {
    // agent: { id, ... } or null
    this.closeStream();
    this._cancelChatIntro();
    this.streamEl.replaceChildren();
    this.model.reset();
    this.thread.clear();
    // Fire-and-forget skill cache warmup so the banner can paint as soon
    // as a /name message lands. Harmless if the agent has none.
    this._loadSkills();
    this._agentStatus = (agent && agent.status) || null;
    this._bgRunning = 0;
    this.statusBar.close();
    this.palette.classList.add('hidden');
    this.palette.replaceChildren();
    this.toastHost.replaceChildren();
    this.composerTa.value = '';
    if (this.composerHint) {
      this.composerHint.classList.add('hidden');
      this.composerHint.textContent = '';
    }
    if (this.imageAttach) this.imageAttach.clear();
    this._promptCapImage = false;
    this._syncAttachBtn();
    if (agent) this._captureAgentCaps(agent);

    if (this.filesMounted) {
      unmountFilesTab();
      this.filesMounted = false;
    }
    if (this.traceMounted) {
      unmountTraceTab();
      this.traceMounted = false;
      this.tracePane.replaceChildren();
    }
    if (this.flowMounted) {
      unmountFlowTab();
      this.flowMounted = false;
      this.flowPane.replaceChildren();
    }

    if (!agent || !agent.id) {
      this.agentId = null;
      this.currentAgent = null;
      this.streamEl.appendChild(this.empty);
      this.infoPane.replaceChildren(el('div', { class: 'pane-empty' }, 'no agent selected'));
      this.filesPane.replaceChildren();
      this._setComposerEnabled(false);
      // Hide the star + connect buttons until an agent is loaded.
      if (this.starBtn)     this.starBtn.hidden = true;
      if (this.settingsBtn) this.settingsBtn.hidden = true;
      if (this.connectBtn)  this.connectBtn.hidden = true;
      if (this.tokensPill)  this.tokensPill.hidden = true;
      if (this.inflightPill) this.inflightPill.hidden = true;
      this.closeSettingsDrawer();
      return;
    }
    if (this.starBtn)     this.starBtn.hidden = false;
    if (this.settingsBtn) this.settingsBtn.hidden = false;
    if (this.connectBtn)  this.connectBtn.hidden = false;

    const switchingAgent = this.agentId !== agent.id;
    if (switchingAgent) {
      this._stopBgTerminalsPolling();
      this._convoSkills = new Map();
      this._renderConvoSkillsStrip();
    }
    this.agentId = agent.id;
    this.currentAgent = agent;
    this.latestTotalTokens = (agent && agent.totalTokens) || null;
    if (switchingAgent) this._lastRenderedTokens = 0;
    this._startBgTerminalsPolling();
    this._setComposerEnabled(true);
    this.composerCancel.disabled = true;
    this._syncConnectBtn();
    this._renderTokensPill();
    this._renderInflightPill();
    this._syncStarBtn();

    if (this.tabsState === 'files') {
      mountFilesTab(this.filesPane, { id: this.agentId });
      this.filesMounted = true;
    }

    const agentIdAtCall = agent.id;
    this.refreshHistory()
      .catch((e) => this.showToast(`history load failed: ${e.message}`, 'warn'))
      .finally(() => {
        // Only show the intro if the agent we loaded history for is still
        // the active one (the user may have switched mid-load), there are
        // no turns yet (brand new conversation), and no other intro is in
        // flight. We also gate on activeTurn being null so we don't paint
        // the intro on top of an SSE event that raced in.
        if (
          this.agentId === agentIdAtCall &&
          this.model.turns.length === 0 &&
          !this._chatIntroAbort
        ) {
          this._playChatIntro();
        }
        this.openStreamForCurrent();
      });

    this.renderInfo(agent);
  }

  // ── chat intro animation ─────────────────────────────────────────────
  //
  // When a brand-new conversation is opened (zero turns), play the
  // hole-to-GR figlet inside the chat-stream as a welcome moment. The
  // animation cancels the moment the user sends a message or an SSE
  // chunk lands (both start a new turn), or the user switches to
  // another agent.

  _playChatIntro() {
    if (this._chatIntroAbort) return;
    const ctrl = new AbortController();
    this._chatIntroAbort = ctrl;

    const figletEl = el('pre', { class: 'chat-intro-figlet figlet' });
    const subEl    = el('div', { class: 'chat-intro-sub' }, 'ready for your first message');
    const wrapEl   = el('div', { class: 'chat-intro' }, figletEl, subEl);
    this._chatIntroEl = wrapEl;

    // Replace whatever was in the stream (the "no agent selected" empty
    // would only be there if no agent; in the new-conversation case the
    // stream is already empty after the history load).
    this.streamEl.replaceChildren(wrapEl);

    (async () => {
      try {
        await playIntro(figletEl, { signal: ctrl.signal });
      } catch { /* ignore */ }
      // Animation finished naturally: leave the figlet + subtitle in
      // place until a turn lands. The cancel path will tear it down.
    })();
  }

  _cancelChatIntro() {
    if (this._chatIntroAbort) {
      try { this._chatIntroAbort.abort(); } catch { /* ignore */ }
      this._chatIntroAbort = null;
    }
    if (this._chatIntroEl && this._chatIntroEl.parentNode) {
      try { this._chatIntroEl.parentNode.removeChild(this._chatIntroEl); } catch { /* ignore */ }
    }
    this._chatIntroEl = null;
  }

  renderInfo(agent: any) {
    if (!agent) {
      this.infoPane.replaceChildren(el('div', { class: 'pane-empty' }, 'no agent selected'));
      return;
    }
    const sessionId = agent.sessionId || null;
    const cwd       = agent.cwd       || '';
    const totalToks = this.latestTotalTokens != null ? this.latestTotalTokens : (agent.totalTokens != null ? agent.totalTokens : null);

    const copyValueBtn = (val: any, label: any) => {
      const btn = el('button', {
        class: 'info-copy',
        type: 'button',
        title: `Copy ${label}`,
        onclick: async () => {
          if (!val) return;
          const ok = await copyToClipboard(val);
          if (ok) {
            this.flashBtnLabel(btn, 'copied');
          }
        },
      }, 'copy');
      if (!val) btn.disabled = true;
      return btn;
    };

    const rows = [
      ['name',     agent.name || '·'],
      ['status',   agent.status || '·'],
      ['model',    agent.model || '·'],
      ['session',  sessionId || 'Pending handshake...', sessionId ? { copy: sessionId } : null],
      ['cwd',      cwd || '·',                          cwd       ? { copy: cwd       } : null],
      ['hostname', agent.hostname || '·'],
      ['version',  agent.agentVersion || '·'],
      ['agent id', agent.agentId || agent.id || '·'],
      ['instance', agent.agentInstanceId || '·'],
      ['created',  agent.createdAt || agent.created_at || '·'],
      ['lastSeen', agent.lastSeen || agent.last_seen || '·'],
      ['tokens',   totalToks != null ? String(totalToks) : '·'],
    ];

    const grid = el('div', { class: 'info-grid' });
    for (const row of rows) {
      const [k, v, copyOpt] = row;
      grid.appendChild(el('div', { class: 'info-k' }, k));
      if (copyOpt && copyOpt.copy) {
        grid.appendChild(el('div', { class: 'info-v info-v--with-copy' },
          el('span', { class: 'info-v-text' }, String(v)),
          copyValueBtn(copyOpt.copy, k),
        ));
      } else {
        grid.appendChild(el('div', { class: 'info-v' }, String(v)));
      }
    }

    // Resume on CLI block
    const resumeText = serializeResumeCommand({ sessionId, cwd });
    const resumeBody = el('pre', { class: 'info-resume-body' }, resumeText);
    const resumeBtn = el('button', {
      class: 'btn btn--ghost info-resume-copy',
      type: 'button',
      onclick: async () => {
        if (!sessionId) return;
        const ok = await copyToClipboard(resumeText);
        if (ok) {
          this.flashBtnLabel(resumeBtn, 'copied');
          this.showToast('resume command copied.', 'info');
        }
      },
    }, 'copy resume command');
    if (!sessionId) resumeBtn.disabled = true;

    const resume = el('div', { class: 'info-resume' },
      el('div', { class: 'info-resume-head' },
        el('span', { class: 'info-resume-title' }, 'Resume on CLI'),
        resumeBtn,
      ),
      resumeBody,
      !sessionId
        ? el('div', { class: 'info-resume-hint' }, 'Session ID not yet assigned. The button enables once the agent finishes its handshake.')
        : null,
    );

    const publishSection = this._buildPublishSection(sessionId);

    this.infoPane.replaceChildren(grid, resume, publishSection);
  }

  // Wraps `grok share <sessionId>` via POST /api/agents/:id/publish. The
  // button is disabled until the agent has a sessionId, mirroring the
  // resume block above. Result + warning text are rendered in-place.
  _buildPublishSection(sessionId: any) {
    const wrap = el('div', { class: 'info-publish' });
    const head = el('div', { class: 'info-publish-head' },
      el('span', { class: 'info-publish-title' }, 'Publish (share)'),
    );
    const warn = el('div', { class: 'info-publish-warn' },
      'This uploads the entire session (prompts, tool calls, assistant messages) to xAI.',
      ' Do not share if it contains secrets, credentials, or private code.',
    );

    const resultHost = el('div', { class: 'info-publish-result' });
    const publishBtn = el('button', {
      class: 'btn btn--ghost info-publish-btn',
      type: 'button',
      onclick: () => this._handlePublish(publishBtn, resultHost),
    }, 'publish session');
    if (!sessionId) {
      publishBtn.disabled = true;
      publishBtn.title = 'Session ID not yet assigned.';
    }
    head.appendChild(publishBtn);

    wrap.appendChild(head);
    wrap.appendChild(warn);
    if (!sessionId) {
      wrap.appendChild(el('div', { class: 'info-publish-hint' },
        'Available once the agent finishes its handshake and has a session id.'));
    }
    wrap.appendChild(resultHost);
    return wrap;
  }

  async _handlePublish(btn: any, resultHost: any) {
    if (!this.agentId || !btn) return;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'publishing...';
    resultHost.replaceChildren();
    try {
      const data: any = await api.share(this.agentId);
      const url = data && data.url;
      if (!url) throw new Error('server did not return a URL');
      const copyBtn = el('button', {
        class: 'info-copy',
        type: 'button',
        title: 'Copy share URL',
        onclick: async () => {
          const ok = await copyToClipboard(url);
          if (ok) {
            this.flashBtnLabel(copyBtn, 'copied');
            this.showToast('share URL copied.', 'info');
          }
        },
      }, 'copy');
      const link = el('a', {
        class: 'info-publish-url',
        href: url,
        target: '_blank',
        rel: 'noopener noreferrer',
      }, url);
      resultHost.appendChild(el('div', { class: 'info-publish-result-row' }, link, copyBtn));
    } catch (e: any) {
      resultHost.appendChild(el('div', { class: 'info-publish-error' },
        `publish failed: ${e && e.message ? e.message : String(e)}`));
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  async refreshHistory({ all = false, turns = 50 } = {}) {
    if (!this.agentId) return;
    this._historyAll = !!all;
    try {
      const hist: any = await api.history(this.agentId, { turns, all });
      const events: any[] = (hist && Array.isArray(hist.events)) ? hist.events : [];
      this.streamEl.replaceChildren();
      this.model.reset();
      this.thread.clear();
      this._seenEvents.reset();
      // If there are older turns we didn't load, show a banner at the top.
      const total = (hist && hist.totalTurns) || 0;
      const returned = (hist && hist.returnedTurns) || 0;
      if (!all && total > returned && returned > 0) {
        this.streamEl.appendChild(this._buildLoadEarlierBanner(total - returned));
      }
      this._isReplaying = true;
      try {
        for (const ev of events) {
          const name = ev.event || ev.type || ev.name;
          this._seenEvents.markSeen(ev.eventId);
          const data = ev.data || ev.payload || ev;
          if (!name) continue;
          // Stash event timestamp so bubble renders pick up the real time
          // rather than "now" during a history replay.
          const t = Date.parse(ev.at);
          if (Number.isFinite(t)) { this._lastEventTs = t; this._seenEvents.setCutoff(t); }
          this.handleEvent(name, data, { fromHistory: true });
        }
      } finally {
        this._isReplaying = false;
      }
      this._lastEventTs = null;
      // agent_status running/idle is live-only (never stored in history), so
      // tell the model the agent's current state. An interrupted turn whose
      // agent is no longer running is closed off instead of spinning forever.
      const st = this.currentAgent && this.currentAgent.status;
      if (st) this.handleEvent('agent_status', { status: st }, { fromHistory: true });
      // Scroll the stream to the bottom after a history load. Reset
      // auto-scroll: the user just opened the conversation, they want to be
      // at the latest message regardless of where the last session ended.
      this._autoScroll = true;
      if (this._jumpToLatestBtn) this._jumpToLatestBtn.hidden = true;
      requestAnimationFrame(() => {
        this.scrollToBottom({ force: true });
      });
    } catch (e) {
      // backend may not implement history yet
    }
  }

  _buildLoadEarlierBanner(missingCount: any) {
    const btn = el('button', {
      class: 'history-load-more-btn',
      type: 'button',
      onclick: async () => {
        btn.disabled = true;
        btn.textContent = 'loading...';
        await this.refreshHistory({ all: true });
      },
    }, `load all earlier turns (${missingCount} more)`);
    return el('div', { class: 'history-load-more' }, btn);
  }

  openStreamForCurrent() {
    if (!this.agentId) return;
    this._setConn('connected');
    this.stream = openStream(`/api/agents/${encodeURIComponent(this.agentId)}/stream`, {
      onOpen:  () => this._setConn('connected'),
      onError: () => this._setConn('reconnecting'),
      // The server resends its recent-event buffer on a fresh connect; skip
      // anything history already drew.
      onAny:   (name, data, ev) => {
        if (this._seenEvents.isDuplicate(ev && ev.lastEventId)) return;
        this.handleEvent(name, data);
      },
    });
  }

  closeStream() {
    if (this._connTimer) { clearTimeout(this._connTimer); this._connTimer = null; }
    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }
  }

  // EventSource drops and retries constantly on phones (app switches, sleep).
  // Only say "reconnecting" if the stream hasn't come back within 3s.
  _setConn(state: ConnState) {
    if (state === 'reconnecting') {
      if (this._connTimer || this._conn === 'reconnecting') return;
      this._connTimer = setTimeout(() => {
        this._connTimer = null;
        this._conn = 'reconnecting';
        this._renderStatus();
      }, 3000);
      return;
    }
    if (this._connTimer) { clearTimeout(this._connTimer); this._connTimer = null; }
    this._conn = state;
    this._renderStatus();
  }

  _activeTurnTools(): RunTool[] {
    const t = this.model.activeTurn();
    if (!t) return [];
    const out: RunTool[] = [];
    for (const s of t.segments) {
      if (s.type === 'run') for (const i of s.items) if (i.type === 'tool') out.push(i);
    }
    return out;
  }

  _renderStatus() {
    if (!this.statusBar) return;
    const running = this.model.isRunning() || this._agentStatus === 'running';
    const tools = running ? this._activeTurnTools() : [];
    let activity: string | null = null;
    if (running) {
      const busy = [...tools].reverse().find((t) => t.status === 'Running' || t.status === 'Pending');
      activity = busy ? busy.title : 'thinking';
      if (activity.length > 48) activity = `${activity.slice(0, 47)}…`;
    }
    this.statusBar.render({
      conn: this._conn,
      agentStatus: running ? 'running' : this._agentStatus,
      activity,
      toolsThisTurn: tools.length,
      bgRunning: this._bgRunning,
    });
    if (this.statusBar.isOpen()) this._renderStatusTools();
  }

  // "This turn" section of the status drop-down: one row per tool call.
  _renderStatusTools() {
    const tools = this._activeTurnTools();
    const glyph: Record<string, string> = { Completed: '✓', Failed: '✗', Canceled: '–', Running: '●', Pending: '●' };
    const rows = tools.map((t) => el('button', {
      type: 'button',
      class: `status-panel__row status-panel__row--${t.status.toLowerCase()}`,
      title: t.title,
      onclick: () => {
        this.statusBar.close();
        const run = this.model.runOf(t.toolCallId);
        if (run) this.thread.revealRun(run.id);
      },
    },
      el('span', { class: 'status-panel__glyph' }, glyph[t.status] || '●'),
      el('span', { class: 'status-panel__kind' }, t.kind),
      el('span', { class: 'status-panel__title' }, t.title),
    ));
    this.statusToolsEl.replaceChildren(
      el('div', { class: 'status-panel__label' },
        tools.length ? `this turn · ${tools.length} tool call${tools.length === 1 ? '' : 's'}` : 'no tool calls this turn'),
      ...rows,
    );
  }

  showToast(text: any, kind?: any) {
    const toast = renderToast(text, kind);
    this.toastHost.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast--out');
      setTimeout(() => toast.remove(), 250);
    }, 4200);
  }

  // ── turn machinery ───────────────────────────────────────────────────

  scrollToBottom(opts?: any) {
    // Stay pinned to the bottom only when the user hasn't scrolled away.
    // Force-scroll on explicit actions (sending a message, initial load).
    const force = !!(opts && opts.force);
    if (!force && this._autoScroll === false) return;

    // Force path: snap to bottom (preserves content-visibility scrollIntoView
    // fallback). Used for initial history load and explicit user actions like
    // the jump-to-latest button.
    if (force) {
      // Cancel any in-flight eased loop so it doesn't fight the snap.
      if (this._easedScrollRaf) {
        cancelAnimationFrame(this._easedScrollRaf);
        this._easedScrollRaf = 0;
      }
      if (this._scrollRaf) return;
      this._scrollRaf = requestAnimationFrame(() => {
        this._scrollRaf = 0;
        const doScroll = () => {
          // content-visibility: auto on .turn makes scrollHeight unreliable
          // until the browser has actually rendered the off-screen turns. Use
          // scrollIntoView on the last child when forcing; it triggers the
          // lazy layout for any sibling on the way and lands accurately at
          // the very bottom.
          const last = this.streamEl.lastElementChild;
          if (last && typeof last.scrollIntoView === 'function') {
            try {
              last.scrollIntoView({ block: 'end' });
              this._lastEasedWrite = this.streamEl.scrollTop;
              return;
            } catch { /* fall through */ }
          }
          this.streamEl.scrollTop = this.streamEl.scrollHeight;
          this._lastEasedWrite = this.streamEl.scrollTop;
        };
        doScroll();
        // Re-run once more after layout has settled so we land on the true
        // bottom even after content-visibility realizes the placeholders.
        requestAnimationFrame(() => {
          doScroll();
          // Reset the eased target so it doesn't immediately yank us back
          // up if the next streaming chunk references a stale target.
          this._easedScrollTarget = this.streamEl.scrollTop;
        });
      });
      return;
    }

    // Streaming path: eased follow toward the current bottom. Each call just
    // re-arms the target; the single rAF loop in _easedScrollTick handles the
    // animation and self-cancels when it lands within 1px of the target.
    this._scheduleEasedScroll();
  }

  // Mark the stream as wanting to chase the bottom. Starts the rAF loop if
  // not already running. Safe to call repeatedly per chunk arrival.
  _scheduleEasedScroll() {
    this._easedScrollPending = true;
    if (typeof document !== 'undefined' && document.hidden) {
      // rAF is throttled when the tab is hidden. Snap instead so when the
      // user comes back they're already at the bottom.
      this.streamEl.scrollTop = this.streamEl.scrollHeight;
      this._lastEasedWrite = this.streamEl.scrollTop;
      this._easedScrollPending = false;
      this._easedScrollTarget = this.streamEl.scrollTop;
      return;
    }
    if (this._easedScrollRaf) return;
    const tick = () => {
      this._easedScrollRaf = 0;
      // Bail if the user scrolled away or the view got torn down between
      // frames.
      if (!this.streamEl || !this.streamEl.isConnected) return;
      if (this._autoScroll === false) {
        this._easedScrollPending = false;
        return;
      }
      const el = this.streamEl;
      const target = Math.max(0, el.scrollHeight - el.clientHeight);
      this._easedScrollTarget = target;
      const current = el.scrollTop;
      const delta = target - current;
      if (Math.abs(delta) <= 1) {
        // Land exactly and stop the loop.
        el.scrollTop = target;
        this._lastEasedWrite = target;
        this._easedScrollPending = false;
        return;
      }
      // Ease ~0.22 per frame. At 60fps a 200px gap closes in ~10 frames.
      const next = current + delta * 0.22;
      el.scrollTop = next;
      this._lastEasedWrite = next;
      this._easedScrollRaf = requestAnimationFrame(tick);
    };
    this._easedScrollRaf = requestAnimationFrame(tick);
  }

  // A thought or tool run was opened or closed in place. Keep its header
  // where it is: if the bottom is now out of view, pause following and
  // offer "jump to latest" instead of yanking the view on the next chunk.
  _pauseFollowAfterExpand(_node: HTMLElement) {
    requestAnimationFrame(() => {
      const s = this.streamEl;
      const dist = s.scrollHeight - s.scrollTop - s.clientHeight;
      if (dist <= 60) return;
      this._autoScroll = false;
      if (this._easedScrollRaf) { cancelAnimationFrame(this._easedScrollRaf); this._easedScrollRaf = 0; }
      if (this._jumpToLatestBtn) this._jumpToLatestBtn.hidden = false;
    });
  }

  _initAutoScroll() {
    this._userScrollIntentAt = 0;
    this._autoScroll = true;
    const THRESHOLD = 60; // px from bottom counts as "at bottom"
    // Jump-to-latest button, hidden by default. Lives inside the stream so
    // it shows up above the composer without restructuring the layout.
    this._jumpToLatestBtn = el('button', {
      type: 'button',
      class: 'jump-to-latest',
      hidden: true,
      onclick: () => {
        this._autoScroll = true;
        this.scrollToBottom({ force: true });
        this._jumpToLatestBtn.hidden = true;
      },
    }, '↓ jump to latest');
    // Append once the user mounts. Defer to a microtask so the button lives
    // inside the conversation pane, not the stream itself.
    requestAnimationFrame(() => {
      const pane = this.streamEl.parentElement;
      if (pane && !pane.contains(this._jumpToLatestBtn)) {
        pane.appendChild(this._jumpToLatestBtn);
      }
    });
    // Track user-initiated scroll. We need to distinguish programmatic
    // eased-scroll writes from real user input; a manual flag set just
    // before each programmatic write would be racy across rAF boundaries,
    // so instead we compare against the most-recent eased target. If the
    // user is meaningfully off-target (more than the threshold), treat it
    // as a manual scroll-away.
    // Only real input (wheel, touch, keys, mouse) counts as the user scrolling.
    // Turns are lazily rendered (content-visibility), so their heights change
    // after we jump to the bottom; those layout shifts must not read as
    // "the user scrolled up".
    const markIntent = () => { this._userScrollIntentAt = Date.now(); };
    const intentEvents = ['wheel', 'touchstart', 'touchmove', 'mousedown'];
    for (const ev of intentEvents) this.streamEl.addEventListener(ev, markIntent, { passive: true });
    const onKey = (ev: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(ev.key)) markIntent();
    };
    window.addEventListener('keydown', onKey, { passive: true });
    const pinToBottom = () => {
      const s = this.streamEl;
      s.scrollTop = s.scrollHeight;
      this._lastEasedWrite = s.scrollTop;
      this._easedScrollTarget = s.scrollTop;
    };
    // While following, any size change in the thread (lazy turns realising,
    // a message growing) keeps the bottom pinned.
    const ro = new ResizeObserver(() => {
      if (this._autoScroll === false) return;
      const s = this.streamEl;
      if (s.scrollHeight - s.scrollTop - s.clientHeight > 1) pinToBottom();
    });
    const mo = new MutationObserver((muts) => {
      for (const m of muts) m.addedNodes.forEach((n) => { if (n instanceof Element) ro.observe(n); });
    });
    mo.observe(this.streamEl, { childList: true });

    const onScroll = () => {
      const el = this.streamEl;
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = dist <= THRESHOLD;
      if (!atBottom && this._autoScroll !== false && Date.now() - (this._userScrollIntentAt || 0) > 800) {
        // Layout moved under us, not the user: stay pinned.
        pinToBottom();
        return;
      }
      // While the eased loop is chasing the bottom, it writes scrollTop
      // mid-flight (still well above the bottom). Those writes raise
      // scroll events that look identical to user scroll-aways. Suppress
      // them by skipping when the eased loop is active AND we're moving
      // toward the bottom (not away).
      if (this._easedScrollRaf && !atBottom) {
        // Currently being pulled toward bottom by our own loop. Trust the
        // loop to keep going; only a clear "user moved further from
        // bottom than our last write" should pause auto-scroll.
        if (this._lastEasedWrite != null && el.scrollTop >= this._lastEasedWrite - 4) {
          return;
        }
      }
      if (atBottom && !this._autoScroll) {
        this._autoScroll = true;
        this._jumpToLatestBtn.hidden = true;
      } else if (!atBottom && this._autoScroll) {
        this._autoScroll = false;
        this._jumpToLatestBtn.hidden = false;
        // Stop chasing while the user is reading further up.
        if (this._easedScrollRaf) {
          cancelAnimationFrame(this._easedScrollRaf);
          this._easedScrollRaf = 0;
        }
      }
    };
    this.streamEl.addEventListener('scroll', onScroll, { passive: true });

    // rAF is throttled while the tab is hidden, so the eased loop stalls.
    // When the user comes back, snap both streams to their targets so they
    // start aligned for any further easing.
    const onVis = () => {
      if (document.hidden) return;
      if (this._autoScroll !== false) {
        this.streamEl.scrollTop = this.streamEl.scrollHeight;
        this._easedScrollTarget = this.streamEl.scrollTop;
        this._lastEasedWrite = this.streamEl.scrollTop;
      }
    };
    document.addEventListener('visibilitychange', onVis);

    this._detachAutoScroll = () => {
      this.streamEl.removeEventListener('scroll', onScroll);
      for (const ev of intentEvents) this.streamEl.removeEventListener(ev, markIntent);
      window.removeEventListener('keydown', onKey);
      ro.disconnect();
      mo.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      if (this._easedScrollRaf) { cancelAnimationFrame(this._easedScrollRaf); this._easedScrollRaf = 0; }
    };
  }

  // ── background terminals strip ───────────────────────────────────────

  _startBgTerminalsPolling() {
    if (this._bgTermsTimer) return;
    const tick = async () => {
      if (!this.agentId) return;
      if (document.hidden) return;
      try {
        const res: any = await api.terminals.list(this.agentId);
        const list = (res && Array.isArray(res.terminals)) ? res.terminals : [];
        this._renderBgTermsStrip(list);
      } catch { /* server may not implement the route yet */ }
    };
    tick();
    this._bgTermsTimer = setInterval(tick, 2000);
  }

  _stopBgTerminalsPolling() {
    if (this._bgTermsTimer) { clearInterval(this._bgTermsTimer); this._bgTermsTimer = null; }
    this._bgTermsByCard.clear();
    this.bgTermsStripEl.replaceChildren();
    this.bgTermsStripEl.hidden = true;
    this._closeBgTermViewer();
  }

  _renderBgTermsStrip(list: any) {
    // Active only by default. Exited entries hide; "view all (N)" link
    // opens the per-conversation viewer that shows the full list.
    const running = (list || []).filter((t: any) => !t.exited);
    const exitedCount = (list || []).length - running.length;
    if (this._bgRunning !== running.length) { this._bgRunning = running.length; this._renderStatus(); }
    if (!running.length && !exitedCount) {
      this.bgTermsStripEl.replaceChildren();
      this.bgTermsStripEl.hidden = true;
      return;
    }
    this.bgTermsStripEl.hidden = false;
    const seen = new Set();
    this.bgTermsStripEl.replaceChildren();
    this.bgTermsStripEl.appendChild(el('span', { class: 'bgterms-label' }, 'bg shells'));
    for (const t of running) {
      seen.add(t.id);
      const short = t.id.replace(/^term-/, '').slice(0, 6);
      const cmdShort = (t.command || '').length > 60 ? (t.command || '').slice(0, 57) + '...' : (t.command || '');
      const chip = el('button', {
        type: 'button',
        class: 'bgterms-chip bgterms-chip--running',
        title: `${t.command}\ncwd: ${t.cwd}\nrunning`,
        onclick: () => this._openBgTermViewer(t.id),
      },
        el('span', { class: 'bgterms-chip__dot' }),
        el('span', { class: 'bgterms-chip__id' }, short),
        el('span', { class: 'bgterms-chip__cmd' }, cmdShort || '(no command)'),
        el('span', { class: 'bgterms-chip__status' }, 'running'),
      );
      this.bgTermsStripEl.appendChild(chip);
      // If a local URL was detected for this dev server, render an
      // adjacent "Open App" link so the user can pop straight to it.
      if (t.url) {
        const link = el('a', {
          class: 'bgterms-open',
          href: t.url,
          target: '_blank',
          rel: 'noopener',
          title: `open ${t.url}`,
        });
        link.innerHTML = `<span class="bgterms-open__ico">${iconHtml('globe')}</span><span class="bgterms-open__label">Open App</span>`;
        this.bgTermsStripEl.appendChild(link);
      }
    }
    if (exitedCount > 0) {
      this.bgTermsStripEl.appendChild(el('button', {
        type: 'button',
        class: 'bgterms-more',
        title: `${exitedCount} exited task${exitedCount === 1 ? '' : 's'}; click to see all`,
        onclick: () => this._openBgListViewer(list),
      }, `view all (+${exitedCount} exited)`));
    } else if (running.length === 0) {
      // Nothing running but exited entries exist: show a tiny dim link.
      this.bgTermsStripEl.appendChild(el('button', {
        type: 'button',
        class: 'bgterms-more',
        onclick: () => this._openBgListViewer(list),
      }, `view all (${exitedCount} exited)`));
    }
    for (const tid of Array.from(this._bgTermsByCard.keys())) {
      if (!seen.has(tid)) this._bgTermsByCard.delete(tid);
    }
  }

  // Modal-style overlay listing every bg task (running + exited) for this
  // conversation. Read-only; clicking a row opens the live viewer.
  _openBgListViewer(initial: any) {
    if (this._bgListViewerEl) { this._bgListViewerEl.remove(); this._bgListViewerEl = null; }
    const overlay = el('div', { class: 'bgterm-viewer bgterm-list-viewer' });
    const closeBtn = el('button', { type: 'button', class: 'bgterm-viewer__close',
      onclick: () => { overlay.remove(); this._bgListViewerEl = null; },
    }, '×');
    overlay.appendChild(el('div', { class: 'bgterm-viewer__head' },
      el('div', { class: 'bgterm-viewer__title' }, 'all bg shells in this conversation'),
      closeBtn,
    ));
    const body = el('div', { class: 'bgterm-list-viewer__body' });
    overlay.appendChild(body);
    document.body.appendChild(overlay);
    this._bgListViewerEl = overlay;
    const render = (list: any) => {
      body.replaceChildren();
      if (!list.length) {
        body.appendChild(el('div', { class: 'bgterm-list-viewer__empty' }, 'no bg shells.'));
        return;
      }
      for (const t of list) {
        const code = t.exitStatus && (t.exitStatus.exitCode ?? t.exitStatus.signal);
        const row = el('button', {
          type: 'button',
          class: `bgterm-list-viewer__row ${t.exited ? 'bgterm-list-viewer__row--exited' : 'bgterm-list-viewer__row--running'}`,
          onclick: () => { overlay.remove(); this._bgListViewerEl = null; this._openBgTermViewer(t.id); },
        },
          el('span', { class: 'bgterm-list-viewer__status' }, t.exited ? `exit ${code ?? '?'}` : 'running'),
          el('span', { class: 'bgterm-list-viewer__id' }, t.id.replace(/^term-/, '').slice(0, 8)),
          el('span', { class: 'bgterm-list-viewer__cmd' }, t.command || '(no command)'),
        );
        body.appendChild(row);
      }
    };
    render(initial || []);
    // Keep the list refreshed while open.
    const timer = setInterval(async () => {
      if (!overlay.isConnected) { clearInterval(timer); return; }
      try {
        const r: any = await api.terminals.list(this.agentId);
        if (overlay.isConnected) render(r && r.terminals || []);
      } catch { /* ignore */ }
    }, 1500);
  }

  async _openBgTermViewer(tid: any) {
    // Modal-style overlay with output buffer. Polls every 1s while open.
    this._closeBgTermViewer();
    const overlay = el('div', { class: 'bgterm-viewer' });
    const closeBtn = el('button', {
      type: 'button', class: 'bgterm-viewer__close',
      onclick: () => this._closeBgTermViewer(),
    }, '×');
    const title = el('div', { class: 'bgterm-viewer__title' }, tid);
    const cmd   = el('div', { class: 'bgterm-viewer__cmd' }, '');
    const status= el('div', { class: 'bgterm-viewer__status' }, '');
    const pre   = el('pre', { class: 'bgterm-viewer__body' }, '');
    const killBtn = el('button', {
      type: 'button', class: 'bgterm-viewer__kill',
      onclick: async () => {
        killBtn.disabled = true;
        killBtn.textContent = 'killing...';
        try {
          await api.terminals.kill(this.agentId, tid);
          // Visible confirmation before the next poll arrives.
          killBtn.textContent = 'kill sent';
          status.textContent = 'killing (waiting for exit)';
          status.className = 'bgterm-viewer__status bgterm-viewer__status--killing';
        } catch (err: any) {
          killBtn.disabled = false;
          killBtn.textContent = 'kill failed; retry';
          status.textContent = `kill failed: ${err.message}`;
        }
      },
    }, 'kill');
    overlay.appendChild(el('div', { class: 'bgterm-viewer__head' }, title, status, killBtn, closeBtn));
    overlay.appendChild(cmd);
    overlay.appendChild(pre);
    document.body.appendChild(overlay);
    this._bgTermViewerEl = overlay;

    let openLink: any = null;
    const refresh = async () => {
      if (!this._bgTermViewerEl) return;
      try {
        const r: any = await api.terminals.read(this.agentId, tid);
        if (!this._bgTermViewerEl) return;
        cmd.textContent = r.command || '';
        const code = r.exitStatus && (r.exitStatus.exitCode ?? r.exitStatus.signal);
        // Don't clobber an in-flight "killing" state with a stale "running".
        if (status.className.indexOf('--killing') === -1 || r.exited) {
          status.textContent = r.exited ? `exited (${code ?? '?'})` : 'running';
          status.className = `bgterm-viewer__status ${r.exited ? 'bgterm-viewer__status--exited' : 'bgterm-viewer__status--running'}`;
        }
        const wasAtBottom = (pre.scrollTop + pre.clientHeight) >= (pre.scrollHeight - 12);
        pre.textContent = (r.truncated ? '[... older output trimmed ...]\n' : '') + (r.output || '');
        if (wasAtBottom) pre.scrollTop = pre.scrollHeight;
        if (r.exited) {
          killBtn.disabled = true;
          killBtn.textContent = 'killed';
        }
        // Surface the detected local URL once we know it. Mount/unmount
        // the link in-place so we don't re-create it every poll.
        if (r.url && !r.exited) {
          if (!openLink) {
            openLink = el('a', {
              class: 'bgterm-viewer__open',
              href: r.url,
              target: '_blank',
              rel: 'noopener',
              title: `open ${r.url}`,
            });
            openLink.innerHTML = `<span class="bgterm-viewer__open-ico">${iconHtml('globe')}</span><span class="bgterm-viewer__open-label">Open App</span>`;
            status.parentNode!.insertBefore(openLink, killBtn);
          }
          openLink.href = r.url;
          openLink.title = `open ${r.url}`;
        } else if (openLink) {
          openLink.remove();
          openLink = null;
        }
      } catch { /* ignore */ }
    };
    await refresh();
    this._bgTermViewerTimer = setInterval(refresh, 1000);
  }

  _closeBgTermViewer() {
    if (this._bgTermViewerTimer) { clearInterval(this._bgTermViewerTimer); this._bgTermViewerTimer = null; }
    if (this._bgTermViewerEl) { this._bgTermViewerEl.remove(); this._bgTermViewerEl = null; }
  }

  // ── event dispatch ──────────────────────────────────────────────────

  handleEvent(name: any, payload: any, opts?: any) {
    const data = unwrap(payload);
    // Side effects that aren't about drawing the thread.
    switch (name) {
      case 'available_commands_update': return this.onAvailableCommands(data);
      case 'handshake':                 return this.onHandshake(data);
      case 'session_notification':      return this.onSessionNotification(data);
      case 'prompt_complete':           this.onPromptComplete(data); break;
      case 'agent_status':              this.onAgentStatus(data); break;
      case 'tool_call_update':          this._notifyFilesChanged(data); break;
      default: break;
    }
    void opts;
    const ch = this.model.apply(name, payload, { ts: this._lastEventTs || Date.now() });
    const changed = ch.newTurn || ch.added.length || ch.updated.length || ch.removed.length;
    if (changed) {
      if (ch.newTurn) this._cancelChatIntro();
      this.thread.apply(ch, name, payload);
      if (name === 'user_message' || name === 'user_message_chunk') this._decorateNewUser(ch);
    }
    this._syncLiveLine();
    this._renderStatus();
    if (changed) this.scrollToBottom();
  }

  // Spinner row at the bottom while grok works and no tool run is showing
  // its own live caption. Skipped during history replay.
  _syncLiveLine() {
    if (this._isReplaying) return;
    const t = this.model.activeTurn();
    const last = t && t.segments[t.segments.length - 1];
    const runOpen = !!(last && last.type === 'run' && last.open);
    this.thread.liveLine(this.model.isRunning() && !runOpen ? 'Thinking…' : null);
  }

  _decorateNewUser(ch: any) {
    const segId = ch.added.find((id: string) => {
      const s = this.model.segment(id);
      return s && s.type === 'user';
    });
    if (!segId || !ch.turnId) return;
    const seg: any = this.model.segment(segId);
    const root = this.thread.turnRoot(ch.turnId);
    const user = this.thread.nodeOf(segId);
    if (root && user) this._decorateSkill({ userText: seg.text, root, user });
  }

  // If a file-mutating tool (Write / Edit / MultiEdit, all kind: 'edit')
  // just completed, ping the Files panel so it can re-list. Skipped while
  // replaying history because the disk is already in its final state.
  _notifyFilesChanged(data: any) {
    if (this._isReplaying || !this.agentId) return;
    const status = String((data && data.status) || '').toLowerCase();
    const kind   = String((data && data.kind)   || '').toLowerCase();
    if (status === 'completed' && kind === 'edit') {
      document.dispatchEvent(new CustomEvent('grok-remote:files-changed', {
        detail: { agentId: this.agentId, toolCallId: data.toolCallId },
      }));
    }
  }

  onAvailableCommands(data: any) {
    const list = (data && data.availableCommands) || data && data.commands || data;
    if (Array.isArray(list)) this.setAvailableCommands(list);
  }

  onHandshake(data: any) {
    // Agent-manager forwards { meta, agentCapabilities } as the SSE payload.
    const caps = data && (data.agentCapabilities || data.agent_capabilities);
    const pc = caps && caps.promptCapabilities;
    if (pc && typeof pc.image === 'boolean') {
      const before = !!this._promptCapImage;
      this._promptCapImage = !!pc.image;
      if (before !== this._promptCapImage) {
        this._syncAttachBtn();
        if (this.imageAttach) this.imageAttach.refreshSupport();
        // If the new model dropped image support, surface a clear warning.
        const atts = this.imageAttach ? this.imageAttach.getAttachments() : [];
        if (!this._promptCapImage && atts.length) {
          this.showToast('Active model no longer supports image input. Remove attachments to send.', 'warn');
        }
      }
    }
  }

  onPromptComplete(data: any) {
    const meta = (data && data._meta) || data || {};
    if (meta && (meta.totalTokens != null || meta.total_tokens != null)) {
      this.latestTotalTokens = meta.totalTokens ?? meta.total_tokens;
      this._renderTokensPill();
    this._renderInflightPill();
    }
    // Capture sessionId/cwd from prompt_complete meta if the agent record is
    // missing it (handshake metadata is sometimes delivered out of band).
    if (this.currentAgent) {
      if (meta.sessionId && !this.currentAgent.sessionId) {
        this.currentAgent.sessionId = meta.sessionId;
      }
      if (meta.modelId && !this.currentAgent.model) {
        this.currentAgent.model = meta.modelId;
      }
      // refresh the info pane if visible
      if (this.tabsState === 'info') this.renderInfo(this.currentAgent);
    }
    this.composerCancel.disabled = true;
  }

  onAgentStatus(data: any) {
    const status = data && (data.status || data.state);
    if (!status) return;
    this._agentStatus = status;
    this.composerCancel.disabled = status !== 'running';
    this._renderStatus();
  }

  onSessionNotification(data: any) {
    const text = (data && (data.message || data.text)) || JSON.stringify(data).slice(0, 200);
    this.showToast(text, 'info');
  }

  // ── composer actions ────────────────────────────────────────────────

  async send() {
    if (!this.agentId) return;
    const text = this.composerTa.value.trim();
    const attachments = this.imageAttach ? this.imageAttach.getAttachments() : [];
    if (!text && !attachments.length) return;

    // Snapshot the payload for the inspector before clearing the composer.
    this._lastPayload = this._buildPayloadSnapshot(text, attachments);
    this._lastServerEcho = null;

    this.composerTa.value = '';
    if (this.composerHint) {
      this.composerHint.classList.add('hidden');
      this.composerHint.textContent = '';
    }
    this.palette.classList.add('hidden');

    // Start a turn locally and let the SSE stream fill in the rest.
    // The user just sent a message; they want to see it land, so re-enable
    // auto-scroll regardless of where they were in the history.
    this._autoScroll = true;
    if (this._jumpToLatestBtn) this._jumpToLatestBtn.hidden = true;
    this.handleEvent('user_message', { text, attachments });
    this.scrollToBottom({ force: true });
    this.composerCancel.disabled = false;

    try {
      const resp = await api.prompt(this.agentId, { text, attachments });
      this._lastServerEcho = resp && typeof resp === 'object' ? resp : null;
      if (this.imageAttach) this.imageAttach.clear();
    } catch (e: any) {
      this.handleEvent('error', { message: e.message });
    }
  }

  _buildPayloadSnapshot(text: any, attachments: any) {
    // Build the same body shape api.prompt would send, so the inspector
    // shows the exact wire payload (base64 included).
    const safeAttachments = (attachments || []).map((a: any) => ({
      kind:       a.kind || 'image',
      name:       a.name || null,
      mimeType:   a.mimeType || null,
      size:       a.size || null,
      dataBase64: a.dataBase64 || '',
    }));
    const body: any = { text };
    if (safeAttachments.length) body.attachments = safeAttachments;
    return {
      method:  'POST',
      url:     `/api/agents/${this.agentId}/prompt`,
      body,
      sentAt:  new Date().toISOString(),
    };
  }

  openPayloadInspector() {
    // Build a "current draft" snapshot from the composer + attachments so
    // the inspector works both before send (preview) and after send (echo).
    const text = this.composerTa ? this.composerTa.value : '';
    const attachments = this.imageAttach ? this.imageAttach.getAttachments() : [];
    const draftPayload = (text.trim() || attachments.length)
      ? this._buildPayloadSnapshot(text.trim(), attachments)
      : null;

    if (this._payloadModal) {
      try { this._payloadModal.remove(); } catch { /* ignore */ }
      this._payloadModal = null;
    }

    const close = () => {
      if (this._payloadModal) {
        try { this._payloadModal.remove(); } catch { /* ignore */ }
        this._payloadModal = null;
      }
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (ev: any) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    const dumpBlock = (title: any, value: any, opts: any = {}) => {
      const pretty = value == null ? 'null' : JSON.stringify(value, null, 2);
      const view = pretty.length > 20000 && !opts.full
        ? this._truncateBase64(pretty)
        : pretty;
      const pre = el('pre', { class: 'payload-pre' }, view);
      const copyBtn = el('button', {
        class: 'btn btn--ghost payload-copy',
        type: 'button',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(pretty);
            this.showToast('payload copied', 'info');
          } catch (e: any) {
            this.showToast(`copy failed: ${e.message}`, 'warn');
          }
        },
      }, 'copy');
      return el('section', { class: 'payload-section' },
        el('header', { class: 'payload-section-head' },
          el('h3', null, title),
          copyBtn,
        ),
        pre,
      );
    };

    const sections = [];
    if (draftPayload) {
      sections.push(dumpBlock(
        'composer draft (would be sent on click)',
        draftPayload,
      ));
    }
    if (this._lastPayload) {
      sections.push(dumpBlock(
        'last sent request body',
        this._lastPayload,
      ));
    }
    if (this._lastServerEcho) {
      sections.push(dumpBlock(
        'server response (echoed back, after attachment processing)',
        this._lastServerEcho,
      ));
    }
    if (!sections.length) {
      sections.push(el('div', { class: 'payload-empty' },
        'No payload yet. Type or attach something, then click here to preview,',
        ' or send a message and reopen this panel to see the actual request.'));
    }

    const closeBtn = el('button', {
      class: 'btn btn--ghost payload-close',
      type: 'button',
      onclick: close,
    }, 'close');

    const modal = el('div', { class: 'payload-modal' },
      el('div', { class: 'payload-modal-backdrop', onclick: close }),
      el('div', { class: 'payload-modal-card' },
        el('header', { class: 'payload-modal-head' },
          el('h2', null, 'Outgoing prompt payload'),
          el('div', { class: 'payload-modal-hint' },
            'Base64 image data is truncated in the view; the copy button copies the FULL payload to your clipboard.'),
          closeBtn,
        ),
        el('div', { class: 'payload-modal-body' }, ...sections),
      ),
    );
    this._payloadModal = modal;
    document.body.appendChild(modal);
  }

  _truncateBase64(pretty: any) {
    // Replace long dataBase64 strings inline with a "<NNN bytes>" placeholder
    // so the panel stays readable. The copy button still copies the original.
    return pretty.replace(/"dataBase64": "([A-Za-z0-9+/=]{200,})"/g, (_m: any, b64: any) => {
      return `"dataBase64": "<base64, ${b64.length} chars; copied in full when you click copy>"`;
    });
  }

  async cancel() {
    if (!this.agentId) return;
    try {
      await api.cancel(this.agentId);
      this.showToast('cancel requested', 'warn');
    } catch (e: any) {
      this.showToast(`cancel failed: ${e.message}`, 'warn');
    }
  }

  // ── settings drawer ─────────────────────────────────────────────────

  toggleSettingsDrawer() {
    if (this.settingsDrawerOpen) this.closeSettingsDrawer();
    else this.openSettingsDrawer();
  }

  openSettingsDrawer() {
    if (!this.agentId) return;
    if (!this.settingsDrawer) this._buildSettingsDrawer();
    this._populateSettingsDrawer(this.currentAgent || {});
    this.settingsDrawer.classList.add('chat-settings-drawer--open');
    this.settingsDrawerOpen = true;
    // Fetch model suggestions lazily on first open. Best-effort.
    if (this._modelSuggestions == null) {
      this._modelSuggestions = [];
      api.systemModels.get()
        .then((r: any) => {
          const items = (r && Array.isArray(r.items)) ? r.items : [];
          this._modelSuggestions = items.map((i: any) => i.id).filter(Boolean);
          this._renderModelDatalist();
        })
        .catch(() => { /* leave list empty */ });
    } else {
      this._renderModelDatalist();
    }
  }

  closeSettingsDrawer() {
    if (!this.settingsDrawer) return;
    this.settingsDrawer.classList.remove('chat-settings-drawer--open');
    this.settingsDrawerOpen = false;
  }

  _buildSettingsDrawer() {
    // Each field is built once, then stitched into grouped sections. We keep
    // the .value plumbing in a flat `fields` map so save-time collection is
    // just a dictionary walk.
    const fields: any = {};

    // ---- field factory --------------------------------------------------
    const field = (key: any, labelText: any, input: any, hintText?: any) => {
      if (key) fields[key] = input;
      return el('div', { class: 'sd-field' },
        el('label', { class: 'sd-label' }, labelText),
        input,
        hintText ? el('div', { class: 'sd-hint' }, hintText) : null,
      );
    };
    const onDirty = (input: any) => {
      const evt = (input.tagName === 'SELECT' || input.type === 'checkbox') ? 'change' : 'input';
      input.addEventListener(evt, () => this._markSettingsDirty());
    };

    // ---- inputs ---------------------------------------------------------
    const nameInput = el('input', {
      class: 'sd-input',
      type: 'text',
      placeholder: 'optional agent name',
    });

    const modelInput = el('input', {
      class: 'sd-input',
      type: 'text',
      list: 'chat-settings-model-list',
      placeholder: 'e.g. grok-code-fast-1',
    });
    const reasoningSelect = el('select', { class: 'sd-input' },
      el('option', { value: '' }, 'default'),
      el('option', { value: 'none' }, 'none'),
      el('option', { value: 'minimal' }, 'minimal'),
      el('option', { value: 'low' }, 'low'),
      el('option', { value: 'medium' }, 'medium'),
      el('option', { value: 'high' }, 'high'),
      el('option', { value: 'xhigh' }, 'xhigh'),
    );

    const systemPromptTa = el('textarea', {
      class: 'sd-input sd-textarea sd-textarea--lg',
      rows: '5',
      placeholder: 'leave blank to keep default.',
    });
    const rulesTa = el('textarea', {
      class: 'sd-input sd-textarea sd-textarea--lg',
      rows: '5',
      placeholder: 'one rule per line.',
    });

    const toolsInput = el('input', {
      class: 'sd-input',
      type: 'text',
      placeholder: 'read_file,grep,list_dir',
    });
    const disallowedInput = el('input', {
      class: 'sd-input',
      type: 'text',
      placeholder: 'web_search,run_terminal_cmd',
    });

    const allowTa = el('textarea', {
      class: 'sd-input sd-textarea',
      rows: '4',
      placeholder: 'Bash(npm*)',
    });
    const denyTa = el('textarea', {
      class: 'sd-input sd-textarea',
      rows: '4',
      placeholder: 'Bash(rm*)',
    });

    const sandboxInput = el('input', {
      class: 'sd-input',
      type: 'text',
      placeholder: 'sandbox profile',
    });
    const worktreeInput = el('input', {
      class: 'sd-input',
      type: 'text',
      placeholder: 'worktree path or name',
    });
    fields.worktree = worktreeInput;

    const alwaysApproveCheckbox = el('input', {
      class: 'sd-checkbox',
      type: 'checkbox',
    });
    alwaysApproveCheckbox.checked = true;
    fields.alwaysApprove = alwaysApproveCheckbox;

    // Wire dirty tracking on every interactive control.
    for (const inp of [
      nameInput, modelInput, reasoningSelect, systemPromptTa, rulesTa,
      toolsInput, disallowedInput, allowTa, denyTa, sandboxInput,
      worktreeInput, alwaysApproveCheckbox,
    ]) onDirty(inp);

    const dataList = el('datalist', { id: 'chat-settings-model-list' });
    this._modelDatalist = dataList;

    // ---- buttons --------------------------------------------------------
    const saveBtn = el('button', {
      class: 'btn btn--primary sd-save',
      type: 'button',
      onclick: () => this._submitSettingsDrawer(),
    }, 'save');
    const resetBtn = el('button', {
      class: 'btn btn--ghost sd-reset',
      type: 'button',
      title: 'Clear all per-conversation settings (revert to defaults)',
      onclick: () => this._clearSettingsDrawer(),
    }, 'clear all');
    const closeBtn = el('button', {
      class: 'btn btn--ghost sd-close',
      type: 'button',
      onclick: () => this.closeSettingsDrawer(),
    }, 'cancel');

    const notice = el('div', { class: 'sd-notice hidden' });
    this._sdNotice = notice;
    const dirtyNotice = el('div', { class: 'sd-dirty hidden' },
      'unsaved changes. reconnect required for new flags to apply.');
    this._sdDirtyNotice = dirtyNotice;

    // ---- sections -------------------------------------------------------
    const section = (title: any, ...children: any[]) => el('section', { class: 'sd-section' },
      el('div', { class: 'sd-section-title' }, title),
      ...children,
    );

    const identitySection = section('Identity',
      field('name', 'Name', nameInput,
        'optional agent name (used in sidebar + tab title).'),
    );

    const modelSection = section('Model',
      el('div', { class: 'sd-grid' },
        field('model', 'Model', modelInput,
          'overrides the global default. blank = use default.'),
        field('reasoningEffort', 'Reasoning effort', reasoningSelect,
          'none | minimal | low | medium | high | xhigh.'),
      ),
      el('label', { class: 'sd-toggle' },
        alwaysApproveCheckbox,
        el('span', { class: 'sd-toggle-text' }, 'always approve tool calls'),
        el('span', { class: 'sd-toggle-hint' },
          'auto-approve every tool call (default on).'),
      ),
    );

    const promptSection = section('System prompt',
      field('systemPromptOverride', 'System prompt override', systemPromptTa,
        'replaces the agent system prompt entirely (leave blank to keep default).'),
      field('rules', 'Rules', rulesTa,
        'extra rules appended to the system prompt.'),
    );

    const toolsSection = section('Tools',
      el('div', { class: 'sd-grid' },
        field('tools', 'Allowed tools', toolsInput,
          'comma-separated allowed tools.'),
        field('disallowedTools', 'Disallowed tools', disallowedInput,
          'comma-separated blocked tools.'),
      ),
    );

    const permsSection = section('Permissions',
      el('div', { class: 'sd-grid' },
        field('allow', 'Allow', allowTa,
          'one rule per line, e.g. Bash(npm*).'),
        field('deny', 'Deny', denyTa,
          'one rule per line; deny wins over allow.'),
      ),
    );

    const envSection = section('Environment',
      el('div', { class: 'sd-grid' },
        field('sandbox', 'Sandbox profile', sandboxInput,
          'sandbox profile name.'),
        field(null, 'Worktree', worktreeInput,
          'spawn into an existing worktree dir (-w <path>).'),
      ),
    );

    const body = el('div', { class: 'sd-body' },
      identitySection,
      modelSection,
      promptSection,
      toolsSection,
      permsSection,
      envSection,
      dataList,
    );

    const head = el('header', { class: 'sd-head' },
      el('h3', { class: 'sd-title' }, 'Conversation settings'),
      el('div', { class: 'sd-sub' },
        'Per-conversation overrides for ', el('code', null, 'grok'),
        ' top-level flags. Applied the next time this agent (re)connects.'),
      notice,
    );

    const foot = el('footer', { class: 'sd-foot' },
      dirtyNotice,
      el('span', { class: 'sd-foot-spacer' }),
      resetBtn,
      closeBtn,
      saveBtn,
    );

    const card = el('aside', { class: 'chat-settings-drawer-card' }, head, body, foot);
    const backdrop = el('div', {
      class: 'chat-settings-drawer-backdrop',
      onclick: () => this.closeSettingsDrawer(),
    });
    const drawer = el('div', { class: 'chat-settings-drawer' }, backdrop, card);

    this._sdFields = fields;
    this._sdNameInput = nameInput;
    this.settingsDrawer = drawer;
    this.root.appendChild(drawer);
  }

  _renderModelDatalist() {
    if (!this._modelDatalist) return;
    this._modelDatalist.replaceChildren();
    for (const m of (this._modelSuggestions || [])) {
      this._modelDatalist.appendChild(el('option', { value: m }));
    }
  }

  _populateSettingsDrawer(agent: any) {
    if (!this._sdFields) return;
    const s = (agent && agent.settings) || {};
    const f = this._sdFields;
    if (this._sdNameInput) {
      this._sdNameInput.value = typeof (agent && agent.name) === 'string' ? agent.name : '';
    }
    f.model.value                = typeof s.model === 'string' ? s.model : '';
    f.reasoningEffort.value      = typeof s.reasoningEffort === 'string' ? s.reasoningEffort : '';
    f.systemPromptOverride.value = typeof s.systemPromptOverride === 'string' ? s.systemPromptOverride : '';
    f.rules.value                = typeof s.rules === 'string' ? s.rules : '';
    f.tools.value                = typeof s.tools === 'string' ? s.tools : '';
    f.disallowedTools.value      = typeof s.disallowedTools === 'string' ? s.disallowedTools : '';
    f.allow.value                = Array.isArray(s.allow) ? s.allow.join('\n') : '';
    f.deny.value                 = Array.isArray(s.deny)  ? s.deny.join('\n')  : '';
    f.sandbox.value              = typeof s.sandbox === 'string' ? s.sandbox : '';
    if (typeof s.worktree === 'string' && s.worktree.length) {
      f.worktree.value = s.worktree;
    } else {
      f.worktree.value = '';
    }
    // alwaysApprove defaults to true if not set.
    f.alwaysApprove.checked = !(s.alwaysApprove === false);

    // Reset the dirty flag now that the form mirrors the saved state.
    this._sdDirty = false;
    if (this._sdDirtyNotice) this._sdDirtyNotice.classList.add('hidden');

    // Live-connected agents need a reconnect before the new settings take
    // effect. Show a small banner explaining that. Mirrors the agent state
    // we track via the sidebar refresh event.
    this._updateSettingsNotice(agent);
  }

  _markSettingsDirty() {
    if (this._sdDirty) return;
    this._sdDirty = true;
    if (this._sdDirtyNotice) this._sdDirtyNotice.classList.remove('hidden');
  }

  _updateSettingsNotice(agent: any) {
    if (!this._sdNotice) return;
    const a = agent || this.currentAgent || {};
    const live = !!a.connected && a.status !== 'disconnected' && a.status !== 'exited';
    this._sdNotice.classList.toggle('hidden', !live);
    if (live) {
      this._sdNotice.textContent =
        'Agent is currently connected. Saved changes will apply the NEXT time it (re)connects.';
    } else {
      this._sdNotice.textContent = '';
    }
  }

  _collectSettings() {
    const f = this._sdFields;
    const linesToArr = (s: any) => String(s || '')
      .split('\n')
      .map((l: any) => l.trim())
      .filter(Boolean);
    const out: any = {
      model:                f.model.value.trim(),
      reasoningEffort:      f.reasoningEffort.value.trim(),
      systemPromptOverride: f.systemPromptOverride.value,
      rules:                f.rules.value,
      tools:                f.tools.value.trim(),
      disallowedTools:      f.disallowedTools.value.trim(),
      allow:                linesToArr(f.allow.value),
      deny:                 linesToArr(f.deny.value),
      sandbox:              f.sandbox.value.trim(),
      alwaysApprove:        !!f.alwaysApprove.checked,
    };
    const wn = (f.worktree.value || '').trim();
    out.worktree = wn ? wn : null;
    // Drop empty values so the saved payload stays minimal.
    for (const k of Object.keys(out)) {
      const v = out[k];
      if (v == null) { delete out[k]; continue; }
      if (typeof v === 'string' && v.length === 0) { delete out[k]; continue; }
      if (Array.isArray(v) && v.length === 0) { delete out[k]; continue; }
    }
    return out;
  }

  async _submitSettingsDrawer() {
    if (!this.agentId || !this._sdFields) return;
    const settings = this._collectSettings();
    const patch: any = { settings };
    if (this._sdNameInput) {
      const nv = this._sdNameInput.value.trim();
      const current = (this.currentAgent && this.currentAgent.name) || '';
      if (nv !== current) patch.name = nv;
    }
    const saveBtn = this.settingsDrawer && this.settingsDrawer.querySelector('.sd-save');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'saving...';
    }
    try {
      const updated = await api.updateAgent(this.agentId, patch);
      this.applyAgentRefresh(updated);
      this._sdDirty = false;
      if (this._sdDirtyNotice) this._sdDirtyNotice.classList.add('hidden');
      this.showToast('conversation settings saved.', 'info');
      this.closeSettingsDrawer();
    } catch (e: any) {
      this.showToast(`save failed: ${e && e.message ? e.message : String(e)}`, 'warn');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'save';
      }
    }
  }

  async _clearSettingsDrawer() {
    if (!this.agentId) return;
    try {
      const updated = await api.updateAgent(this.agentId, { settings: null });
      this.applyAgentRefresh(updated);
      this._populateSettingsDrawer(updated || {});
      this.showToast('per-conversation settings cleared.', 'info');
    } catch (e: any) {
      this.showToast(`clear failed: ${e && e.message ? e.message : String(e)}`, 'warn');
    }
  }
}

// `unwrap` lives in ../lib/acp-payload.ts so it's
// typed and unit-testable. Imported above.
