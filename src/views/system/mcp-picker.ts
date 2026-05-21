// MCP-specific browse-registry UI. Wraps the shared registry picker with a
// faceted sidebar, sort dropdown, and chip-style active-filter breadcrumbs.

import {
  openRegistryPicker,
  type OpenRegistryPickerOptions,
  type RegistryPickEntry,
  type RegistryPickerSidebar,
  type RegistryPickerSidebarCtx,
  type RegistryRefreshResult,
} from './registry-picker.js';
import {
  activeFilterCount,
  applyFilters,
  classifyPackageSource,
  computeCounts,
  defaultFilters,
  deserializeFilters,
  PACKAGE_SOURCES,
  SERVER_KINDS,
  serializeFilters,
  TRANSPORTS,
  type EnvMode,
  type OfficialMode,
  type PackageSource,
  type PickerFilters,
  type RemoteMode,
  type ServerKind,
  type SortMode,
  type TransportKind,
} from './registry-filters.js';
import type { McpRegistryEntry } from './mcp-registry.js';

export interface McpPickerOptions {
  title: string;
  totalLabel?: string;
  entries: McpRegistryEntry[];
  groupOrder?: string[];
  closeAfterAdd?: boolean;
  fetchedAt?: string;
  onAdd: (slug: string) => void;
  onRefresh?: () => Promise<{ entries: McpRegistryEntry[]; fetchedAt?: string; count?: number }>;
  toPickEntry: (entry: McpRegistryEntry) => RegistryPickEntry;
  storageKey?: string;
}

const COLLAPSE_STATE_KEY_SUFFIX = '.collapsed';

interface CollapseState {
  category: boolean;
  kind: boolean;
  transport: boolean;
  package: boolean;
  toggles: boolean;
}

const DEFAULT_COLLAPSE: CollapseState = {
  category: false,
  kind: false,
  transport: false,
  package: false,
  toggles: false,
};

function readCollapse(key: string | undefined): CollapseState {
  if (!key || typeof localStorage === 'undefined') return { ...DEFAULT_COLLAPSE };
  try {
    const raw = localStorage.getItem(key + COLLAPSE_STATE_KEY_SUFFIX);
    if (!raw) return { ...DEFAULT_COLLAPSE };
    const obj = JSON.parse(raw) as Partial<CollapseState>;
    return {
      category: typeof obj.category === 'boolean' ? obj.category : false,
      kind: typeof obj.kind === 'boolean' ? obj.kind : false,
      transport: typeof obj.transport === 'boolean' ? obj.transport : false,
      package: typeof obj.package === 'boolean' ? obj.package : false,
      toggles: typeof obj.toggles === 'boolean' ? obj.toggles : false,
    };
  } catch {
    return { ...DEFAULT_COLLAPSE };
  }
}

function writeCollapse(key: string | undefined, state: CollapseState): void {
  if (!key || typeof localStorage === 'undefined') return;
  try { localStorage.setItem(key + COLLAPSE_STATE_KEY_SUFFIX, JSON.stringify(state)); }
  catch { /* ignore quota errors */ }
}

function readFilters(key: string | undefined): PickerFilters {
  if (!key || typeof localStorage === 'undefined') return defaultFilters();
  try { return deserializeFilters(localStorage.getItem(key)); }
  catch { return defaultFilters(); }
}

function writeFilters(key: string | undefined, f: PickerFilters): void {
  if (!key || typeof localStorage === 'undefined') return;
  try { localStorage.setItem(key, serializeFilters(f)); }
  catch { /* ignore */ }
}

interface SortOption { value: SortMode; label: string; }
const SORT_OPTIONS: SortOption[] = [
  { value: 'name-asc', label: 'name (a-z)' },
  { value: 'name-desc', label: 'name (z-a)' },
  { value: 'category', label: 'category' },
  { value: 'official', label: 'official first' },
];

interface PackageSourceMeta { value: PackageSource; label: string; }
const PACKAGE_SOURCE_LABELS: Record<PackageSource, string> = {
  npm: 'npm (npx)',
  docker: 'docker',
  python: 'python (uvx / pip)',
  go: 'go',
  other: 'other / remote-only',
};

const TRANSPORT_LABELS: Record<TransportKind, string> = {
  stdio: 'stdio',
  http: 'http',
  sse: 'sse',
};

const SERVER_KIND_LABELS: Record<ServerKind, string> = {
  local: 'local',
  'api-wrapper': 'api wrapper',
  remote: 'remote',
};

export interface McpPickerHandle {
  close: () => void;
  refresh: () => void;
  setEntries: (entries: McpRegistryEntry[], fetchedAt?: string) => void;
}

