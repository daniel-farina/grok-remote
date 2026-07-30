#!/usr/bin/env node
// grok-remote server

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

import { AgentManager, type PublicAgent } from './lib/agent-manager.js';
import { load as loadSettings, save as saveSettings } from './lib/settings.js';
import {
  listFolders,
  createFolder,
  updateFolder,
  removeFolder,
  assignAgentToFolder,
  setArchivedForAgent,
} from './lib/folders.js';
import { startRetentionTimer } from './lib/retention.js';
import { inferDevServerUrl } from './lib/dev-url.js';
import { readAll as readHistory, dedupeHistoryByUpstreamEventId } from './lib/history.js';
import { writeHeaders as sseHeaders, writeEvent as sseWrite, writePing as ssePing } from './lib/sse.js';
import { buildTrace, buildTraceForSessionId } from './lib/trace-host.js';
import { handleSystem } from './lib/routes/system.js';
import { runGrokText, errorToResponse } from './lib/grok-cli.js';
import {
  readCurrentVersion,
  readLatestVersion,
  readDiff as readVersionDiff,
  runUpdate as runVersionUpdate,
  isUpdateInProgress,
  readReleases,
  type UpdateStepEvent,
} from './lib/version-update.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const PORT = parseInt(process.env['PORT'] || '7910', 10);
const HOST = process.env['HOST'] || '0.0.0.0';

const APP_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch { return '0.0.0'; }
})();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

const manager = new AgentManager();

interface TailscaleIdentity {
  backend: string;
  dns: string;
  ip: string;
  hostname: string;
}

function safeJoin(base: string, rel: string): string | null {
  const target = path.resolve(base, '.' + rel);
  if (!target.startsWith(base)) return null;
  return target;
}

function tailscaleIdentity(): TailscaleIdentity | null {
  const r = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout) as { Self?: { DNSName?: string; TailscaleIPs?: string[]; HostName?: string }; BackendState?: string };
    const self = j.Self || {};
    return {
      backend: j.BackendState || '',
      dns: (self.DNSName || '').replace(/\.$/, ''),
      ip:  (self.TailscaleIPs && self.TailscaleIPs[0]) || '',
      hostname: self.HostName || os.hostname(),
    };
  } catch { return null; }
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = decodeURIComponent((req.url || '/').split('?')[0] || '/');
  const rel = url === '/' ? '/index.html' : url;
  let target = safeJoin(DIST, rel);
  if (!target || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = path.join(DIST, 'index.html');
  }
  if (!fs.existsSync(target)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('grok-remote: dist/ not built yet. Run `npm run build` (or `npm run install:setup`).\n');
    return;
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage, limitBytes: number = 32 * 1024 * 1024): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > limitBytes) {
        req.destroy();
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.length) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reject(new Error(`invalid json: ${msg}`));
      }
    });
    req.on('error', reject);
  });
}

function matchAgentRoute(url: string): { id: string; suffix: string } | null {
  const m = url.match(/^\/api\/agents\/([^\/]+)(\/[^?]*)?$/);
  if (!m || !m[1]) return null;
  return { id: m[1], suffix: m[2] || '' };
}

