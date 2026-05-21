// MCP servers page. Lists configured MCP servers, lets you add/remove, and
// run `grok mcp doctor` against one or all of them.

import { api } from '../../lib/api.js';
import { MCP_REGISTRY, MCP_CATEGORIES, type McpRegistryEntry } from './mcp-registry.js';
import { type RegistryPickEntry, type RegistryItemKindBadge } from './registry-picker.js';
import { openMcpPicker, type McpPickerHandle } from './mcp-picker.js';
import { classifyServerKind, type ServerKind } from './registry-filters.js';

// Shape returned by the backend live-registry endpoint. Matches the
// NormalizedEntry shape in lib/mcp-registry-upstream.ts.
interface LiveRegistryEntry {
  name: string;
  slug: string;
  description: string;
  category: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Array<{ name: string; required: boolean; placeholder?: string; help?: string }>;
  url_docs?: string;
  official: boolean;
  source: 'upstream' | 'static';
}

interface LiveRegistryResponse {
  ok: boolean;
  fetchedAt?: string;
  count?: number;
  stale?: boolean;
  entries?: LiveRegistryEntry[];
  error?: string;
}

interface McpServer {
  name?: string;
  id?: string;
  key?: string;
  type?: string;
  transport?: string;
  command?: string;
  url?: string;
  args?: unknown;
  env?: unknown;
  [k: string]: unknown;
}

interface CardState {
  doctorBusy: boolean;
  doctorResult: unknown;
  doctorError: string | null;
  removing: boolean;
}

interface McpState {
  loading: boolean;
  loadError: string | null;
  servers: McpServer[];
  cards: Map<string, CardState>;
  formType: 'stdio' | 'http' | 'sse';
  formError: string | null;
  formBusy: boolean;
  doctorAllBusy: boolean;
  doctorAllResult: unknown;
  doctorAllError: string | null;
}

interface AddServerBody {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
}

let activeContainer: HTMLElement | null = null;
let state: McpState = freshState();

function freshState(): McpState {
  return {
    loading: false,
    loadError: null,
    servers: [],
    cards: new Map(),
    formType: 'stdio',
    formError: null,
    formBusy: false,
    doctorAllBusy: false,
    doctorAllResult: null,
    doctorAllError: null,
  };
}

export function mount(container: HTMLElement): void {
  activeContainer = container;
  state = freshState();
  render();
  void refreshList();
}

