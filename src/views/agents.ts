// Agents sidebar: list + new + star + archive + folders.
//
// Rows are intentionally compact: status dot + star + name + archive close. The
// model badge, connect/disconnect link, and cwd path were moved off the row
// (cwd is meant to land in the chat topbar; see CHAT_TOPBAR_TODO.md). Folders
// are persisted server-side via /api/folders. Drag/drop uses Pointer Events so
// the same code path works on desktop and touch.

import { api } from '../lib/api.js';
import { el } from '../lib/render.js';
import { fmtTokens } from '../lib/format.js';
import { computeSelection } from './agents-selection.js';

const STATUS_LABEL: Record<string, string> = {
  idle:         'idle',
  running:      'running',
  errored:      'errored',
  killed:       'killed',
  starting:     'starting',
  disconnected: 'disconnected',
  exited:       'disconnected',
};

const SORT_KEY        = 'grok-remote.sidebar.sort';
const SEARCH_KEY      = 'grok-remote.sidebar.search';
const COLLAPSED_KEY   = 'grok-remote.sidebar.collapsed-folders';
const SORT_DEFAULT    = 'created_desc';
// Touch needs a long-press because vertical drag is reserved for scrolling.
// Mouse/pen activate drag immediately past a small horizontal move threshold.
const LONG_PRESS_MS    = 450;
const MOUSE_DRAG_THRESH = 6;
const TOUCH_MOVE_THRESH = 8;
// A pointerup within this window with no movement counts as a plain click.
const CLICK_MAX_MS = 250;

interface SortConfig { label: string; cmp(a: Agent, b: Agent): number }

const SORTS: Record<string, SortConfig> = {
  created_desc:    { label: 'newest first',     cmp: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') },
  created_asc:     { label: 'oldest first',     cmp: (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') },
  activity_desc:   { label: 'last active',      cmp: (a, b) => (b.lastSeen   || '').localeCompare(a.lastSeen   || '') },
  name_asc:        { label: 'name (a -> z)',    cmp: (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }) },
};

function loadSort(): string { try { const v = localStorage.getItem(SORT_KEY); return v && SORTS[v] ? v : SORT_DEFAULT; } catch { return SORT_DEFAULT; } }
function saveSort(v: string): void { try { localStorage.setItem(SORT_KEY, v); } catch { /* ignore */ } }
function loadSearch(): string { try { return localStorage.getItem(SEARCH_KEY) || ''; } catch { return ''; } }
function saveSearch(v: string): void { try { localStorage.setItem(SEARCH_KEY, v); } catch { /* ignore */ } }
function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch { return new Set(); }
}
function saveCollapsed(set: Set<string>): void {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(set))); } catch { /* ignore */ }
}

export interface Agent {
  id: string;
  name?: string;
  model?: string;
  status?: string;
  cwd?: string;
  createdAt?: string;
  lastSeen?: string;
  starred?: boolean;
  archived?: boolean;
  totalTokens?: number;
  inFlight?: number;
  [k: string]: unknown;
}

export interface Folder {
  id: string;
  name: string;
  agentIds: string[];
  createdAt: string;
  // System folders ("Archived") can't be deleted or renamed.
  system?: boolean;
}

const ARCHIVED_FOLDER_ID = 'archived';

export interface AgentsSidebarOptions {
  onSelect?: (id: string) => void;
  onCreate?: (created: Agent) => void;
  onDelete?: (id: string) => void;
}

const TOP_LEVEL_ID = '__top__';

export class AgentsSidebar {
  onSelect?: (id: string) => void;
  onCreate?: (created: Agent) => void;
  onDelete?: (id: string) => void;

  agents: Agent[];
  folders: Folder[];
  selectedId: string | null;
  // Multi-selection (Ctrl/Cmd-click + Shift-click) is independent of selectedId,
  // which still tracks the currently-open conversation.
  multiSelection: Set<string>;
  selectionAnchor: string | null;
  pollHandle: ReturnType<typeof setInterval> | null;
  sortKey: string;
  search: string;
  collapsed: Set<string>;

  activeList: HTMLElement;
  multiSelectFooter: HTMLElement;
  multiSelectLabel: HTMLElement;
  empty: HTMLElement;
  noMatch: HTMLElement;
  error: HTMLElement;
  newBtn: HTMLButtonElement;
  newFolderBtn: HTMLButtonElement;
  closeDrawerBtn: HTMLButtonElement;
  searchInput: HTMLInputElement;
  searchClearBtn: HTMLButtonElement;
  sortSelect: HTMLSelectElement;
  root: HTMLElement;

  private _creating?: boolean;
  private _spawnHandlerWired?: boolean;
  private _agentsStream?: EventSource | null;
  private _sseAlive?: boolean;
  private _onVisibility?: () => void;

  // Drag state (pointer-events based).
  private _drag: {
    agentId: string;
    pointerId: number;
    pointerType: string;
    startX: number;
    startY: number;
    startTime: number;
    sourceEl: HTMLElement;
    ghost: HTMLElement | null;
    active: boolean;
    captured: boolean;
    pressTimer: number | null;
    moved: boolean;
  } | null = null;

  private _ctxMenu: HTMLElement | null = null;
  private _ctxCleanup: (() => void) | null = null;

