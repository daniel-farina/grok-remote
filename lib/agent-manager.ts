// Registry of live AcpClient instances + per-agent SSE ring buffers and history.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { AcpClient, type AcpClientSettings } from './acp-client.js';
import { ensureAgentDirs, agentDir, historyPath, append as historyAppend } from './history.js';
import { createRing, type SseRing, type SseRingEntry } from './sse.js';

const SSE_RING_LIMIT = 200;
const AGENTS_ROOT = path.join(os.homedir(), '.grok-remote', 'agents');

function nowIso(): string { return new Date().toISOString(); }

export interface BgTask {
  id: string;
  tool_call_id: string | null;
  command: string;
  cwd: string;
  output_file: string;
  startedAt: number;
  completed: boolean;
  exit_code: number | null;
  signal: NodeJS.Signals | string | null;
  endedAt?: number;
  kind: 'grok-bg';
  cached_output?: string;
}

export interface AgentMeta {
  id: string;
  name: string;
  autoNamed: boolean;
  modelHint: string | null;
  cwd: string;
  createdAt: string;
  lastSeen: string;
  lastSessionId: string | null;
  lastError: string | null;
  starred: boolean;
  archived: boolean;
  archivedAt: string | null;
  settings: AcpClientSettings | null;
}

interface AgentRingEntry extends SseRingEntry {
  id: string;
  event: string;
  data: Record<string, unknown>;
}

interface AgentRecord extends AgentMeta {
  client: AcpClient | null;
  ring: SseRing<AgentRingEntry>;
  status: string;
  eventCounter: number;
  bgTasks?: Map<string, BgTask>;
  totalTokens?: number;
  inFlight?: number;
  _inFlightIds?: Set<string>;
  _lastTokenEmit?: number;
}

export interface AgentSpawnOptions {
  name?: string;
  model?: string;
  cwd?: string;
  settings?: AcpClientSettings | null;
  /** Adopt an existing store session: the first connect issues session/load
   *  for this id instead of session/new. */
  resumeSessionId?: string;
}

export interface AgentPatch {
  name?: string;
  starred?: boolean;
  archived?: boolean;
  settings?: AcpClientSettings | null;
}

export interface PublicAgent {
  id: string;
  name: string;
  model: string | null;
  status: string;
  connected: boolean;
  cwd: string;
  createdAt: string;
  lastSeen: string;
  lastSessionId: string | null;
  handshakeMeta: unknown;
  agentCapabilities: unknown;
  sessionId: string | null;
  availableCommands: unknown[];
  lastError: string | null;
  exitInfo: unknown;
  starred: boolean;
  archived: boolean;
  archivedAt: string | null;
  settings: AcpClientSettings | null;
  totalTokens: number;
  inFlight: number;
}

export interface PromptAttachment {
  name?: string;
  mimeType?: string;
  dataBase64?: string;
}

export interface PromptInput {
  text?: string;
  attachments?: PromptAttachment[];
}

export interface SavedFile {
  rel: string;
  abs: string;
  mimeType: string | null;
  size: number;
}

export function countRunningBg(record: AgentRecord | null | undefined): number {
  if (!record || !record.bgTasks) return 0;
  let n = 0;
  for (const v of record.bgTasks.values()) if (!v.completed) n++;
  return n;
}

