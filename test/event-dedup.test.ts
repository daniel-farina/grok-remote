import test from 'node:test';
import assert from 'node:assert/strict';

import { EventDedup } from '../src/lib/event-dedup.js';

test('an id seen in history is a duplicate when the stream resends it', () => {
  const d = new EventDedup();
  d.markSeen('1792824073943-41');
  assert.equal(d.isDuplicate('1792824073943-41'), true);
});

test('unseen ids and missing ids are never duplicates', () => {
  const d = new EventDedup();
  d.markSeen('a');
  assert.equal(d.isDuplicate('b'), false);
  assert.equal(d.isDuplicate(''), false);
  assert.equal(d.isDuplicate(undefined), false);
});

test('reset forgets every id', () => {
  const d = new EventDedup();
  d.markSeen('a');
  d.reset();
  assert.equal(d.isDuplicate('a'), false);
});

test('events stamped at or before the history cutoff are duplicates', () => {
  const d = new EventDedup();
  d.setCutoff(1792824073943);
  assert.equal(d.isDuplicate('1792824073943-user'), true);
  assert.equal(d.isDuplicate('1792824073000-12'), true);
  assert.equal(d.isDuplicate('1792824073944-user'), false);
  assert.equal(d.isDuplicate('not-a-timestamp'), false);
});

test('reset clears the cutoff', () => {
  const d = new EventDedup();
  d.setCutoff(5000);
  d.reset();
  assert.equal(d.isDuplicate('4000-1'), false);
});
