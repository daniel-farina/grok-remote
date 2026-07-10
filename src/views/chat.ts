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

import Split from 'split.js';
import { api } from '../lib/api';
import { openStream } from '../lib/sse';
import { mountFilesTab, unmountFilesTab } from './files';
import { mountTraceTab, unmountTraceTab } from './trace';
import { mountScoped as mountFlowTab, unmount as unmountFlowTab } from './system/flow';
import attachSlashPalette from '../lib/slash-palette';
import { setupImageAttach } from '../lib/attach-images';
import {
  el,
  renderUserBubble,
  renderAssistantBubble,
  renderThinkingPane,
  renderToolCard,
  renderTodoWriteCard,
  isTodoWriteToolCall,
  renderTokenFooter,
  renderCompactedPill,
  renderErrorBanner,
  renderToast,
} from '../lib/render';
import { unwrap, extractText } from '../lib/acp-payload.js';
import { copyToClipboard, serializeConversation, serializeResumeCommand } from '../lib/copy';
import { iconHtml } from '../lib/icons';
import { fmtTokens } from '../lib/format';
import { playIntro } from '../lib/intro-animation';
import { getToolsInChat, TOOLS_IN_CHAT_CHANGE } from '../lib/ui-prefs';

export class ChatView {
  static _toolsToggleWired: any;
  static _active: any;
  _activeTodoCard!: any;
  _autoScroll!: any;
  _autoScrollTools!: any;
  _bgListViewerEl!: any;
  _bgTermsByCard!: any;
  _bgTermsTimer!: any;
  _bgTermViewerEl!: any;
  _bgTermViewerTimer!: any;
  _chatIntroAbort!: any;
  _chatIntroEl!: any;
  _chatSplit!: any;
  _chatSplitBuild!: any;
  _chatSplitCollapsed!: any;
  _chatSplitLastSizes!: any;
  _convoSkills!: any;
  _detachAutoScroll!: any;
  _detachPalette!: any;
  _easedScrollPending!: any;
  _easedScrollRaf!: any;
  _easedScrollTarget!: any;
  _easedToolsRaf!: any;
  _easedToolsTarget!: any;
  _historyAll!: any;
  _inFlightMap!: any;
  _inFlightTimer!: any;
  _isReplaying!: any;
  _jumpToLatestBtn!: any;
  _knownSkills!: any;
  _lastEasedToolsWrite!: any;
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
  _onToolsInChatChange!: ((ev?: Event) => void) | null;
  _payloadModal!: any;
  _pendingTodoSeed!: any;
  _promptCapImage!: any;
  _scrollRaf!: any;
  _sdDirty!: any;
  _sdDirtyNotice!: any;
  _sdFields!: any;
  _sdNameInput!: any;
  _sdNotice!: any;
  _skillCommands!: any;
  _skillsPromise!: any;
  _splitFullscreenBtn!: any;
  _splitToggleBtn!: any;
  _toolsColFullscreen!: any;
  _toolsColTab!: any;
  _toolsFilesMounted!: any;
  _toolsTabBtns!: any;
  activeTurn!: any;
  agentId!: any;
  availableCommands!: any;
  bgTermsStripEl!: any;
  chatSplitEl!: any;
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
  inFlightStripEl!: any;
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
  toolsColEl!: any;
  toolsFilesPaneEl!: any;
  toolsStreamEl!: any;
  traceMounted!: any;
  tracePane!: any;
  turns!: any;

