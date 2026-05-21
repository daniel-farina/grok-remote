// Talks to the official MCP Registry (registry.modelcontextprotocol.io v0).
// Walks the cursor pagination, caches the result to ~/.grok-remote/mcp-registry-cache.json,
// and exposes normalized entries the existing picker UI can render.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_BASE = 'https://registry.modelcontextprotocol.io';
const PAGE_LIMIT = 100;
const MAX_PAGES = 200; // safety cap, currently ~95 pages of latest-only at write time

export interface UpstreamArgument {
  type?: 'positional' | 'named';
  name?: string;
  value?: string;
  default?: string;
  description?: string;
  format?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  isRepeated?: boolean;
  valueHint?: string;
}

export interface UpstreamEnvVar {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
}

export interface UpstreamPackage {
  registryType: string;          // npm | pypi | oci | nuget | mcpb | etc
  identifier: string;            // package name (or oci image)
  version?: string;
  runtimeHint?: string;          // npx | uvx | docker | etc
  transport?: { type: string; url?: string };
  runtimeArguments?: UpstreamArgument[];
  packageArguments?: UpstreamArgument[];
  environmentVariables?: UpstreamEnvVar[];
}

export interface UpstreamRemote {
  type: string;                  // streamable-http | sse | etc
  url: string;
  headers?: Array<{ name: string; description?: string; isSecret?: boolean }>;
}

export interface UpstreamServer {
  name: string;                  // e.g. io.github.modelcontextprotocol/server-github
  title?: string;
  description: string;
  version?: string;
  packages?: UpstreamPackage[];
  remotes?: UpstreamRemote[];
  repository?: { url?: string; source?: string };
  websiteUrl?: string;
}

export interface UpstreamMeta {
  status?: string;
  isLatest?: boolean;
  publishedAt?: string;
  updatedAt?: string;
}

export interface UpstreamEntry {
  server: UpstreamServer;
  _meta?: Record<string, UpstreamMeta>;
}

export interface UpstreamListResponse {
  servers: UpstreamEntry[];
  metadata?: { nextCursor?: string; count?: number };
}

export interface CacheFile {
  fetchedAt: string;            // ISO timestamp
  count: number;
  source: 'upstream';
  baseUrl: string;
  servers: UpstreamServer[];
}

function cacheDir(): string {
  const home = process.env['HOME'] || os.homedir();
  return path.join(home, '.grok-remote');
}

export function cachePath(): string {
  return path.join(cacheDir(), 'mcp-registry-cache.json');
}