function isNodeErr(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in (err as object);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: string, method: string): Promise<void> {
  if (url === '/api/hello' && method === 'GET') {
    const ts = tailscaleIdentity();
    sendJson(res, 200, {
      ok: true,
      app: 'grok-remote',
      version: APP_VERSION,
      message: 'remote up. agent endpoints land here soon.',
      now: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      node: process.version,
      platform: process.platform,
      hostname: os.hostname(),
      tailscale: ts,
    });
    return;
  }

  if (url === '/api/health' && method === 'GET') {
    sendJson(res, 200, { ok: true, version: APP_VERSION, uptime_seconds: Math.floor(process.uptime()) });
    return;
  }

  if (url === '/api/version/current' && method === 'GET') {
    try {
      const data = await readCurrentVersion();
      sendJson(res, 200, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: msg });
    }
    return;
  }
  if (url === '/api/version/latest' && method === 'GET') {
    try {
      const data = await readLatestVersion();
      sendJson(res, 200, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: msg });
    }
    return;
  }
  if (url === '/api/version/diff' && method === 'GET') {
    try {
      const data = await readVersionDiff();
      sendJson(res, 200, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: msg });
    }
    return;
  }
  if ((url === '/api/version/releases' || url.startsWith('/api/version/releases?'))
      && method === 'GET') {
    try {
      const force = /\bforce=1\b/.test(url);
      const data = await readReleases({ force });
      sendJson(res, 200, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: msg });
    }
    return;
  }
  if (url === '/api/version/update' && method === 'POST') {
    if (isUpdateInProgress()) {
      sendJson(res, 409, { ok: false, error: 'update already in progress' });
      return;
    }
    handleVersionUpdateStream(req, res);
    return;
  }

  if (url === '/api/settings' && method === 'GET') {
    sendJson(res, 200, loadSettings());
    return;
  }

  if (url === '/api/settings' && method === 'PATCH') {
    try {
      const body = await readJsonBody(req);
      const merged = saveSettings((body || {}) as Record<string, unknown>);
      sendJson(res, 200, merged);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { ok: false, error: msg });
    }
    return;
  }

  if (url === '/api/agents' && method === 'GET') {
    sendJson(res, 200, manager.list());
    return;
  }

  if (url === '/api/agents/stream' && method === 'GET') {
    handleAgentsStream(req, res);
    return;
  }

  if (url === '/api/folders' && method === 'GET') {
    sendJson(res, 200, listFolders());
    return;
  }

  if (url === '/api/folders' && method === 'POST') {
    try {
      const body = (await readJsonBody(req) || {}) as Record<string, unknown>;
      const name = typeof body['name'] === 'string' ? body['name'] : '';
      const f = createFolder(name);
      sendJson(res, 201, f);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { ok: false, error: msg });
    }
    return;
  }

  {
    const fm = url.match(/^\/api\/folders\/([^\/?]+)$/);
    if (fm) {
      const id = fm[1] || '';
      if (method === 'PATCH') {
        try {
          const body = (await readJsonBody(req) || {}) as Record<string, unknown>;
          const patch: { name?: string; agentIds?: string[] } = {};
          if (typeof body['name'] === 'string') patch.name = body['name'];
          if (Array.isArray(body['agentIds'])) {
            patch.agentIds = (body['agentIds'] as unknown[])
              .filter((x): x is string => typeof x === 'string');
          }
          const out = updateFolder(id, patch);
          sendJson(res, 200, out);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = msg === 'folder not found' ? 404 : 400;
          sendJson(res, code, { ok: false, error: msg });
        }
        return;
      }
      if (method === 'DELETE') {
        const ok = removeFolder(id);
        sendJson(res, ok ? 200 : 404, { ok });
        return;
      }
    }
  }

  if (url === '/api/bg-terminals' && method === 'GET') {
    handleGlobalBgTerminals(_req(req), res);
    return;
  }

  {
    const sm = url.match(/^\/api\/subagents\/([^\/]+)\/trace$/);
    if (sm && method === 'GET') {
      const sid = sm[1] || '';
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(sid)) {
        sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
        return;
      }
      try {
        const data = await buildTraceForSessionId(sid);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(data));
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
        return;
      }
    }
  }

  {
    const sm = url.match(/^\/api\/subagents\/([^\/]+)\/updates(?:\?.*)?$/);
    if (sm && method === 'GET') {
      const sid = sm[1] || '';
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(sid)) {
        sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
        return;
      }
      const qs   = new URL(req.url || '/', 'http://x').searchParams;
      const cwd  = qs.get('cwd') || '';
      const root = path.join(os.homedir(), '.grok', 'sessions');

      function tryReadUpdates(sessionDir: string): unknown[] | null {
        const p = path.join(sessionDir, 'updates.jsonl');
        if (!fs.existsSync(p)) return null;
        let raw: string;
        try { raw = fs.readFileSync(p, 'utf8'); }
        catch { return null; }
        const out: unknown[] = [];
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          try { out.push(JSON.parse(t)); } catch { /* skip malformed */ }
        }
        return out;
      }

      let updates: unknown[] | null = null;
      let sourceDir: string | null = null;

      if (cwd) {
        const dir = path.join(root, encodeURIComponent(cwd), sid);
        updates = tryReadUpdates(dir);
        if (updates) sourceDir = dir;
      }
      if (!updates) {
        try {
          const cwds = fs.readdirSync(root);
          for (const enc of cwds) {
            const dir = path.join(root, enc, sid);
            const got = tryReadUpdates(dir);
            if (got) { updates = got; sourceDir = dir; break; }
          }
        } catch { /* root may not exist yet */ }
      }

      if (!updates) {
        sendJson(res, 404, {
          ok: false, error: 'session dir not flushed yet', sessionId: sid,
        });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({
        ok: true,
        sessionId: sid,
        source: 'direct',
        sourceDir,
        updates,
      }));
      return;
    }
  }

  if (url === '/api/agents' && method === 'POST') {
    try {
      const body = (await readJsonBody(req) || {}) as Record<string, unknown>;
      const defaults = loadSettings();
      const settings = { ...((body['settings'] as Record<string, unknown>) || {}) };
      if (!body['model'] && !settings['model'] && defaults.defaultModel) {
        settings['model'] = defaults.defaultModel;
      }
      if (typeof settings['alwaysApprove'] !== 'boolean' && typeof defaults.autoApprove === 'boolean') {
        settings['alwaysApprove'] = defaults.autoApprove;
      }
      const merged = {
        ...body,
        settings,
        ...(!body['cwd'] && defaults.defaultCwd ? { cwd: defaults.defaultCwd } : {}),
      };
      const rec = await manager.spawn(merged as never);
      sendJson(res, 201, rec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { ok: false, error: msg });
    }
    return;
  }

  const route = matchAgentRoute(url);
  if (route) {
    const { id, suffix } = route;
    const rec = manager.get(id);
    if (!rec) { sendJson(res, 404, { ok: false, error: 'agent not found' }); return; }

    if (suffix === '' && method === 'GET') {
      sendJson(res, 200, rec);
      return;
    }
    if (suffix === '' && method === 'PATCH') {
      try {
        const body = (await readJsonBody(req) || {}) as Record<string, unknown>;
        const out = await manager.update(id, body as never);
        // Side-effect: archive toggles also move the agent into / out of the
        // system "Archived" folder so the sidebar shows one canonical location.
        if (typeof body['archived'] === 'boolean') {
          try { setArchivedForAgent(id, body['archived'] as boolean); }
          catch { /* folder side-effect should never fail the patch response */ }
        }
        sendJson(res, 200, out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }
    if (suffix === '' && method === 'DELETE') {
      const ok = await manager.kill(id);
      sendJson(res, ok ? 200 : 404, { ok });
      return;
    }
    if (suffix === '/folder' && method === 'PUT') {
      try {
        const body = (await readJsonBody(req) || {}) as Record<string, unknown>;
        const raw = body['folderId'];
        const folderId = raw === null || raw === undefined ? null : String(raw);
        const out = assignAgentToFolder(id, folderId);
        sendJson(res, 200, { ok: true, folder: out });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = msg === 'folder not found' ? 404 : 400;
        sendJson(res, code, { ok: false, error: msg });
      }
      return;
    }
    if (suffix === '/prompt' && method === 'POST') {
      try {
        const body = (await readJsonBody(req)) as { text?: unknown; attachments?: unknown };
        const text = body?.text;
        const attachments = Array.isArray(body?.attachments) ? body.attachments as Record<string, unknown>[] : [];
        const hasText = typeof text === 'string' && text.length > 0;
        if (!hasText && !attachments.length) {
          sendJson(res, 400, { ok: false, error: 'text or attachments required' });
          return;
        }
        for (const att of attachments) {
          if (!att || typeof att !== 'object') {
            sendJson(res, 400, { ok: false, error: 'invalid attachment' });
            return;
          }
          if ((att as { kind?: unknown }).kind !== 'image') {
            sendJson(res, 400, { ok: false, error: `unsupported attachment kind: ${String((att as { kind?: unknown }).kind)}` });
            return;
          }
          const mt = (att as { mimeType?: unknown }).mimeType;
          if (typeof mt !== 'string' || !mt.startsWith('image/')) {
            sendJson(res, 400, { ok: false, error: 'attachment.mimeType must be image/*' });
            return;
          }
          const db = (att as { dataBase64?: unknown }).dataBase64;
          if (typeof db !== 'string' || !db.length) {
            sendJson(res, 400, { ok: false, error: 'attachment.dataBase64 required' });
            return;
          }
        }
        const result = await manager.prompt(id, { text: hasText ? (text as string) : '', attachments: attachments as never });
        sendJson(res, 202, { ok: true, accepted: true, debug: result?.debug || null });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }
    if (suffix === '/cancel' && method === 'POST') {
      await manager.cancel(id);
      sendJson(res, 202, { ok: true, accepted: true });
      return;
    }
    if (suffix === '/disconnect' && method === 'POST') {
      try {
        const out = await manager.disconnect(id);
        sendJson(res, 200, out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }
    if (suffix === '/connect' && method === 'POST') {
      try {
        const out = await manager.connect(id);
        sendJson(res, 202, out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }
    if (suffix === '/history' && method === 'GET') {
      const urlObj = new URL(req.url || '/', 'http://x');
      const all = urlObj.searchParams.get('all') === '1';
      const turnsParam = parseInt(urlObj.searchParams.get('turns') || '50', 10);
      const turns = Number.isFinite(turnsParam) && turnsParam > 0 ? turnsParam : 50;
      const sliced = sliceHistoryByTurns(readHistory(id) || '', { all, turns });
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'X-Total-Turns': String(sliced.totalTurns),
        'X-Returned-Turns': String(sliced.returnedTurns),
      });
      res.end(sliced.text);
      return;
    }
    if (suffix === '/files' && method === 'GET') {
      handleFilesList(req, res, rec);
      return;
    }
    if (suffix === '/trace' && method === 'GET') {
      try {
        const data = await buildTrace(rec as never);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(data));
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
        return;
      }
    }
    if (suffix === '/files/raw' && (method === 'GET' || method === 'HEAD')) {
      handleFilesRaw(req, res, rec, method);
      return;
    }
    if (suffix === '/stream' && method === 'GET') {
      handleStream(req, res, id);
      return;
    }
    if (suffix === '/terminals' && method === 'GET') {
      handleTerminalList(req, res, rec);
      return;
    }
    {
      const tmatch = suffix.match(/^\/terminals\/([^/]+)(\/kill)?$/);
      if (tmatch) {
        const tid = tmatch[1] || '';
        const kill = !!tmatch[2];
        if (kill && method === 'POST')  { handleTerminalKill(req, res, rec, tid); return; }
        if (!kill && method === 'GET')  { handleTerminalRead(req, res, rec, tid); return; }
      }
    }
    {
      const bgmatch = suffix.match(/^\/bg-tasks\/([^/]+)$/);
      if (bgmatch && method === 'GET') {
        handleBgTaskRead(req, res, rec, bgmatch[1] || '');
        return;
      }
    }
    if (suffix === '/publish' && method === 'POST') {
      const sessionId = rec.sessionId || rec.lastSessionId;
      if (!sessionId) {
        sendJson(res, 400, {
          ok: false,
          error: 'agent has no sessionId yet; complete at least one turn before publishing',
        });
        return;
      }
      try {
        const stdout = await runGrokText(['share', sessionId], {
          timeoutMs: 60_000,
          maxBytes: 256 * 1024,
        });
        const m = stdout.match(/https?:\/\/\S+/);
        const url2 = m ? m[0].replace(/[)\].,;]+$/, '') : null;
        if (!url2) {
          sendJson(res, 500, {
            ok: false,
            error: 'grok share did not print a URL',
            stdout: stdout.slice(-2000),
          });
          return;
        }
        sendJson(res, 200, { ok: true, url: url2, sessionId, stdout });
      } catch (err) {
        sendJson(res, 500, errorToResponse(err));
      }
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
}

interface SliceHistoryOptions { all: boolean; turns: number }
interface SliceHistoryResult { text: string; totalTurns: number; returnedTurns: number }

function sliceHistoryByTurns(raw: string, { all, turns }: SliceHistoryOptions): SliceHistoryResult {
  if (!raw) return { text: '', totalTurns: 0, returnedTurns: 0 };
  // Strip session-resume duplicates so the client never re-paints prior
  // assistant text into the latest bubble when reloading after reconnect.
  const deduped = dedupeHistoryByUpstreamEventId(raw);
  const lines = deduped.split('\n').filter(Boolean);
  const userMessageIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || '';
    if (line.indexOf('"user_message"') === -1) continue;
    try {
      const obj = JSON.parse(line) as { event?: string };
      if (obj && obj.event === 'user_message') userMessageIndices.push(i);
    } catch { /* skip malformed */ }
  }
  const totalTurns = userMessageIndices.length;
  if (all || totalTurns <= turns) {
    return { text: lines.join('\n') + (lines.length ? '\n' : ''), totalTurns, returnedTurns: totalTurns };
  }
  const cutoffLineIdx = userMessageIndices[totalTurns - turns];
  if (cutoffLineIdx == null) {
    return { text: lines.join('\n') + (lines.length ? '\n' : ''), totalTurns, returnedTurns: totalTurns };
  }
  const sliced = lines.slice(cutoffLineIdx);
  return { text: sliced.join('\n') + '\n', totalTurns, returnedTurns: turns };
}

const FILE_MAX_BYTES = 256_000;

function withinAgentScope(scopeDir: string, target: string): boolean {
  const scope = path.resolve(scopeDir);
  const resolved = path.resolve(target);
  return resolved === scope || resolved.startsWith(scope + path.sep);
}

function _req(req: IncomingMessage): IncomingMessage { return req; }

function handleFilesList(req: IncomingMessage, res: ServerResponse, rec: PublicAgent): void {
  const cwd = rec && rec.cwd;
  if (!cwd) { sendJson(res, 404, { ok: false, error: 'agent cwd missing' }); return; }

  const urlObj = new URL(req.url || '/', 'http://x');
  const rel = urlObj.searchParams.get('path') || '';
  const cleanRel = String(rel).replace(/^\/+/, '');

  let target: string;
  try {
    target = path.resolve(cwd, cleanRel);
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid path' });
    return;
  }
  if (!withinAgentScope(cwd, target)) {
    sendJson(res, 400, { ok: false, error: 'path escapes agent scope' });
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch (err) {
    if (isNodeErr(err) && err.code === 'ENOENT') {
      sendJson(res, 404, { ok: false, error: 'path not found' });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, error: msg });
    return;
  }

  if (stat.isDirectory()) {
    let names: string[];
    try {
      names = fs.readdirSync(target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: msg });
      return;
    }
    interface DirEntry { name: string; type: 'directory'; entries: null; isHidden: boolean }
    interface FileEntry { name: string; type: 'file'; size: number; mtime: string; isHidden: boolean }
    const dirs: DirEntry[] = [];
    const files: FileEntry[] = [];
    for (const name of names) {
      const full = path.join(target, name);
      let s: fs.Stats;
      try { s = fs.lstatSync(full); }
      catch { continue; }
      const isHidden = name.startsWith('.');
      if (s.isDirectory()) {
        dirs.push({ name, type: 'directory', entries: null, isHidden });
      } else if (s.isFile()) {
        files.push({
          name,
          type: 'file',
          size: s.size,
          mtime: s.mtime.toISOString(),
          isHidden,
        });
      } else {
        files.push({
          name,
          type: 'file',
          size: s.size,
          mtime: s.mtime.toISOString(),
          isHidden,
        });
      }
    }
    const cmp = <T extends { isHidden: boolean; name: string }>(a: T, b: T): number => {
      if (a.isHidden !== b.isHidden) return a.isHidden ? 1 : -1;
      return a.name.localeCompare(b.name);
    };
    dirs.sort(cmp);
    files.sort(cmp);
    sendJson(res, 200, {
      type: 'directory',
      path: cleanRel,
      entries: [...dirs, ...files],
    });
    return;
  }

  if (stat.isFile()) {
    if (stat.size > FILE_MAX_BYTES) {
      sendJson(res, 200, {
        type: 'file',
        path: cleanRel,
        size: stat.size,
        truncated: true,
        content: null,
        reason: 'too_large',
      });
      return;
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: msg });
      return;
    }
    const sniff = buf.subarray(0, Math.min(512, buf.length));
    let binary = false;
    for (let i = 0; i < sniff.length; i++) {
      if (sniff[i] === 0) { binary = true; break; }
    }
    if (binary) {
      sendJson(res, 200, {
        type: 'file',
        path: cleanRel,
        size: stat.size,
        binary: true,
        content: null,
      });
      return;
    }
    sendJson(res, 200, {
      type: 'file',
      path: cleanRel,
      size: stat.size,
      binary: false,
      mtime: stat.mtime.toISOString(),
      content: buf.toString('utf8'),
    });
    return;
  }

  sendJson(res, 400, { ok: false, error: 'unsupported file type' });
}

