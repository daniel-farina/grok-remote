import test from 'node:test';
import assert from 'node:assert/strict';

// EventSource is a browser API. Install a deterministic stub on globalThis
// before importing the module under test so its `new EventSource(url)` call
// resolves to our fake. The fake records construction args, exposes a fire()
// hook the tests can use to dispatch named events, and records close() calls.

type FakeListener = (ev: { data: string }) => void;

interface FakeES {
  url: string;
  readyState: number;
  listeners: Map<string, FakeListener[]>;
  addEventListener(name: string, fn: FakeListener): void;
  fire(name: string, data: string): void;
  close(): void;
}

let lastInstance: FakeES | null = null;

class FakeEventSource implements FakeES {
  url: string;
  readyState = 0;
  listeners = new Map<string, FakeListener[]>();
  closed = false;
  constructor(url: string) {
    this.url = url;
    lastInstance = this;
  }
  addEventListener(name: string, fn: FakeListener): void {
    let arr = this.listeners.get(name);
    if (!arr) { arr = []; this.listeners.set(name, arr); }
    arr.push(fn);
  }
  fire(name: string, data: string): void {
    const arr = this.listeners.get(name) || [];
    for (const fn of arr) fn({ data });
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

(globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;

const { openStream } = await import('../src/lib/sse.js');

function fresh(): FakeES {
  lastInstance = null;
  return null as unknown as FakeES;
}

test('openStream constructs an EventSource with the given URL', () => {
  fresh();
  const h = openStream('/api/agents/abc/stream');
  assert.ok(lastInstance);
  assert.equal(lastInstance!.url, '/api/agents/abc/stream');
  h.close();
});

test('openStream registers onOpen, onError, message, and each known event', () => {
  fresh();
  const h = openStream('/x', { onOpen: () => {}, onError: () => {} });
  // open + error + message + every entry in KNOWN_EVENTS.
  const names = Array.from(lastInstance!.listeners.keys()).sort();
  // Spot-check a representative subset (the implementation iterates KNOWN_EVENTS).
  for (const n of ['open', 'error', 'message', 'user_message', 'tool_call', 'tool_call_update', 'tool_call_delta_chunk', 'agent_status', 'prompt_complete']) {
    assert.ok(names.includes(n), `expected listener for ${n}; got ${names.join(',')}`);
  }
  h.close();
});

test('openStream fires onOpen on the open event', () => {
  fresh();
  let opened = 0;
  const h = openStream('/x', { onOpen: () => { opened++; } });
  lastInstance!.fire('open', '');
  assert.equal(opened, 1);
  h.close();
});

test('openStream parses JSON event data before invoking the per-event handler', () => {
  fresh();
  let received: unknown = null;
  const h = openStream('/x', {
    on: { tool_call: (parsed) => { received = parsed; } },
  });
  lastInstance!.fire('tool_call', '{"toolCallId":"t-1","kind":"Read"}');
  assert.deepEqual(received, { toolCallId: 't-1', kind: 'Read' });
  h.close();
});

test('openStream falls back to raw string data when JSON.parse fails', () => {
  fresh();
  let received: unknown = null;
  const h = openStream('/x', {
    on: { agent_status: (parsed) => { received = parsed; } },
  });
  lastInstance!.fire('agent_status', 'not-json');
  assert.equal(received, 'not-json');
  h.close();
});

test('openStream calls onAny for every named event with the event name as the first arg', () => {
  fresh();
  const calls: Array<[string, unknown]> = [];
  const h = openStream('/x', {
    onAny: (name, parsed) => { calls.push([name, parsed]); },
  });
  lastInstance!.fire('tool_call', '{"id":1}');
  lastInstance!.fire('prompt_complete', '{"totalTokens":42}');
  assert.deepEqual(calls, [
    ['tool_call',       { id: 1 }],
    ['prompt_complete', { totalTokens: 42 }],
  ]);
  h.close();
});

test('openStream calls onAny for the generic "message" event too', () => {
  fresh();
  const calls: Array<[string, unknown]> = [];
  const h = openStream('/x', { onAny: (name, p) => { calls.push([name, p]); } });
  lastInstance!.fire('message', '{"hello":"world"}');
  assert.deepEqual(calls, [['message', { hello: 'world' }]]);
  h.close();
});

test('close() shuts the EventSource down and flips isClosed', () => {
  fresh();
  const h = openStream('/x');
  assert.equal(h.isClosed(), false);
  h.close();
  assert.equal(h.isClosed(), true);
  assert.equal((lastInstance as unknown as { closed: boolean }).closed, true);
});

test('close() is idempotent — second call does not throw or re-close', () => {
  fresh();
  const h = openStream('/x');
  h.close();
  h.close(); // should be a safe no-op
  assert.equal(h.isClosed(), true);
});

test('readyState reports 2 (CLOSED) when the underlying EventSource is gone', () => {
  fresh();
  const h = openStream('/x');
  h.close();
  assert.equal(h.readyState(), 2);
});


test('openStream fires onAny for user_message (cross-client prompt echo)', () => {
  fresh();
  const seen: Array<{ name: string; parsed: unknown }> = [];
  const h = openStream('/x', {
    onAny: (name, parsed) => { seen.push({ name, parsed }); },
  });
  lastInstance!.fire('user_message', '{"text":"hello from desktop","_t":1}');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.name, 'user_message');
  assert.deepEqual(seen[0]!.parsed, { text: 'hello from desktop', _t: 1 });
  h.close();
});