export async function readCache(): Promise<CacheFile | null> {
  try {
    const raw = await fs.readFile(cachePath(), 'utf8');
    const parsed = JSON.parse(raw) as CacheFile;
    if (!parsed || !Array.isArray(parsed.servers)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeCache(servers: UpstreamServer[], baseUrl: string = DEFAULT_BASE): Promise<CacheFile> {
  await fs.mkdir(cacheDir(), { recursive: true });
  const payload: CacheFile = {
    fetchedAt: new Date().toISOString(),
    count: servers.length,
    source: 'upstream',
    baseUrl,
    servers,
  };
  await fs.writeFile(cachePath(), JSON.stringify(payload, null, 0), 'utf8');
  return payload;
}

export async function cacheAgeMs(): Promise<number | null> {
  try {
    const st = await fs.stat(cachePath());
    return Date.now() - st.mtimeMs;
  } catch {
    return null;
  }
}

async function fetchPage(baseUrl: string, cursor: string | null): Promise<UpstreamListResponse> {
  const qs = new URLSearchParams();
  qs.set('limit', String(PAGE_LIMIT));
  qs.set('version', 'latest');
  if (cursor) qs.set('cursor', cursor);
  const url = `${baseUrl}/v0/servers?${qs}`;
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (r.status === 429 || r.status === 503) {
    const retry = Number(r.headers.get('retry-after')) || 2;
    await sleep(retry * 1000);
    return fetchPage(baseUrl, cursor);
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`registry list failed: HTTP ${r.status} ${txt.slice(0, 200)}`);
  }
  return (await r.json()) as UpstreamListResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchAllServers(baseUrl: string = DEFAULT_BASE): Promise<UpstreamServer[]> {
  const all: UpstreamServer[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp: UpstreamListResponse = await fetchPage(baseUrl, cursor);
    if (Array.isArray(resp.servers)) {
      for (const entry of resp.servers) {
        if (entry && entry.server) all.push(entry.server);
      }
    }
    const next = resp.metadata && resp.metadata.nextCursor;
    if (!next || typeof next !== 'string') break;
    cursor = next;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Normalization to the existing McpRegistryEntry shape used by the picker UI.

export interface NormalizedEntry {
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

const CATEGORY_RULES: Array<{ test: RegExp; category: string }> = [
  { test: /(github|gitlab|bitbucket|git\b|jira|linear|notion|confluence|slack|teams|discord)/i, category: 'development' },
  { test: /(postgres|mysql|sqlite|redis|mongo|clickhouse|duckdb|bigquery|snowflake|database|sql)/i, category: 'data' },
  { test: /(playwright|puppeteer|browser|chrome|selenium|web-scrap)/i, category: 'browser' },
  { test: /(search|brave|google|duckduckgo|fetch|web|crawl)/i, category: 'search' },
  { test: /(memory|knowledge|note|obsidian|reminder|todo|calendar|email|gmail)/i, category: 'productivity' },
  { test: /(filesystem|file-system|files|fs\b)/i, category: 'development' },
];

function categorize(name: string, description: string): string {
  // Only the last segment of the name plus the description. Otherwise the
  // very common "io.github.*" prefix swallows the heuristic.
  const slash = name.lastIndexOf('/');
  const leaf = slash >= 0 ? name.slice(slash + 1) : name;
  const hay = `${leaf} ${description}`.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.test.test(hay)) return rule.category;
  }
  return 'other';
}

function lastSegment(name: string): string {
  const slash = name.lastIndexOf('/');
  const raw = slash >= 0 ? name.slice(slash + 1) : name;
  return raw.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

function isOfficialName(name: string): boolean {
  // The official upstream uses the io.github.modelcontextprotocol namespace
  // for reference servers. We also flag a few well-known vendor namespaces.
  const lower = name.toLowerCase();
  if (lower.startsWith('io.github.modelcontextprotocol/')) return true;
  if (lower.startsWith('com.microsoft/')) return true;
  if (lower.startsWith('com.notion/') || lower.startsWith('com.notionhq/')) return true;
  if (lower.startsWith('com.anthropic/')) return true;
  return false;
}

function pickPackage(pkgs: UpstreamPackage[]): UpstreamPackage | null {
  const order = ['npm', 'pypi', 'oci', 'docker', 'mcpb', 'nuget'];
  for (const want of order) {
    const found = pkgs.find(p => (p.registryType || '').toLowerCase() === want);
    if (found) return found;
  }
  return pkgs[0] || null;
}

function commandFromPackage(pkg: UpstreamPackage): { command: string; args: string[] } | null {
  const hint = (pkg.runtimeHint || '').toLowerCase();
  const reg = (pkg.registryType || '').toLowerCase();
  const id = pkg.identifier;
  if (!id) return null;

  if (hint === 'npx' || reg === 'npm') {
    const versioned = pkg.version ? `${id}@${pkg.version}` : id;
    return { command: 'npx', args: ['-y', versioned] };
  }
  if (hint === 'uvx' || reg === 'pypi') {
    const args: string[] = [];
    if (pkg.version) args.push(`${id}==${pkg.version}`);
    else args.push(id);
    return { command: 'uvx', args };
  }
  if (hint === 'docker' || reg === 'oci' || reg === 'docker') {
    return { command: 'docker', args: ['run', '-i', '--rm', id] };
  }
  if (hint === 'dotnet' || reg === 'nuget') {
    return { command: 'dotnet', args: ['tool', 'run', id] };
  }
  // Fallback: best-effort, treat identifier as the command itself.
  return { command: id, args: [] };
}

function normalizeRemoteTransport(t: string): 'http' | 'sse' {
  const lower = (t || '').toLowerCase();
  if (lower === 'sse') return 'sse';
  return 'http';
}

function envFromPackage(pkg: UpstreamPackage): NormalizedEntry['env'] {
  const vars = pkg.environmentVariables;
  if (!Array.isArray(vars) || !vars.length) return undefined;
  return vars.map(v => ({
    name: v.name,
    required: Boolean(v.isRequired),
    placeholder: v.default || (v.isSecret ? '****' : undefined),
    help: v.description,
  }));
}

export function normalizeUpstream(upstream: UpstreamServer): NormalizedEntry | null {
  if (!upstream || !upstream.name) return null;
  const name = upstream.name;
  const description = upstream.description || '';
  const slug = lastSegment(name);
  const category = categorize(name, description);
  const official = isOfficialName(name);
  const docs = (upstream.repository && upstream.repository.url) || upstream.websiteUrl;

  const pkgs = Array.isArray(upstream.packages) ? upstream.packages : [];
  const remotes = Array.isArray(upstream.remotes) ? upstream.remotes : [];

  if (pkgs.length) {
    const pkg = pickPackage(pkgs);
    if (pkg) {
      const cmd = commandFromPackage(pkg);
      if (cmd) {
        return {
          name,
          slug,
          description,
          category,
          transport: 'stdio',
          command: cmd.command,
          args: cmd.args,
          env: envFromPackage(pkg),
          url_docs: docs,
          official,
          source: 'upstream',
        };
      }
    }
  }

  if (remotes.length) {
    const r = remotes[0];
    if (r && r.url) {
      return {
        name,
        slug,
        description,
        category,
        transport: normalizeRemoteTransport(r.type),
        url: r.url,
        url_docs: docs,
        official,
        source: 'upstream',
      };
    }
  }

  return null;
}

export function normalizeAll(servers: UpstreamServer[]): NormalizedEntry[] {
  const seen = new Set<string>();
  const out: NormalizedEntry[] = [];
  for (const s of servers) {
    const e = normalizeUpstream(s);
    if (!e) continue;
    // Dedupe by upstream name (we already filter latest, but be defensive).
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push(e);
  }
  // Stable sort: official first, then by name.
  out.sort((a, b) => {
    if (a.official !== b.official) return a.official ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}
