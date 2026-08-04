import test from 'node:test';
import assert from 'node:assert/strict';

import {
  serializeConversation,
  serializeResumeCommand,
  type ConvoTurn,
} from '../src/lib/copy.js';

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

test('serializeConversation emits a header with agent name and model', () => {
  const out = serializeConversation([], {
    agent: { name: 'Worker', model: 'grok-2', sessionId: 's1' },
  });
  assert.match(out, /^# Conversation with Worker/);
  assert.match(out, /^# Model: grok-2/m);
  assert.match(out, /^# Session: s1/m);
  assert.match(out, /^# Captured: \d{4}-\d{2}-\d{2}T/m);
});

test('serializeConversation falls back to agent id when no name', () => {
  const out = serializeConversation([], { agent: { id: 'agent-007' } });
  assert.match(out, /^# Conversation with agent-007/);
});

test('serializeConversation handles null ctx and empty turns gracefully', () => {
  const out = serializeConversation([], null);
  assert.match(out, /^# Conversation with agent/);
});

test('serializeConversation emits You/Grok sections per turn', () => {
  const turns: ConvoTurn[] = [
    {
      userText: 'hello there',
      assistant: { text: 'hi back' },
    },
  ];
  const out = serializeConversation(turns, { agent: { name: 'a' } });
  assert.match(out, /## You\nhello there/);
  assert.match(out, /## Grok\nhi back/);
});

test('serializeConversation includes every assistants[] segment in a tool-heavy turn', () => {
  // Long turns stream interim status bubbles between tool batches; copy
  // must not collapse them into a single bubble / drop earlier ones.
  const turns: ConvoTurn[] = [
    {
      userText: 'fix it',
      assistants: [
        { text: 'Looking at the layout…' },
        { text: 'Patching the CSS…' },
        { text: '### Done\nOffset the drawer under chrome-peek.' },
      ],
      assistant: { text: '### Done\nOffset the drawer under chrome-peek.' },
    },
  ];
  const out = serializeConversation(turns, { agent: { name: 'a' } });
  assert.match(out, /Looking at the layout/);
  assert.match(out, /Patching the CSS/);
  assert.match(out, /Offset the drawer under chrome-peek/);
  // Three distinct Grok sections, not one concatenated blob.
  assert.equal((out.match(/## Grok/g) || []).length, 3);
});

test('serializeConversation handles bubble.text as a function', () => {
  const turns: ConvoTurn[] = [
    {
      userText: 'q',
      assistant: { text: () => 'computed answer' },
    },
  ];
  const out = serializeConversation(turns, null);
  assert.match(out, /computed answer/);
});

test('serializeConversation emits "(empty)" placeholder when user has no text', () => {
  const turns: ConvoTurn[] = [{ assistant: { text: 'answer only' } }];
  const out = serializeConversation(turns, null);
  assert.match(out, /## You\n\(empty\)/);
});

test('serializeConversation includes a Thinking section when present', () => {
  const turns: ConvoTurn[] = [
    {
      userText: 'plan?',
      thinking: { text: 'considering options' },
      assistant: { text: 'done' },
    },
  ];
  const out = serializeConversation(turns, null);
  assert.match(out, /## Thinking\nconsidering options/);
});

test('serializeConversation separates turns with a horizontal divider', () => {
  const turns: ConvoTurn[] = [
    { userText: 'one', assistant: { text: 'a' } },
    { userText: 'two', assistant: { text: 'b' } },
  ];
  const out = serializeConversation(turns, null);
  // exactly one ---- divider between the two turns
  const dividers = out.match(/^----$/gm) || [];
  assert.equal(dividers.length, 1);
});

test('serializeConversation tolerates a function that throws when reading text', () => {
  const turns: ConvoTurn[] = [
    {
      userText: 'q',
      assistant: { text: () => { throw new Error('boom'); } },
    },
  ];
  const out = serializeConversation(turns, null);
  // Should still emit the user section; no Grok section since bubble threw.
  assert.match(out, /## You\nq/);
  assert.doesNotMatch(out, /## Grok/);
});
