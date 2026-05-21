// Pure filter + facet-count helpers for the MCP registry picker.
// Kept free of DOM so the test runner can exercise it directly.

import type { McpRegistryEntry } from './mcp-registry.js';

export type TransportKind = 'stdio' | 'http' | 'sse';
export type PackageSource = 'npm' | 'docker' | 'python' | 'go' | 'other';
export type OfficialMode = 'all' | 'only' | 'hide';
export type EnvMode = 'all' | 'with' | 'without';
export type RemoteMode = 'all' | 'remote' | 'stdio-only';
export type SortMode = 'name-asc' | 'name-desc' | 'category' | 'official';
export type ServerKind = 'local' | 'api-wrapper' | 'remote';

export interface PickerFilters {
  category: string | null;
  transports: Set<TransportKind>;
  packageSources: Set<PackageSource>;
  kinds: Set<ServerKind>;
  officialMode: OfficialMode;
  envMode: EnvMode;
  remoteMode: RemoteMode;
  search: string;
  sort: SortMode;
}

export interface PickerCounts {
  categories: Record<string, number>;
  transports: Record<TransportKind, number>;
  packageSources: Record<PackageSource, number>;
  kinds: Record<ServerKind, number>;
  totals: { official: number; withEnv: number; remote: number };
}

const TRANSPORT_VALUES: readonly TransportKind[] = ['stdio', 'http', 'sse'];
const PACKAGE_SOURCE_VALUES: readonly PackageSource[] = ['npm', 'docker', 'python', 'go', 'other'];
const SERVER_KIND_VALUES: readonly ServerKind[] = ['local', 'api-wrapper', 'remote'];

export function defaultFilters(): PickerFilters {
  return {
    category: null,
    transports: new Set(),
    packageSources: new Set(),
    kinds: new Set(),
    officialMode: 'all',
    envMode: 'all',
    remoteMode: 'all',
    search: '',
    sort: 'name-asc',
  };
}

