// MCP servers routes.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { send, readJsonBody } from '../helpers.js';
import { runGrokJson, runGrok, errorToResponse } from '../../grok-cli.js';
import type { RouteRegistrar, RouteParams } from '../system.js';
import {
  fetchAllServers,
  readCache,
  writeCache,
  cacheAgeMs,
  normalizeAll,
  cachePath,
  type CacheFile,
} from '../../mcp-registry-upstream.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function register(add: RouteRegistrar): void {
  add('GET',    '/api/system/mcp',                 listHandler);
  add('POST',   '/api/system/mcp',                 addHandler);
  add('GET',    '/api/system/mcp/registry',         registryGetHandler);
  add('POST',   '/api/system/mcp/registry/refresh', registryRefreshHandler);
  add('DELETE', '/api/system/mcp/:name',           removeHandler);
  add('GET',    '/api/system/mcp/:name/doctor',    doctorOneHandler);
  add('GET',    '/api/system/mcp/doctor',          doctorAllHandler);
}

function normalizeList(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    return Object.entries(json as Record<string, unknown>).map(([name, value]) => {
      if (value && typeof value === 'object') return { name, ...(value as Record<string, unknown>) };
      return { name, value };
    });
  }
  return [];
}

async function fetchList(): Promise<unknown[]> {
  const json = await runGrokJson(['mcp', 'list', '--json']);
  return normalizeList(json);
}

async function listHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const servers = await fetchList();
    send(res, 200, { ok: true, servers });
  } catch (err) {
    send(res, 500, errorToResponse(err));
  }
}

interface AddBody {
  name?: unknown;
  command?: unknown;
  url?: unknown;
  type?: unknown;
  args?: unknown;
  env?: unknown;
}

async function addHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: AddBody;
  try {
    body = (await readJsonBody(req)) as AddBody;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid body';
    send(res, 400, { ok: false, error: msg });
    return;
  }

  const name    = typeof body.name === 'string' ? body.name.trim() : '';
  const command = typeof body.command === 'string' ? body.command.trim() : '';
  const url     = typeof body.url === 'string' ? body.url.trim() : '';
  const type    = typeof body.type === 'string' ? body.type.trim() : '';
  const args: string[] = Array.isArray(body.args)
    ? (body.args as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];
  const envIn   = body.env;

  if (!name) {
    send(res, 400, { ok: false, error: 'name is required' });
    return;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    send(res, 400, { ok: false, error: 'name must be alphanumeric (plus _ . -)' });
    return;
  }
  const hasCommand = command.length > 0;
  const hasUrl     = url.length > 0;
  if (hasCommand === hasUrl) {
    send(res, 400, { ok: false, error: 'provide exactly one of command or url' });
    return;
  }

  const envPairs: string[] = [];
  if (Array.isArray(envIn)) {
    for (const item of envIn as unknown[]) {
      if (typeof item === 'string' && item.includes('=')) envPairs.push(item);
    }
  } else if (envIn && typeof envIn === 'object') {
    for (const [k, v] of Object.entries(envIn as Record<string, unknown>)) {
      if (typeof k === 'string' && k.length && v !== undefined && v !== null) {
        envPairs.push(`${k}=${String(v)}`);
      }
    }
  }

  const argv: string[] = ['mcp', 'add', name];
  if (hasCommand) {
    argv.push('--command', command);
    if (args.length) {
      argv.push('--args', ...args);
    }
    for (const pair of envPairs) {
      argv.push('--env', pair);
    }
  } else {
    argv.push('--url', url);
    if (type) argv.push('--type', type);
  }

  try {
    await runGrok(argv);
  } catch (err) {
    send(res, 500, errorToResponse(err));
    return;
  }

  try {
    const servers = await fetchList();
    send(res, 200, { ok: true, servers });
  } catch (err) {
    send(res, 200, { ok: true, servers: [], warning: errorToResponse(err) });
  }
}

async function removeHandler(_req: IncomingMessage, res: ServerResponse, _url: URL, params?: RouteParams): Promise<void> {
  const name = params && params['name'];
  if (!name) {
    send(res, 400, { ok: false, error: 'name is required' });
    return;
  }
  try {
    await runGrok(['mcp', 'remove', name]);
  } catch (err) {
    send(res, 500, errorToResponse(err));
    return;
  }
  try {
    const servers = await fetchList();
    send(res, 200, { ok: true, servers });
  } catch (err) {
    send(res, 200, { ok: true, servers: [], warning: errorToResponse(err) });
  }
}

async function doctorOneHandler(_req: IncomingMessage, res: ServerResponse, _url: URL, params?: RouteParams): Promise<void> {
  const name = params && params['name'];
  if (!name) {
    send(res, 400, { ok: false, error: 'name is required' });
    return;
  }
  try {
    const result = await runGrokJson(['mcp', 'doctor', name, '--json']);
    send(res, 200, { ok: true, result });
  } catch (err) {
    send(res, 500, errorToResponse(err));
  }
}

async function doctorAllHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const result = await runGrokJson(['mcp', 'doctor', '--json']);
    send(res, 200, { ok: true, result });
  } catch (err) {
    send(res, 500, errorToResponse(err));
  }
}

// ---------------------------------------------------------------------------
// Live registry proxy.

let backgroundRefreshInFlight: Promise<void> | null = null;

function cacheToResponse(cache: CacheFile, stale: boolean): Record<string, unknown> {
  const entries = normalizeAll(cache.servers);
  return {
    ok: true,
    fetchedAt: cache.fetchedAt,
    count: entries.length,
    rawCount: cache.count,
    stale,
    cachePath: cachePath(),
    entries,
  };
}

async function refreshInBackground(): Promise<void> {
  if (backgroundRefreshInFlight) return backgroundRefreshInFlight;
  backgroundRefreshInFlight = (async () => {
    try {
      const servers = await fetchAllServers();
      await writeCache(servers);
    } catch {
      // swallow; the next refresh will retry
    } finally {
      backgroundRefreshInFlight = null;
    }
  })();
  return backgroundRefreshInFlight;
}

async function registryGetHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    let cache = await readCache();
    const age = await cacheAgeMs();
    if (!cache) {
      const servers = await fetchAllServers();
      cache = await writeCache(servers);
      send(res, 200, cacheToResponse(cache, false));
      return;
    }
    const stale = age === null ? true : age > CACHE_TTL_MS;
    if (stale) void refreshInBackground();
    send(res, 200, cacheToResponse(cache, stale));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { ok: false, error: msg });
  }
}

async function registryRefreshHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const servers = await fetchAllServers();
    const cache = await writeCache(servers);
    send(res, 200, cacheToResponse(cache, false));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 502, { ok: false, error: `registry refresh failed: ${msg}` });
  }
}
