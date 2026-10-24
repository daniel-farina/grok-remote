import test from 'node:test';
import assert from 'node:assert/strict';

import { serializeResumeCommand } from '../src/lib/copy.js';

test('serializeResumeCommand fills in sessionId and cwd when given', () => {
  const out = serializeResumeCommand({
    id: 'a1',
    sessionId: 'sess-123',
    cwd: '/work/project',
  });
  assert.match(out, /grok -p "your next prompt" -r sess-123/);
  assert.match(out, /cd \/work\/project/);
  assert.match(out, /grok --resume sess-123/);
});

test('serializeResumeCommand uses placeholders when fields are missing', () => {
  const out = serializeResumeCommand(null);
  assert.match(out, /grok -p "your next prompt" -r <sessionId>/);
  assert.match(out, /cd <cwd>/);
});

test('serializeResumeCommand also handles partial agent records', () => {
  const out = serializeResumeCommand({ sessionId: 'only-sid' });
  assert.match(out, /-r only-sid/);
  assert.match(out, /cd <cwd>/);
});

// ── serializeThread (from the thread model) ────────────────────────────
import { serializeThread } from '../src/lib/copy.js';
import type { Turn } from '../src/lib/thread-model.js';

test('serializeThread keeps segment order', () => {
  const turns: Turn[] = [{
    id: 't1', running: false, background: false,
    segments: [
      { id: 's1', type: 'user', text: 'please list files', attachments: [], ts: 1 },
      { id: 's2', type: 'message', text: 'Listing now.', ts: 1 },
      { id: 's3', type: 'run', open: false, items: [
        { type: 'thought', id: 's4', text: 'use ls' },
        { type: 'tool', toolCallId: 'c1', kind: 'execute', title: 'ls -la', status: 'Completed' },
      ] },
      { id: 's5', type: 'message', text: 'Two files.', ts: 2 },
    ],
  }];
  const out = serializeThread(turns, (id) => (id === 'c1' ? 'TOOL-OUTPUT-1' : ''), { agent: { name: 'demo' } });
  const order = ['please list files', 'Listing now.', 'use ls', 'ls -la', 'TOOL-OUTPUT-1', 'Two files.'].map((s) => out.indexOf(s));
  assert.ok(order.every((i) => i >= 0), `missing piece in:\n${out}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(out.startsWith('# Conversation with demo'));
});

test('serializeThread marks background turns', () => {
  const turns: Turn[] = [{
    id: 't2', running: false, background: true,
    segments: [
      { id: 'm', type: 'marker', text: 'background update' },
      { id: 'x', type: 'message', text: 'Download finished.', ts: 1 },
    ],
  }];
  const out = serializeThread(turns, () => '');
  assert.ok(out.includes('background update'));
  assert.ok(out.includes('Download finished.'));
});

test('serializeThread falls back to agent id and tolerates null ctx', () => {
  assert.ok(serializeThread([], () => '', { agent: { id: 'abc' } }).startsWith('# Conversation with abc'));
  assert.ok(serializeThread(null, () => '', null).startsWith('# Conversation with agent'));
});

test('serializeThread separates turns and marks empty prompts', () => {
  const mk = (id: string, text: string): Turn => ({ id, running: false, background: false,
    segments: [{ id: `${id}u`, type: 'user', text, attachments: [], ts: 1 }] });
  const out = serializeThread([mk('a', ''), mk('b', 'second')], () => '');
  assert.ok(out.includes('(empty)'));
  assert.ok(out.includes('----'));
});
