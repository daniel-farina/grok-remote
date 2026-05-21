import test from 'node:test';
import assert from 'node:assert/strict';

import { computeSelection } from '../src/views/agents-selection.js';

const ORDER = ['a', 'b', 'c', 'd', 'e'];

test('plain click replaces selection and sets anchor', () => {
  const res = computeSelection(new Set(['a', 'b']), 'a', 'c', {}, ORDER);
  assert.deepEqual([...res.next].sort(), ['c']);
  assert.equal(res.anchor, 'c');
});

test('plain click on an already-selected row still collapses to that single row', () => {
  const res = computeSelection(new Set(['a', 'b', 'c']), 'a', 'b', {}, ORDER);
  assert.deepEqual([...res.next].sort(), ['b']);
  assert.equal(res.anchor, 'b');
});

test('ctrl-click adds a row to the selection when absent', () => {
  const res = computeSelection(new Set(['a']), 'a', 'c', { ctrlKey: true }, ORDER);
  assert.deepEqual([...res.next].sort(), ['a', 'c']);
  assert.equal(res.anchor, 'c');
});

test('ctrl-click removes a row from the selection when present', () => {
  const res = computeSelection(new Set(['a', 'b', 'c']), 'a', 'b', { ctrlKey: true }, ORDER);
  assert.deepEqual([...res.next].sort(), ['a', 'c']);
  assert.equal(res.anchor, 'b');
});

test('meta-click behaves like ctrl-click (macOS)', () => {
  const res = computeSelection(new Set(['a']), 'a', 'd', { metaKey: true }, ORDER);
  assert.deepEqual([...res.next].sort(), ['a', 'd']);
  assert.equal(res.anchor, 'd');
});

test('shift-click selects a forward range from anchor inclusive', () => {
  const res = computeSelection(new Set(['b']), 'b', 'd', { shiftKey: true }, ORDER);
  assert.deepEqual([...res.next].sort(), ['b', 'c', 'd']);
  // Anchor stays put across shift-clicks so the range can be extended again.
  assert.equal(res.anchor, 'b');
});

test('shift-click selects a backward range from anchor inclusive', () => {
  const res = computeSelection(new Set(['d']), 'd', 'a', { shiftKey: true }, ORDER);
  assert.deepEqual([...res.next].sort(), ['a', 'b', 'c', 'd']);
  assert.equal(res.anchor, 'd');
});

test('shift-click with no anchor falls back to plain click', () => {
  const res = computeSelection(new Set(['a', 'c']), null, 'd', { shiftKey: true }, ORDER);
  assert.deepEqual([...res.next].sort(), ['d']);
  assert.equal(res.anchor, 'd');
});

test('shift-click whose anchor is no longer in the list falls back to plain click', () => {
  const res = computeSelection(new Set(['a']), 'zzz', 'c', { shiftKey: true }, ORDER);
  assert.deepEqual([...res.next].sort(), ['c']);
  assert.equal(res.anchor, 'c');
});

test('shift-click range over a single row selects just that row', () => {
  const res = computeSelection(new Set(['a', 'b']), 'c', 'c', { shiftKey: true }, ORDER);
  assert.deepEqual([...res.next].sort(), ['c']);
  assert.equal(res.anchor, 'c');
});
