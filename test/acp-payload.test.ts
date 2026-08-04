import test from 'node:test';
import assert from 'node:assert/strict';

import { unwrap, extractText, upstreamEventId } from '../src/lib/acp-payload.js';

test('unwrap returns the inner .update object when present', () => {
  const inner = { sessionUpdate: 'tool_call', toolCallId: 't1' };
  assert.deepEqual(unwrap({ update: inner }), inner);
});

test('unwrap passes through a bare update payload unchanged', () => {
  // SSE events already arrive unwrapped from the server.
  const inner = { sessionUpdate: 'tool_call_update' };
  assert.deepEqual(unwrap(inner), inner);
});

test('unwrap returns an empty object for nullish input so property access is safe', () => {
  assert.deepEqual(unwrap(null), {});
  assert.deepEqual(unwrap(undefined), {});
  assert.deepEqual(unwrap(''), {});
  assert.deepEqual(unwrap(0), {});
});

test('unwrap ignores .update when it is not an object', () => {
  // Treat `update: "string"` as a regular field on the payload, not a wrapper.
  const payload = { update: 'not-a-wrapper', other: 1 };
  assert.deepEqual(unwrap(payload), payload);
});

test('extractText returns null for nullish input', () => {
  assert.equal(extractText(null), null);
  assert.equal(extractText(undefined), null);
});

test('extractText returns plain strings as-is', () => {
  assert.equal(extractText('hello world'), 'hello world');
});

test('extractText reads payload.content when content is a string', () => {
  assert.equal(extractText({ content: 'inline text' }), 'inline text');
});

test('extractText reads payload.content.text when content is an object', () => {
  assert.equal(extractText({ content: { text: 'wrapped text' } }), 'wrapped text');
});

test('extractText prefers payload.content over payload.text when both are present', () => {
  // content is the canonical ACP field; .text is a legacy shape.
  assert.equal(extractText({ content: 'newer', text: 'older' }), 'newer');
});

test('extractText falls back to payload.text when there is no content', () => {
  assert.equal(extractText({ text: 'fallback' }), 'fallback');
});

test('extractText returns null for non-string non-object input', () => {
  assert.equal(extractText(42), null);
  assert.equal(extractText(true), null);
});

test('extractText returns null when no text field is present anywhere', () => {
  assert.equal(extractText({ kind: 'tool_call', toolCallId: 't1' }), null);
  assert.equal(extractText({ content: { kind: 'image' } }), null);
});

test('upstreamEventId reads _meta.eventId from the SSE envelope', () => {
  assert.equal(
    upstreamEventId({
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } },
      _meta: { eventId: 'abc-123', chunkId: 4 },
    }),
    'abc-123',
  );
});

test('upstreamEventId returns null when _meta is missing or empty', () => {
  assert.equal(upstreamEventId(null), null);
  assert.equal(upstreamEventId({ update: { sessionUpdate: 'agent_message_chunk' } }), null);
  assert.equal(upstreamEventId({ _meta: {} }), null);
  assert.equal(upstreamEventId({ _meta: { eventId: '' } }), null);
});

test('upstreamEventId stringifies non-string eventIds', () => {
  assert.equal(upstreamEventId({ _meta: { eventId: 42 } }), '42');
});
