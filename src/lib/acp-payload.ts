// Pure helpers for un-narrowing ACP payloads received over SSE / history.
// Extracted from src/views/chat.ts so they can be unit-tested without DOM.

interface UnknownRecord {
  [key: string]: unknown;
}

interface MaybeUpdateWrapper {
  update?: unknown;
}

/**
 * Some history endpoints wrap the ACP `update` object inside an envelope:
 * `{ update: { ... } }`. SSE events arrive already unwrapped by the server.
 * Returns the inner update when present, otherwise the payload itself (or
 * an empty object so callers can safely property-access the result).
 */
export function unwrap(payload: unknown): UnknownRecord {
  if (payload && typeof payload === 'object') {
    const maybe = payload as MaybeUpdateWrapper;
    if (maybe.update && typeof maybe.update === 'object') {
      return maybe.update as UnknownRecord;
    }
    return payload as UnknownRecord;
  }
  return {};
}

/**
 * Best-effort text extractor for ACP content blocks. Handles three shapes:
 *   - plain strings
 *   - `{ content: 'text' }`
 *   - `{ content: { text: 'text' } }`
 *   - `{ text: 'text' }`
 * Returns null when no string can be found, so callers can branch on it.
 */
export function extractText(payload: unknown): string | null {
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object') return null;
  const p = payload as {
    content?: unknown;
    text?: unknown;
  };
  if (p.content) {
    if (typeof p.content === 'string') return p.content;
    if (typeof p.content === 'object' && p.content !== null) {
      const inner = (p.content as { text?: unknown }).text;
      if (typeof inner === 'string') return inner;
    }
  }
  if (typeof p.text === 'string') return p.text;
  return null;
}

/**
 * Stable id for an ACP session/update as assigned by the Grok agent.
 *
 * On session resume the agent re-emits prior thought/message/tool events with
 * the *same* `_meta.eventId`. Our local SSE id is always new, so callers that
 * want to ignore historical replays must key off this upstream id.
 *
 * Accepts both the live SSE envelope `{ update, _meta }` and a bare update
 * (no id available → null).
 */
export function upstreamEventId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { _meta?: unknown; update?: unknown };
  const meta = p._meta;
  if (meta && typeof meta === 'object') {
    const eid = (meta as { eventId?: unknown }).eventId;
    if (eid != null && eid !== '') return String(eid);
  }
  return null;
}
