import test from 'node:test';
import assert from 'node:assert/strict';

import { ThreadModel, type ModelChange, type Segment } from '../src/lib/thread-model.js';

// Event builders mirroring the shapes stored in history.jsonl / sent over SSE.
type Ev = [string, unknown];
const upd = (sessionUpdate: string, rest: Record<string, unknown>) => ({ update: { sessionUpdate, ...rest } });
const txt = (text: string) => ({ type: 'text', text });
const user = (text: string): Ev => ['user_message', { text }];
const userChunk = (text: string): Ev => ['user_message_chunk', upd('user_message_chunk', { content: txt(text) })];
const msg = (text: string): Ev => ['agent_message_chunk', upd('agent_message_chunk', { content: txt(text) })];
const thought = (text: string): Ev => ['agent_thought_chunk', upd('agent_thought_chunk', { content: txt(text) })];
const tool = (id: string, kind = 'execute', status = 'pending', title = `cmd ${id}`): Ev =>
  ['tool_call', upd('tool_call', { toolCallId: id, kind, status, title })];
const toolUpd = (id: string, status: string): Ev => ['tool_call_update', upd('tool_call_update', { toolCallId: id, status })];
const delta = (id: string): Ev => ['tool_call_delta_chunk', upd('tool_call_delta_chunk', { toolCallId: id, delta: 'x' })];
const todo = (id: string, merge: boolean): Ev =>
  ['tool_call', upd('tool_call', { toolCallId: id, kind: 'think', status: 'completed', title: 'Updating plan',
    rawInput: { variant: 'TodoWrite', merge, todos: [{ content: 'a', status: 'pending' }] } })];
const complete = (): Ev => ['prompt_complete', { stopReason: 'end_turn', _meta: { totalTokens: 10 } }];
const status = (s: string): Ev => ['agent_status', { status: s }];

function run(evs: Ev[]): { model: ThreadModel; changes: ModelChange[] } {
  const model = new ThreadModel();
  const changes = evs.map(([n, p]) => model.apply(n, p, { ts: 1 }));
  return { model, changes };
}
const types = (segs: Segment[]) => segs.map((s) => s.type);
const lastTurn = (m: ThreadModel) => m.turns[m.turns.length - 1]!;

test('message, tool, message produce three segments', () => {
  const { model } = run([user('hi'), msg('a'), tool('t1'), msg('b')]);
  assert.deepEqual(types(lastTurn(model).segments), ['user', 'message', 'run', 'message']);
});

test('consecutive message chunks join one segment', () => {
  const { model } = run([user('hi'), msg('Hello '), msg('world')]);
  const segs = lastTurn(model).segments;
  assert.deepEqual(types(segs), ['user', 'message']);
  assert.equal((segs[1] as Extract<Segment, { type: 'message' }>).text, 'Hello world');
});

test('tool_call absorbs the preceding thought', () => {
  const { model, changes } = run([user('hi'), thought('plan it'), tool('t1')]);
  const segs = lastTurn(model).segments;
  assert.deepEqual(types(segs), ['user', 'run']);
  const r = segs[1] as Extract<Segment, { type: 'run' }>;
  assert.equal(r.items[0]!.type, 'thought');
  const thoughtId = changes[1]!.added[0]!;
  assert.ok(changes[2]!.removed.includes(thoughtId));
});

test('open run absorbs thoughts between tools', () => {
  const { model } = run([user('hi'), thought('a'), tool('t1'), thought('b'), tool('t2'), thought('c'), tool('t3'), msg('done')]);
  const segs = lastTurn(model).segments;
  assert.deepEqual(types(segs), ['user', 'run', 'message']);
  const r = segs[1] as Extract<Segment, { type: 'run' }>;
  assert.deepEqual(r.items.map((i) => i.type), ['thought', 'tool', 'thought', 'tool', 'thought', 'tool']);
  assert.equal(r.open, false);
});

test('thought followed by message stays top-level', () => {
  const { model } = run([user('hi'), thought('hmm'), msg('answer')]);
  assert.deepEqual(types(lastTurn(model).segments), ['user', 'thought', 'message']);
});

test('tool_call_update changes status', () => {
  const { model, changes } = run([user('hi'), tool('t1'), toolUpd('t1', 'completed')]);
  const r = model.runOf('t1')!;
  const t = r.items.find((i) => i.type === 'tool')!;
  assert.equal(t.type === 'tool' && t.status, 'Completed');
  assert.ok(changes[2]!.updated.includes(r.id));
});

test('update for unknown toolCallId creates the call', () => {
  const { model } = run([user('hi'), toolUpd('ghost', 'running')]);
  const r = model.runOf('ghost');
  assert.ok(r);
  assert.equal(r!.items.length, 1);
});

test('delta for unknown id does not throw', () => {
  assert.doesNotThrow(() => run([user('hi'), delta('nope')]));
});

test('replayed user_message_chunk starts turns', () => {
  const { model } = run([userChunk('A'), msg('one'), userChunk('B'), msg('two')]);
  assert.equal(model.turns.length, 2);
  const texts = model.turns.map((t) => (t.segments[0] as Extract<Segment, { type: 'user' }>).text);
  assert.deepEqual(texts, ['A', 'B']);
});

test('user_message echo is deduped', () => {
  const { model } = run([user('hi'), user('hi')]);
  assert.equal(model.turns.length, 1);
});

test('events after prompt_complete start a background turn', () => {
  const { model } = run([user('hi'), msg('a'), complete(), thought('wake'), msg('bg')]);
  assert.equal(model.turns.length, 2);
  const t1 = model.turns[0]!;
  const t2 = model.turns[1]!;
  assert.equal(t1.segments[t1.segments.length - 1]!.type, 'footer');
  assert.equal(t2.background, true);
  assert.equal(t2.segments[0]!.type, 'marker');
});

test('agent_status idle closes the open run', () => {
  const { model } = run([user('hi'), status('running'), tool('t1'), status('idle')]);
  assert.equal(model.runOf('t1')!.open, false);
  assert.equal(model.isRunning(), false);
});

test('agent_status running sets isRunning', () => {
  const { model } = run([user('hi'), status('running')]);
  assert.equal(model.isRunning(), true);
});

test('TodoWrite calls share one plan segment', () => {
  const { model, changes } = run([user('hi'), todo('p1', false), msg('x'), todo('p2', true)]);
  const plans = lastTurn(model).segments.filter((s) => s.type === 'plan');
  assert.equal(plans.length, 1);
  assert.ok(changes[3]!.updated.includes(plans[0]!.id));
});

test('error and compacted segments', () => {
  const { model } = run([user('hi'), ['error', { message: 'boom' }], ['session_summary_generated', { summary: 's' }]]);
  assert.deepEqual(types(lastTurn(model).segments), ['user', 'error', 'compacted']);
});