function hydrateBgTasksFromHistory(agentId: string): Map<string, BgTask> {
  const out = new Map<string, BgTask>();
  let raw: string;
  try { raw = fs.readFileSync(historyPath(agentId), 'utf8'); }
  catch { return out; }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.indexOf('task_backgrounded') === -1 &&
        trimmed.indexOf('task_completed')    === -1 &&
        trimmed.indexOf('TaskOutput')         === -1) continue;
    let ev: { at?: string; data?: { params?: { update?: Record<string, unknown> }; update?: Record<string, unknown> } };
    try { ev = JSON.parse(trimmed); } catch { continue; }
    const upd = ev?.data?.params?.update;
    if (upd && upd['sessionUpdate'] === 'task_backgrounded') {
      const tid = upd['task_id'] as string | undefined;
      if (!tid) continue;
      out.set(tid, {
        id: tid,
        tool_call_id: (upd['tool_call_id'] as string) || null,
        command: (upd['command'] as string) || '',
        cwd: (upd['cwd'] as string) || '',
        output_file: (upd['output_file'] as string) || '',
        startedAt: Date.parse(ev.at || '') || Date.now(),
        completed: false,
        exit_code: null,
        signal: null,
        kind: 'grok-bg',
      });
      continue;
    }
    if (upd && upd['sessionUpdate'] === 'task_completed') {
      const snap = (upd['task_snapshot'] as Record<string, unknown>) || {};
      const tid = snap['task_id'] as string | undefined;
      if (!tid || !out.has(tid)) continue;
      const entry = out.get(tid)!;
      entry.completed = true;
      entry.exit_code = snap['exit_code'] != null ? (snap['exit_code'] as number) : null;
      entry.signal    = (snap['signal'] as string) || null;
      entry.endedAt   = Date.parse(ev.at || '') || Date.now();
      continue;
    }
    const ud = ev?.data?.update;
    const ro = ud && (ud['rawOutput'] as Record<string, unknown>);
    if (ro && ro['type'] === 'TaskOutput' && ro['Result']) {
      const result = ro['Result'] as Record<string, unknown>;
      if (result['task_id']) {
        const tid = result['task_id'] as string;
        const entry = out.get(tid);
        if (entry && typeof result['output'] === 'string' && (result['output'] as string).length) {
          entry.cached_output = result['output'] as string;
        }
      }
    }
  }
  return out;
}

function metaPath(id: string): string {
  return path.join(agentDir(id), 'meta.json');
}

function readMetaFromDisk(id: string): Partial<AgentMeta> | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')) as Partial<AgentMeta>;
  } catch { return null; }
}