const RAW_MAX_BYTES = 200 * 1024 * 1024;

const RAW_MIME: Record<string, string> = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.bmp':  'image/bmp',
  '.ico':  'image/x-icon',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mov':  'video/quicktime',
  '.ogv':  'video/ogg',
  '.m4v':  'video/x-m4v',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.m4a':  'audio/mp4',
  '.flac': 'audio/flac',
  '.pdf':  'application/pdf',
  '.txt':  'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

type RangeParsed = { start: number; end: number } | { unsatisfiable: true } | null;

function parseRange(headerVal: string | undefined, size: number): RangeParsed {
  if (!headerVal || typeof headerVal !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(headerVal.trim());
  if (!m) return { unsatisfiable: true };
  const startStr = m[1] || '';
  const endStr = m[2] || '';
  let start: number;
  let end: number;
  if (startStr === '' && endStr === '') return { unsatisfiable: true };
  if (startStr === '') {
    const n = parseInt(endStr, 10);
    if (!Number.isFinite(n) || n <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === '' ? size - 1 : parseInt(endStr, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { unsatisfiable: true };
  }
  if (start > end || start < 0 || end >= size) return { unsatisfiable: true };
  return { start, end };
}

function handleFilesRaw(req: IncomingMessage, res: ServerResponse, rec: PublicAgent, method: string): void {
  const cwd = rec && rec.cwd;
  if (!cwd) { sendJson(res, 404, { ok: false, error: 'agent cwd missing' }); return; }

  const urlObj = new URL(req.url || '/', 'http://x');
  const rel = urlObj.searchParams.get('path') || '';
  const cleanRel = String(rel).replace(/^\/+/, '');

  let target: string;
  try {
    target = path.resolve(cwd, cleanRel);
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid path' });
    return;
  }
  if (!withinAgentScope(cwd, target)) {
    sendJson(res, 400, { ok: false, error: 'path escapes agent scope' });
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch (err) {
    if (isNodeErr(err) && err.code === 'ENOENT') {
      sendJson(res, 404, { ok: false, error: 'path not found' });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, error: msg });
    return;
  }

  if (stat.isDirectory()) {
    sendJson(res, 400, { ok: false, error: 'path is a directory' });
    return;
  }
  if (!stat.isFile()) {
    sendJson(res, 400, { ok: false, error: 'unsupported file type' });
    return;
  }
  if (stat.size > RAW_MAX_BYTES) {
    res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'file too large' }));
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const contentType = RAW_MIME[ext] || 'application/octet-stream';
  const lastModified = stat.mtime.toUTCString();

  const rangeHeader = req.headers['range'] as string | undefined;
  const parsed = parseRange(rangeHeader, stat.size);
  if (parsed && 'unsatisfiable' in parsed) {
    res.writeHead(416, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Range': `bytes */${stat.size}`,
    });
    res.end(JSON.stringify({ ok: false, error: 'range not satisfiable' }));
    return;
  }

  if (parsed) {
    const { start, end } = parsed;
    const chunkLen = end - start + 1;
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Length': String(chunkLen),
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Last-Modified': lastModified,
    });
    if (method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(target, { start, end });
    stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
    stream.pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': String(stat.size),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Last-Modified': lastModified,
  });
  if (method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(target);
  stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
  stream.pipe(res);
}