  constructor() {
    this.agentId = null;
    this.stream  = null;
    this.turns   = []; // each: { user, thinking, tools[], assistant, footer, root }
    this.activeTurn = null;
    this.availableCommands = [];
    this.tabsState = 'conversation';

    // Lazy cache of known skill names (set of strings). Populated on first
    // user message that starts with `/`. Drives the "invoked skill" banner
    // we drop above turns that hit a /name match.
    this._knownSkills = null;
    this._skillCommands = [];
    this._skillsPromise = null;

    this.streamEl  = el('div', { class: 'chat-stream' });
    this.toolsColEl = el('div', { class: 'chat-tools-col' });
    this.toolsStreamEl = el('div', { class: 'chat-tools-stream' });
    // Files preview panel that lives inside the tools column. Mounted
    // lazily when the user switches the in-column tab to "files".
    this.toolsFilesPaneEl = el('div', { class: 'chat-tools-files', hidden: true });
    this._toolsColTab = this._readToolsColTab();
    this._toolsColFullscreen = this._readToolsColFullscreen();
    this._toolsFilesMounted = false;
    this._buildToolsColHeader();
    this.composerEl = this.buildComposer();
    this.tabsEl    = this.buildTabs();
    this.statusEl  = el('div', { class: 'chat-status' });

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

    // Strip pinned above the chat stream that lists tool calls currently
    // in flight. Each chip shows kind + label + live duration; clicking
    // scrolls to that tool's pill in the conversation. Hidden when empty.
    this.inFlightStripEl = el('div', { class: 'inflight-strip', hidden: true });
    this._inFlightMap = new Map(); // toolCallId -> { kind, label, startedAt, chip }
    this._inFlightTimer = null;

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

    this.root = el('section', { class: 'chat' },
      this.tabsEl,
      el('div', { class: 'chat-body' },
        el('div', { class: 'pane pane--conversation' },
          this.statusEl,
          this.bgTermsStripEl,
          this.convoSkillsStripEl,
          this.inFlightStripEl,
          this.chatSplitEl = el('div', { class: 'chat-split' },
            this.streamEl,
            this.toolsColEl,
          ),
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
    // Split.js needs the panes to actually be in the DOM to read sizes,
    // so we init the inner chat split here, not in the constructor.
    // Tear down any previous instance first (mount is re-entrant when the
    // user navigates between routes).
    this._destroyChatSplit();
    this._initChatSplit();
    // External topbar button toggles tools panel via this event. Keep one
    // listener for the document lifetime by guarding with a flag.
    if (!ChatView._toolsToggleWired) {
      document.addEventListener('grok-remote:tools-toggle', () => {
        // Ask the active ChatView to toggle; we walk to the one mounted.
        // Simplest path: dispatch a DOM event from the toggle btn the
        // chat view already owns. Use a custom hook on the class.
        if (ChatView._active) ChatView._active._toggleToolsCol();
      });
      ChatView._toolsToggleWired = true;
    }
    ChatView._active = this;
    // Initial state push so the topbar button paints correctly right after
    // mount, before any user toggle happens.
    document.dispatchEvent(new CustomEvent('grok-remote:tools-state', {
      detail: { collapsed: !!this._chatSplitCollapsed },
    }));
    // Re-place tool cards when the tools-in-chat preference flips.
    if (!this._onToolsInChatChange) {
      this._onToolsInChatChange = () => {
        try { this._applyToolsInChatPlacement(); } catch { /* ignore */ }
      };
      window.addEventListener(TOOLS_IN_CHAT_CHANGE, this._onToolsInChatChange);
    }
    // Apply current placement in case history was rendered under a
    // different preference, or the viewport crossed the mobile breakpoint.
    try { this._applyToolsInChatPlacement(); } catch { /* ignore */ }
  }

  destroy() {
    this._destroyChatSplit();
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
    if (this._inFlightTimer) { try { clearInterval(this._inFlightTimer); } catch { /* ignore */ } this._inFlightTimer = null; }
    this._stopBgTerminalsPolling();
    if (this.imageAttach) { try { this.imageAttach.destroy(); } catch { /* ignore */ } this.imageAttach = null; }
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._onToolsInChatChange) {
      window.removeEventListener(TOOLS_IN_CHAT_CHANGE, this._onToolsInChatChange);
      this._onToolsInChatChange = null;
    }
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
    const text = serializeConversation(this.turns, { agent: this.currentAgent || { id: this.agentId } });
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
        // The Files singleton just moved into the top-bar pane; clear the
        // tools-column's stale shell so it doesn't look duplicated.
        if (this._toolsFilesMounted) {
          this._toolsFilesMounted = false;
          if (this.toolsFilesPaneEl) this.toolsFilesPaneEl.replaceChildren();
        }
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
    if (!this._isChatMobile() && !this._chatSplitCollapsed) {
      this._toggleToolsCol();
    }
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
    if (this.toolsStreamEl) this.toolsStreamEl.replaceChildren();
    this.turns = [];
    this.activeTurn = null;
    // Fire-and-forget skill cache warmup so the banner can paint as soon
    // as a /name message lands. Harmless if the agent has none.
    this._loadSkills();
    this.statusEl.textContent = '';
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
    // Tools-column files view shares the same singleton as the top-bar
    // Files tab. Unmount before remounting against the new agent.
    if (this._toolsFilesMounted) {
      unmountFilesTab();
      this._toolsFilesMounted = false;
      if (this.toolsFilesPaneEl) this.toolsFilesPaneEl.replaceChildren();
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
      if (this.toolsFilesPaneEl && this._toolsColTab === 'files') {
        this.toolsFilesPaneEl.replaceChildren(
          el('div', { class: 'pane-empty' }, 'no agent selected'),
        );
      }
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
      this._clearAllInFlight();
      this._activeTodoCard = null;
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

    // If the tools-column files tab is active, rebind it to the new agent's
    // files. _applyToolsColTab handles the unmount/mount via the shared
    // singleton.
    if (this._toolsColTab === 'files') {
      this._applyToolsColTab();
    }

    const agentIdAtCall = agent.id;
    this.refreshHistory()
      .catch((e) => this.showStatus(`history load failed: ${e.message}`, 'warn'))
      .finally(() => {
        // Only show the intro if the agent we loaded history for is still
        // the active one (the user may have switched mid-load), there are
        // no turns yet (brand new conversation), and no other intro is in
        // flight. We also gate on activeTurn being null so we don't paint
        // the intro on top of an SSE event that raced in.
        if (
          this.agentId === agentIdAtCall &&
          (!this.turns || this.turns.length === 0) &&
          !this.activeTurn &&
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
  // chunk lands (both flow through startTurn), or the user switches to
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
      if (this.toolsStreamEl) this.toolsStreamEl.replaceChildren();
      this.turns = [];
      this.activeTurn = null;
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
          const data = ev.data || ev.payload || ev;
          if (!name) continue;
          // Stash event timestamp so bubble renders pick up the real time
          // rather than "now" during a history replay.
          const t = Date.parse(ev.at);
          if (Number.isFinite(t)) this._lastEventTs = t;
          this.handleEvent(name, data, { fromHistory: true });
        }
      } finally {
        this._isReplaying = false;
      }
      this._lastEventTs = null;
      // History replay may end with an unterminated turn (interrupted session,
      // or a prompt_complete that never made it to disk). Walk every turn and
      // finalize any thinking pane that is still in its active/blinking state
      // so the dots stop animating. Then close out the final active turn so
      // the assistant bubble is finalized too.
      for (const turn of this.turns) {
        if (turn.thinking && typeof turn.thinking.finalize === 'function') {
          turn.thinking.finalize();
        }
      }
      if (this.activeTurn) this.endTurn(null);
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
    this.showStatus('connecting...', 'idle');
    this.stream = openStream(`/api/agents/${encodeURIComponent(this.agentId)}/stream`, {
      onOpen:  () => this.showStatus('connected', 'ok'),
      onError: () => this.showStatus('stream error · reconnecting', 'warn'),
      onAny:   (name, data) => this.handleEvent(name, data),
    });
  }

  closeStream() {
    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }
  }

  showStatus(text: any, kind?: any) {
    this.statusEl.replaceChildren(
      el('span', { class: `status-pill status-pill--${kind || 'idle'}` }, '·'),
      el('span', { class: 'chat-status-text' }, text),
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

  ensureTurn() {
    if (this.activeTurn) return this.activeTurn;
    return this.startTurn('', { ts: this._lastEventTs || Date.now() });
  }

  startTurn(userText: any, opts?: any) {
    // A turn is about to land in the stream. Cancel the welcome animation
    // if it's still running so the figlet doesn't overlap the new bubble.
    this._cancelChatIntro();
    const ts = (opts && opts.ts) || Date.now();
    const attachments = Array.isArray(opts && opts.attachments) ? opts.attachments : [];
    const text = (typeof userText === 'string') ? userText : (userText == null ? '' : String(userText));
    // ensureTurn() used to call startTurn('') when the first assistant/tool
    // chunk arrived before a user_message (or when user_message was dropped
    // by the SSE client). That rendered a blank "you" bubble — the "ghost
    // messages" bug. Only mount a user bubble when there is actual content.
    const hasUserContent = !!(text && text.length) || attachments.length > 0;
    const userBubble = hasUserContent
      ? renderUserBubble(text, ts, { attachments, agentId: this.agentId })
      : null;
    // Only animate fresh insertions, never historical replay (that would
    // produce a chaotic shimmer across all replayed turns).
    const animate = !this._isReplaying && !(opts && opts.fromHistory);
    const classes = animate ? 'turn turn--enter' : 'turn';
    const root = el('div', { class: classes });
    if (userBubble) root.appendChild(userBubble);
    this.streamEl.appendChild(root);
    const turn = {
      user:      userBubble,
      userText:  text,
      userAttachments: attachments,
      thinking:  null,
      tools:     [],
      assistant: null,
      footer:    null,
      root,
    };
    this.turns.push(turn);
    this.activeTurn = turn;
    // Decorate retroactively once the skill set is loaded. Idempotent.
    this._decorateSkill(turn);
    this.scrollToBottom();
    return turn;
  }

  /**
   * If ensureTurn() already opened an empty shell for early assistant/tool
   * chunks, fill that shell's user bubble instead of starting a second turn
   * when user_message finally arrives (or is recovered).
   */
  _fillEmptyUserTurn(text: any, attachments: any, opts?: any) {
    const turn = this.activeTurn;
    if (!turn) return false;
    const hasExisting = !!(turn.userText && turn.userText.length)
      || (Array.isArray(turn.userAttachments) && turn.userAttachments.length > 0);
    if (hasExisting) return false;
    const t = (typeof text === 'string') ? text : (text == null ? '' : String(text));
    const atts = Array.isArray(attachments) ? attachments : [];
    if (!t && !atts.length) return false;
    const ts = (opts && opts.ts) || this._lastEventTs || Date.now();
    const userBubble = renderUserBubble(t, ts, {
      attachments: atts,
      agentId: this.agentId,
    });
    turn.user = userBubble;
    turn.userText = t;
    turn.userAttachments = atts;
    // User bubble belongs at the top of the turn, before thinking/tools/assistant.
    turn.root.insertBefore(userBubble, turn.root.firstChild);
    this._decorateSkill(turn);
    this.scrollToBottom();
    return true;
  }

  endTurn(meta: any) {
    if (!this.activeTurn) return;
    if (this.activeTurn.thinking) this.activeTurn.thinking.finalize();
    if (this.activeTurn.assistant) this.activeTurn.assistant.finalize();
    const footer = renderTokenFooter(meta || {});
    this.activeTurn.root.appendChild(footer);
    this.activeTurn.footer = footer;
    this.activeTurn = null;
    this.composerCancel.disabled = true;
    this.scrollToBottom();
  }

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

  // Eased follow for the tools column. Mirrors scrollToBottom() above but
  // for this.toolsStreamEl. Cheaper because the tools column doesn't use
  // content-visibility so scrollHeight is always accurate.
  _scrollToolsToBottom(opts?: any) {
    if (!this.toolsStreamEl) return;
    const force = !!(opts && opts.force);
    if (!force && this._autoScrollTools === false) return;
    if (force) {
      this.toolsStreamEl.scrollTop = this.toolsStreamEl.scrollHeight;
      this._lastEasedToolsWrite = this.toolsStreamEl.scrollTop;
      this._easedToolsTarget = this.toolsStreamEl.scrollTop;
      return;
    }
    if (typeof document !== 'undefined' && document.hidden) {
      this.toolsStreamEl.scrollTop = this.toolsStreamEl.scrollHeight;
      this._lastEasedToolsWrite = this.toolsStreamEl.scrollTop;
      this._easedToolsTarget = this.toolsStreamEl.scrollTop;
      return;
    }
    if (this._easedToolsRaf) return;
    const tick = () => {
      this._easedToolsRaf = 0;
      if (!this.toolsStreamEl || !this.toolsStreamEl.isConnected) return;
      if (this._autoScrollTools === false) return;
      const el = this.toolsStreamEl;
      const target = Math.max(0, el.scrollHeight - el.clientHeight);
      this._easedToolsTarget = target;
      const current = el.scrollTop;
      const delta = target - current;
      if (Math.abs(delta) <= 1) {
        el.scrollTop = target;
        this._lastEasedToolsWrite = target;
        return;
      }
      const next = current + delta * 0.22;
      el.scrollTop = next;
      this._lastEasedToolsWrite = next;
      this._easedToolsRaf = requestAnimationFrame(tick);
    };
    this._easedToolsRaf = requestAnimationFrame(tick);
  }

  // Build the header for the tools column. The header has two segmented
  // tab buttons (tools/files), a spacer, then a full-screen toggle and the
  // existing collapse toggle. The actual Split.js instance is created in
  // _initChatSplit() from mount(), after the elements are in the DOM.
  _buildToolsColHeader() {
    const mkTab = (key: any, label: any, iconName: any) => el('button', {
      type: 'button',
      class: `chat-tools-tab${this._toolsColTab === key ? ' chat-tools-tab--active' : ''}`,
      'data-tab': key,
      title: label,
      onclick: () => this._setToolsColTab(key),
    },
      el('span', { class: 'chat-tools-tab__ico', innerHTML: iconHtml(iconName) }),
      el('span', { class: 'chat-tools-tab__lbl' }, label),
    );

    this._toolsTabBtns = {
      tools: mkTab('tools', 'tool calls', 'wrench'),
      files: mkTab('files', 'files',      'folder'),
    };

    const fullscreen = el('button', {
      type: 'button',
      class: 'chat-tools-col__icon-btn chat-tools-col__fullscreen',
      title: this._toolsColFullscreen ? 'restore tools panel' : 'expand tools panel',
      onclick: () => this._toggleToolsFullscreen(),
    });
    fullscreen.innerHTML = iconHtml(this._toolsColFullscreen ? 'minimize-2' : 'maximize-2');
    this._splitFullscreenBtn = fullscreen;

    // The collapse-tools control lives on the topbar (right-hand panel
    // icon) and is the single source of truth. We intentionally do NOT
    // duplicate it in the column header. _splitToggleBtn is kept on the
    // instance so other code paths that toggle its `hidden` state on
    // mobile still work without a null check.
    this._splitToggleBtn = null;

    const header = el('div', { class: 'chat-tools-col__head' },
      el('div', { class: 'chat-tools-col__tabs' },
        this._toolsTabBtns.tools,
        this._toolsTabBtns.files,
      ),
      el('span', { class: 'chat-tools-col__spacer' }),
      fullscreen,
    );

    this.toolsColEl.replaceChildren(header, this.toolsStreamEl, this.toolsFilesPaneEl);
    this._applyToolsColTab();
  }

  static get CHAT_TOOLS_TAB_KEY()        { return 'grok-remote.split.chat.tab'; }
  static get CHAT_TOOLS_FULLSCREEN_KEY() { return 'grok-remote.split.chat.fullscreen'; }

  _readToolsColTab() {
    try {
      const v = localStorage.getItem(ChatView.CHAT_TOOLS_TAB_KEY);
      if (v === 'files' || v === 'tools') return v;
    } catch { /* ignore */ }
    return 'tools';
  }

  _readToolsColFullscreen() {
    try { return localStorage.getItem(ChatView.CHAT_TOOLS_FULLSCREEN_KEY) === '1'; }
    catch { return false; }
  }

  _setToolsColTab(key: any) {
    if (key !== 'tools' && key !== 'files') return;
    if (this._toolsColTab === key) return;
    this._toolsColTab = key;
    try { localStorage.setItem(ChatView.CHAT_TOOLS_TAB_KEY, key); } catch { /* ignore */ }
    this._applyToolsColTab();
    // Apply this tab's remembered width to the live Split.js instance.
    // Skipped when the panel is collapsed (split is destroyed) or
    // fullscreen (sizes are irrelevant), or on mobile (no split). The
    // cached _chatSplitLastSizes is kept in sync so the next expand
    // picks up the right width.
    if (this._chatSplit && !this._chatSplitCollapsed && !this._toolsColFullscreen
        && !this._isChatMobile()) {
      const sizes = this._readChatSplitSizesForTab(key);
      try { this._chatSplit.setSizes(sizes); } catch { /* ignore */ }
      this._chatSplitLastSizes = sizes;
    } else {
      // Even when we can't apply now, keep the cached "last sizes" in
      // sync so the next expand or fullscreen-restore uses the right
      // width for the now-active tab.
      this._chatSplitLastSizes = this._readChatSplitSizesForTab(key);
    }
  }

  _applyToolsColTab() {
    const key = this._toolsColTab;
    if (this._toolsTabBtns) {
      for (const [k, btn] of Object.entries(this._toolsTabBtns)) {
        (btn as any).classList.toggle('chat-tools-tab--active', k === key);
      }
    }
    if (this.toolsStreamEl)    this.toolsStreamEl.hidden    = key !== 'tools';
    if (this.toolsFilesPaneEl) this.toolsFilesPaneEl.hidden = key !== 'files';
    if (key === 'files') {
      // Reuse the same Files component as the top-bar Files tab. mountFilesTab
      // is a module-singleton that unmounts any prior mount first, so calling
      // it here transfers ownership of the file viewer into the tools column.
      // The top-bar Files pane will appear empty until the user switches back.
      if (this.agentId) {
        mountFilesTab(this.toolsFilesPaneEl, { id: this.agentId });
        this._toolsFilesMounted = true;
        this.filesMounted = false;
      } else {
        this.toolsFilesPaneEl.replaceChildren(
          el('div', { class: 'pane-empty' }, 'no agent selected'),
        );
      }
    } else if (this._toolsFilesMounted) {
      unmountFilesTab();
      this._toolsFilesMounted = false;
      this.toolsFilesPaneEl.replaceChildren();
    }
  }

  _toggleToolsFullscreen() {
    // Mobile: stacked layout, fullscreen has no meaning since there is no
    // side-by-side split.
    if (this._isChatMobile()) return;
    // Going fullscreen on a collapsed split: expand first so the user has
    // something to look at. Otherwise toggling fullscreen on a collapsed
    // column would have no visible effect.
    if (!this._toolsColFullscreen && this._chatSplitCollapsed) {
      this._toggleToolsCol();
    }
    this._toolsColFullscreen = !this._toolsColFullscreen;
    try {
      localStorage.setItem(
        ChatView.CHAT_TOOLS_FULLSCREEN_KEY,
        this._toolsColFullscreen ? '1' : '0',
      );
    } catch { /* ignore */ }
    this._applyToolsFullscreenClass();
    if (this._splitFullscreenBtn) {
      this._splitFullscreenBtn.innerHTML = iconHtml(
        this._toolsColFullscreen ? 'minimize-2' : 'maximize-2',
      );
      this._splitFullscreenBtn.title = this._toolsColFullscreen
        ? 'restore tools panel'
        : 'expand tools panel';
    }
  }

  _applyToolsFullscreenClass() {
    if (!this.chatSplitEl) return;
    this.chatSplitEl.classList.toggle(
      'chat-split--tools-fullscreen',
      !!this._toolsColFullscreen,
    );
  }

  // Persisted state keys for the inner chat split. Sizes are stored
  // per-tab so the user's preferred Files width can differ from their
  // preferred Tools width (Files defaults to half, Tools to ~30%).
  static get CHAT_SPLIT_SIZES_KEY()     { return 'grok-remote.split.chat'; }
  static get CHAT_SPLIT_COLLAPSED_KEY() { return 'grok-remote.split.chat.collapsed'; }
  static get CHAT_SPLIT_DEFAULT_SIZES() {
    return { tools: [70, 30], files: [50, 50] };
  }
  static get CHAT_SPLIT_MOBILE_MAX()    { return 720; }

  _isValidSizesArray(a: any) {
    return Array.isArray(a) && a.length === 2 &&
      a.every((n: any) => typeof n === 'number' && isFinite(n) && n >= 0 && n <= 100);
  }

  _readAllChatSplitSizes() {
    const defaults = ChatView.CHAT_SPLIT_DEFAULT_SIZES;
    try {
      const raw = localStorage.getItem(ChatView.CHAT_SPLIT_SIZES_KEY);
      if (!raw) return { ...defaults };
      const parsed = JSON.parse(raw);
      // Legacy format: a bare [a, b] from before per-tab sizes existed.
      // Treat it as the Tools tab's prior preference; keep the new Files
      // default unless the user has already customized it.
      if (this._isValidSizesArray(parsed)) {
        return { ...defaults, tools: parsed };
      }
      if (parsed && typeof parsed === 'object') {
        const out = { ...defaults };
        if (this._isValidSizesArray(parsed.tools)) out.tools = parsed.tools;
        if (this._isValidSizesArray(parsed.files)) out.files = parsed.files;
        return out;
      }
    } catch { /* ignore */ }
    return { ...defaults };
  }

  _readChatSplitSizesForTab(tab: any) {
    const all: any = this._readAllChatSplitSizes();
    return (all[tab] || all.tools).slice();
  }

  _writeChatSplitSizesForTab(tab: any, sizes: any) {
    if (!this._isValidSizesArray(sizes)) return;
    const all: any = this._readAllChatSplitSizes();
    all[tab] = sizes;
    try { localStorage.setItem(ChatView.CHAT_SPLIT_SIZES_KEY, JSON.stringify(all)); }
    catch { /* ignore */ }
  }

  _isChatMobile() {
    return window.innerWidth <= ChatView.CHAT_SPLIT_MOBILE_MAX;
  }

  _initChatSplit() {
    if (this._chatSplit) return;
    // Mobile: don't init Split.js. The tools column is hidden (see
    // .chat-split @media block) and tool cards render inline in the
    // conversation stream via _ensureToolsGroup. Mark collapsed so the
    // topbar tools toggle (if shown) reflects reality.
    if (this._isChatMobile()) {
      if (this._splitToggleBtn) this._splitToggleBtn.hidden = true;
      this._chatSplitCollapsed = true;
      this._applyChatSplitCollapsedClass();
      return;
    }
    if (this._splitToggleBtn) this._splitToggleBtn.hidden = false;

    let collapsed = false;
    try { collapsed = localStorage.getItem(ChatView.CHAT_SPLIT_COLLAPSED_KEY) === '1'; } catch { /* ignore */ }
    // Seed the cached "last sizes" from the currently active tab so an
    // expand-after-collapse comes back to the right width for that tab.
    this._chatSplitLastSizes = this._readChatSplitSizesForTab(this._toolsColTab);

    const buildSplit = (sizes: any) => {
      this._chatSplit = Split([this.streamEl, this.toolsColEl], {
        sizes,
        minSize: [400, 240],
        gutterSize: 6,
        snapOffset: 0,
        expandToMin: true,
        direction: 'horizontal',
        elementStyle: (dim, size, gutterSize) => ({
          'flex-basis': `calc(${size}% - ${gutterSize}px)`,
        }),
        gutterStyle: (dim, gutterSize) => ({ 'flex-basis': `${gutterSize}px` }),
        onDragEnd: (next) => {
          // Persist under the tab that is active at the moment of the
          // drag. Users get a remembered width per tab without any
          // explicit "save" step.
          this._chatSplitLastSizes = next;
          this._writeChatSplitSizesForTab(this._toolsColTab, next);
        },
      });
    };

    this._chatSplitCollapsed = collapsed;
    this._applyChatSplitCollapsedClass();
    this._applyToolsFullscreenClass();
    this._updateToolsToggleLabel();
    if (!collapsed) buildSplit(this._chatSplitLastSizes);
    this._chatSplitBuild = buildSplit;
  }

  _destroyChatSplit() {
    if (this._chatSplit) {
      // No args: Split.js clears its inline flex-basis from both panes
      // (and removes the gutter). Preserving inline styles would leave
      // the chat-stream stuck at its dragged width even after the
      // tools column collapses, which fights the CSS rule that
      // reclaims the freed space.
      try { this._chatSplit.destroy(); } catch { /* ignore */ }
      this._chatSplit = null;
    }
  }

  _applyChatSplitCollapsedClass() {
    if (!this.chatSplitEl) return;
    this.chatSplitEl.classList.toggle('chat-split--tools-collapsed', !!this._chatSplitCollapsed);
    // Notify the topbar so its right-side panel icon can reflect state.
    document.dispatchEvent(new CustomEvent('grok-remote:tools-state', {
      detail: { collapsed: !!this._chatSplitCollapsed },
    }));
  }

  _updateToolsToggleLabel() {
    if (!this._splitToggleBtn) return;
    const c = !!this._chatSplitCollapsed;
    this._splitToggleBtn.textContent = c ? '⟨' : '⟩';
    this._splitToggleBtn.title = c ? 'expand tools panel' : 'collapse tools panel';
  }

  _toggleToolsCol() {
    // Mobile: stacked layout, no Split.js, no-op.
    if (this._isChatMobile()) return;
    const next = !this._chatSplitCollapsed;
    this._chatSplitCollapsed = next;
    try { localStorage.setItem(ChatView.CHAT_SPLIT_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
    if (next) {
      this._destroyChatSplit();
    } else if (this._chatSplitBuild) {
      this._chatSplitBuild(this._chatSplitLastSizes);
    }
    this._applyChatSplitCollapsedClass();
    this._updateToolsToggleLabel();
  }

  /** Whether tool cards should live inline in the conversation stream. */
  _wantsToolsInline() {
    return getToolsInChat(this._isChatMobile());
  }

  _ensureToolsGroup(turn: any) {
    if (turn._toolsGroup) return turn._toolsGroup;
    const inline = this._wantsToolsInline();
    // Side-panel groups get a short user-text snippet so you can map tools
    // back to the turn. Inline groups sit under the user bubble already.
    const snippet = (turn.userText || '').trim();
    const short = (!inline && snippet)
      ? (snippet.length > 80 ? snippet.slice(0, 78) + '...' : snippet)
      : '';
    const group = el('div', { class: 'tools-group' },
      short ? el('div', { class: 'tools-group__head', title: snippet }, short) : null,
    );
    turn._toolsGroup = group;
    this._placeToolsGroup(turn, group, inline);
    return group;
  }

  _placeToolsGroup(turn: any, group: any, inline: boolean) {
    if (inline && turn.root) {
      const before = (turn.assistant && turn.assistant.node
        && turn.assistant.node.parentNode === turn.root)
        ? turn.assistant.node
        : null;
      if (before) turn.root.insertBefore(group, before);
      else turn.root.appendChild(group);
      return;
    }
    if (this.toolsStreamEl) this.toolsStreamEl.appendChild(group);
  }

  /** Re-home every existing tools group after the tools-in-chat pref changes. */
  _applyToolsInChatPlacement() {
    const inline = this._wantsToolsInline();
    if (!inline && this.toolsStreamEl) {
      // Preserve turn order in the side panel.
      for (const turn of this.turns || []) {
        if (turn && turn._toolsGroup) this.toolsStreamEl.appendChild(turn._toolsGroup);
      }
      return;
    }
    for (const turn of this.turns || []) {
      if (!turn || !turn._toolsGroup) continue;
      this._placeToolsGroup(turn, turn._toolsGroup, true);
    }
  }

  _initAutoScroll() {
    this._autoScroll = true;
    this._autoScrollTools = true;
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
    const onScroll = () => {
      const el = this.streamEl;
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = dist <= THRESHOLD;
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

    // Same listener for the tools column. No jump-to-latest button there;
    // we just pause the eased follow when the user scrolls up.
    const onToolsScroll = () => {
      const el = this.toolsStreamEl;
      if (!el) return;
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = dist <= THRESHOLD;
      if (this._easedToolsRaf && !atBottom) {
        if (this._lastEasedToolsWrite != null && el.scrollTop >= this._lastEasedToolsWrite - 4) {
          return;
        }
      }
      if (atBottom && !this._autoScrollTools) {
        this._autoScrollTools = true;
      } else if (!atBottom && this._autoScrollTools) {
        this._autoScrollTools = false;
        if (this._easedToolsRaf) {
          cancelAnimationFrame(this._easedToolsRaf);
          this._easedToolsRaf = 0;
        }
      }
    };
    if (this.toolsStreamEl) {
      this.toolsStreamEl.addEventListener('scroll', onToolsScroll, { passive: true });
    }

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
      if (this._autoScrollTools !== false && this.toolsStreamEl) {
        this.toolsStreamEl.scrollTop = this.toolsStreamEl.scrollHeight;
        this._easedToolsTarget = this.toolsStreamEl.scrollTop;
        this._lastEasedToolsWrite = this.toolsStreamEl.scrollTop;
      }
    };
    document.addEventListener('visibilitychange', onVis);

    this._detachAutoScroll = () => {
      this.streamEl.removeEventListener('scroll', onScroll);
      if (this.toolsStreamEl) this.toolsStreamEl.removeEventListener('scroll', onToolsScroll);
      document.removeEventListener('visibilitychange', onVis);
      if (this._easedScrollRaf) { cancelAnimationFrame(this._easedScrollRaf); this._easedScrollRaf = 0; }
      if (this._easedToolsRaf)  { cancelAnimationFrame(this._easedToolsRaf);  this._easedToolsRaf  = 0; }
    };
  }

  // ── in-flight strip ──────────────────────────────────────────────────

  _addInFlight(data: any, cardNode: any) {
    if (!data || !data.toolCallId) return;
    if (this._inFlightMap.has(data.toolCallId)) return;
    const label = (data.rawInput && (data.rawInput.command || data.rawInput.path || data.rawInput.file_path || data.rawInput.url))
                || data.title
                || data.kind
                || 'tool';
    const kind = data.kind || 'tool';
    const startedAt = Date.now();
    const chip = el('button', {
      type: 'button',
      class: 'inflight-chip',
      title: `${kind} · ${label}`,
      onclick: () => {
        // Scroll the card into view and pulse it briefly so the user can
        // confirm which one in the stream it maps to.
        if (cardNode && cardNode.scrollIntoView) {
          cardNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
          cardNode.classList.add('tool-pill--highlight');
          setTimeout(() => cardNode.classList.remove('tool-pill--highlight'), 1200);
        }
      },
    },
      el('span', { class: 'inflight-chip__dot' }),
      el('span', { class: 'inflight-chip__kind' }, kind),
      el('span', { class: 'inflight-chip__label' }, String(label)),
      el('span', { class: 'inflight-chip__dur' }, '0s'),
    );
    this._inFlightMap.set(data.toolCallId, { kind, label, startedAt, chip });
    this.inFlightStripEl.appendChild(chip);
    this._syncInFlightVisibility();
    this._startInFlightTicker();
  }

  _removeInFlight(toolCallId: any) {
    const entry = this._inFlightMap.get(toolCallId);
    if (!entry) return;
    entry.chip.remove();
    this._inFlightMap.delete(toolCallId);
    this._syncInFlightVisibility();
    if (this._inFlightMap.size === 0 && this._inFlightTimer) {
      clearInterval(this._inFlightTimer);
      this._inFlightTimer = null;
    }
  }

  _clearAllInFlight() {
    this._inFlightMap.clear();
    this.inFlightStripEl.replaceChildren();
    this._syncInFlightVisibility();
    if (this._inFlightTimer) {
      clearInterval(this._inFlightTimer);
      this._inFlightTimer = null;
    }
  }

  _syncInFlightVisibility() {
    this.inFlightStripEl.hidden = this._inFlightMap.size === 0;
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

  _startInFlightTicker() {
    if (this._inFlightTimer) return;
    this._inFlightTimer = setInterval(() => {
      const now = Date.now();
      for (const entry of this._inFlightMap.values()) {
        const ms = now - entry.startedAt;
        const durEl = entry.chip.querySelector('.inflight-chip__dur');
        if (!durEl) continue;
        if (ms < 1000) durEl.textContent = `${Math.round(ms)}ms`;
        else if (ms < 60000) durEl.textContent = `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
        else {
          const m = Math.floor(ms / 60000);
          const s = Math.round((ms % 60000) / 1000);
          durEl.textContent = `${m}m${s ? ` ${s}s` : ''}`;
        }
      }
      // Self-heal: walk the rendered pills and drop any stale chip whose
      // card has reached terminal status without us having seen the event.
      this._resyncInFlightStrip();
    }, 500);
  }

  // ── event dispatch ──────────────────────────────────────────────────

  handleEvent(name: any, payload: any, opts?: any) {
    const data = unwrap(payload);
    switch (name) {
      case 'user_message':              return this.onUserMessage(data, opts);
      case 'agent_message_chunk':       return this.onMessageChunk(data, opts);
      case 'agent_thought_chunk':       return this.onThoughtChunk(data, opts);
      case 'tool_call':                 return this.onToolCall(data, opts);
      case 'tool_call_update':          return this.onToolCallUpdate(data, opts);
      case 'tool_call_delta_chunk':     return this.onToolCallDelta(data);
      case 'available_commands_update': return this.onAvailableCommands(data);
      case 'handshake':                 return this.onHandshake(data);
      case 'session_summary_generated': return this.onSessionSummary(data);
      case 'prompt_complete':           return this.onPromptComplete(data);
      case 'agent_status':              return this.onAgentStatus(data);
      case 'session_notification':      return this.onSessionNotification(data);
      case 'error':                     return this.onError(data);
      default: return;
    }
  }

  onUserMessage(data: any, opts?: any) {
    // Prefer the explicit text field the server puts on user_message events.
    // Fall back to extractText for odd envelope shapes from history replay.
    let text = (data && typeof data.text === 'string') ? data.text : extractText(data);
    if (text == null) text = '';
    const attachments = Array.isArray(data && data.attachments) ? data.attachments : [];
    if (!text && !attachments.length) return;

    // Late fill: ensureTurn() may have opened an empty shell when the first
    // assistant/tool chunk beat user_message over SSE (or when an older
    // client dropped user_message entirely). Prefer filling that shell.
    if (this._fillEmptyUserTurn(text, attachments, {
      ts: this._lastEventTs || Date.now(),
      fromHistory: !!(opts && opts.fromHistory),
    })) {
      return;
    }

    // Dedup: the live send() path calls startTurn(text) BEFORE the server
    // echoes user_message back over SSE. If the active turn already has the
    // same userText and no assistant/tools yet, the bubble is already there.
    if (
      this.activeTurn &&
      (this.activeTurn.userText === text ||
        ((this.activeTurn.userAttachments || []).length && attachments.length)) &&
      !this.activeTurn.assistant &&
      (!this.activeTurn.tools || !this.activeTurn.tools.length)
    ) {
      return;
    }
    this.startTurn(text, {
      ts: this._lastEventTs || Date.now(),
      fromHistory: !!(opts && opts.fromHistory),
      attachments,
    });
  }

  onMessageChunk(data: any, opts?: any) {
    const text = extractText(data);
    if (text == null) return;
    const turn = this.ensureTurn();
    const fresh = !turn.assistant;
    if (fresh) {
      turn.assistant = renderAssistantBubble(this._lastEventTs || Date.now());
      // Mark the assistant bubble for entrance animation only on first
      // insertion in the live path (skip during history replay).
      if (!this._isReplaying && !(opts && opts.fromHistory)) {
        turn.assistant.node.classList.add('msg--enter');
      }
      turn.root.appendChild(turn.assistant.node);
    }
    turn.assistant.append(text);
    this.scrollToBottom();
  }

  onThoughtChunk(data: any, opts?: any) {
    const text = extractText(data);
    if (text == null) return;
    const turn = this.ensureTurn();
    if (!turn.thinking) {
      turn.thinking = renderThinkingPane();
      turn.root.appendChild(turn.thinking.node);
    }
    turn.thinking.append(text);
    this.scrollToBottom();
  }

  // Coalesce TodoWrite tool calls so a checklist evolves in place
  // instead of stacking a new pill per merge=true patch. Returns true
  // when the call was absorbed (caller should NOT also create a pill).
  //
  // Rules:
  //   - rawInput.merge === false (or no prior active card) → start a
  //     fresh card. Falls through to the normal pill path; we just stash
  //     the reference so later merges can find it.
  //   - rawInput.merge === true and we have an active card → patch the
  //     existing card and stop. No new pill, no strip chip.
  _maybeRouteTodoToolCall(data: any, opts?: any) {
    if (!isTodoWriteToolCall(data)) return false;
    const ri = data.rawInput || {};
    const isMerge = !!ri.merge;

    // Merge update with an active todo card already: absorb in place.
    if (isMerge && this._activeTodoCard && typeof this._activeTodoCard.ingestExternal === 'function') {
      this._activeTodoCard.ingestExternal(data);
      return true;
    }

    // grok often emits the initial tool_call event WITHOUT rawInput,
    // then fills it in on a subsequent tool_call_update. By that point
    // we've already created a regular card. Swap it for a todo card
    // in place so the user sees the checklist, not raw JSON.
    const turn = this.activeTurn || this.turns[this.turns.length - 1];
    if (turn && data.toolCallId) {
      const entry = turn.tools.find((t: any) => t.id === data.toolCallId);
      if (entry && entry.card && !entry.card.isTodo) {
        const next = renderTodoWriteCard(data);
        if (entry.card.node && entry.card.node.parentNode) {
          entry.card.node.parentNode.replaceChild(next.node, entry.card.node);
        }
        entry.card = next;
        this._activeTodoCard = next;
        // Drop any in-flight chip the old regular card had registered;
        // todo cards don't participate in the strip.
        try { this._removeInFlight(data.toolCallId); } catch { /* ignore */ }
        return true;
      }
      // An existing todo card with the same id getting a non-merge
      // update: just re-ingest. Covers the rare case of grok re-seeding
      // the list mid-conversation.
      if (entry && entry.card && entry.card.isTodo) {
        entry.card.applyUpdate(data);
        this._activeTodoCard = entry.card;
        return true;
      }
    }

    // No existing entry: let the normal creation path run and tag the
    // resulting card as the active todo (renderToolCard will dispatch
    // to renderTodoWriteCard when rawInput.variant is present).
    this._pendingTodoSeed = true;
    return false;
  }

  onToolCall(data: any, opts?: any) {
    // TodoWrite tool calls coalesce into a single live-updating card
    // (see _maybeRouteTodoToolCall). Subsequent calls with merge=true
    // are absorbed by the previous card instead of producing siblings.
    if (this._maybeRouteTodoToolCall(data, opts)) return;

    const turn = this.ensureTurn();
    const card = renderToolCard(data);
    turn.tools.push({ id: data.toolCallId, card });
    const live = !this._isReplaying && !(opts && opts.fromHistory);
    if (live) card.node.classList.add('tool-pill--enter');
    this._ensureToolsGroup(turn).appendChild(card.node);
    this._scrollToolsToBottom();
    // Add to the in-flight strip unless this came from history replay
    // (those calls are already terminal and would just flash). Skip
    // entirely for todo cards: they aren't interesting work in flight.
    if (live && !card.isTodo) {
      this._addInFlight(data, card.node);
    }
    if (this._pendingTodoSeed) {
      this._activeTodoCard = card;
      this._pendingTodoSeed = false;
    }
    this.scrollToBottom();
  }

  onToolCallUpdate(data: any, opts?: any) {
    if (this._maybeRouteTodoToolCall(data, opts)) return;

    const turn = this.activeTurn || this.turns[this.turns.length - 1];
    if (!turn) return;
    let entry = turn.tools.find((t: any) => t.id === data.toolCallId);
    if (entry) {
      entry.card.applyUpdate(data);
    } else {
      // server might emit an update before we ever saw a tool_call. create one.
      const card = renderToolCard(data);
      turn.tools.push({ id: data.toolCallId, card });
      const live = !this._isReplaying && !(opts && opts.fromHistory);
      if (live) card.node.classList.add('tool-pill--enter');
      this._ensureToolsGroup(turn).appendChild(card.node);
      this._scrollToolsToBottom();
      if (live && !card.isTodo) this._addInFlight(data, card.node);
      if (this._pendingTodoSeed) {
        this._activeTodoCard = card;
        this._pendingTodoSeed = false;
      }
      entry = turn.tools[turn.tools.length - 1];
    }
    // Always reconcile the strip against the actual pill statuses. This is
    // robust to wire-format variations: whatever rendered the pill as
    // COMPLETED also drains its chip from the strip.
    this._resyncInFlightStrip();

    // If a file-mutating tool (Write / Edit / MultiEdit, all kind: 'edit')
    // just completed, ping the Files panel so it can re-list. Skipped while
    // replaying history because the disk is already in its final state and
    // a flurry of refreshes during catch-up wastes IO. The event carries
    // the agent id so the listener can ignore updates from a stale mount.
    if (!this._isReplaying && this.agentId) {
      const status = String((data && data.status) || '').toLowerCase();
      const kind   = String((data && data.kind)   || '').toLowerCase();
      if (status === 'completed' && kind === 'edit') {
        document.dispatchEvent(new CustomEvent('grok-remote:files-changed', {
          detail: { agentId: this.agentId, toolCallId: data.toolCallId },
        }));
      }
    }
  }

  // Walk the current turn's tools and drop any strip chips whose card has
  // reached a terminal status. Cheap (small N) and self-healing if an
  // intermediate event was missed.
  _resyncInFlightStrip() {
    if (!this._inFlightMap.size) return;
    const TERMINAL = new Set(['completed','failed','canceled','cancelled','success','succeeded','error','errored']);
    // Collect all currently-rendered tool ids across all turns since strip
    // chips can outlive a single turn boundary.
    const liveByActive = new Map(); // id -> status string (lowercased)
    for (const turn of this.turns) {
      for (const t of (turn.tools || [])) {
        const s = (t.card && t.card.getStatus && t.card.getStatus() || '').toLowerCase();
        liveByActive.set(t.id, s);
      }
    }
    for (const tid of Array.from(this._inFlightMap.keys())) {
      const s = liveByActive.get(tid);
      // Gone from any turn (shouldn't happen, but defensive) or terminal: drop.
      if (s == null || TERMINAL.has(s)) {
        this._removeInFlight(tid);
      }
    }
  }

  onToolCallDelta(data: any) {
    const turn = this.activeTurn || this.turns[this.turns.length - 1];
    if (!turn || !turn.tools.length) return;
    // append to most-recent open tool card
    let target = null;
    for (let i = turn.tools.length - 1; i >= 0; i--) {
      const status = turn.tools[i].card.getStatus();
      if (status !== 'completed' && status !== 'failed') { target = turn.tools[i]; break; }
    }
    if (!target) target = turn.tools[turn.tools.length - 1];
    if (data && data.toolCallId) {
      const exact = turn.tools.find((t: any) => t.id === data.toolCallId);
      if (exact) target = exact;
    }
    target.card.appendDelta(data);
    this.scrollToBottom();
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

  onSessionSummary(data: any) {
    const text = (data && (data.summary || data.text)) || '';
    const pill = renderCompactedPill(text);
    this.streamEl.appendChild(pill);
    this.scrollToBottom();
  }

  onPromptComplete(data: any) {
    const meta = (data && data._meta) || data || {};
    if (meta && (meta.totalTokens != null || meta.total_tokens != null)) {
      this.latestTotalTokens = meta.totalTokens ?? meta.total_tokens;
      this._renderTokensPill();
    this._renderInflightPill();
    }
    // The turn is done; any tools that didn't get a terminal update were
    // implicitly completed (or aborted). Clear the strip so it doesn't
    // show ghost activity between turns.
    this._clearAllInFlight();
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
    this.endTurn(meta);
  }

  onAgentStatus(data: any) {
    const status = data && (data.status || data.state);
    if (!status) return;
    if (status === 'running') {
      this.showStatus('agent is running', 'warn');
      this.composerCancel.disabled = false;
    } else if (status === 'idle') {
      this.showStatus('idle', 'ok');
      this.composerCancel.disabled = true;
    } else if (status === 'errored') {
      this.showStatus('errored', 'fail');
    } else if (status === 'killed') {
      this.showStatus('killed', 'fail');
    } else {
      this.showStatus(status, 'idle');
    }
  }

  onSessionNotification(data: any) {
    const text = (data && (data.message || data.text)) || JSON.stringify(data).slice(0, 200);
    this.showToast(text, 'info');
  }

  onError(data: any) {
    const text = (data && (data.message || data.error)) || (typeof data === 'string' ? data : JSON.stringify(data));
    const turn = this.activeTurn || this.ensureTurn();
    turn.root.appendChild(renderErrorBanner(text));
    this.scrollToBottom();
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
    this.startTurn(text, { attachments });
    this.scrollToBottom({ force: true });
    this.composerCancel.disabled = false;

    try {
      const resp = await api.prompt(this.agentId, { text, attachments });
      this._lastServerEcho = resp && typeof resp === 'object' ? resp : null;
      if (this.imageAttach) this.imageAttach.clear();
    } catch (e: any) {
      this.activeTurn && this.activeTurn.root.appendChild(renderErrorBanner(e.message));
      this.endTurn(null);
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

// `unwrap` and `extractText` moved to ../lib/acp-payload.ts so they're
// typed + unit-testable. Imported above.
