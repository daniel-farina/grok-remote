import test from 'node:test';
import assert from 'node:assert/strict';

import { statusSummary } from '../src/lib/status-bar.js';

const base = { conn: 'connected' as const, agentStatus: 'idle', activity: null, toolsThisTurn: 0, bgRunning: 0 };

test('working with activity, tools and background shells', () => {
  assert.deepEqual(
    statusSummary({ conn: 'connected', agentStatus: 'running', activity: 'curl -s', toolsThisTurn: 14, bgRunning: 1 }),
    { dot: 'warn', text: 'working · curl -s · 14 tools · bg 1' },
  );
});

test('idle with nothing going on', () => {
  assert.deepEqual(statusSummary(base), { dot: 'ok', text: 'idle' });
});

test('reconnecting takes priority over agent state', () => {
  const r = statusSummary({ ...base, conn: 'reconnecting', agentStatus: 'running' });
  assert.ok(r.text.startsWith('reconnecting'));
  assert.equal(r.dot, 'warn');
});

test('errored shows a failure dot', () => {
  const r = statusSummary({ ...base, agentStatus: 'errored' });
  assert.equal(r.dot, 'fail');
  assert.ok(r.text.startsWith('errored'));
});

test('one tool reads singular', () => {
  assert.equal(statusSummary({ ...base, agentStatus: 'running', toolsThisTurn: 1 }).text, 'working · 1 tool');
});