export function unmount(): void {
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

function render(): void {
  if (!activeContainer) return;
  activeContainer.replaceChildren();
  const root = document.createElement('section');
  root.className = 'system-page';
  root.innerHTML = `
    <header class="mcp-header">
      <h2 class="system-page-title">MCP servers</h2>
      <div class="mcp-header-actions">
        <button type="button" class="mcp-btn" data-act="browse-registry">browse registry</button>
        <button type="button" class="mcp-btn" data-act="refresh">refresh</button>
        <button type="button" class="mcp-btn mcp-btn--accent" data-act="doctor-all">doctor all</button>
      </div>
    </header>

    <p class="system-page-sub">
      Configured MCP servers from <code>grok mcp list</code>. Add stdio
      processes or HTTP/SSE endpoints. The doctor command attempts the
      configured transport and reports connectivity issues.
    </p>

    <div class="mcp-doctor-all" data-slot="doctor-all"></div>

    <div class="mcp-list" data-slot="list"></div>

    <section class="mcp-add">
      <h3 class="mcp-section-title">Add server</h3>
      <form class="mcp-add-form" data-slot="form" autocomplete="off">
        <label class="mcp-field">
          <span class="mcp-field-label">name</span>
          <input name="name" type="text" required pattern="[A-Za-z0-9_.\\-]+" placeholder="my-server" />
        </label>

        <div class="mcp-field mcp-field--row">
          <span class="mcp-field-label">transport</span>
          <label class="mcp-radio"><input type="radio" name="type" value="stdio" checked /> stdio</label>
          <label class="mcp-radio"><input type="radio" name="type" value="http" /> http</label>
          <label class="mcp-radio"><input type="radio" name="type" value="sse" /> sse</label>
        </div>

        <div class="mcp-stdio-fields" data-slot="stdio-fields">
          <label class="mcp-field">
            <span class="mcp-field-label">command</span>
            <input name="command" type="text" placeholder="npx" />
          </label>
          <label class="mcp-field">
            <span class="mcp-field-label">args (one per line)</span>
            <textarea name="args" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-github"></textarea>
          </label>
          <label class="mcp-field">
            <span class="mcp-field-label">env (KEY=VALUE per line)</span>
            <textarea name="env" rows="3" placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=ghp_..."></textarea>
          </label>
        </div>

        <div class="mcp-url-fields" data-slot="url-fields" hidden>
          <label class="mcp-field">
            <span class="mcp-field-label">url</span>
            <input name="url" type="text" placeholder="https://mcp.example.com/v1" />
          </label>
        </div>

        <div class="mcp-form-error" data-slot="form-error" hidden></div>

        <div class="mcp-form-actions">
          <button type="submit" class="mcp-btn mcp-btn--primary" data-slot="submit">add</button>
          <button type="reset" class="mcp-btn">reset</button>
        </div>
      </form>
    </section>
  `;
  activeContainer.appendChild(root);

  root.querySelector<HTMLButtonElement>('[data-act="refresh"]')?.addEventListener('click', () => {
    void refreshList();
  });
  root.querySelector<HTMLButtonElement>('[data-act="doctor-all"]')?.addEventListener('click', () => {
    void runDoctorAll();
  });
  root.querySelector<HTMLButtonElement>('[data-act="browse-registry"]')?.addEventListener('click', () => {
    openMcpRegistryPicker();
  });

  const form = root.querySelector<HTMLFormElement>('[data-slot="form"]');
  if (form) {
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void submitAddForm(form);
    });
    form.addEventListener('reset', () => {
      state.formType = 'stdio';
      state.formError = null;
      queueMicrotask(() => syncFormVisibility(form));
    });
    form.addEventListener('change', (ev) => {
      const t = ev.target as HTMLInputElement | null;
      if (t && t.name === 'type') {
        const v = t.value;
        state.formType = v === 'http' || v === 'sse' ? v : 'stdio';
        syncFormVisibility(form);
      }
    });
    syncFormVisibility(form);
  }

  renderList();
  renderDoctorAll();
}

function syncFormVisibility(form: HTMLFormElement): void {
  const isStdio = state.formType === 'stdio';
  const stdio = form.querySelector<HTMLElement>('[data-slot="stdio-fields"]');
  const urlBox = form.querySelector<HTMLElement>('[data-slot="url-fields"]');
  if (stdio) stdio.hidden = !isStdio;
  if (urlBox) urlBox.hidden = isStdio;
  const errSlot = form.querySelector<HTMLElement>('[data-slot="form-error"]');
  if (errSlot) {
    if (state.formError) {
      errSlot.textContent = state.formError;
      errSlot.hidden = false;
    } else {
      errSlot.textContent = '';
      errSlot.hidden = true;
    }
  }
  const submit = form.querySelector<HTMLButtonElement>('[data-slot="submit"]');
  if (submit) {
    submit.disabled = state.formBusy;
    submit.textContent = state.formBusy ? 'adding...' : 'add';
  }
}

function renderList(): void {
  if (!activeContainer) return;
  const slot = activeContainer.querySelector<HTMLElement>('[data-slot="list"]');
  if (!slot) return;
  slot.replaceChildren();

  if (state.loading) {
    const p = document.createElement('p');
    p.className = 'mcp-empty';
    p.textContent = 'loading...';
    slot.appendChild(p);
    return;
  }
  if (state.loadError) {
    const p = document.createElement('p');
    p.className = 'mcp-empty mcp-empty--err';
    p.textContent = `failed to load: ${state.loadError}`;
    slot.appendChild(p);
    return;
  }
  if (!state.servers.length) {
    const p = document.createElement('p');
    p.className = 'mcp-empty';
    p.textContent = 'no MCP servers configured. add one below.';
    slot.appendChild(p);
    return;
  }

  for (const server of state.servers) {
    slot.appendChild(buildCard(server));
  }
}

