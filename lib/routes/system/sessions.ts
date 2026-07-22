// sessions routes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { send } from '../helpers.js';
import { errorToResponse } from '../../grok-cli.js';
import type { RouteRegistrar } from '../system.js';

interface SessionItem {
  sessionId: string;
  created: string;
  updated: string;
  status:  string;
  summary: string;
  cwd:     string;
}

export function register(add: RouteRegistrar): void {
  add('GET', '/api/system/sessions', listHandler);
}

function clampLimit(raw: string | null): number {
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n) || n <= 0) return 20;
  if (n > 200) return 200;
  return n;
}

// `grok sessions list` only reports sessions for the process cwd, so shelling
// out from the server's own directory always came back empty. Read the store
// at ~/.grok/sessions directly instead: one URL-encoded directory per cwd,
// one directory per session inside it, metadata in summary.json.
function scanStore(): SessionItem[] {
  const root = path.join(os.homedir(), '.grok', 'sessions');
  const items: SessionItem[] = [];
  let cwdDirs: string[];
  try { cwdDirs = fs.readdirSync(root); } catch { return items; }

  for (const enc of cwdDirs) {
    const cwdPath = path.join(root, enc);
    let stat: fs.Stats;
    try { stat = fs.statSync(cwdPath); } catch { continue; }
    if (!stat.isDirectory()) continue;

    let decodedCwd: string;
    try { decodedCwd = decodeURIComponent(enc); } catch { decodedCwd = enc; }

    let sessionDirs: string[];
    try { sessionDirs = fs.readdirSync(cwdPath); } catch { continue; }

    for (const sid of sessionDirs) {
      if (!/^[0-9a-f-]{8,}$/i.test(sid)) continue;
      const summaryPath = path.join(cwdPath, sid, 'summary.json');
      let meta: {
        session_summary?: string;
        created_at?: string;
        updated_at?: string;
      };
      try { meta = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); }
      catch { continue; }

      items.push({
        sessionId: sid,
        created: (meta.created_at || '').slice(0, 10),
        updated: (meta.updated_at || '').slice(0, 10),
        status:  'local',
        summary: meta.session_summary || '(no summary)',
        cwd:     decodedCwd,
        // keep full timestamps for sorting via a non-enumerable side channel
      });
      // stash sortable timestamp on the array entry
      (items[items.length - 1] as SessionItem & { _sort?: string })._sort =
        meta.updated_at || meta.created_at || '';
    }
  }

  items.sort((a, b) => {
    const sa = (a as SessionItem & { _sort?: string })._sort || '';
    const sb = (b as SessionItem & { _sort?: string })._sort || '';
    return sb.localeCompare(sa);
  });
  for (const it of items) delete (it as SessionItem & { _sort?: string })._sort;
  return items;
}

async function listHandler(_req: IncomingMessage, res: ServerResponse, urlObj: URL): Promise<void> {
  const q     = (urlObj.searchParams.get('q') || '').trim().toLowerCase();
  const limit = clampLimit(urlObj.searchParams.get('limit'));

  try {
    let items = scanStore();
    if (q) {
      items = items.filter((it) =>
        it.summary.toLowerCase().includes(q) ||
        it.cwd.toLowerCase().includes(q) ||
        it.sessionId.toLowerCase().startsWith(q),
      );
    }
    items = items.slice(0, limit);
    send(res, 200, { ok: true, raw: '', items });
  } catch (err) {
    send(res, 500, errorToResponse(err));
  }
}