export function classifyPackageSource(entry: McpRegistryEntry): PackageSource {
  if (entry.transport !== 'stdio') return 'other';
  const cmd = (entry.command || '').toLowerCase();
  if (!cmd) return 'other';
  if (cmd === 'npx' || cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn' || cmd === 'bunx' || cmd === 'bun') return 'npm';
  if (cmd === 'docker' || cmd === 'podman') return 'docker';
  if (cmd === 'uvx' || cmd === 'uv' || cmd === 'pipx' || cmd === 'pip' || cmd === 'python' || cmd === 'python3') return 'python';
  if (cmd === 'go' || cmd === 'gorun') return 'go';
  return 'other';
}

export function hasEnv(entry: McpRegistryEntry): boolean {
  return Array.isArray(entry.env) && entry.env.length > 0;
}

export function isRemote(entry: McpRegistryEntry): boolean {
  return entry.transport === 'http' || entry.transport === 'sse';
}

export function classifyServerKind(entry: McpRegistryEntry): ServerKind {
  if (entry.transport === 'http' || entry.transport === 'sse') return 'remote';
  const hasCommand = typeof entry.command === 'string' && entry.command.trim().length > 0;
  if (!hasCommand && typeof entry.url === 'string' && entry.url.trim().length > 0) return 'remote';
  return hasEnv(entry) ? 'api-wrapper' : 'local';
}

function matchesSearch(entry: McpRegistryEntry, query: string): boolean {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${entry.name} ${entry.slug} ${entry.description} ${entry.category}`.toLowerCase();
  return hay.includes(q);
}

function matchesCategory(entry: McpRegistryEntry, category: string | null): boolean {
  if (!category) return true;
  return entry.category === category;
}

function matchesTransport(entry: McpRegistryEntry, set: Set<TransportKind>): boolean {
  if (!set || set.size === 0) return true;
  return set.has(entry.transport);
}

function matchesPackageSource(entry: McpRegistryEntry, set: Set<PackageSource>): boolean {
  if (!set || set.size === 0) return true;
  return set.has(classifyPackageSource(entry));
}

function matchesKind(entry: McpRegistryEntry, set: Set<ServerKind>): boolean {
  if (!set || set.size === 0) return true;
  return set.has(classifyServerKind(entry));
}

function matchesOfficial(entry: McpRegistryEntry, mode: OfficialMode): boolean {
  if (mode === 'only') return Boolean(entry.official);
  if (mode === 'hide') return !entry.official;
  return true;
}

function matchesEnv(entry: McpRegistryEntry, mode: EnvMode): boolean {
  if (mode === 'with') return hasEnv(entry);
  if (mode === 'without') return !hasEnv(entry);
  return true;
}

function matchesRemote(entry: McpRegistryEntry, mode: RemoteMode): boolean {
  if (mode === 'remote') return isRemote(entry);
  if (mode === 'stdio-only') return entry.transport === 'stdio';
  return true;
}

function sortEntries(entries: McpRegistryEntry[], mode: SortMode): McpRegistryEntry[] {
  const out = entries.slice();
  const byName = (a: McpRegistryEntry, b: McpRegistryEntry) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  if (mode === 'name-asc') {
    out.sort(byName);
  } else if (mode === 'name-desc') {
    out.sort((a, b) => byName(b, a));
  } else if (mode === 'category') {
    out.sort((a, b) => {
      const c = a.category.localeCompare(b.category, undefined, { sensitivity: 'base' });
      return c !== 0 ? c : byName(a, b);
    });
  } else if (mode === 'official') {
    out.sort((a, b) => {
      const ao = a.official ? 0 : 1;
      const bo = b.official ? 0 : 1;
      return ao !== bo ? ao - bo : byName(a, b);
    });
  }
  return out;
}

export function applyFilters(entries: McpRegistryEntry[], f: PickerFilters): McpRegistryEntry[] {
  const filtered = entries.filter(e =>
    matchesCategory(e, f.category) &&
    matchesTransport(e, f.transports) &&
    matchesPackageSource(e, f.packageSources) &&
    matchesKind(e, f.kinds) &&
    matchesOfficial(e, f.officialMode) &&
    matchesEnv(e, f.envMode) &&
    matchesRemote(e, f.remoteMode) &&
    matchesSearch(e, f.search),
  );
  return sortEntries(filtered, f.sort);
}

// Amazon-style faceted counts: each facet shows the count assuming every
// OTHER facet stays applied. That way clicking an option always lands on a
// non-empty list (unless other filters were already empty).
export function computeCounts(entries: McpRegistryEntry[], f: PickerFilters): PickerCounts {
  const categories: Record<string, number> = {};
  const transports: Record<TransportKind, number> = { stdio: 0, http: 0, sse: 0 };
  const packageSources: Record<PackageSource, number> = { npm: 0, docker: 0, python: 0, go: 0, other: 0 };
  const kinds: Record<ServerKind, number> = { local: 0, 'api-wrapper': 0, remote: 0 };
  const totals = { official: 0, withEnv: 0, remote: 0 };

  for (const e of entries) {
    const passSearch = matchesSearch(e, f.search);
    const passCategory = matchesCategory(e, f.category);
    const passTransport = matchesTransport(e, f.transports);
    const passPkg = matchesPackageSource(e, f.packageSources);
    const passKind = matchesKind(e, f.kinds);
    const passOfficial = matchesOfficial(e, f.officialMode);
    const passEnv = matchesEnv(e, f.envMode);
    const passRemote = matchesRemote(e, f.remoteMode);

    const otherPasses = passSearch && passTransport && passPkg && passKind && passOfficial && passEnv && passRemote;
    if (otherPasses) {
      categories[e.category] = (categories[e.category] || 0) + 1;
    }

    if (passSearch && passCategory && passPkg && passKind && passOfficial && passEnv && passRemote) {
      transports[e.transport] = (transports[e.transport] || 0) + 1;
    }

    if (passSearch && passCategory && passTransport && passKind && passOfficial && passEnv && passRemote) {
      const src = classifyPackageSource(e);
      packageSources[src] = (packageSources[src] || 0) + 1;
    }

    if (passSearch && passCategory && passTransport && passPkg && passOfficial && passEnv && passRemote) {
      const k = classifyServerKind(e);
      kinds[k] = (kinds[k] || 0) + 1;
    }

    if (passSearch && passCategory && passTransport && passPkg && passKind && passEnv && passRemote) {
      if (e.official) totals.official++;
    }
    if (passSearch && passCategory && passTransport && passPkg && passKind && passOfficial && passRemote) {
      if (hasEnv(e)) totals.withEnv++;
    }
    if (passSearch && passCategory && passTransport && passPkg && passKind && passOfficial && passEnv) {
      if (isRemote(e)) totals.remote++;
    }
  }

  for (const t of TRANSPORT_VALUES) if (!(t in transports)) transports[t] = 0;
  for (const s of PACKAGE_SOURCE_VALUES) if (!(s in packageSources)) packageSources[s] = 0;
  for (const k of SERVER_KIND_VALUES) if (!(k in kinds)) kinds[k] = 0;

  return { categories, transports, packageSources, kinds, totals };
}

export function activeFilterCount(f: PickerFilters): number {
  let n = 0;
  if (f.category) n++;
  if (f.transports.size > 0) n++;
  if (f.packageSources.size > 0) n++;
  if (f.kinds.size > 0) n++;
  if (f.officialMode !== 'all') n++;
  if (f.envMode !== 'all') n++;
  if (f.remoteMode !== 'all') n++;
  if (f.search.trim().length > 0) n++;
  return n;
}

export function serializeFilters(f: PickerFilters): string {
  return JSON.stringify({
    category: f.category,
    transports: Array.from(f.transports),
    packageSources: Array.from(f.packageSources),
    kinds: Array.from(f.kinds),
    officialMode: f.officialMode,
    envMode: f.envMode,
    remoteMode: f.remoteMode,
    search: f.search,
    sort: f.sort,
  });
}

export function deserializeFilters(raw: string | null | undefined): PickerFilters {
  const base = defaultFilters();
  if (!raw) return base;
  try {
    const obj = JSON.parse(raw) as Partial<{
      category: string | null;
      transports: TransportKind[];
      packageSources: PackageSource[];
      kinds: ServerKind[];
      officialMode: OfficialMode;
      envMode: EnvMode;
      remoteMode: RemoteMode;
      search: string;
      sort: SortMode;
    }>;
    if (typeof obj.category === 'string' || obj.category === null) base.category = obj.category;
    if (Array.isArray(obj.transports)) base.transports = new Set(obj.transports.filter(t => TRANSPORT_VALUES.includes(t)));
    if (Array.isArray(obj.packageSources)) base.packageSources = new Set(obj.packageSources.filter(s => PACKAGE_SOURCE_VALUES.includes(s)));
    if (Array.isArray(obj.kinds)) base.kinds = new Set(obj.kinds.filter(k => SERVER_KIND_VALUES.includes(k)));
    if (obj.officialMode === 'all' || obj.officialMode === 'only' || obj.officialMode === 'hide') base.officialMode = obj.officialMode;
    if (obj.envMode === 'all' || obj.envMode === 'with' || obj.envMode === 'without') base.envMode = obj.envMode;
    if (obj.remoteMode === 'all' || obj.remoteMode === 'remote' || obj.remoteMode === 'stdio-only') base.remoteMode = obj.remoteMode;
    if (typeof obj.search === 'string') base.search = obj.search;
    if (obj.sort === 'name-asc' || obj.sort === 'name-desc' || obj.sort === 'category' || obj.sort === 'official') base.sort = obj.sort;
  } catch {
    // ignore corrupt state and fall back to defaults
  }
  return base;
}

export const TRANSPORTS: readonly TransportKind[] = TRANSPORT_VALUES;
export const PACKAGE_SOURCES: readonly PackageSource[] = PACKAGE_SOURCE_VALUES;
export const SERVER_KINDS: readonly ServerKind[] = SERVER_KIND_VALUES;