function buildCard(server: McpServer): HTMLElement {
  const name = readServerName(server);
  const transport = readTransport(server);
  const target = readTarget(server);
  const args = readArgs(server);
  const env = readEnv(server);
  const cardState = ensureCardState(name);

  const card = document.createElement('article');
  card.className = 'mcp-card';
  card.dataset.name = name;

  const head = document.createElement('header');
  head.className = 'mcp-card-head';
  const title = document.createElement('div');
  title.className = 'mcp-card-title';
  title.textContent = name;
  const badge = document.createElement('span');
  badge.className = `mcp-badge mcp-badge--${transport || 'unknown'}`;
  badge.textContent = transport || 'unknown';
  head.appendChild(title);
  head.appendChild(badge);

  const body = document.createElement('div');
  body.className = 'mcp-card-body';
  if (target) {
    const row = document.createElement('div');
    row.className = 'mcp-row';
    row.innerHTML = `<span class="mcp-row-label">${transport === 'stdio' ? 'command' : 'url'}</span>`;
    const code = document.createElement('code');
    code.className = 'mcp-row-value';
    code.textContent = target;
    row.appendChild(code);
    body.appendChild(row);
  }
  if (args && args.length) {
    const row = document.createElement('div');
    row.className = 'mcp-row';
    row.innerHTML = `<span class="mcp-row-label">args</span>`;
    const code = document.createElement('code');
    code.className = 'mcp-row-value';
    code.textContent = args.join(' ');
    row.appendChild(code);
    body.appendChild(row);
  }
  if (env && Object.keys(env).length) {
    const row = document.createElement('div');
    row.className = 'mcp-row';
    row.innerHTML = `<span class="mcp-row-label">env</span>`;
    const code = document.createElement('code');
    code.className = 'mcp-row-value';
    code.textContent = Object.keys(env).join(', ');
    row.appendChild(code);
    body.appendChild(row);
  }

  const actions = document.createElement('div');
  actions.className = 'mcp-card-actions';
  const docBtn = document.createElement('button');
  docBtn.type = 'button';
  docBtn.className = 'mcp-btn';
  docBtn.textContent = cardState.doctorBusy ? 'checking...' : 'doctor';
  docBtn.disabled = cardState.doctorBusy;
  docBtn.addEventListener('click', () => { void runDoctorOne(name); });
  const rmBtn = document.createElement('button');
  rmBtn.type = 'button';
  rmBtn.className = 'mcp-btn mcp-btn--danger';
  rmBtn.textContent = cardState.removing ? 'removing...' : 'remove';
  rmBtn.disabled = cardState.removing;
  rmBtn.addEventListener('click', () => { void removeServer(name); });
  actions.appendChild(docBtn);
  actions.appendChild(rmBtn);

  card.appendChild(head);
  card.appendChild(body);
  card.appendChild(actions);

  if (cardState.doctorResult || cardState.doctorError) {
    const out = document.createElement('pre');
    out.className = 'mcp-card-output';
    if (cardState.doctorError) {
      out.classList.add('mcp-card-output--err');
      out.textContent = cardState.doctorError;
    } else {
      out.textContent = formatJson(cardState.doctorResult);
    }
    card.appendChild(out);
  }

  return card;
}

function ensureCardState(name: string): CardState {
  let cs = state.cards.get(name);
  if (!cs) {
    cs = { doctorBusy: false, doctorResult: null, doctorError: null, removing: false };
    state.cards.set(name, cs);
  }
  return cs;
}

function readServerName(server: McpServer | unknown): string {
  if (!server || typeof server !== 'object') return String(server);
  const s = server as McpServer;
  return s.name || s.id || s.key || '';
}
function readTransport(server: McpServer | unknown): string {
  if (!server || typeof server !== 'object') return '';
  const s = server as McpServer;
  const t = s.type || s.transport;
  if (t) return String(t).toLowerCase();
  if (s.command) return 'stdio';
  if (s.url) return 'http';
  return '';
}
function readTarget(server: McpServer | unknown): string {
  if (!server || typeof server !== 'object') return '';
  const s = server as McpServer;
  if (s.command) return String(s.command);
  if (s.url) return String(s.url);
  return '';
}
function readArgs(server: McpServer | unknown): string[] {
  if (!server || typeof server !== 'object') return [];
  const s = server as McpServer;
  if (Array.isArray(s.args)) return (s.args as unknown[]).map(String);
  return [];
}
function readEnv(server: McpServer | unknown): Record<string, string> {
  if (!server || typeof server !== 'object') return {};
  const e = (server as McpServer).env;
  if (e && typeof e === 'object' && !Array.isArray(e)) return e as Record<string, string>;
  if (Array.isArray(e)) {
    const out: Record<string, string> = {};
    for (const pair of e) {
      if (typeof pair !== 'string') continue;
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      out[pair.slice(0, i)] = pair.slice(i + 1);
    }
    return out;
  }
  return {};
}

function formatJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

async function refreshList(): Promise<void> {
  state.loading = true;
  state.loadError = null;
  renderList();
  try {
    const resp = await api.mcp.list() as { servers?: unknown } | undefined;
    state.servers = Array.isArray(resp?.servers) ? (resp!.servers as McpServer[]) : [];
  } catch (err) {
    state.loadError = err instanceof Error ? err.message : String(err);
    state.servers = [];
  } finally {
    state.loading = false;
    const live = new Set(state.servers.map(readServerName));
    for (const k of Array.from(state.cards.keys())) {
      if (!live.has(k)) state.cards.delete(k);
    }
    renderList();
  }
}

async function submitAddForm(form: HTMLFormElement): Promise<void> {
  const fd = new FormData(form);
  const name = String(fd.get('name') || '').trim();
  const type = String(fd.get('type') || 'stdio');
  const command = String(fd.get('command') || '').trim();
  const url = String(fd.get('url') || '').trim();
  const argsRaw = String(fd.get('args') || '');
  const envRaw = String(fd.get('env') || '');

  if (!name) {
    state.formError = 'name is required';
    syncFormVisibility(form);
    return;
  }
  const body: AddServerBody = { name };
  if (type === 'stdio') {
    if (!command) {
      state.formError = 'command is required for stdio transport';
      syncFormVisibility(form);
      return;
    }
    body.command = command;
    const args = argsRaw.split('\n').map(s => s.trim()).filter(Boolean);
    if (args.length) body.args = args;
    const env: Record<string, string> = {};
    for (const line of envRaw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const i = t.indexOf('=');
      if (i <= 0) continue;
      env[t.slice(0, i)] = t.slice(i + 1);
    }
    if (Object.keys(env).length) body.env = env;
  } else {
    if (!url) {
      state.formError = `url is required for ${type} transport`;
      syncFormVisibility(form);
      return;
    }
    body.url = url;
    body.type = type;
  }

  state.formBusy = true;
  state.formError = null;
  syncFormVisibility(form);

  try {
    const resp = await api.mcp.add(body as unknown as Record<string, unknown>) as { servers?: unknown } | undefined;
    if (Array.isArray(resp?.servers)) state.servers = resp!.servers as McpServer[];
    form.reset();
    state.formType = 'stdio';
    renderList();
  } catch (err) {
    state.formError = err instanceof Error ? err.message : String(err);
  } finally {
    state.formBusy = false;
    syncFormVisibility(form);
  }
}