interface MergedTerminal {
  id: string;
  source: 'acp' | 'grok' | 'merged';
  command: string;
  cwd: string;
  exited: boolean;
  exitStatus: { exitCode: number | null; signal: string | NodeJS.Signals | null } | null;
  bytes?: number;
  truncated?: boolean;
  outputFile: string | null;
  startedAt: number | null;
  endedAt: number | null;
  url?: string;
}

function handleGlobalBgTerminals(_req2: IncomingMessage, res: ServerResponse): void {
  const out: { agentId: string; agentName: string; terminals: MergedTerminal[] }[] = [];
  let runningTotal = 0;
  for (const rec of manager.list()) {
    const a = manager.getRaw(rec.id);
    const merged = mergeBgSources(a);
    for (const t of merged) if (!t.exited) runningTotal++;
    if (merged.length) {
      out.push({ agentId: rec.id, agentName: rec.name || rec.id, terminals: merged });
    }
  }
  sendJson(res, 200, { ok: true, runningCount: runningTotal, agents: out });
}

function mergeBgSources(a: ReturnType<typeof manager.getRaw>): MergedTerminal[] {
  const byId = new Map<string, MergedTerminal>();
  const host = a && a.client && a.client.terminalHost;
  if (host && host._terminals) {
    for (const t of host._terminals.values()) {
      byId.set(t.id, {
        id: t.id,
        source: 'acp',
        command: t.command,
        cwd: t.cwd,
        exited: !!t.exited,
        exitStatus: t.exitStatus || null,
        bytes: t.buffer ? t.buffer.length : 0,
        truncated: !!t.truncated,
        outputFile: null,
        startedAt: null,
        endedAt: null,
      });
    }
  }
  if (a && a.bgTasks && a.bgTasks.size) {
    for (const t of a.bgTasks.values()) {
      const grokStatus = (t.exit_code != null || t.signal)
        ? { exitCode: t.exit_code, signal: t.signal }
        : null;
      const existing = byId.get(t.id);
      if (existing) {
        existing.source = 'merged';
        existing.command = t.command || existing.command;
        existing.cwd = t.cwd || existing.cwd;
        existing.outputFile = t.output_file || existing.outputFile;
        existing.startedAt = t.startedAt || existing.startedAt;
        existing.endedAt = t.endedAt || existing.endedAt;
        if (t.completed && !existing.exited) existing.exited = true;
        if (!existing.exitStatus && grokStatus) existing.exitStatus = grokStatus;
      } else {
        byId.set(t.id, {
          id: t.id,
          source: 'grok',
          command: t.command,
          cwd: t.cwd,
          outputFile: t.output_file || null,
          exited: !!t.completed,
          exitStatus: grokStatus,
          startedAt: t.startedAt,
          endedAt: t.endedAt || null,
        });
      }
    }
  }
  for (const t of byId.values()) {
    if (!t.url) {
      let output = '';
      if (t.source === 'acp' || t.source === 'merged') {
        const acpT = host && host._terminals && host._terminals.get(t.id);
        if (acpT && acpT.buffer) {
          output = acpT.buffer.toString('utf8', 0, Math.min(acpT.buffer.length, 16 * 1024));
        }
      }
      if (!output && t.outputFile) {
        try {
          const buf = readFileTail(t.outputFile, 16 * 1024);
          if (buf) output = buf.toString('utf8');
        } catch { /* ignore */ }
      }
      if (!output && (t.source === 'grok' || t.source === 'merged')) {
        const bg = a && a.bgTasks && a.bgTasks.get(t.id);
        if (bg && typeof bg.cached_output === 'string' && bg.cached_output.length) {
          output = bg.cached_output;
        }
      }
      const url2 = inferDevServerUrl(t.command, output);
      if (url2) t.url = url2;
    }
  }
  return [...byId.values()].sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0));
}

