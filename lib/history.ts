// Per-agent append-only JSONL history at ~/.grok-remote/agents/<id>/history.jsonl.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.homedir(), '.grok-remote', 'agents');

export function agentDir(agentId: string): string {
  return path.join(ROOT, agentId);
}

export function historyPath(agentId: string): string {
  return path.join(agentDir(agentId), 'history.jsonl');
}

export function ensureAgentDirs(agentId: string): string {
  const dir = agentDir(agentId);
  fs.mkdirSync(path.join(dir, 'cwd'), { recursive: true });
  return dir;
}

export function append(agentId: string, event: unknown): void {
  try {
    ensureAgentDirs(agentId);
    fs.appendFileSync(historyPath(agentId), JSON.stringify(event) + '\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[history] append failed for ${agentId}: ${msg}\n`);
  }
}

export function readAll(agentId: string): string {
  try {
    return fs.readFileSync(historyPath(agentId), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Drop session-resume duplicates from a history.jsonl body.
 *
 * On reconnect, Grok re-emits prior session/update events with the same
 * `_meta.eventId`. Those used to be appended again, so reloading a
 * conversation re-painted every past assistant reply into the latest
 * bubble. First occurrence wins; lines without an upstream id always pass.
 */
export function dedupeHistoryByUpstreamEventId(raw: string): string {
  if (!raw) return '';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    if (line.indexOf('eventId') === -1) {
      out.push(line);
      continue;
    }
    let eid: unknown;
    try {
      const ev = JSON.parse(line) as { data?: { _meta?: { eventId?: unknown } } };
      eid = ev?.data?._meta?.eventId;
    } catch {
      out.push(line);
      continue;
    }
    if (eid != null && eid !== '') {
      const key = String(eid);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(line);
  }
  // Preserve trailing newline when the input had content (NDJSON convention).
  return out.length ? out.join('\n') + '\n' : '';
}