async function removeServer(name: string): Promise<void> {
  if (!confirm(`Remove MCP server "${name}"?`)) return;
  const cs = ensureCardState(name);
  cs.removing = true;
  renderList();
  try {
    const resp = await api.mcp.remove(name) as { servers?: unknown } | undefined;
    if (Array.isArray(resp?.servers)) state.servers = resp!.servers as McpServer[];
  } catch (err) {
    cs.doctorError = `remove failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    cs.removing = false;
    renderList();
  }
}

async function runDoctorOne(name: string): Promise<void> {
  const cs = ensureCardState(name);
  cs.doctorBusy = true;
  cs.doctorError = null;
  cs.doctorResult = null;
  renderList();
  try {
    const resp = await api.mcp.doctor(name) as { result?: unknown } | undefined;
    cs.doctorResult = resp && 'result' in (resp as Record<string, unknown>) ? (resp as { result: unknown }).result : resp;
  } catch (err) {
    cs.doctorError = err instanceof Error ? err.message : String(err);
  } finally {
    cs.doctorBusy = false;
    renderList();
  }
}

async function runDoctorAll(): Promise<void> {
  state.doctorAllBusy = true;
  state.doctorAllError = null;
  state.doctorAllResult = null;
  renderDoctorAll();
  try {
    const resp = await api.mcp.doctor() as { result?: unknown } | undefined;
    state.doctorAllResult = resp && 'result' in (resp as Record<string, unknown>) ? (resp as { result: unknown }).result : resp;
  } catch (err) {
    state.doctorAllError = err instanceof Error ? err.message : String(err);
  } finally {
    state.doctorAllBusy = false;
    renderDoctorAll();
  }
}

function renderDoctorAll(): void {
  if (!activeContainer) return;
  const slot = activeContainer.querySelector<HTMLElement>('[data-slot="doctor-all"]');
  if (!slot) return;
  slot.replaceChildren();
  const btn = activeContainer.querySelector<HTMLButtonElement>('[data-act="doctor-all"]');
  if (btn) {
    btn.disabled = state.doctorAllBusy;
    btn.textContent = state.doctorAllBusy ? 'checking...' : 'doctor all';
  }
  if (!state.doctorAllResult && !state.doctorAllError && !state.doctorAllBusy) {
    slot.hidden = true;
    return;
  }
  slot.hidden = false;
  if (state.doctorAllBusy) {
    const p = document.createElement('p');
    p.className = 'mcp-empty';
    p.textContent = 'running doctor on all servers...';
    slot.appendChild(p);
    return;
  }
  const out = document.createElement('pre');
  out.className = 'mcp-card-output';
  if (state.doctorAllError) {
    out.classList.add('mcp-card-output--err');
    out.textContent = state.doctorAllError;
  } else {
    out.textContent = formatJson(state.doctorAllResult);
  }
  slot.appendChild(out);
}

interface PickerState {
  bySlug: Map<string, McpRegistryEntry>;
  source: 'live' | 'static';
}

const KIND_BADGE_META: Record<ServerKind, { label: string; icon?: string; tooltip: string }> = {
  'local': {
    label: 'local',
    tooltip: 'Runs locally as a subprocess. No network calls.',
  },
  'api-wrapper': {
    label: 'api wrapper',
    icon: '⚙',
    tooltip: 'Runs locally but talks to a third-party API. Requires credentials.',
  },
  'remote': {
    label: 'remote',
    icon: '☁',
    tooltip: 'Hosted MCP service. Connects over HTTP or SSE.',
  },
};

function toPickEntry(e: McpRegistryEntry & { source?: string }): RegistryPickEntry {
  const tags: string[] = [e.transport];
  if (e.source === 'static') tags.push('fallback');
  const kind = classifyServerKind(e);
  const meta = KIND_BADGE_META[kind];
  const kindBadge: RegistryItemKindBadge = {
    kind,
    label: meta.label,
    tooltip: meta.tooltip,
    ...(meta.icon ? { icon: meta.icon } : {}),
  };
  return {
    slug: e.slug,
    name: e.name,
    description: e.description,
    group: e.category,
    tags,
    official: e.official,
    envHints: (e.env || []).map(v => `${v.required ? 'required' : 'optional'} env: ${v.name}${v.placeholder ? ` (${v.placeholder})` : ''}`),
    docsUrl: e.url_docs,
    kindBadge,
  };
}


function fromLive(le: LiveRegistryEntry): McpRegistryEntry {
  const env = le.env ? le.env.map(v => ({
    name: v.name,
    required: Boolean(v.required),
    ...(v.placeholder ? { placeholder: v.placeholder } : {}),
    ...(v.help ? { help: v.help } : {}),
  })) : undefined;
  return {
    name: le.name,
    slug: le.slug,
    description: le.description || '(no description)',
    category: le.category || 'other',
    transport: le.transport,
    ...(le.command ? { command: le.command } : {}),
    ...(le.args ? { args: le.args } : {}),
    ...(le.url ? { url: le.url } : {}),
    ...(env ? { env } : {}),
    ...(le.url_docs ? { url_docs: le.url_docs } : {}),
    official: Boolean(le.official),
  };
}

function dedupeBySlug(entries: McpRegistryEntry[]): McpRegistryEntry[] {
  const seen = new Map<string, McpRegistryEntry>();
  for (const e of entries) {
    if (!seen.has(e.slug)) seen.set(e.slug, e);
  }
  return Array.from(seen.values());
}

const STATIC_FALLBACK_ENTRIES: McpRegistryEntry[] = MCP_REGISTRY;

interface LiveLoadResult {
  entries: McpRegistryEntry[];
  fetchedAt?: string;
  state: PickerState;
}

async function loadLiveRegistry(): Promise<LiveLoadResult> {
  const resp = await api.mcp.getRegistry() as LiveRegistryResponse;
  if (resp && Array.isArray(resp.entries) && resp.entries.length) {
    const merged = dedupeBySlug(resp.entries.map(fromLive));
    const state: PickerState = { bySlug: new Map(merged.map(e => [e.slug, e])), source: 'live' };
    return { entries: merged, fetchedAt: resp.fetchedAt, state };
  }
  const state: PickerState = {
    bySlug: new Map(STATIC_FALLBACK_ENTRIES.map(e => [e.slug, e])),
    source: 'static',
  };
  return { entries: STATIC_FALLBACK_ENTRIES, state };
}

function openMcpRegistryPicker(): void {
  // Open instantly with the static seeds; swap in the live list once the
  // backend cache responds (or stays on the seeds if upstream is offline).
  let pickerState: PickerState = {
    bySlug: new Map(STATIC_FALLBACK_ENTRIES.map(e => [e.slug, e])),
    source: 'static',
  };

  const handle: McpPickerHandle = openMcpPicker({
    title: 'MCP server registry',
    totalLabel: 'servers',
    entries: STATIC_FALLBACK_ENTRIES,
    groupOrder: MCP_CATEGORIES,
    closeAfterAdd: true,
    storageKey: 'grok-remote.mcp-picker.filters',
    toPickEntry: (e) => toPickEntry({ ...e, source: pickerState.source === 'live' ? 'upstream' : 'static' }),
    onAdd: (slug) => {
      const entry = pickerState.bySlug.get(slug);
      if (entry) prefillMcpForm(entry);
    },
    onRefresh: async () => {
      const resp = await api.mcp.refreshRegistry() as LiveRegistryResponse;
      if (!resp || !Array.isArray(resp.entries)) {
        throw new Error(resp && resp.error ? resp.error : 'empty registry response');
      }
      const merged = dedupeBySlug(resp.entries.map(fromLive));
      pickerState = { bySlug: new Map(merged.map(e => [e.slug, e])), source: 'live' };
      return {
        entries: merged,
        fetchedAt: resp.fetchedAt,
        count: merged.length,
      };
    },
  });

  void (async () => {
    try {
      const live = await loadLiveRegistry();
      pickerState = live.state;
      handle.setEntries(live.entries, live.fetchedAt);
    } catch {
      // keep the seed picker visible. user can still hit refresh.
    }
  })();
}

function prefillMcpForm(entry: McpRegistryEntry): void {
  if (!activeContainer) return;
  const form = activeContainer.querySelector<HTMLFormElement>('[data-slot="form"]');
  if (!form) return;

  state.formType = entry.transport;
  state.formError = null;

  const nameInput = form.querySelector<HTMLInputElement>('input[name="name"]');
  if (nameInput) nameInput.value = entry.slug;

  const radio = form.querySelector<HTMLInputElement>(`input[name="type"][value="${entry.transport}"]`);
  if (radio) radio.checked = true;

  const commandInput = form.querySelector<HTMLInputElement>('input[name="command"]');
  const argsArea = form.querySelector<HTMLTextAreaElement>('textarea[name="args"]');
  const envArea = form.querySelector<HTMLTextAreaElement>('textarea[name="env"]');
  const urlInput = form.querySelector<HTMLInputElement>('input[name="url"]');

  if (entry.transport === 'stdio') {
    if (commandInput) commandInput.value = entry.command || '';
    if (argsArea) argsArea.value = (entry.args || []).join('\n');
    if (envArea) {
      const lines = (entry.env || []).map(v => `${v.name}=`);
      envArea.value = lines.join('\n');
    }
  } else {
    if (urlInput) urlInput.value = entry.url || '';
  }

  syncFormVisibility(form);

  const target = entry.transport === 'stdio'
    ? (entry.env && entry.env.length ? envArea : commandInput)
    : urlInput;
  queueMicrotask(() => {
    if (target instanceof HTMLTextAreaElement) {
      target.focus();
      const pos = target.value.indexOf('=');
      if (pos >= 0) {
        const cursor = pos + 1;
        target.setSelectionRange(cursor, cursor);
      }
    } else if (target instanceof HTMLInputElement) {
      target.focus();
    }
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