function readFileTail(filePath: string, n: number): Buffer | null {
  try {
    const st = fs.statSync(filePath);
    const size = st.size;
    if (size <= n) return fs.readFileSync(filePath);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    fs.closeSync(fd);
    return buf;
  } catch { return null; }
}

function handleTerminalList(_req2: IncomingMessage, res: ServerResponse, rec: PublicAgent): void {
  const a = manager.getRaw(rec.id);
  sendJson(res, 200, { ok: true, terminals: mergeBgSources(a) });
}

function handleTerminalRead(req: IncomingMessage, res: ServerResponse, rec: PublicAgent, tid: string): void {
  const a = manager.getRaw(rec.id);
  const host = a && a.client && a.client.terminalHost;
  const t = host && host._terminals && host._terminals.get(tid);
  if (t) {
    const output = t.buffer ? t.buffer.toString('utf8') : '';
    sendJson(res, 200, {
      ok: true,
      id: t.id,
      source: 'acp',
      command: t.command,
      cwd: t.cwd,
      exited: !!t.exited,
      exitStatus: t.exitStatus || null,
      truncated: !!t.truncated,
      output,
      url: inferDevServerUrl(t.command, output),
    });
    return;
  }
  handleBgTaskRead(req, res, rec, tid);
}

function handleBgTaskRead(_req2: IncomingMessage, res: ServerResponse, rec: PublicAgent, tid: string): void {
  const a = manager.getRaw(rec.id);
  const t = a && a.bgTasks && a.bgTasks.get(tid);
  if (!t) { sendJson(res, 404, { ok: false, error: 'bg task not found' }); return; }
  const TAIL_BYTES = 64 * 1024;
  let output = '';
  let truncated = false;
  if (t.output_file) {
    try {
      const st = fs.statSync(t.output_file);
      const size = st.size;
      if (size > TAIL_BYTES) {
        const fd = fs.openSync(t.output_file, 'r');
        const buf = Buffer.alloc(TAIL_BYTES);
        fs.readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
        fs.closeSync(fd);
        output = buf.toString('utf8');
        truncated = true;
      } else {
        output = fs.readFileSync(t.output_file, 'utf8');
      }
    } catch (err) {
      if (typeof t.cached_output === 'string' && t.cached_output.length) {
        output = t.cached_output;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        output = `[grok-remote] failed to read log: ${msg}`;
      }
    }
  } else if (typeof t.cached_output === 'string' && t.cached_output.length) {
    output = t.cached_output;
  }
  sendJson(res, 200, {
    ok: true,
    id: t.id,
    source: 'grok',
    command: t.command,
    cwd: t.cwd,
    outputFile: t.output_file || null,
    startedAt: t.startedAt,
    endedAt: t.endedAt || null,
    exited: !!t.completed,
    exitStatus: (t.exit_code != null || t.signal) ? { exitCode: t.exit_code, signal: t.signal } : null,
    truncated,
    output,
    url: inferDevServerUrl(t.command, output),
  });
}

