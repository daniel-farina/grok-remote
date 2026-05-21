// Small fetch wrapper for the REST endpoints described in PROTOCOL.md.

export interface ApiError extends Error {
  status?: number;
  body?: unknown;
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const opts: RequestInit = {
    method,
    headers: { accept: 'application/json' },
  };
  if (body !== undefined) {
    (opts.headers as Record<string, string>)['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  const txt = await r.text();
  let data: unknown = null;
  if (txt) {
    try { data = JSON.parse(txt); }
    catch { data = txt; }
  }
  if (!r.ok) {
    const msg = (data && typeof data === 'object' && ('error' in data || 'message' in data))
      ? String((data as { error?: unknown; message?: unknown }).error
              ?? (data as { message?: unknown }).message)
      : `HTTP ${r.status}`;
    const err = new Error(msg) as ApiError;
    err.status = r.status;
    err.body = data;
    throw err;
  }
  return data;
}

export interface PromptInput {
  text?: string;
  attachments?: unknown[];
}

export interface HistoryOptions {
  turns?: number;
  all?: boolean;
}

export interface HistoryResult {
  events: unknown[];
  totalTurns: number;
  returnedTurns: number;
}

export const api = {
  hello:    (): Promise<unknown>   => request('GET',    '/api/hello'),
  health:   (): Promise<unknown>   => request('GET',    '/api/health'),
  models:   (): Promise<unknown>   => request('GET',    '/api/models'),

  listAgents:      (): Promise<unknown> => request('GET',    '/api/agents'),
  agentsStreamUrl: (): string => '/api/agents/stream',
  getAgent:     (id: string): Promise<unknown>          => request('GET',    `/api/agents/${encodeURIComponent(id)}`),
  createAgent:  (body?: Record<string, unknown>): Promise<unknown>  => request('POST',   '/api/agents', body || {}),
  deleteAgent:  (id: string): Promise<unknown>          => request('DELETE', `/api/agents/${encodeURIComponent(id)}`),
  updateAgent:  (id: string, patch?: Record<string, unknown>): Promise<unknown>   => request('PATCH',  `/api/agents/${encodeURIComponent(id)}`, patch || {}),
  setAgentFolder: (id: string, folderId: string | null): Promise<unknown> =>
    request('PUT', `/api/agents/${encodeURIComponent(id)}/folder`, { folderId }),
  disconnect:   (id: string): Promise<unknown>          => request('POST',   `/api/agents/${encodeURIComponent(id)}/disconnect`),
  connect:      (id: string): Promise<unknown>          => request('POST',   `/api/agents/${encodeURIComponent(id)}/connect`),
  share:        (id: string): Promise<unknown>          => request('POST',   `/api/agents/${encodeURIComponent(id)}/publish`),
  runSetup:     (): Promise<unknown>                    => request('POST',   '/api/system/setup'),
  prompt:       (id: string, textOrOpts: string | PromptInput): Promise<unknown> => {
    const body = (textOrOpts && typeof textOrOpts === 'object')
      ? {
          text: String(textOrOpts.text || ''),
          ...(Array.isArray(textOrOpts.attachments) && textOrOpts.attachments.length
            ? { attachments: textOrOpts.attachments }
            : {}),
        }
      : { text: String(textOrOpts || '') };
    return request('POST', `/api/agents/${encodeURIComponent(id)}/prompt`, body);
  },
  cancel:       (id: string): Promise<unknown> => request('POST',   `/api/agents/${encodeURIComponent(id)}/cancel`),
  history:      async (id: string, opts?: HistoryOptions): Promise<HistoryResult> => {
    const { turns, all } = opts || {};
    const qs = new URLSearchParams();
    if (all) qs.set('all', '1');
    if (typeof turns === 'number' && turns > 0) qs.set('turns', String(turns));
    const url = `/api/agents/${encodeURIComponent(id)}/history${qs.toString() ? `?${qs}` : ''}`;
    const r = await fetch(url, { headers: { accept: 'application/x-ndjson' } });
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status}`) as ApiError;
      err.status = r.status;
      throw err;
    }
    const text = await r.text();
    const events: unknown[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { events.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
    }
    return {
      events,
      totalTurns:    parseInt(r.headers.get('X-Total-Turns')    || '0', 10) || 0,
      returnedTurns: parseInt(r.headers.get('X-Returned-Turns') || '0', 10) || 0,
    };
  },
  listFiles:    (id: string, path?: string): Promise<unknown> => request('GET', `/api/agents/${encodeURIComponent(id)}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  readFile:     (id: string, path: string): Promise<unknown> => request('GET', `/api/agents/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`),
  fileRawUrl:   (id: string, p?: string): string => `/api/agents/${encodeURIComponent(id)}/files/raw?path=${encodeURIComponent(p || '')}`,
  trace:        (id: string): Promise<unknown> => request('GET', `/api/agents/${encodeURIComponent(id)}/trace`),

  terminals: {
    list:   (id: string): Promise<unknown>          => request('GET',    `/api/agents/${encodeURIComponent(id)}/terminals`),
    read:   (id: string, tid: string): Promise<unknown> => request('GET',    `/api/agents/${encodeURIComponent(id)}/terminals/${encodeURIComponent(tid)}`),
    kill:   (id: string, tid: string): Promise<unknown> => request('POST',   `/api/agents/${encodeURIComponent(id)}/terminals/${encodeURIComponent(tid)}/kill`),
    global: (): Promise<unknown>                    => request('GET',    '/api/bg-terminals'),
  },

  subagents: {
    trace: (sessionId: string): Promise<unknown> => request('GET', `/api/subagents/${encodeURIComponent(sessionId)}/trace`),
    updates: (sessionId: string, cwd?: string): Promise<unknown> => {
      const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
      return request('GET', `/api/subagents/${encodeURIComponent(sessionId)}/updates${qs}`);
    },
  },

  getSettings:  (): Promise<unknown> => request('GET',    '/api/settings'),
  patchSettings:(body: Record<string, unknown>): Promise<unknown> => request('PATCH', '/api/settings', body),

  mcp: {
    list:     (): Promise<unknown>      => request('GET',    '/api/system/mcp'),
    add:      (body?: Record<string, unknown>): Promise<unknown>  => request('POST',   '/api/system/mcp', body || {}),
    remove:   (name: string): Promise<unknown>  => request('DELETE', `/api/system/mcp/${encodeURIComponent(name)}`),
    doctor:   (name?: string): Promise<unknown>  => request('GET',    name
                                              ? `/api/system/mcp/${encodeURIComponent(name)}/doctor`
                                              : '/api/system/mcp/doctor'),
    getRegistry:     (): Promise<unknown> => request('GET',  '/api/system/mcp/registry'),
    refreshRegistry: (): Promise<unknown> => request('POST', '/api/system/mcp/registry/refresh'),
  },

  lsp: {
    add: (body?: Record<string, unknown>): Promise<unknown> => request('POST', '/api/system/lsp/add', body || {}),
  },

  memory: {
    get:         (): Promise<unknown>          => request('GET',  '/api/system/memory'),
    clear:       (scope: string): Promise<unknown> => request('POST', '/api/system/memory/clear', { scope }),
    read:        (p: string): Promise<unknown> => request('GET',
      `/api/system/memory/read?path=${encodeURIComponent(p || '')}`),
    saveContent: (p: string, content: string): Promise<unknown>   => request('PUT',  '/api/system/memory/content',
      { path: p, content }),
    createFile:  (scope: string, name: string, content?: string): Promise<unknown> => request('POST', '/api/system/memory/file',
      { scope, name, ...(typeof content === 'string' ? { content } : {}) }),
    deleteFile:  (p: string): Promise<unknown> => request('DELETE',
      `/api/system/memory/file?path=${encodeURIComponent(p || '')}`),
  },

  skills: {
    list: (opts?: { includeArchived?: boolean }): Promise<unknown> => {
      const qs = new URLSearchParams();
      if (opts && opts.includeArchived) qs.set('includeArchived', '1');
      const tail = qs.toString();
      return request('GET', `/api/system/skills${tail ? `?${tail}` : ''}`);
    },
    read:        (path: string): Promise<unknown> => request('GET',  `/api/system/skills/read?path=${encodeURIComponent(path)}`),
    archive:     (scope: string, name: string): Promise<unknown> => request('POST', '/api/system/skills/archive', { scope, name }),
    restore:     (scope: string, name: string): Promise<unknown> => request('POST', '/api/system/skills/restore', { scope, name }),
    move:        (scope: string, name: string, toScope: string): Promise<unknown> => request('POST', '/api/system/skills/move', { scope, name, toScope }),
    saveContent: (scope: string, name: string, content: string): Promise<unknown> => request('PUT',  '/api/system/skills/content', { scope, name, content }),
    history:     (scope: string, name: string): Promise<unknown> => request('GET',
      `/api/system/skills/history?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}`),
    historySnapshot: (scope: string, name: string, ts: string): Promise<unknown> => request('GET',
      `/api/system/skills/history/content?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}&ts=${encodeURIComponent(ts)}`),
    historyRestore: (scope: string, name: string, ts: string): Promise<unknown> => request('POST',
      '/api/system/skills/history/restore', { scope, name, ts }),
    use:        (name: string, agentId?: string): Promise<unknown> => request('POST', '/api/system/skills/use', { name, ...(agentId ? { agentId } : {}) }),
    usage:      (): Promise<unknown> => request('GET',  '/api/system/skills/usage'),
  },

  systemModels: {
    get:      (): Promise<unknown>      => request('GET',  '/api/system/models'),
  },

  systemAgents: {
    read:         (p: string): Promise<unknown>                  => request('GET',  `/api/system/agents/read?path=${encodeURIComponent(p || '')}`),
    saveContent:  (p: string, content: string): Promise<unknown> => request('PUT',  '/api/system/agents/content', { path: p, content }),
    createFile:   (scope: string, name: string, content?: string): Promise<unknown>    => request('POST', '/api/system/agents/file',
      { scope, name, ...(typeof content === 'string' ? { content } : {}) }),
    deleteFile:   (p: string): Promise<unknown>                  => request('DELETE',
      `/api/system/agents/file?path=${encodeURIComponent(p || '')}`),
  },

  systemHealth: {
    get:      (): Promise<unknown>      => request('GET',  '/api/system/health'),
    recheck:  (): Promise<unknown>      => request('POST', '/api/system/health/recheck'),
  },

  leaders: {
    list:          (): Promise<unknown>           => request('GET',  '/api/system/leaders'),
    info:          (pid: string): Promise<unknown> => request('GET',  `/api/system/leaders/${encodeURIComponent(pid)}`),
    killAll:       (): Promise<unknown>           => request('POST', '/api/system/leaders/kill', {}),
    profileStatus: (pid: string): Promise<unknown> => request('GET',  `/api/system/leaders/${encodeURIComponent(pid)}/profile/status`),
    profileStart:  (pid: string, body?: Record<string, unknown>): Promise<unknown> => request('POST', `/api/system/leaders/${encodeURIComponent(pid)}/profile/start`, body || {}),
    profileStop:   (pid: string, body?: Record<string, unknown>): Promise<unknown> => request('POST', `/api/system/leaders/${encodeURIComponent(pid)}/profile/stop`, body || {}),
  },

  folders: {
    list:   (): Promise<unknown> => request('GET', '/api/folders'),
    create: (name: string): Promise<unknown> => request('POST', '/api/folders', { name }),
    update: (id: string, patch: { name?: string; agentIds?: string[] }): Promise<unknown> =>
      request('PATCH', `/api/folders/${encodeURIComponent(id)}`, patch || {}),
    remove: (id: string): Promise<unknown> => request('DELETE', `/api/folders/${encodeURIComponent(id)}`),
  },

  agents: {
    setFolder: (agentId: string, folderId: string | null): Promise<unknown> =>
      request('PUT', `/api/agents/${encodeURIComponent(agentId)}/folder`, { folderId }),
  },

  worktrees: {
    list: (opts?: { all?: boolean; repo?: string; type?: string }): Promise<unknown> => {
      const qs = new URLSearchParams();
      if (opts && opts.all)  qs.set('all',  '1');
      if (opts && opts.repo) qs.set('repo', String(opts.repo));
      if (opts && opts.type) qs.set('type', String(opts.type));
      const tail = qs.toString();
      return request('GET', `/api/system/worktrees${tail ? `?${tail}` : ''}`);
    },
    show: (id: string): Promise<unknown> => request('GET', `/api/system/worktrees/${encodeURIComponent(id)}`),
    rm: (id: string, opts?: { force?: boolean; dryRun?: boolean }): Promise<unknown> => {
      const qs = new URLSearchParams();
      if (opts && opts.force)  qs.set('force',  '1');
      if (opts && opts.dryRun) qs.set('dryRun', '1');
      const tail = qs.toString();
      return request('DELETE', `/api/system/worktrees/${encodeURIComponent(id)}${tail ? `?${tail}` : ''}`);
    },
    gc:        (body?: Record<string, unknown>): Promise<unknown> => request('POST', '/api/system/worktrees/gc', body || {}),
    dbStats:   (): Promise<unknown> => request('GET',  '/api/system/worktrees/db/stats'),
    dbPath:    (): Promise<unknown> => request('GET',  '/api/system/worktrees/db/path'),
    dbRebuild: (): Promise<unknown> => request('POST', '/api/system/worktrees/db/rebuild', {}),
  },

  sessions: {
    list: (opts?: { q?: string; limit?: number }): Promise<unknown> => {
      const { q, limit } = opts || {};
      const qs = new URLSearchParams();
      if (q && String(q).trim()) qs.set('q', String(q).trim());
      if (typeof limit === 'number' && limit > 0) qs.set('limit', String(limit));
      const tail = qs.toString();
      return request('GET', `/api/system/sessions${tail ? `?${tail}` : ''}`);
    },
  },

  importer: {
    list: (): Promise<unknown>        => request('GET',  '/api/system/import'),
    run:  (targets: unknown[]): Promise<unknown> => request('POST', '/api/system/import', { targets: Array.isArray(targets) ? targets : [] }),
  },

  version: {
    current:    (): Promise<unknown> => request('GET', '/api/version/current'),
    latest:     (): Promise<unknown> => request('GET', '/api/version/latest'),
    diff:       (): Promise<unknown> => request('GET', '/api/version/diff'),
    releases:   ({ force = false }: { force?: boolean } = {}): Promise<unknown> =>
      request('GET', `/api/version/releases${force ? '?force=1' : ''}`),
    updateUrl:  (): string => '/api/version/update',
  },
};