function writeMeta(record: AgentRecord): void {
  try {
    fs.mkdirSync(agentDir(record.id), { recursive: true });
    const out: AgentMeta = {
      id: record.id,
      name: record.name,
      autoNamed: !!record.autoNamed,
      modelHint: record.modelHint || null,
      cwd: record.cwd,
      createdAt: record.createdAt,
      lastSeen: record.lastSeen,
      lastSessionId: record.lastSessionId || null,
      lastError: record.lastError || null,
      starred: !!record.starred,
      archived: !!record.archived,
      archivedAt: record.archivedAt || null,
      settings: record.settings && typeof record.settings === 'object' ? record.settings : null,
    };
    fs.writeFileSync(metaPath(record.id), JSON.stringify(out, null, 2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[meta] write failed for ${record.id}: ${msg}\n`);
  }
}

function listPersistedAgentIds(): string[] {
  try {
    return fs.readdirSync(AGENTS_ROOT).filter((name) => {
      try {
        return fs.statSync(path.join(AGENTS_ROOT, name)).isDirectory()
            && fs.existsSync(path.join(AGENTS_ROOT, name, 'meta.json'));
      } catch { return false; }
    });
  } catch { return []; }
}

const MIME_EXT: Record<string, string> = {
  'image/png':  '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif':  '.gif',
  'image/svg+xml': '.svg',
};

export function sanitizeFilename(name: string | null | undefined): string {
  return String(name || '')
    .replace(/[\\/]/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 100);
}

export function uniqueUploadName(dir: string, requestedName: string | undefined, mimeType: string | undefined): string {
  let raw = sanitizeFilename(requestedName);
  if (!raw) {
    const ext = (mimeType && MIME_EXT[mimeType]) || '';
    raw = `image-${Date.now()}${ext}`;
  }
  let candidate = raw;
  const ext = path.extname(raw);
  const stem = ext ? raw.slice(0, -ext.length) : raw;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}-${i++}${ext}`;
  }
  return candidate;
}

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return '? bytes';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentLine(f: SavedFile): string {
  const size = humanSize(f.size);
  return `- ${f.abs} (${f.mimeType || 'application/octet-stream'}, ${size})`;
}

export class AgentManager extends EventEmitter {
  agents: Map<string, AgentRecord>;

  constructor() {
    super();
    this.agents = new Map();
    this._hydrateFromDisk();
  }

  private _hydrateFromDisk(): void {
    for (const id of listPersistedAgentIds()) {
      const meta = readMetaFromDisk(id);
      if (!meta || !meta.id) continue;
      const ring = createRing<AgentRingEntry>(SSE_RING_LIMIT);
      const record: AgentRecord = {
        id: meta.id,
        name: meta.name || `agent-${meta.id.slice(0, 8)}`,
        autoNamed: !!meta.autoNamed,
        modelHint: meta.modelHint || null,
        cwd: meta.cwd || path.join(agentDir(meta.id), 'cwd'),
        createdAt: meta.createdAt || nowIso(),
        lastSeen: meta.lastSeen || nowIso(),
        lastSessionId: meta.lastSessionId || null,
        lastError: meta.lastError || null,
        starred: !!meta.starred,
        archived: !!meta.archived,
        archivedAt: meta.archivedAt || null,
        settings: meta.settings && typeof meta.settings === 'object' ? meta.settings : null,
        client: null,
        ring,
        status: 'disconnected',
        eventCounter: 0,
      };
      record.bgTasks = hydrateBgTasksFromHistory(record.id);
      this.agents.set(record.id, record);
    }
  }

  list(): PublicAgent[] {
    return [...this.agents.values()].map((a) => this._publicRecord(a));
  }

  get(id: string): PublicAgent | null {
    const a = this.agents.get(id);
    return a ? this._publicRecord(a) : null;
  }

  getRaw(id: string): AgentRecord | null {
    return this.agents.get(id) || null;
  }

  private _publicRecord(a: AgentRecord): PublicAgent {
    const handshake = a.client?.handshake as { _meta?: unknown; agentCapabilities?: unknown } | null;
    return {
      id: a.id,
      name: a.name,
      model: a.client?.modelId || a.modelHint || null,
      status: a.client?.status || a.status || 'disconnected',
      connected: !!a.client,
      cwd: a.cwd,
      createdAt: a.createdAt,
      lastSeen: a.lastSeen,
      lastSessionId: a.client?.sessionId || a.lastSessionId || null,
      handshakeMeta: handshake?._meta || null,
      agentCapabilities: handshake?.agentCapabilities || null,
      sessionId: a.client?.sessionId || a.lastSessionId || null,
      availableCommands: a.client?.availableCommands || [],
      lastError: a.client?.lastError || a.lastError || null,
      exitInfo: a.client?.exitInfo || null,
      starred:    !!a.starred,
      archived:   !!a.archived,
      archivedAt: a.archivedAt || null,
      settings:   a.settings && typeof a.settings === 'object' ? a.settings : null,
      totalTokens: typeof a.totalTokens === 'number' ? a.totalTokens : 0,
      inFlight: typeof a.inFlight === 'number' ? a.inFlight : 0,
    };
  }

  async update(id: string, patch: AgentPatch): Promise<PublicAgent> {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    if (!patch || typeof patch !== 'object') throw new Error('invalid patch');
    let changed = false;
    if (typeof patch.name === 'string' && patch.name.trim()) {
      a.name = patch.name.trim().slice(0, 200);
      a.autoNamed = false;
      changed = true;
    }
    if (typeof patch.starred === 'boolean' && a.starred !== patch.starred) {
      a.starred = patch.starred;
      changed = true;
    }
    if (typeof patch.archived === 'boolean' && a.archived !== patch.archived) {
      a.archived = patch.archived;
      a.archivedAt = patch.archived ? nowIso() : null;
      changed = true;
      if (patch.archived && a.client) {
        try { await a.client.shutdown('SIGTERM'); } catch { /* ignore */ }
        a.client = null;
        a.status = 'disconnected';
      }
    }
    if (patch.settings === null) {
      if (a.settings != null) {
        a.settings = null;
        changed = true;
      }
    } else if (patch.settings && typeof patch.settings === 'object') {
      const next: AcpClientSettings = { ...(a.settings || {}), ...patch.settings };
      for (const k of Object.keys(next)) {
        const v = next[k];
        if (v == null) { delete next[k]; continue; }
        if (typeof v === 'string' && v.length === 0) { delete next[k]; continue; }
        if (Array.isArray(v) && v.length === 0) { delete next[k]; continue; }
      }
      a.settings = Object.keys(next).length ? next : null;
      changed = true;
    }
    if (changed) {
      writeMeta(a);
      const emitEvent = this._emitEventFactory(a);
      emitEvent('agent_updated', {
        id: a.id,
        name: a.name,
        starred: !!a.starred,
        archived: !!a.archived,
      });
      this.emit('list_changed', { event: 'agent_updated', agent: this._publicRecord(a) });
    }
    return this._publicRecord(a);
  }

  private _emitEventFactory(record: AgentRecord): (event: string, data: Record<string, unknown>) => void {
    return (event: string, data: Record<string, unknown>): void => {
      record.eventCounter = (record.eventCounter || 0) + 1;
      const eventId = `${Date.now()}-${record.eventCounter}`;
      const wrapped: AgentRingEntry = { id: eventId, event, data: { ...data, _t: Date.now() } };
      record.ring.push(wrapped);
      record.lastSeen = nowIso();
      this.emit(`agent:${record.id}`, wrapped);
      const at = record.lastSeen;
      setImmediate(() => historyAppend(record.id, { eventId, at, event, data }));
    };
  }

  private _wireClient(record: AgentRecord): void {
    const id = record.id;
    const emitEvent = this._emitEventFactory(record);
    const client = record.client;
    if (!client) return;

    client.on('status', (s: Record<string, unknown>) => {
      emitEvent('agent_status', s);
      this.emit('list_changed', {
        event: 'agent_status',
        id: record.id,
        status: (s && s['status']) || record.status,
      });
    });
    client.on('handshake', (h: { _meta?: unknown; agentCapabilities?: unknown }) => {
      emitEvent('handshake', { meta: h?._meta || null, agentCapabilities: h?.agentCapabilities || null });
    });
    client.on('session_ready', (s: { sessionId?: string; resumed?: boolean }) => {
      if (s && s.sessionId) {
        record.lastSessionId = s.sessionId;
        writeMeta(record);
      }
      emitEvent('session_ready', s as unknown as Record<string, unknown>);
    });
    client.on('update', (params: { update?: Record<string, unknown>; _meta?: Record<string, unknown>; sessionId?: string }) => {
      const u = params?.update || {};
      const event = (u['sessionUpdate'] as string) || 'update';
      const meta = params?._meta;
      const tt = meta && ((meta['totalTokens'] as number) ?? (meta['total_tokens'] as number));
      if (typeof tt === 'number' && Number.isFinite(tt) && tt > (record.totalTokens || 0)) {
        record.totalTokens = tt;
        const now = Date.now();
        if (!record._lastTokenEmit || (now - record._lastTokenEmit) >= 500) {
          record._lastTokenEmit = now;
          this.emit('list_changed', { event: 'agent_tokens', id: record.id, totalTokens: tt });
        }
      }
      const sub = u['sessionUpdate'];
      const callId = (u['toolCallId'] as string) || (u['id'] as string);
      if (callId) {
        if (!record._inFlightIds) record._inFlightIds = new Set();
        const updateParams = (meta as Record<string, unknown> | undefined)?.['updateParams'] as Record<string, unknown> | undefined;
        const metaStatus = updateParams && updateParams['status'];
        const rawStatus = (u['status'] as string) || (metaStatus as string) || '';
        const lowered = String(rawStatus).toLowerCase();
        const TERMINAL = new Set(['completed','success','succeeded','failed','error','errored','canceled','cancelled']);
        if (sub === 'tool_call' || sub === 'tool_call_start') {
          if (!TERMINAL.has(lowered)) record._inFlightIds.add(callId);
        } else if (sub === 'tool_call_update' || sub === 'tool_call_end') {
          if (TERMINAL.has(lowered)) record._inFlightIds.delete(callId);
        }
        const nextCount = record._inFlightIds.size;
        if (nextCount !== record.inFlight) {
          record.inFlight = nextCount;
          this.emit('list_changed', { event: 'agent_inflight', id: record.id, inFlight: nextCount });
        }
      }
      try {
        const ro = u['rawOutput'] as Record<string, unknown> | undefined;
        if (ro && ro['type'] === 'TaskOutput' && ro['Result']) {
          const result = ro['Result'] as Record<string, unknown>;
          if (result['task_id']) {
            const tid = result['task_id'] as string;
            if (record.bgTasks && record.bgTasks.has(tid)) {
              const entry = record.bgTasks.get(tid)!;
              if (typeof result['output'] === 'string' && (result['output'] as string).length) {
                entry.cached_output = result['output'] as string;
              }
            }
          }
        }
      } catch { /* ignore */ }
      emitEvent(event, { update: u, _meta: params?._meta || null, sessionId: params?.sessionId });
    });
    client.on('x_notification', (msg: { method?: string; params?: { update?: Record<string, unknown> } }) => {
      const method = msg.method || 'x_notification';
      emitEvent(method.replace(/^_/, ''), { method, params: msg.params });

      const upd = msg?.params?.update;
      if (upd && upd['sessionUpdate'] === 'task_backgrounded') {
        if (!record.bgTasks) record.bgTasks = new Map();
        const tid = upd['task_id'] as string | undefined;
        if (tid) {
          record.bgTasks.set(tid, {
            id: tid,
            tool_call_id: (upd['tool_call_id'] as string) || null,
            command: (upd['command'] as string) || '',
            cwd: (upd['cwd'] as string) || record.cwd || '',
            output_file: (upd['output_file'] as string) || '',
            startedAt: Date.now(),
            completed: false,
            exit_code: null,
            signal: null,
            kind: 'grok-bg',
          });
          this.emit('list_changed', { event: 'bg_tasks', id: record.id, count: countRunningBg(record) });
        }
      } else if (upd && upd['sessionUpdate'] === 'task_completed') {
        const snap = (upd['task_snapshot'] as Record<string, unknown>) || {};
        const tid = snap['task_id'] as string | undefined;
        if (tid && record.bgTasks && record.bgTasks.has(tid)) {
          const entry = record.bgTasks.get(tid)!;
          entry.completed = true;
          entry.exit_code = snap['exit_code'] != null ? (snap['exit_code'] as number) : null;
          entry.signal    = (snap['signal'] as string) || null;
          entry.endedAt   = Date.now();
          this.emit('list_changed', { event: 'bg_tasks', id: record.id, count: countRunningBg(record) });
        }
      }

      if (upd && upd['sessionUpdate'] === 'session_summary_generated' && record.autoNamed) {
        const summary = String(upd['session_summary'] || '').trim();
        if (summary) {
          const prev = record.name;
          const next = summary.length > 60 ? summary.slice(0, 60).replace(/\s+\S*$/, '') + '...' : summary;
          if (next && next !== prev) {
            record.name = next;
            writeMeta(record);
            emitEvent('agent_renamed', { id, name: next, prevName: prev, source: 'auto', summary });
          }
        }
      }
    });
    client.on('prompt_complete', (params: Record<string, unknown>) => emitEvent('prompt_complete', params));
    client.on('prompt_result',  (result: Record<string, unknown>) => emitEvent('prompt_result', result));
    client.on('error', (err: Error | { message?: string }) => {
      record.lastError = (err && (err as Error).message) || String(err);
      writeMeta(record);
      emitEvent('error', { message: record.lastError });
    });
    client.on('exit', (info: Record<string, unknown>) => {
      emitEvent('agent_exited', info);
      if (record.client === client) {
        record.client = null;
        record.status = 'disconnected';
        writeMeta(record);
        if (record._inFlightIds) record._inFlightIds.clear();
        if (record.inFlight) {
          record.inFlight = 0;
          this.emit('list_changed', { event: 'agent_inflight', id: record.id, inFlight: 0 });
        }
        emitEvent('agent_status', { status: 'disconnected', reason: 'process_exit' });
        this.emit('list_changed', { event: 'agent_status', id: record.id, status: 'disconnected' });
      }
    });
    client.on('stderr', (chunk: string) => emitEvent('stderr', { chunk }));
  }

  async spawn({ name, model, cwd, settings, resumeSessionId }: AgentSpawnOptions = {}): Promise<PublicAgent> {
    const id = randomUUID();
    ensureAgentDirs(id);
    const dir = agentDir(id);
    const workCwd = cwd && fs.existsSync(cwd) ? path.resolve(cwd) : path.join(dir, 'cwd');
    fs.mkdirSync(workCwd, { recursive: true });

    const ring = createRing<AgentRingEntry>(SSE_RING_LIMIT);
    const record: AgentRecord = {
      id,
      name: name || `agent-${id.slice(0, 8)}`,
      autoNamed: !name,
      modelHint: model || null,
      cwd: workCwd,
      createdAt: nowIso(),
      lastSeen: nowIso(),
      lastSessionId: resumeSessionId || null,
      lastError: null,
      starred: false,
      archived: false,
      archivedAt: null,
      settings: settings && typeof settings === 'object' ? settings : null,
      client: null,
      ring,
      status: 'starting',
      eventCounter: 0,
    };
    this.agents.set(id, record);
    writeMeta(record);

    historyAppend(id, { at: nowIso(), event: 'agent_created', data: { id, name: record.name, cwd: workCwd } });

    this._connectRecord(record);
    const pub = this._publicRecord(record);
    this.emit('list_changed', { event: 'agent_added', agent: pub });
    return pub;
  }

  private _connectRecord(record: AgentRecord): AcpClient {
    if (record.client) return record.client;
    record.status = 'starting';
    const client = new AcpClient({
      cwd: record.cwd,
      modelHint: record.modelHint,
      settings: record.settings || null,
    });
    record.client = client;
    this._wireClient(record);
    const emitEvent = this._emitEventFactory(record);
    emitEvent('agent_status', { status: 'starting' });
    client.start({ resumeSessionId: record.lastSessionId || null }).catch((err: Error | { message?: string }) => {
      record.lastError = (err && (err as Error).message) || String(err);
      writeMeta(record);
      emitEvent('error', { message: record.lastError });
    });
    return client;
  }

  async connect(id: string): Promise<PublicAgent> {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    if (a.client) return this._publicRecord(a);
    this._connectRecord(a);
    return this._publicRecord(a);
  }

  async disconnect(id: string): Promise<PublicAgent> {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    if (!a.client) return this._publicRecord(a);
    const client = a.client;
    a.client = null;
    a.status = 'disconnected';
    if (client.sessionId) a.lastSessionId = client.sessionId;
    writeMeta(a);
    try { await client.shutdown('SIGTERM'); } catch { /* ignore */ }
    const emitEvent = this._emitEventFactory(a);
    if (a._inFlightIds) a._inFlightIds.clear();
    if (a.inFlight) {
      a.inFlight = 0;
      this.emit('list_changed', { event: 'agent_inflight', id: a.id, inFlight: 0 });
    }
    emitEvent('agent_status', { status: 'disconnected', reason: 'user_request' });
    this.emit('list_changed', { event: 'agent_status', id: a.id, status: 'disconnected' });
    return this._publicRecord(a);
  }

  async kill(id: string): Promise<boolean> {
    const a = this.agents.get(id);
    if (!a) return false;
    if (a.client) {
      try { await a.client.shutdown('SIGTERM'); } catch { /* ignore */ }
    }
    this.agents.delete(id);
    this.emit('list_changed', { event: 'agent_removed', id });
    try {
      const dir = agentDir(id);
      if (dir.startsWith(AGENTS_ROOT + path.sep)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[kill] failed to remove ${id}: ${msg}\n`);
    }
    return true;
  }

  async prompt(id: string, textOrOpts: string | PromptInput): Promise<{ ok: true; debug: Record<string, unknown> }> {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');

    if (!a.client) {
      this._connectRecord(a);
      await this._waitForSession(a, 8000);
    } else if (!a.client.sessionId) {
      await this._waitForSession(a, 8000);
    }
    if (!a.client) throw new Error('reconnect failed');

    let text: string;
    let attachments: PromptAttachment[];
    if (textOrOpts && typeof textOrOpts === 'object' && !Array.isArray(textOrOpts)) {
      text = String(textOrOpts.text || '');
      attachments = Array.isArray(textOrOpts.attachments) ? textOrOpts.attachments : [];
    } else {
      text = String(textOrOpts || '');
      attachments = [];
    }

    const savedFiles: SavedFile[] = [];
    if (attachments.length) {
      const uploadsDir = path.join(a.cwd, 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });
      for (const att of attachments) {
        if (!att || typeof att.dataBase64 !== 'string' || !att.dataBase64) continue;
        const buf = Buffer.from(att.dataBase64, 'base64');
        const candidate = uniqueUploadName(uploadsDir, att.name, att.mimeType);
        const abs = path.join(uploadsDir, candidate);
        fs.writeFileSync(abs, buf);
        savedFiles.push({
          rel: path.posix.join('uploads', candidate),
          abs,
          mimeType: att.mimeType || null,
          size: buf.length,
        });
      }
    }

    const handshake = a.client?.handshake as { agentCapabilities?: { promptCapabilities?: { image?: boolean; embeddedContext?: boolean } } } | null;
    const supportsImage = !!handshake?.agentCapabilities?.promptCapabilities?.image;
    let finalText = text;
    if (savedFiles.length) {
      const lines = savedFiles.map((f) => attachmentLine(f));
      const refBlock = 'Attached files:\n' + lines.join('\n');
      finalText = text && text.length ? `${text}\n\n${refBlock}` : refBlock;
    }

    const embeddedContext = !!handshake?.agentCapabilities?.promptCapabilities?.embeddedContext;
    const blocks: unknown[] = [];
    if (finalText && finalText.length) blocks.push({ type: 'text', text: finalText });
    for (let i = 0; i < savedFiles.length; i++) {
      const f = savedFiles[i]!;
      const mime = (f.mimeType || '').toLowerCase();
      if (!mime.startsWith('image/')) continue;
      try {
        const buf = fs.readFileSync(f.abs);
        blocks.push({
          type: 'image',
          mimeType: f.mimeType || 'image/png',
          data: buf.toString('base64'),
        });
      } catch { /* fall back to text+resource_link only */ }
    }
    if (embeddedContext) {
      for (const f of savedFiles) {
        blocks.push({
          type: 'resource_link',
          uri: 'file://' + f.abs,
          name: path.basename(f.abs),
          mimeType: f.mimeType || 'application/octet-stream',
          size: f.size,
        });
      }
    }
    if (!blocks.length) throw new Error('empty prompt');

    const histAttachments = savedFiles.map((f) => ({
      rel: f.rel, mimeType: f.mimeType, size: f.size,
    }));
    const histData: Record<string, unknown> = histAttachments.length
      ? { text: finalText, attachments: histAttachments }
      : { text: finalText };
    historyAppend(id, { at: nowIso(), event: 'user_message', data: histData });
    a.ring.push({
      id: `${Date.now()}-user`,
      event: 'user_message',
      data: { ...histData, _t: Date.now() },
    });
    this.emit(`agent:${id}`, {
      id: `${Date.now()}-user`,
      event: 'user_message',
      data: { ...histData, _t: Date.now() },
    });
    a.client.prompt(blocks).catch(() => { /* error already emitted */ });
    return {
      ok: true,
      debug: {
        sessionId: a.client?.sessionId || null,
        composedText: finalText,
        promptBlocks: blocks,
        savedFiles: savedFiles.map((f) => ({
          abs: f.abs, rel: f.rel, mimeType: f.mimeType, size: f.size,
        })),
        supportsImage,
      },
    };
  }

  async cancel(id: string): Promise<boolean> {
    const a = this.agents.get(id);
    if (!a) return false;
    if (!a.client) return false;
    await a.client.cancel();
    return true;
  }

  private async _waitForSession(record: AgentRecord, timeoutMs: number): Promise<void> {
    if (record.client && record.client.sessionId) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (record.client && record.client.sessionId) return;
      if (record.client && record.client.status === 'errored') {
        throw new Error(record.client.lastError || 'agent errored during reconnect');
      }
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    throw new Error('timed out waiting for session');
  }

  ring(id: string): SseRing<AgentRingEntry> | null {
    const a = this.agents.get(id);
    return a ? a.ring : null;
  }

  subscribe(id: string, listener: (event: AgentRingEntry) => void): () => void {
    this.on(`agent:${id}`, listener);
    return () => this.off(`agent:${id}`, listener);
  }

  async shutdownAll(): Promise<void> {
    const ids = [...this.agents.keys()];
    await Promise.all(ids.map((id) => this.disconnect(id).catch(() => { /* ignore */ })));
  }
}