function handleTerminalKill(_req2: IncomingMessage, res: ServerResponse, rec: PublicAgent, tid: string): void {
  const a = manager.getRaw(rec.id);
  const host = a && a.client && a.client.terminalHost;
  const t = host && host._terminals && host._terminals.get(tid);
  if (t) {
    try {
      if (t.proc && !t.exited) t.proc.kill('SIGTERM');
    } catch { /* ignore */ }
    sendJson(res, 200, { ok: true });
    return;
  }
  const bg = a && a.bgTasks && a.bgTasks.get(tid);
  if (!bg) { sendJson(res, 404, { ok: false, error: 'terminal not found' }); return; }
  if (bg.completed) { sendJson(res, 200, { ok: true, alreadyExited: true }); return; }
  const cwd = bg.cwd || '';
  if (!cwd) { sendJson(res, 500, { ok: false, error: 'task has no cwd; cannot derive kill pattern' }); return; }
  try {
    spawnSync('/usr/bin/pkill', ['-TERM', '-f', cwd], { timeout: 4000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, error: `pkill failed: ${msg}` });
    return;
  }
  bg.completed = true;
  bg.signal    = bg.signal || 'killed-by-user';
  bg.endedAt   = Date.now();
  try { manager.emit('list_changed', { event: 'bg_tasks', id: rec.id, count: 0 }); } catch { /* ignore */ }
  sendJson(res, 200, { ok: true, source: 'grok', killed: true });
}