  constructor({ onSelect, onCreate, onDelete }: AgentsSidebarOptions) {
    this.onSelect = onSelect;
    this.onCreate = onCreate;
    this.onDelete = onDelete;
    this.agents = [];
    this.folders = [];
    this.selectedId = null;
    this.multiSelection = new Set();
    this.selectionAnchor = null;
    this.pollHandle = null;
    this.sortKey = loadSort();
    this.search  = loadSearch();
    this.collapsed = loadCollapsed();

    this.activeList = el('div', { class: 'agents-list' }) as HTMLElement;
    // Drop-target highlight should clear if the user drags out of the list.
    this.activeList.addEventListener('pointerleave', () => {
      this.activeList.querySelectorAll('.folder-header--drop').forEach((n) =>
        n.classList.remove('folder-header--drop'),
      );
    });

    this.empty = el('div', { class: 'agents-empty' }, 'no agents yet') as HTMLElement;
    this.noMatch = el('div', { class: 'agents-empty' }, 'no conversations match your search') as HTMLElement;
    this.error = el('div', { class: 'agents-empty agents-empty--err' }) as HTMLElement;
    this.error.hidden = true;

    this.newBtn = el('button', {
      class: 'agents-new-btn',
      title: 'spawn a new agent (auto-named from the first message)',
      onclick: () => void this.spawnNew(),
    }, '+ new') as HTMLButtonElement;

    this.newFolderBtn = el('button', {
      class: 'agents-new-folder-btn',
      type: 'button',
      title: 'create a new folder',
      onclick: () => void this.promptNewFolder(),
    }, '+ folder') as HTMLButtonElement;

    this.closeDrawerBtn = el('button', {
      class: 'sidebar-close',
      type: 'button',
      title: 'close menu',
      'aria-label': 'close menu',
      onclick: () => document.dispatchEvent(new CustomEvent('grok-remote:close-drawer')),
    }, '×') as HTMLButtonElement;

    this.searchInput = el('input', {
      class: 'sidebar-search-input',
      type: 'search',
      placeholder: 'search conversations',
      value: this.search,
      'aria-label': 'search conversations',
      oninput: (ev: Event) => {
        const target = ev.target as HTMLInputElement;
        this.search = (target.value || '').trim();
        saveSearch(this.search);
        this.renderList();
      },
    }) as HTMLInputElement;
    this.searchClearBtn = el('button', {
      class: 'sidebar-search-clear',
      type: 'button',
      title: 'clear search',
      'aria-label': 'clear search',
      onclick: () => {
        this.search = '';
        this.searchInput.value = '';
        saveSearch('');
        this.renderList();
        this.searchInput.focus();
      },
    }, '×') as HTMLButtonElement;

    this.sortSelect = el('select', {
      class: 'sidebar-sort',
      'aria-label': 'sort conversations',
      onchange: (ev: Event) => {
        const target = ev.target as HTMLSelectElement;
        this.sortKey = target.value;
        saveSort(this.sortKey);
        this.renderList();
      },
    },
      ...Object.entries(SORTS).map(([k, s]) =>
        el('option', { value: k, ...(k === this.sortKey ? { selected: '' } : {}) }, s.label),
      ),
    ) as HTMLSelectElement;

    this.multiSelectLabel = el('span', { class: 'sidebar-multi__label' }, '') as HTMLElement;
    const clearBtn = el('button', {
      class: 'sidebar-multi__clear',
      type: 'button',
      title: 'clear selection (Esc)',
      onclick: (ev: MouseEvent) => { ev.stopPropagation(); this.clearMultiSelection(); },
    }, 'clear') as HTMLButtonElement;
    this.multiSelectFooter = el('div', { class: 'sidebar-multi', hidden: '' },
      this.multiSelectLabel,
      clearBtn,
    ) as HTMLElement;

    this.root = el('aside', { class: 'sidebar' },
      el('div', { class: 'sidebar-head' },
        el('span', { class: 'sidebar-title' }, 'agents'),
        this.newBtn,
        this.newFolderBtn,
        this.closeDrawerBtn,
      ),
      el('div', { class: 'sidebar-tools' },
        el('div', { class: 'sidebar-search' },
          this.searchInput,
          this.searchClearBtn,
        ),
        this.sortSelect,
      ),
      this.error,
      el('div', { class: 'sidebar-body' },
        this.activeList,
      ),
      this.multiSelectFooter,
    ) as HTMLElement;

    // Esc clears the multi-selection. Scoped to the sidebar root so we don't
    // intercept Esc inside the chat composer or other modals.
    this.root.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && this.multiSelection.size > 0) {
        ev.preventDefault();
        this.clearMultiSelection();
      }
    });
    // Make the root focusable for the Escape handler to fire.
    if (!this.root.hasAttribute('tabindex')) this.root.setAttribute('tabindex', '-1');
  }

  clearMultiSelection(): void {
    if (this.multiSelection.size === 0 && this.selectionAnchor == null) return;
    this.multiSelection = new Set();
    this.selectionAnchor = null;
    this.renderList();
  }

  private _updateMultiFooter(): void {
    const n = this.multiSelection.size;
    if (n <= 1) {
      this.multiSelectFooter.hidden = true;
      return;
    }
    this.multiSelectFooter.hidden = false;
    this.multiSelectLabel.textContent = `${n} selected`;
  }

  // Visible, sorted, search-filtered agent IDs in their on-screen order.
  // Used as the ordering universe for shift-click range selection.
  private _visibleOrderedIds(): string[] {
    const visible = this._sortAgents(this.agents).filter((a) => this._matchesSearch(a));
    const folderById = new Map<string, Folder>();
    for (const f of this.folders) folderById.set(f.id, f);
    const folderOfAgent = new Map<string, string>();
    for (const f of this.folders) for (const aid of f.agentIds) folderOfAgent.set(aid, f.id);

    if (this.folders.length === 0) return visible.map((a) => a.id);

    const topLevel: string[] = [];
    const buckets = new Map<string, string[]>();
    for (const a of visible) {
      const fid = folderOfAgent.get(a.id);
      if (fid && folderById.has(fid)) {
        if (!buckets.has(fid)) buckets.set(fid, []);
        buckets.get(fid)!.push(a.id);
      } else {
        topLevel.push(a.id);
      }
    }
    const ordered: string[] = [];
    ordered.push(...topLevel);
    for (const f of this.folders) ordered.push(...(buckets.get(f.id) || []));
    return ordered;
  }

  private _sortAgents(list: Agent[]): Agent[] {
    const sorter = SORTS[this.sortKey] || SORTS[SORT_DEFAULT]!;
    return list.slice().sort((a, b) => {
      const s = (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
      if (s) return s;
      return sorter.cmp(a, b);
    });
  }

  private _matchesSearch(a: Agent): boolean {
    if (!this.search) return true;
    const needle = this.search.toLowerCase();
    return (a.name || '').toLowerCase().includes(needle)
        || (a.id || '').toLowerCase().includes(needle)
        || (a.model || '').toLowerCase().includes(needle);
  }

  async spawnNew(): Promise<void> {
    if (this._creating) return;
    this._creating = true;
    this.newBtn.disabled = true;
    this.error.hidden = true;
    const prevLabel = this.newBtn.textContent;
    this.newBtn.textContent = 'spawning...';
    try {
      const created = await api.createAgent({}) as Agent;
      if (typeof this.onCreate === 'function') this.onCreate(created);
      await this.refresh();
      if (created && created.id) this.select(created.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed to spawn agent';
      this.error.textContent = msg;
      this.error.hidden = false;
    } finally {
      this._creating = false;
      this.newBtn.disabled = false;
      this.newBtn.textContent = prevLabel;
    }
  }

  async promptNewFolder(): Promise<void> {
    const name = window.prompt('New folder name:');
    if (!name || !name.trim()) return;
    try {
      await api.folders.create(name.trim());
      await this.refreshFolders();
      this.renderList();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`create folder failed: ${msg}`);
    }
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
    void this.refresh();
    void this.refreshFolders();
    this._startSseStream();
    this.startPolling();
    if (!this._spawnHandlerWired) {
      document.addEventListener('grok-remote:spawn-agent', () => void this.spawnNew());
      this._spawnHandlerWired = true;
    }
  }

  private _startSseStream(): void {
    if (this._agentsStream) return;
    try {
      const es = new EventSource(api.agentsStreamUrl());
      this._agentsStream = es;
      es.addEventListener('open', () => { this._sseAlive = true; });
      es.addEventListener('agents_snapshot', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data);
          if (d && Array.isArray(d.agents)) {
            this.agents = d.agents;
            this.renderList();
            document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: d.agents }));
          }
        } catch { /* ignore */ }
      });
      const onMutation = (): void => { void this.refresh(); };
      es.addEventListener('agent_added',   onMutation);
      es.addEventListener('agent_removed', onMutation);
      es.addEventListener('agent_updated', onMutation);
      es.addEventListener('agent_status',  onMutation);
      es.addEventListener('agent_tokens', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data) as { id?: string; totalTokens?: unknown };
          if (!d || !d.id || typeof d.totalTokens !== 'number') return;
          const idx = this.agents.findIndex((a) => a && a.id === d.id);
          if (idx < 0) return;
          this.agents[idx] = { ...this.agents[idx]!, totalTokens: d.totalTokens };
          this.renderList();
          document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: this.agents }));
        } catch { /* ignore */ }
      });
      es.addEventListener('agent_inflight', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data) as { id?: string; inFlight?: unknown };
          if (!d || !d.id || typeof d.inFlight !== 'number') return;
          const idx = this.agents.findIndex((a) => a && a.id === d.id);
          if (idx < 0) return;
          this.agents[idx] = { ...this.agents[idx]!, inFlight: d.inFlight };
          this.renderList();
          document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: this.agents }));
        } catch { /* ignore */ }
      });
      es.addEventListener('error', () => { this._sseAlive = false; });
    } catch {
      this._agentsStream = null;
    }
  }

  private _stopSseStream(): void {
    if (this._agentsStream) {
      try { this._agentsStream.close(); } catch { /* ignore */ }
      this._agentsStream = null;
    }
  }

  startPolling(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = setInterval(() => {
      if (document.hidden) return;
      if (this._sseAlive) return;
      void this.refresh();
    }, 4000);
    if (!this._onVisibility) {
      this._onVisibility = (): void => {
        if (!document.hidden) void this.refresh();
      };
      document.addEventListener('visibilitychange', this._onVisibility);
    }
  }

  stopPolling(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    if (this._onVisibility) {
      document.removeEventListener('visibilitychange', this._onVisibility);
      this._onVisibility = undefined;
    }
    this._stopSseStream();
  }

  async refresh(): Promise<void> {
    try {
      const data = await api.listAgents();
      const agents: Agent[] = Array.isArray(data)
        ? data as Agent[]
        : (data && typeof data === 'object' && Array.isArray((data as { agents?: unknown }).agents)
            ? (data as { agents: Agent[] }).agents
            : []);
      this.agents = agents;
      this.renderList();
      document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: agents }));
    } catch (e) {
      this.agents = [];
      const msg = e instanceof Error ? e.message : String(e);
      this.renderList(msg);
    }
  }

  async refreshFolders(): Promise<void> {
    try {
      const data = await api.folders.list() as unknown;
      this.folders = Array.isArray(data) ? data as Folder[] : [];
    } catch {
      this.folders = [];
    }
  }

  renderList(errorMessage?: string): void {
    this._closeContextMenu();
    // If an SSE-triggered re-render lands mid-drag, kill the drag so we don't
    // leave a ghost stranded against a recycled source element.
    if (this._drag) this._cancelDrag();
    this.activeList.replaceChildren();
    if (this.searchClearBtn) this.searchClearBtn.hidden = !this.search;
    // Drop stale ids from multi-selection so the footer count stays accurate.
    if (this.multiSelection.size > 0) {
      const liveIds = new Set(this.agents.map((a) => a.id));
      const before = this.multiSelection.size;
      for (const id of [...this.multiSelection]) {
        if (!liveIds.has(id)) this.multiSelection.delete(id);
      }
      if (before !== this.multiSelection.size && this.selectionAnchor && !liveIds.has(this.selectionAnchor)) {
        this.selectionAnchor = null;
      }
    }
    this._updateMultiFooter();

    if (errorMessage) {
      this.activeList.appendChild(el('div', { class: 'agents-empty agents-empty--err' },
        'backend unreachable'));
      return;
    }

    const visible = this._sortAgents(this.agents).filter((a) => this._matchesSearch(a));

    // Bucket every visible agent by folder id. The system "Archived" folder
    // collects every archived agent automatically (the backend assigns them
    // when the archived flag flips).
    const folderById = new Map<string, Folder>();
    for (const f of this.folders) folderById.set(f.id, f);
    const folderOfAgent = new Map<string, string>();
    for (const f of this.folders) for (const aid of f.agentIds) folderOfAgent.set(aid, f.id);

    const topLevel: Agent[] = [];
    const buckets = new Map<string, Agent[]>();
    for (const a of visible) {
      const fid = folderOfAgent.get(a.id);
      if (fid && folderById.has(fid)) {
        if (!buckets.has(fid)) buckets.set(fid, []);
        buckets.get(fid)!.push(a);
      } else {
        topLevel.push(a);
      }
    }

    if (!this.agents.length) {
      this.activeList.appendChild(this.empty);
      return;
    }
    if (!visible.length && this.folders.length === 0) {
      this.activeList.appendChild(this.noMatch);
      return;
    }

    if (this.folders.length > 0) {
      this.activeList.appendChild(this.renderGroup(TOP_LEVEL_ID, 'top level', topLevel, null));
      for (const f of this.folders) {
        this.activeList.appendChild(this.renderGroup(f.id, f.name, buckets.get(f.id) || [], f));
      }
    } else {
      for (const a of topLevel) this.activeList.appendChild(this.renderItem(a, false));
    }
  }

  private renderGroup(groupId: string, label: string, items: Agent[], folder: Folder | null): HTMLElement {
    const isTopLevel = groupId === TOP_LEVEL_ID;
    const isSystem = !!(folder && folder.system);
    const isArchived = folder?.id === ARCHIVED_FOLDER_ID;
    // System (archived) folders auto-collapse by default until the user toggles them.
    const isCollapsed = isArchived
      ? !this.collapsed.has(`open:${groupId}`)
      : this.collapsed.has(groupId);
    const folderId = isTopLevel ? null : groupId;

    const caret = el('span', { class: 'folder-caret' }, isCollapsed ? '▶' : '▼');
    const labelEl = el('span', { class: 'folder-name' }, label);
    const count = el('span', { class: 'folder-count' }, String(items.length));

    const deleteBtn = (!isTopLevel && !isSystem) ? el('button', {
      class: 'folder-delete',
      type: 'button',
      title: 'delete folder (agents move back to top level)',
      onclick: async (ev: MouseEvent) => {
        ev.stopPropagation();
        if (!confirm(`Delete folder "${label}"?\nIts agents move back to the top level.`)) return;
        try {
          await api.folders.remove(folderId!);
          await this.refreshFolders();
          this.renderList();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`delete folder failed: ${msg}`);
        }
      },
    }, '×') as HTMLButtonElement : null;

    const header = el('div', {
      class: `folder-header${isTopLevel ? ' folder-header--top' : ''}${isSystem ? ' folder-header--system' : ''}`,
      'data-folder-id': groupId,
      onclick: () => {
        if (isArchived) {
          // Inverse key so the default state is collapsed.
          const k = `open:${groupId}`;
          if (this.collapsed.has(k)) this.collapsed.delete(k); else this.collapsed.add(k);
        } else {
          if (isCollapsed) this.collapsed.delete(groupId); else this.collapsed.add(groupId);
        }
        saveCollapsed(this.collapsed);
        this.renderList();
      },
      ondblclick: (ev: MouseEvent) => {
        if (isTopLevel || isSystem || !folder) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.beginInlineRenameFolder(folder, labelEl as HTMLElement);
      },
    }, caret, labelEl, count, deleteBtn) as HTMLElement;

    const body = el('div', { class: 'folder-body' }) as HTMLElement;
    if (!isCollapsed) {
      if (items.length === 0) {
        body.appendChild(el('div', { class: 'folder-empty' },
          isTopLevel ? 'drop agents here to remove from folders' : 'drop agents here'));
      } else {
        for (const a of items) body.appendChild(this.renderItem(a, false));
      }
    }

    return el('div', { class: 'folder-group', 'data-folder-id': groupId }, header, body) as HTMLElement;
  }

  private beginInlineRenameFolder(folder: Folder, labelEl: HTMLElement): void {
    const parent = labelEl.parentElement;
    if (!parent) return;
    const input = el('input', {
      class: 'folder-rename-input',
      type: 'text',
      value: folder.name,
      onclick: (ev: MouseEvent) => ev.stopPropagation(),
      onkeydown: (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') { ev.preventDefault(); (ev.target as HTMLInputElement).blur(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); (input as HTMLInputElement).value = folder.name; (ev.target as HTMLInputElement).blur(); }
      },
      onblur: async (ev: FocusEvent) => {
        const next = ((ev.target as HTMLInputElement).value || '').trim();
        if (!next || next === folder.name) { this.renderList(); return; }
        try {
          await api.folders.update(folder.id, { name: next });
          await this.refreshFolders();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`rename folder failed: ${msg}`);
        }
        this.renderList();
      },
    }) as HTMLInputElement;
    parent.replaceChild(input, labelEl);
    input.focus();
    input.select();
  }

  private beginInlineRenameAgent(a: Agent, nameEl: HTMLElement): void {
    const parent = nameEl.parentElement;
    if (!parent) return;
    const input = el('input', {
      class: 'agent-rename-input',
      type: 'text',
      value: a.name || '',
      onclick: (ev: MouseEvent) => ev.stopPropagation(),
      onkeydown: (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') { ev.preventDefault(); (ev.target as HTMLInputElement).blur(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); (input as HTMLInputElement).value = a.name || ''; (input as HTMLInputElement).dataset['cancel'] = '1'; (ev.target as HTMLInputElement).blur(); }
      },
      onblur: async (ev: FocusEvent) => {
        const target = ev.target as HTMLInputElement;
        const cancel = target.dataset['cancel'] === '1';
        const next = (target.value || '').trim();
        if (cancel || !next || next === a.name) { this.renderList(); return; }
        try {
          await api.updateAgent(a.id, { name: next });
          await this.refresh();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`rename failed: ${msg}`);
          this.renderList();
        }
      },
    }) as HTMLInputElement;
    parent.replaceChild(input, nameEl);
    input.focus();
    input.select();
  }

  renderItem(a: Agent, isArchived: boolean): HTMLElement {
    const isSelected = a.id === this.selectedId;
    const status = a.status || 'idle';
    const isDisconnected = status === 'disconnected' || status === 'exited';
    const dot = el('span', { class: `agent-dot agent-dot--${status}` });

    const starBtn = el('button', {
      class: `agent-star agent-row-action${a.starred ? ' is-on' : ''}`,
      title: a.starred ? 'unstar' : 'star',
      type: 'button',
      onclick: async (ev: MouseEvent) => {
        ev.stopPropagation();
        starBtn.disabled = true;
        try {
          await api.updateAgent(a.id, { starred: !a.starred });
          await this.refresh();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`star failed: ${msg}`);
        } finally {
          starBtn.disabled = false;
        }
      },
    }, a.starred ? '★' : '☆') as HTMLButtonElement;

    const nameEl = el('span', {
      class: 'agent-name',
      ondblclick: (ev: MouseEvent) => {
        if (isArchived) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.beginInlineRenameAgent(a, nameEl as HTMLElement);
      },
    }, a.name || a.id.slice(0, 8)) as HTMLElement;

    let closeArea: HTMLElement | null;
    if (!isArchived) {
      const archiveBtn = el('button', {
        class: 'agent-archive agent-row-action',
        type: 'button',
        title: 'archive (move to archived; you can restore or delete later)',
        onclick: async (ev: MouseEvent) => {
          ev.stopPropagation();
          archiveBtn.disabled = true;
          try {
            await api.updateAgent(a.id, { archived: true });
            if (this.selectedId === a.id) this.selectedId = null;
            await this.refresh();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`archive failed: ${msg}`);
          } finally {
            archiveBtn.disabled = false;
          }
        },
      }, '×') as HTMLButtonElement;
      closeArea = archiveBtn;
    } else {
      const restoreBtn = el('button', {
        class: 'agent-restore agent-row-action',
        type: 'button',
        title: 'restore from archive',
        onclick: async (ev: MouseEvent) => {
          ev.stopPropagation();
          restoreBtn.disabled = true;
          try {
            await api.updateAgent(a.id, { archived: false });
            await this.refresh();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`restore failed: ${msg}`);
          } finally {
            restoreBtn.disabled = false;
          }
        },
      }, 'restore') as HTMLButtonElement;
      const deleteBtn = el('button', {
        class: 'agent-delete-forever agent-row-action',
        type: 'button',
        title: 'delete forever (removes history + uploads)',
        onclick: async (ev: MouseEvent) => {
          ev.stopPropagation();
          if (!confirm(`Delete "${a.name || a.id}" forever?\nThis removes its history and uploaded files. Cannot be undone.`)) return;
          try {
            await api.deleteAgent(a.id);
            if (typeof this.onDelete === 'function') this.onDelete(a.id);
            if (this.selectedId === a.id) this.selectedId = null;
            await this.refresh();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`delete failed: ${msg}`);
          }
        },
      }, 'delete') as HTMLButtonElement;
      closeArea = el('div', { class: 'agent-archived-actions' }, restoreBtn, deleteBtn) as HTMLElement;
    }

    const inflightChip = (typeof a.inFlight === 'number' && a.inFlight > 0)
      ? el('span', { class: 'agent-inflight', title: `${a.inFlight} tool call${a.inFlight === 1 ? '' : 's'} in flight` },
          el('span', { class: 'agent-inflight-dot' }),
          `${a.inFlight} tool${a.inFlight === 1 ? '' : 's'}`)
      : null;
    const tokenChip = (typeof a.totalTokens === 'number' && a.totalTokens > 0)
      ? el('span', { class: 'agent-tokens', title: `${a.totalTokens.toLocaleString()} tokens in context` }, fmtTokens(a.totalTokens))
      : null;
    const statusChip = el('span', { class: `agent-status agent-status--${status}` }, STATUS_LABEL[status] || status);

    const metaChildren: (HTMLElement | null)[] = [statusChip];
    if (inflightChip) metaChildren.push(inflightChip);
    if (tokenChip) metaChildren.push(tokenChip);

    const isMulti = this.multiSelection.has(a.id);
    const item = el('div', {
      class: [
        'agent-item',
        isSelected     ? 'agent-item--selected' : '',
        isMulti        ? 'agent-item--multi' : '',
        isDisconnected ? 'agent-item--off' : '',
        isArchived     ? 'agent-item--archived' : '',
        a.starred      ? 'agent-item--starred' : '',
      ].filter(Boolean).join(' '),
      'data-agent-id': a.id,
      oncontextmenu: (ev: MouseEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        this._showContextMenu(a, ev.clientX, ev.clientY);
      },
    },
      el('div', { class: 'agent-item-top' },
        dot,
        starBtn,
        nameEl,
        closeArea,
      ),
      el('div', { class: 'agent-item-meta' }, ...metaChildren),
    ) as HTMLElement;

    // Treat genuinely-archived agents as non-draggable regardless of the
    // legacy parameter (the folder system handles archived now).
    const treatAsArchived = isArchived || !!a.archived;
    this._attachDragHandlers(item, a, treatAsArchived);
    return item;
  }

  // Pointer-events drag/drop. Mouse/pen drag activates as soon as horizontal
  // motion crosses MOUSE_DRAG_THRESH; touch uses a long-press so vertical
  // scroll still works. We do NOT setPointerCapture until drag actually
  // activates: capturing on pointerdown was breaking the row's own click-to-
  // select because pointer capture redirects subsequent events away from any
  // ancestor click target until release.
  private _attachDragHandlers(item: HTMLElement, agent: Agent, isArchived: boolean): void {
    const agentId = agent.id;

    const onPointerDown = (ev: PointerEvent): void => {
      if (ev.button !== undefined && ev.button !== 0) return;
      const target = ev.target as HTMLElement | null;
      // Only the explicit action buttons (star, archive, restore, delete-forever)
      // and any input/select inside the row (rename) opt out of drag. The rest
      // of the row body, including the name text, should drag freely.
      if (target && target.closest('.agent-row-action, input, select, textarea')) return;
      this._cancelDrag();
      const drag = {
        agentId,
        pointerId: ev.pointerId,
        pointerType: ev.pointerType || 'mouse',
        startX: ev.clientX,
        startY: ev.clientY,
        startTime: performance.now(),
        sourceEl: item,
        ghost: null as HTMLElement | null,
        active: false,
        captured: false,
        pressTimer: null as number | null,
        moved: false,
      };
      this._drag = drag;
      if (isArchived) {
        // Archived rows don't drag (drop targets are non-archived folders),
        // but we still want click-to-select to work via pointerup below.
        return;
      }
      if (drag.pointerType === 'touch') {
        // Touch: wait for the long-press; mouse skips the timer entirely so
        // click-and-drag feels immediate.
        drag.pressTimer = window.setTimeout(() => {
          if (this._drag === drag) this._activateDrag(drag.startX, drag.startY);
        }, LONG_PRESS_MS);
      }
    };

    const onPointerMove = (ev: PointerEvent): void => {
      const drag = this._drag;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      const moved = Math.hypot(dx, dy);
      if (!drag.active) {
        if (isArchived) {
          // Mark moved so pointerup will skip the click branch; archived rows
          // never start a drag.
          if (moved > MOUSE_DRAG_THRESH) drag.moved = true;
          return;
        }
        if (drag.pointerType === 'touch') {
          // Touch: any movement before the long-press fires means "scroll".
          if (moved > TOUCH_MOVE_THRESH) this._cancelDrag();
          return;
        }
        // Mouse / pen: cross MOUSE_DRAG_THRESH on the X axis to start drag.
        if (Math.abs(dx) >= MOUSE_DRAG_THRESH || moved >= MOUSE_DRAG_THRESH * 2) {
          drag.moved = true;
          this._activateDrag(ev.clientX, ev.clientY);
        }
        return;
      }
      ev.preventDefault();
      this._moveGhost(ev.clientX, ev.clientY);
      this._highlightDropTarget(ev.clientX, ev.clientY);
    };

    const onPointerUp = (ev: PointerEvent): void => {
      const drag = this._drag;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      if (drag.captured) {
        try { item.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      }
      if (drag.active) {
        const target = this._findDropTarget(ev.clientX, ev.clientY);
        this._endDrag();
        if (target) void this._assignAgentToFolder(drag.agentId, target);
        return;
      }
      // No drag activated: treat as a click and select the row. We do this
      // explicitly because there is no native onclick (we needed pointer
      // capture to NOT swallow the click, but doing nothing leaves no
      // selection at all on touch where browsers sometimes skip the
      // synthesised click).
      const dt = performance.now() - drag.startTime;
      const dx = Math.abs(ev.clientX - drag.startX);
      const dy = Math.abs(ev.clientY - drag.startY);
      this._cancelDrag();
      const isClick = dt < CLICK_MAX_MS * 4
        && dx < MOUSE_DRAG_THRESH
        && dy < MOUSE_DRAG_THRESH;
      if (isClick) {
        const tgt = ev.target as HTMLElement | null;
        if (tgt && tgt.closest('.agent-row-action, input, select, textarea')) return;
        this._handleRowClick(agentId, ev);
      }
    };

    const onPointerCancel = (ev: PointerEvent): void => {
      const drag = this._drag;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      this._cancelDrag();
    };

    item.addEventListener('pointerdown', onPointerDown);
    item.addEventListener('pointermove', onPointerMove);
    item.addEventListener('pointerup', onPointerUp);
    item.addEventListener('pointercancel', onPointerCancel);
  }

  private _activateDrag(clientX: number, clientY: number): void {
    const drag = this._drag;
    if (!drag || drag.active) return;
    drag.active = true;
    if (drag.pressTimer) { clearTimeout(drag.pressTimer); drag.pressTimer = null; }
    // Capture only now. Capturing on pointerdown was breaking taps because
    // the captured pointer's events bypass the row's click semantics.
    try {
      drag.sourceEl.setPointerCapture(drag.pointerId);
      drag.captured = true;
    } catch { /* ignore */ }
    const rect = drag.sourceEl.getBoundingClientRect();
    const ghost = drag.sourceEl.cloneNode(true) as HTMLElement;
    ghost.classList.add('agent-drag-ghost');
    ghost.style.position = 'fixed';
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '9999';
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.sourceEl.classList.add('agent-item--dragging');
    document.body.classList.add('agents-dragging');
    this._moveGhost(clientX, clientY);
    this._highlightDropTarget(clientX, clientY);
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch { /* ignore */ } }
  }

  private _moveGhost(clientX: number, clientY: number): void {
    const drag = this._drag;
    if (!drag || !drag.ghost) return;
    const rect = drag.sourceEl.getBoundingClientRect();
    const offsetX = drag.startX - rect.left;
    const offsetY = drag.startY - rect.top;
    drag.ghost.style.left = `${clientX - offsetX}px`;
    drag.ghost.style.top  = `${clientY - offsetY}px`;
  }

  private _highlightDropTarget(clientX: number, clientY: number): void {
    const all = this.activeList.querySelectorAll<HTMLElement>('.folder-header');
    let hit: HTMLElement | null = null;
    for (const h of all) {
      const r = h.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        hit = h;
        break;
      }
    }
    for (const h of all) h.classList.toggle('folder-header--drop', h === hit);
  }

  private _findDropTarget(clientX: number, clientY: number): string | null {
    const all = this.activeList.querySelectorAll<HTMLElement>('.folder-header');
    for (const h of all) {
      const r = h.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        return h.getAttribute('data-folder-id');
      }
    }
    return null;
  }

  private _endDrag(): void {
    const drag = this._drag;
    if (!drag) return;
    if (drag.pressTimer) { clearTimeout(drag.pressTimer); drag.pressTimer = null; }
    if (drag.captured) {
      try { drag.sourceEl.releasePointerCapture(drag.pointerId); } catch { /* ignore */ }
    }
    if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    drag.sourceEl.classList.remove('agent-item--dragging');
    document.body.classList.remove('agents-dragging');
    this.activeList.querySelectorAll('.folder-header--drop').forEach((n) => n.classList.remove('folder-header--drop'));
    this._drag = null;
  }

  private _cancelDrag(): void {
    if (!this._drag) return;
    this._endDrag();
  }

  private async _assignAgentToFolder(agentId: string, groupId: string): Promise<void> {
    const folderId = groupId === TOP_LEVEL_ID ? null : groupId;
    try {
      await api.agents.setFolder(agentId, folderId);
      await this.refreshFolders();
      this.renderList();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`move failed: ${msg}`);
    }
  }

  select(id: string): void {
    this.selectedId = id;
    this.renderList();
    if (typeof this.onSelect === 'function') this.onSelect(id);
  }

  private _handleRowClick(agentId: string, ev: PointerEvent | MouseEvent): void {
    const modified = ev.ctrlKey || ev.metaKey || ev.shiftKey;
    if (!modified) {
      // Plain click: clear any multi-selection, then navigate.
      if (this.multiSelection.size > 0) {
        this.multiSelection = new Set();
      }
      this.selectionAnchor = agentId;
      this.select(agentId);
      return;
    }
    // Modifier click: extend/toggle multi-selection without navigating.
    const order = this._visibleOrderedIds();
    const seed = this.multiSelection.size > 0
      ? this.multiSelection
      : (this.selectedId ? new Set([this.selectedId]) : new Set<string>());
    const { next, anchor } = computeSelection(
      seed,
      this.selectionAnchor || this.selectedId,
      agentId,
      { ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, shiftKey: ev.shiftKey },
      order,
    );
    this.multiSelection = next;
    this.selectionAnchor = anchor;
    // If the user collapsed back to exactly one row, treat it like a normal
    // selection so the chat opens it.
    if (this.multiSelection.size === 1) {
      const only = [...this.multiSelection][0]!;
      this.multiSelection = new Set();
      this.selectedId = only;
      this.renderList();
      if (typeof this.onSelect === 'function') this.onSelect(only);
      return;
    }
    this.renderList();
  }

  private _showContextMenu(a: Agent, clientX: number, clientY: number): void {
    this._closeContextMenu();

    // Decide whether this menu acts on a single row or the multi-selection.
    // Right-clicking outside the current multi-selection clears it and acts
    // on the single clicked row, matching every familiar file manager.
    let targetIds: string[];
    if (this.multiSelection.size > 1 && this.multiSelection.has(a.id)) {
      targetIds = [...this.multiSelection];
    } else {
      if (this.multiSelection.size > 0) {
        this.multiSelection = new Set();
        this.renderList();
      }
      targetIds = [a.id];
    }
    const targetAgents = targetIds
      .map((id) => this.agents.find((x) => x.id === id))
      .filter((x): x is Agent => !!x);
    const bulk = targetAgents.length > 1;

    const items: HTMLElement[] = [];

    const mkItem = (label: string, run: () => void, opts?: { danger?: boolean }): HTMLElement => {
      const btn = el('button', {
        class: `ctx-menu__item${opts && opts.danger ? ' ctx-menu__danger' : ''}`,
        type: 'button',
        onclick: (ev: MouseEvent) => {
          ev.stopPropagation();
          this._closeContextMenu();
          run();
        },
      }, label) as HTMLElement;
      return btn;
    };

    const mkSep = (): HTMLElement => el('div', { class: 'ctx-menu__sep' }) as HTMLElement;

    // Majority-vote on the current starred / archived state so the action
    // label reads naturally for the bulk case ("Star all" if most aren't
    // already starred).
    const starredCount   = targetAgents.filter((x) => !!x.starred).length;
    const archivedCount  = targetAgents.filter((x) => !!x.archived).length;
    const majorityStarred  = starredCount  > targetAgents.length / 2;
    const majorityArchived = archivedCount > targetAgents.length / 2;

    const starLabel = bulk
      ? (majorityStarred ? `Unstar ${targetAgents.length}` : `Star ${targetAgents.length}`)
      : (a.starred ? 'Unstar' : 'Star');
    items.push(mkItem(starLabel, async () => {
      const nextStarred = bulk ? !majorityStarred : !a.starred;
      try {
        await Promise.all(targetAgents.map((x) => api.updateAgent(x.id, { starred: nextStarred })));
        await this.refresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        alert(`star failed: ${msg}`);
      }
    }));

    if (!bulk) {
      items.push(mkItem('Rename', () => {
        const node = this.activeList.querySelector<HTMLElement>(
          `.agent-item[data-agent-id="${CSS.escape(a.id)}"] .agent-name`,
        );
        if (node) this.beginInlineRenameAgent(a, node);
      }));
    }

    items.push(mkSep());

    // Move to folder. Inline the candidate folders right in the menu (a single
    // flat list keeps the implementation small + works fine on touch). System
    // folders (Archived) are excluded; "Archive" handles that case.
    const moveTargets = this.folders.filter((f) => !f.system);
    const currentFolder = (() => {
      // For single-row, indicate the folder the row currently lives in.
      if (bulk) return null;
      for (const f of this.folders) if (f.agentIds.includes(a.id)) return f.id;
      return null;
    })();

    if (moveTargets.length > 0 || currentFolder) {
      const heading = bulk ? `Move ${targetAgents.length} to` : 'Move to';
      items.push(el('div', { class: 'ctx-menu__heading' }, heading) as HTMLElement);
      items.push(mkItem(`(no folder)${!bulk && !currentFolder ? '  •' : ''}`, async () => {
        try {
          await Promise.all(targetAgents.map((x) => api.agents.setFolder(x.id, null)));
          await this.refreshFolders();
          this.renderList();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`move failed: ${msg}`);
        }
      }));
      for (const f of moveTargets) {
        const label = (!bulk && currentFolder === f.id) ? `${f.name}  •` : f.name;
        items.push(mkItem(label, async () => {
          try {
            await Promise.all(targetAgents.map((x) => api.agents.setFolder(x.id, f.id)));
            await this.refreshFolders();
            this.renderList();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`move failed: ${msg}`);
          }
        }));
      }
      items.push(mkSep());
    }

    const archiveLabel = bulk
      ? (majorityArchived ? `Unarchive ${targetAgents.length}` : `Archive ${targetAgents.length}`)
      : (a.archived ? 'Unarchive' : 'Archive');
    items.push(mkItem(archiveLabel, async () => {
      const nextArchived = bulk ? !majorityArchived : !a.archived;
      try {
        await Promise.all(targetAgents.map((x) => api.updateAgent(x.id, { archived: nextArchived })));
        if (nextArchived) {
          for (const x of targetAgents) {
            if (this.selectedId === x.id) this.selectedId = null;
          }
        }
        await this.refresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        alert(`archive failed: ${msg}`);
      }
    }));

    if (!bulk) {
      items.push(mkItem('Copy id', async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(a.id);
          } else {
            const ta = document.createElement('textarea');
            ta.value = a.id;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch { /* ignore */ }
            document.body.removeChild(ta);
          }
        } catch {
          alert('copy failed');
        }
      }));
    }

    items.push(mkSep());

    const deleteLabel = bulk ? `Delete ${targetAgents.length}…` : 'Delete…';
    items.push(mkItem(deleteLabel, async () => {
      const prompt = bulk
        ? `Delete ${targetAgents.length} conversations?\nThis removes their history and uploaded files. Cannot be undone.`
        : `Delete "${a.name || a.id}" forever?\nThis removes its history and uploaded files. Cannot be undone.`;
      if (!confirm(prompt)) return;
      try {
        await Promise.all(targetAgents.map((x) => api.deleteAgent(x.id)));
        if (typeof this.onDelete === 'function') {
          for (const x of targetAgents) this.onDelete(x.id);
        }
        for (const x of targetAgents) {
          if (this.selectedId === x.id) this.selectedId = null;
        }
        if (bulk) this.multiSelection = new Set();
        await this.refresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        alert(`delete failed: ${msg}`);
      }
    }, { danger: true }));

    const menu = el('div', {
      class: 'ctx-menu',
      role: 'menu',
      // Stop bubbling so the document-level dismiss listener does not fire
      // when clicking inside the menu itself.
      onclick: (ev: MouseEvent) => ev.stopPropagation(),
      oncontextmenu: (ev: MouseEvent) => { ev.preventDefault(); this._closeContextMenu(); },
    }, ...items) as HTMLElement;

    // Position offscreen first so we can measure and clamp.
    menu.style.position = 'fixed';
    menu.style.left = '-9999px';
    menu.style.top  = '-9999px';
    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    const margin = 6;
    const maxX = window.innerWidth  - rect.width  - margin;
    const maxY = window.innerHeight - rect.height - margin;
    const x = Math.max(margin, Math.min(clientX, maxX));
    const y = Math.max(margin, Math.min(clientY, maxY));
    menu.style.left = `${x}px`;
    menu.style.top  = `${y}px`;
    this._ctxMenu = menu;

    const onDocPointerDown = (ev: PointerEvent): void => {
      const tgt = ev.target as Node | null;
      if (tgt && menu.contains(tgt)) return;
      this._closeContextMenu();
    };
    const onDocContextMenu = (ev: MouseEvent): void => {
      const tgt = ev.target as Node | null;
      if (tgt && menu.contains(tgt)) return;
      // Let a fresh contextmenu open the new one; just close this one now.
      this._closeContextMenu();
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') { ev.preventDefault(); this._closeContextMenu(); }
    };
    // Fire on the *next* tick so the contextmenu event that opened us does
    // not immediately close it.
    setTimeout(() => {
      document.addEventListener('pointerdown', onDocPointerDown, true);
      document.addEventListener('contextmenu', onDocContextMenu, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    this._ctxCleanup = () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('contextmenu', onDocContextMenu, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }

  private _closeContextMenu(): void {
    if (this._ctxCleanup) { try { this._ctxCleanup(); } catch { /* ignore */ } this._ctxCleanup = null; }
    if (this._ctxMenu && this._ctxMenu.parentNode) this._ctxMenu.parentNode.removeChild(this._ctxMenu);
    this._ctxMenu = null;
  }
}
