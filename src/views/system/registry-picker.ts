// Generic "Browse registry" modal used by the MCP and LSP settings pages.

export interface RegistryPickEntry {
  slug: string;
  name: string;
  description: string;
  group: string;
  tags?: string[];
  official?: boolean;
  envHints?: string[];
  docsUrl?: string;
}

export interface RegistryRefreshResult {
  entries: RegistryPickEntry[];
  fetchedAt?: string;
  count?: number;
}

export interface OpenRegistryPickerOptions {
  title: string;
  groupLabel: string;
  entries: RegistryPickEntry[];
  groupOrder?: string[];
  onAdd: (slug: string) => void;
  closeAfterAdd?: boolean;
  // Optional live-refresh hook. When provided, a refresh button appears in
  // the header. The handler should call upstream, then return the new
  // entries plus an optional fetchedAt timestamp for the status line.
  onRefresh?: () => Promise<RegistryRefreshResult>;
  fetchedAt?: string;
  totalLabel?: string; // e.g. "servers"
}

export interface RegistryPickerHandle {
  close: () => void;
  update: (entries: RegistryPickEntry[], fetchedAt?: string) => void;
}

export function openRegistryPicker(opts: OpenRegistryPickerOptions): RegistryPickerHandle {
  ensurePickerStyles();

  const root = document.createElement('div');
  root.className = 'registry-picker';

  const backdrop = document.createElement('div');
  backdrop.className = 'registry-picker__backdrop';
  root.appendChild(backdrop);

  const card = document.createElement('div');
  card.className = 'registry-picker__card';
  root.appendChild(card);

  let entries: RegistryPickEntry[] = opts.entries.slice();
  let fetchedAt: string | undefined = opts.fetchedAt;
  let refreshing = false;

  const head = document.createElement('header');
  head.className = 'registry-picker__head';
  const h2 = document.createElement('h2');
  h2.textContent = opts.title;
  const headActions = document.createElement('div');
  headActions.className = 'registry-picker__head-actions';
  let refreshBtn: HTMLButtonElement | null = null;
  if (typeof opts.onRefresh === 'function') {
    refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'mcp-btn';
    refreshBtn.textContent = 'refresh';
    refreshBtn.title = 'Re-fetch from upstream registry';
    refreshBtn.addEventListener('click', () => { void doRefresh(); });
    headActions.appendChild(refreshBtn);
  }
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'mcp-btn';
  closeBtn.textContent = 'close';
  headActions.appendChild(closeBtn);
  head.appendChild(h2);
  head.appendChild(headActions);
  card.appendChild(head);

  const status = document.createElement('div');
  status.className = 'registry-picker__status';
  card.appendChild(status);

  const filterRow = document.createElement('div');
  filterRow.className = 'registry-picker__filter';
  const filter = document.createElement('input');
  filter.type = 'text';
  filter.placeholder = 'filter...';
  filter.autocomplete = 'off';
  filterRow.appendChild(filter);
  card.appendChild(filterRow);

  const body = document.createElement('div');
  body.className = 'registry-picker__body';
  card.appendChild(body);

  function close(): void {
    document.removeEventListener('keydown', onKey);
    if (root.parentNode) root.parentNode.removeChild(root);
  }
  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
  }
  backdrop.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  async function doRefresh(): Promise<void> {
    if (!opts.onRefresh || refreshing) return;
    refreshing = true;
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'refreshing...';
    }
    paintStatus(null);
    try {
      const result = await opts.onRefresh();
      entries = result.entries.slice();
      fetchedAt = result.fetchedAt;
      paint(filter.value);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      paintStatus(`refresh failed: ${msg}`);
    } finally {
      refreshing = false;
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'refresh';
      }
    }
  }

  function paintStatus(errorMsg: string | null): void {
    status.replaceChildren();
    if (errorMsg) {
      status.classList.add('registry-picker__status--err');
      status.textContent = errorMsg;
      return;
    }
    status.classList.remove('registry-picker__status--err');
    const total = entries.length;
    const visible = countFiltered(filter.value);
    const label = opts.totalLabel || 'entries';
    const parts: string[] = [];
    if (visible === total) parts.push(`${total} ${label}`);
    else parts.push(`showing ${visible} of ${total} ${label}`);
    if (fetchedAt) parts.push(`updated ${formatRelative(fetchedAt)}`);
    status.textContent = parts.join(' . ');
  }

  function countFiltered(query: string): number {
    const q = query.trim().toLowerCase();
    if (!q) return entries.length;
    let n = 0;
    for (const e of entries) {
      const hay = `${e.name} ${e.slug} ${e.description} ${e.group} ${(e.tags || []).join(' ')}`.toLowerCase();
      if (hay.includes(q)) n++;
    }
    return n;
  }

  function paint(query: string): void {
    body.replaceChildren();
    paintStatus(null);
    const q = query.trim().toLowerCase();
    const filtered = entries.filter(e => {
      if (!q) return true;
      const hay = `${e.name} ${e.slug} ${e.description} ${e.group} ${(e.tags || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'registry-picker__empty';
      empty.textContent = 'nothing matches that filter.';
      body.appendChild(empty);
      return;
    }
    const groups = new Map<string, RegistryPickEntry[]>();
    for (const e of filtered) {
      if (!groups.has(e.group)) groups.set(e.group, []);
      groups.get(e.group)!.push(e);
    }
    const order = (opts.groupOrder && opts.groupOrder.length)
      ? opts.groupOrder.filter(g => groups.has(g)).concat(Array.from(groups.keys()).filter(g => !opts.groupOrder!.includes(g)))
      : Array.from(groups.keys());
    for (const g of order) {
      const items = groups.get(g);
      if (!items || !items.length) continue;
      const section = document.createElement('section');
      section.className = 'registry-picker__group';
      const heading = document.createElement('h3');
      heading.className = 'registry-picker__group-title';
      heading.textContent = `${opts.groupLabel}: ${g}`;
      section.appendChild(heading);
      for (const e of items) section.appendChild(renderItem(e));
      body.appendChild(section);
    }
  }

  function renderItem(e: RegistryPickEntry): HTMLElement {
    const item = document.createElement('article');
    item.className = 'registry-item';

    const itemHead = document.createElement('div');
    itemHead.className = 'registry-item__head';
    const title = document.createElement('span');
    title.className = 'registry-item__title';
    title.textContent = e.name;
    itemHead.appendChild(title);
    if (e.official) {
      const badge = document.createElement('span');
      badge.className = 'registry-item__badge';
      badge.textContent = 'official';
      itemHead.appendChild(badge);
    }
    if (Array.isArray(e.tags)) {
      for (const tag of e.tags) {
        const t = document.createElement('span');
        t.className = 'registry-item__tag';
        t.textContent = tag;
        itemHead.appendChild(t);
      }
    }
    item.appendChild(itemHead);

    const desc = document.createElement('p');
    desc.className = 'registry-item__desc';
    desc.textContent = e.description;
    item.appendChild(desc);

    if (Array.isArray(e.envHints) && e.envHints.length) {
      const envList = document.createElement('ul');
      envList.className = 'registry-item__env-list';
      for (const h of e.envHints) {
        const li = document.createElement('li');
        li.textContent = h;
        envList.appendChild(li);
      }
      item.appendChild(envList);
    }

    const actions = document.createElement('div');
    actions.className = 'registry-item__actions';
    if (e.docsUrl) {
      const a = document.createElement('a');
      a.href = e.docsUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'registry-item__docs';
      a.textContent = 'docs';
      actions.appendChild(a);
    }
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'mcp-btn mcp-btn--primary';
    addBtn.textContent = 'add';
    addBtn.addEventListener('click', () => {
      opts.onAdd(e.slug);
      if (opts.closeAfterAdd) close();
    });
    actions.appendChild(addBtn);
    item.appendChild(actions);

    return item;
  }

  filter.addEventListener('input', () => paint(filter.value));
  paint('');

  document.body.appendChild(root);
  queueMicrotask(() => filter.focus());
  return {
    close,
    update(next: RegistryPickEntry[], when?: string): void {
      entries = next.slice();
      if (when) fetchedAt = when;
      paint(filter.value);
    },
  };
}

let stylesInstalled = false;
function ensurePickerStyles(): void {
  if (stylesInstalled || typeof document === 'undefined') return;
  stylesInstalled = true;
  const css = `
.registry-picker__head-actions { display: flex; gap: 6px; }
.registry-picker__status {
  padding: 6px 18px;
  font-size: 11px;
  color: var(--muted, #888);
  border-bottom: 1px solid var(--border, #2a2a2a);
}
.registry-picker__status--err { color: var(--err, #e06060); }
.registry-item__tag {
  background: var(--bg-soft, #1c1c1c);
  color: var(--muted, #999);
  border-radius: 3px;
  padding: 1px 5px;
  font-size: 10px;
  margin-left: 6px;
}
`;
  const tag = document.createElement('style');
  tag.setAttribute('data-from', 'registry-picker');
  tag.textContent = css;
  document.head.appendChild(tag);
}

export function formatRelative(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Math.max(0, now - t);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} seconds ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const y = Math.floor(mo / 12);
  return `${y} year${y === 1 ? '' : 's'} ago`;
}