function handleVersionUpdateStream(req: IncomingMessage, res: ServerResponse): void {
  sseHeaders(res);
  let counter = 0;
  const send = (data: UpdateStepEvent): void => {
    sseWrite(res, {
      id: `vupd-${Date.now()}-${++counter}`,
      event: 'update',
      data,
    });
  };
  send({ step: 'open', status: 'ok', detail: 'connected' });

  const heartbeat = setInterval(() => ssePing(res), 5000);
  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (!res.writableEnded) try { res.end(); } catch { /* ignore */ }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);

  runVersionUpdate({
    emit: (ev: UpdateStepEvent) => { if (!closed) send(ev); },
  }).then(() => {
    if (!closed) {
      send({ step: 'done', status: 'ok', detail: 'all steps completed' });
      cleanup();
    }
  }).catch((err: unknown) => {
    if (!closed) {
      const msg = err instanceof Error ? err.message : String(err);
      send({ step: 'done', status: 'fail', detail: msg });
      cleanup();
    }
  });
}

function handleAgentsStream(req: IncomingMessage, res: ServerResponse): void {
  sseHeaders(res);
  let counter = 0;
  sseWrite(res, {
    id: `agents-${Date.now()}-${++counter}`,
    event: 'agents_snapshot',
    data: { agents: manager.list() },
  });
  const onChange = (payload: { event?: string; [k: string]: unknown }): void => {
    sseWrite(res, {
      id: `agents-${Date.now()}-${++counter}`,
      event: payload.event || 'agents_changed',
      data: payload,
    });
  };
  manager.on('list_changed', onChange);
  const heartbeat = setInterval(() => ssePing(res), 15000);
  const cleanup = (): void => {
    clearInterval(heartbeat);
    try { manager.off('list_changed', onChange); } catch { /* ignore */ }
    if (!res.writableEnded) try { res.end(); } catch { /* ignore */ }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

function handleStream(req: IncomingMessage, res: ServerResponse, id: string): void {
  const ring = manager.ring(id);
  if (!ring) { sendJson(res, 404, { ok: false, error: 'agent not found' }); return; }

  sseHeaders(res);
  const lastId = req.headers['last-event-id'] as string | undefined;
  for (const ev of ring.since(lastId)) {
    sseWrite(res, ev);
  }

  const unsub = manager.subscribe(id, (ev) => sseWrite(res, ev));
  const heartbeat = setInterval(() => ssePing(res), 15000);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    try { unsub(); } catch { /* ignore */ }
    if (!res.writableEnded) try { res.end(); } catch { /* ignore */ }
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
}

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = (req.url || '').split('?')[0] || '/';
  if (url.startsWith('/api/system/')) {
    try {
      await handleSystem(req, res, url);
    } catch (err) {
      if (!res.headersSent) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, { ok: false, error: msg });
      }
    }
    return;
  }
  if (url.startsWith('/api/')) {
    try {
      await handleApi(req, res, url, req.method || 'GET');
    } catch (err) {
      if (!res.headersSent) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, { ok: false, error: msg });
      }
    }
    return;
  }
  serveStatic(req, res);
});

const retention = startRetentionTimer({ getSettings: loadSettings, manager: manager as never });

server.listen(PORT, HOST, () => {
  const ts = tailscaleIdentity();
  const where = ts?.dns ? `http://${ts.dns}:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`[grok-remote] listening on ${HOST}:${PORT}`);
  console.log(`[grok-remote] tailnet url: ${where}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    try { retention.stop(); } catch { /* ignore */ }
  });
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[grok-remote] shutdown on ${signal}`);
  try { await manager.shutdownAll(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  const t = setTimeout(() => process.exit(0), 3000);
  t.unref?.();
}
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
