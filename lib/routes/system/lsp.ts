// LSP servers routes. grok-cli reads language-server definitions from
// `~/.grok/lsp.json` (JSON), NOT from config.toml -- the [[lsp]] table form
// that earlier versions of this route emitted is silently ignored by grok,
// which is why "Add" looked broken: the route returned 200 but the LSP page
// reloaded against `grok inspect`, which never sees those entries.
//
// This route accepts the same registry-shaped payload the picker already
// sends (`language`, `command`, `args`, `root_markers`, optional `name`,
// `extensions`, `env`, `extras`) and merges it into the user's lsp.json,
// translating to grok's schema (`extensionToLanguage`, etc).

import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { send, readJsonBody } from '../helpers.js';
import type { RouteRegistrar } from '../system.js';

function userLspPath(): string {
  return path.join(os.homedir(), '.grok', 'lsp.json');
}

export function register(add: RouteRegistrar): void {
  add('POST', '/api/system/lsp/add', addHandler);
}

interface AddBody {
  name?: unknown;
  language?: unknown;
  command?: unknown;
  args?: unknown;
  root_markers?: unknown;
  rootMarkers?: unknown;
  extensions?: unknown;
  extensionToLanguage?: unknown;
  env?: unknown;
  initializationOptions?: unknown;
  settings?: unknown;
  startupTimeout?: unknown;
  shutdownTimeout?: unknown;
  restartOnCrash?: unknown;
  maxRestarts?: unknown;
  overwrite?: unknown;
}

interface ServerEntry {
  command: string;
  args?: string[];
  extensionToLanguage: Record<string, string>;
  rootMarkers?: string[];
  env?: Record<string, string>;
  initializationOptions?: unknown;
  settings?: unknown;
  startupTimeout?: number;
  shutdownTimeout?: number;
  restartOnCrash?: boolean;
  maxRestarts?: number;
}

interface NormalizedBody {
  name: string;
  command: string;
  args: string[];
  extensionToLanguage: Record<string, string>;
  rootMarkers: string[];
  env: Record<string, string>;
  initializationOptions?: unknown;
  settings?: unknown;
  startupTimeout?: number;
  shutdownTimeout?: number;
  restartOnCrash?: boolean;
  maxRestarts?: number;
  overwrite: boolean;
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

  let normalized: NormalizedBody;
  try {
    normalized = normalizeBody(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 400, { ok: false, error: msg });
    return;
  }

  const filePath = userLspPath();
  try {
    const result = mergeAndWrite(filePath, normalized);
    send(res, 200, {
      ok: true,
      configPath: filePath,
      name: normalized.name,
      entry: result.entry,
      overwrote: result.overwrote,
    });
  } catch (err) {
    if (err instanceof DuplicateNameError) {
      send(res, 409, { ok: false, error: err.message, name: normalized.name });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { ok: false, error: `failed to write ${filePath}: ${msg}` });
  }
}

class DuplicateNameError extends Error {
  constructor(name: string) {
    super(`server "${name}" is already configured (pass overwrite=true to replace)`);
    this.name = 'DuplicateNameError';
  }
}

function normalizeBody(body: AddBody): NormalizedBody {
  const language = typeof body.language === 'string' ? body.language.trim() : '';
  const explicitName = typeof body.name === 'string' ? body.name.trim() : '';
  const name = explicitName || language;
  if (!name) throw new Error('name or language is required');
  if (!/^[A-Za-z0-9_.\-]+$/.test(name)) {
    throw new Error('name must be alphanumeric (plus _ . -)');
  }

  const command = typeof body.command === 'string' ? body.command.trim() : '';
  if (!command) throw new Error('command is required');

  const args = filterStringArray(body.args);

  const markersRaw = body.root_markers ?? body.rootMarkers;
  const rootMarkers = filterStringArray(markersRaw).filter(s => s.length > 0);
  if (!rootMarkers.length) throw new Error('at least one root_marker is required');

  const extMap = buildExtensionMap(body, language);
  if (!Object.keys(extMap).length) {
    throw new Error('extensions (or extensionToLanguage) is required');
  }

  const env: Record<string, string> = {};
  if (body.env && typeof body.env === 'object' && !Array.isArray(body.env)) {
    for (const [k, v] of Object.entries(body.env as Record<string, unknown>)) {
      if (typeof k === 'string' && k.length && v !== undefined && v !== null) {
        env[k] = String(v);
      }
    }
  }

  const normalized: NormalizedBody = {
    name,
    command,
    args,
    extensionToLanguage: extMap,
    rootMarkers,
    env,
    overwrite: body.overwrite === true,
  };
  if (body.initializationOptions !== undefined) normalized.initializationOptions = body.initializationOptions;
  if (body.settings !== undefined) normalized.settings = body.settings;
  if (typeof body.startupTimeout === 'number') normalized.startupTimeout = body.startupTimeout;
  if (typeof body.shutdownTimeout === 'number') normalized.shutdownTimeout = body.shutdownTimeout;
  if (typeof body.restartOnCrash === 'boolean') normalized.restartOnCrash = body.restartOnCrash;
  if (typeof body.maxRestarts === 'number') normalized.maxRestarts = body.maxRestarts;
  return normalized;
}

function filterStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter((s): s is string => typeof s === 'string');
}

function buildExtensionMap(body: AddBody, languageFallback: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Preferred: caller already provides an extensionToLanguage map.
  if (body.extensionToLanguage && typeof body.extensionToLanguage === 'object' && !Array.isArray(body.extensionToLanguage)) {
    for (const [k, v] of Object.entries(body.extensionToLanguage as Record<string, unknown>)) {
      const key = normalizeExtKey(k);
      if (!key) continue;
      const lang = typeof v === 'string' ? v.trim() : '';
      if (!lang) continue;
      out[key] = lang;
    }
  }
  // Friendly shape from the registry / picker: `extensions: { ".ts": "typescript", ... }`.
  if (body.extensions && typeof body.extensions === 'object' && !Array.isArray(body.extensions)) {
    for (const [k, v] of Object.entries(body.extensions as Record<string, unknown>)) {
      const key = normalizeExtKey(k);
      if (!key) continue;
      const lang = typeof v === 'string' && v.trim().length ? v.trim() : languageFallback;
      if (!lang) continue;
      out[key] = lang;
    }
  }
  // Or `extensions: [".ts", ".tsx"]` -- map each to the language fallback.
  if (Array.isArray(body.extensions) && languageFallback) {
    for (const k of body.extensions as unknown[]) {
      if (typeof k !== 'string') continue;
      const key = normalizeExtKey(k);
      if (!key) continue;
      out[key] = languageFallback;
    }
  }
  return out;
}

function normalizeExtKey(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  return t.startsWith('.') ? t : '.' + t;
}

interface MergeResult { entry: ServerEntry; overwrote: boolean }

function mergeAndWrite(filePath: string, body: NormalizedBody): MergeResult {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const current = readCurrent(filePath);
  const existed = Object.prototype.hasOwnProperty.call(current, body.name);
  if (existed && !body.overwrite) {
    throw new DuplicateNameError(body.name);
  }
  const entry: ServerEntry = {
    command: body.command,
    extensionToLanguage: body.extensionToLanguage,
  };
  if (body.args.length) entry.args = body.args;
  if (body.rootMarkers.length) entry.rootMarkers = body.rootMarkers;
  if (Object.keys(body.env).length) entry.env = body.env;
  if (body.initializationOptions !== undefined) entry.initializationOptions = body.initializationOptions;
  if (body.settings !== undefined) entry.settings = body.settings;
  if (typeof body.startupTimeout === 'number') entry.startupTimeout = body.startupTimeout;
  if (typeof body.shutdownTimeout === 'number') entry.shutdownTimeout = body.shutdownTimeout;
  if (typeof body.restartOnCrash === 'boolean') entry.restartOnCrash = body.restartOnCrash;
  if (typeof body.maxRestarts === 'number') entry.maxRestarts = body.maxRestarts;

  const next: Record<string, ServerEntry> = { ...current, [body.name]: entry };
  atomicWriteJson(filePath, next);
  return { entry, overwrote: existed };
}

function readCurrent(filePath: string): Record<string, ServerEntry> {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const trimmed = raw.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`existing lsp.json is not valid JSON: ${msg}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('existing lsp.json must be a JSON object keyed by server name');
  }
  return parsed as Record<string, ServerEntry>;
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const body = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmp, body);
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

export const _internal = {
  userLspPath,
  normalizeBody,
  mergeAndWrite,
  readCurrent,
  atomicWriteJson,
  DuplicateNameError,
};