export function openMcpPicker(opts: McpPickerOptions): McpPickerHandle {
  let rawEntries: McpRegistryEntry[] = opts.entries.slice();
  const filters: PickerFilters = readFilters(opts.storageKey);
  const collapsed: CollapseState = readCollapse(opts.storageKey);

  let pickerCtx: RegistryPickerSidebarCtx | null = null;
  let sidebarRoot: HTMLElement | null = null;

  function persist(): void {
    writeFilters(opts.storageKey, filters);
  }

  function persistCollapse(): void {
    writeCollapse(opts.storageKey, collapsed);
  }

  function refreshAll(): void {
    persist();
    rebuildSidebar();
    pickerCtx?.refresh();
  }

  function rebuildSidebar(): void {
    if (!sidebarRoot) return;
    sidebarRoot.replaceChildren(...buildSidebarContent());
  }

  function visibleCounts() {
    return computeCounts(rawEntries, { ...filters, search: filters.search });
  }

  function buildSidebarContent(): HTMLElement[] {
    const counts = visibleCounts();
    const nodes: HTMLElement[] = [];

    nodes.push(makeCategorySection(counts.categories));
    nodes.push(makeServerKindSection(counts.kinds));
    nodes.push(makeTransportSection(counts.transports));
    nodes.push(makePackageSourceSection(counts.packageSources));
    nodes.push(makeTogglesSection(counts.totals));

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'registry-sidebar__reset';
    reset.textContent = 'Reset filters';
    reset.addEventListener('click', () => {
      const fresh = defaultFilters();
      Object.assign(filters, {
        category: fresh.category,
        transports: new Set<TransportKind>(),
        packageSources: new Set<PackageSource>(),
        kinds: new Set<ServerKind>(),
        officialMode: fresh.officialMode,
        envMode: fresh.envMode,
        remoteMode: fresh.remoteMode,
        search: '',
        sort: filters.sort, // keep sort
      });
      pickerCtx?.setSearch('');
      refreshAll();
    });
    nodes.push(reset);

    return nodes;
  }

  function makeSection(
    titleText: string,
    sectionKey: keyof CollapseState,
    buildItems: () => HTMLElement,
  ): HTMLElement {
    const sec = document.createElement('div');
    sec.className = 'registry-sidebar__section';
    if (collapsed[sectionKey]) sec.classList.add('registry-sidebar__section--collapsed');

    const heading = document.createElement('h4');
    heading.className = 'registry-sidebar__title';
    const label = document.createElement('span');
    label.textContent = titleText;
    const caret = document.createElement('span');
    caret.className = 'registry-sidebar__title-caret';
    caret.textContent = 'v';
    heading.appendChild(label);
    heading.appendChild(caret);
    heading.addEventListener('click', () => {
      collapsed[sectionKey] = !collapsed[sectionKey];
      persistCollapse();
      sec.classList.toggle('registry-sidebar__section--collapsed', collapsed[sectionKey]);
    });
    sec.appendChild(heading);

    const items = buildItems();
    items.classList.add('registry-sidebar__items');
    sec.appendChild(items);

    return sec;
  }

  function makeCategorySection(counts: Record<string, number>): HTMLElement {
    return makeSection('Categories', 'category', () => {
      const wrap = document.createElement('div');

      const totalAll = Object.values(counts).reduce((sum, n) => sum + n, 0);
      wrap.appendChild(buildCategoryRow(null, 'All servers', totalAll));

      const known = (opts.groupOrder || []).filter(c => c in counts);
      const extras = Object.keys(counts).filter(c => !known.includes(c)).sort();
      for (const cat of [...known, ...extras]) {
        wrap.appendChild(buildCategoryRow(cat, cat, counts[cat] || 0));
      }
      return wrap;
    });
  }

  function buildCategoryRow(value: string | null, label: string, count: number): HTMLElement {
    const row = document.createElement('label');
    row.className = 'registry-sidebar__item';
    const active = filters.category === value;
    if (active) row.classList.add('registry-sidebar__item--active');

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'mcp-picker-category';
    input.checked = active;
    input.addEventListener('change', () => {
      filters.category = value;
      refreshAll();
    });
    row.appendChild(input);

    const text = document.createElement('span');
    text.className = 'registry-sidebar__item-label';
    text.textContent = label;
    row.appendChild(text);

    const c = document.createElement('span');
    c.className = 'registry-sidebar__count';
    c.textContent = `(${count})`;
    row.appendChild(c);

    return row;
  }

  function makeServerKindSection(counts: Record<ServerKind, number>): HTMLElement {
    return makeSection('Server kind', 'kind', () => {
      const wrap = document.createElement('div');
      for (const k of SERVER_KINDS) {
        wrap.appendChild(buildCheckboxRow(
          SERVER_KIND_LABELS[k],
          counts[k] || 0,
          filters.kinds.has(k),
          (checked) => {
            if (checked) filters.kinds.add(k);
            else filters.kinds.delete(k);
            refreshAll();
          },
        ));
      }
      return wrap;
    });
  }

  function makeTransportSection(counts: Record<TransportKind, number>): HTMLElement {
    return makeSection('Transport', 'transport', () => {
      const wrap = document.createElement('div');
      for (const t of TRANSPORTS) {
        wrap.appendChild(buildCheckboxRow(
          TRANSPORT_LABELS[t],
          counts[t] || 0,
          filters.transports.has(t),
          (checked) => {
            if (checked) filters.transports.add(t);
            else filters.transports.delete(t);
            refreshAll();
          },
        ));
      }
      return wrap;
    });
  }

  function makePackageSourceSection(counts: Record<PackageSource, number>): HTMLElement {
    const meta: PackageSourceMeta[] = PACKAGE_SOURCES.map(v => ({ value: v, label: PACKAGE_SOURCE_LABELS[v] }));
    return makeSection('Package source', 'package', () => {
      const wrap = document.createElement('div');
      for (const m of meta) {
        wrap.appendChild(buildCheckboxRow(
          m.label,
          counts[m.value] || 0,
          filters.packageSources.has(m.value),
          (checked) => {
            if (checked) filters.packageSources.add(m.value);
            else filters.packageSources.delete(m.value);
            refreshAll();
          },
        ));
      }
      return wrap;
    });
  }

  function buildCheckboxRow(
    label: string,
    count: number,
    checked: boolean,
    onChange: (next: boolean) => void,
  ): HTMLElement {
    const row = document.createElement('label');
    row.className = 'registry-sidebar__item';
    if (checked) row.classList.add('registry-sidebar__item--active');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.addEventListener('change', () => onChange(cb.checked));
    row.appendChild(cb);
    const text = document.createElement('span');
    text.className = 'registry-sidebar__item-label';
    text.textContent = label;
    row.appendChild(text);
    const c = document.createElement('span');
    c.className = 'registry-sidebar__count';
    c.textContent = `(${count})`;
    row.appendChild(c);
    return row;
  }

  function makeTogglesSection(totals: { official: number; withEnv: number; remote: number }): HTMLElement {
    return makeSection('Toggles', 'toggles', () => {
      const wrap = document.createElement('div');
      wrap.appendChild(buildTriToggle(
        `Official badge (${totals.official})`,
        ['all', 'only', 'hide'],
        filters.officialMode,
        (next) => { filters.officialMode = next as OfficialMode; refreshAll(); },
      ));
      wrap.appendChild(buildTriToggle(
        `Has env vars (${totals.withEnv})`,
        ['all', 'with', 'without'],
        filters.envMode,
        (next) => { filters.envMode = next as EnvMode; refreshAll(); },
      ));
      wrap.appendChild(buildTriToggle(
        `Has remote URL (${totals.remote})`,
        ['all', 'remote', 'stdio-only'],
        filters.remoteMode,
        (next) => { filters.remoteMode = next as RemoteMode; refreshAll(); },
      ));
      return wrap;
    });
  }

  function buildTriToggle(
    labelText: string,
    options: string[],
    selected: string,
    onChange: (next: string) => void,
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '4px';
    wrap.style.marginBottom = '8px';
    const lab = document.createElement('span');
    lab.className = 'registry-sidebar__toggle-label';
    lab.textContent = labelText;
    wrap.appendChild(lab);
    const group = document.createElement('div');
    group.className = 'registry-sidebar__toggle';
    for (const o of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = humanToggleLabel(o);
      btn.setAttribute('aria-pressed', o === selected ? 'true' : 'false');
      btn.addEventListener('click', () => onChange(o));
      group.appendChild(btn);
    }
    wrap.appendChild(group);
    return wrap;
  }

  function humanToggleLabel(value: string): string {
    if (value === 'all') return 'all';
    if (value === 'only') return 'only';
    if (value === 'hide') return 'hide';
    if (value === 'with') return 'with';
    if (value === 'without') return 'no env';
    if (value === 'remote') return 'remote';
    if (value === 'stdio-only') return 'stdio';
    return value;
  }

  function renderChips(): HTMLElement | null {
    const chips: Array<{ label: string; onRemove: () => void }> = [];
    if (filters.category) {
      chips.push({
        label: `category: ${filters.category}`,
        onRemove: () => { filters.category = null; refreshAll(); },
      });
    }
    if (filters.transports.size) {
      const list = Array.from(filters.transports).join(', ');
      chips.push({
        label: `transport: ${list}`,
        onRemove: () => { filters.transports.clear(); refreshAll(); },
      });
    }
    if (filters.packageSources.size) {
      const list = Array.from(filters.packageSources).join(', ');
      chips.push({
        label: `package: ${list}`,
        onRemove: () => { filters.packageSources.clear(); refreshAll(); },
      });
    }
    if (filters.kinds.size) {
      const list = Array.from(filters.kinds).map(k => SERVER_KIND_LABELS[k]).join(', ');
      chips.push({
        label: `kind: ${list}`,
        onRemove: () => { filters.kinds.clear(); refreshAll(); },
      });
    }
    if (filters.officialMode !== 'all') {
      chips.push({
        label: `official: ${filters.officialMode}`,
        onRemove: () => { filters.officialMode = 'all'; refreshAll(); },
      });
    }
    if (filters.envMode !== 'all') {
      chips.push({
        label: `env: ${filters.envMode}`,
        onRemove: () => { filters.envMode = 'all'; refreshAll(); },
      });
    }
    if (filters.remoteMode !== 'all') {
      chips.push({
        label: `remote: ${filters.remoteMode}`,
        onRemove: () => { filters.remoteMode = 'all'; refreshAll(); },
      });
    }
    if (filters.search.trim()) {
      chips.push({
        label: `search: ${filters.search.trim()}`,
        onRemove: () => { filters.search = ''; pickerCtx?.setSearch(''); refreshAll(); },
      });
    }
    if (!chips.length) return null;
    const wrap = document.createElement('div');
    for (const chip of chips) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'registry-picker__chip';
      const text = document.createElement('span');
      text.textContent = chip.label;
      el.appendChild(text);
      const x = document.createElement('span');
      x.className = 'registry-picker__chip-remove';
      x.textContent = 'x';
      el.appendChild(x);
      el.addEventListener('click', chip.onRemove);
      wrap.appendChild(el);
    }
    return wrap;
  }

  function renderSortHeader(): HTMLElement {
    const sel = document.createElement('select');
    sel.className = 'registry-picker__sort';
    for (const o of SORT_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = `sort: ${o.label}`;
      if (filters.sort === o.value) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      filters.sort = sel.value as SortMode;
      refreshAll();
    });
    return sel;
  }

  function renderEmpty(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'registry-picker__empty';
    const p = document.createElement('p');
    p.style.margin = '0 0 8px';
    p.textContent = 'no servers match those filters.';
    wrap.appendChild(p);
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'registry-picker__empty-cta';
    cta.textContent = 'Reset filters';
    cta.addEventListener('click', () => {
      Object.assign(filters, {
        category: null,
        transports: new Set<TransportKind>(),
        packageSources: new Set<PackageSource>(),
        kinds: new Set<ServerKind>(),
        officialMode: 'all',
        envMode: 'all',
        remoteMode: 'all',
        search: '',
      });
      pickerCtx?.setSearch('');
      refreshAll();
    });
    wrap.appendChild(cta);
    return wrap;
  }

  const sidebar: RegistryPickerSidebar = {
    render(ctx) {
      pickerCtx = ctx;
      sidebarRoot = document.createElement('aside');
      sidebarRoot.replaceChildren(...buildSidebarContent());
      return sidebarRoot;
    },
    renderHeader(ctx) {
      pickerCtx = ctx;
      return renderSortHeader();
    },
    renderChips() {
      return renderChips();
    },
    renderEmpty() {
      return renderEmpty();
    },
    filter(_pickEntries, query) {
      filters.search = query;
      persist();
      const filtered = applyFilters(rawEntries, filters);
      return filtered.map(opts.toPickEntry);
    },
    statusSuffix() {
      const n = activeFilterCount(filters);
      if (n === 0) return null;
      return `${n} filter${n === 1 ? '' : 's'} active`;
    },
  };

  const initialPick: RegistryPickEntry[] = applyFilters(rawEntries, filters).map(opts.toPickEntry);

  const pickerOpts: OpenRegistryPickerOptions = {
    title: opts.title,
    groupLabel: 'category',
    totalLabel: opts.totalLabel,
    entries: initialPick,
    groupOrder: opts.groupOrder,
    closeAfterAdd: opts.closeAfterAdd,
    fetchedAt: opts.fetchedAt,
    onAdd: opts.onAdd,
    sidebar,
    initialSearch: filters.search,
    onRefresh: opts.onRefresh
      ? async (): Promise<RegistryRefreshResult> => {
          const res = await opts.onRefresh!();
          rawEntries = res.entries.slice();
          rebuildSidebar();
          return {
            entries: applyFilters(rawEntries, filters).map(opts.toPickEntry),
            fetchedAt: res.fetchedAt,
            count: rawEntries.length,
          };
        }
      : undefined,
  };

  const handle = openRegistryPicker(pickerOpts);

  return {
    close: handle.close,
    refresh: () => { rebuildSidebar(); handle.refresh(); },
    setEntries(next: McpRegistryEntry[], when?: string): void {
      rawEntries = next.slice();
      rebuildSidebar();
      handle.update(applyFilters(rawEntries, filters).map(opts.toPickEntry), when);
    },
  };
}

export { applyFilters, classifyPackageSource, computeCounts };
