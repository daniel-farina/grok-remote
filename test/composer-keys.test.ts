import test from 'node:test';
import assert from 'node:assert/strict';

import { enterAction } from '../src/lib/composer-keys.js';

test('desktop Enter sends', () => {
  assert.equal(enterAction({ key: 'Enter', shiftKey: false }, false), 'send');
});

test('desktop Shift+Enter inserts a newline', () => {
  assert.equal(enterAction({ key: 'Enter', shiftKey: true }, false), 'newline');
});

test('touch Enter inserts a newline (send button sends)', () => {
  assert.equal(enterAction({ key: 'Enter', shiftKey: false }, true), 'newline');
});

test('Enter while an IME is composing never sends', () => {
  assert.equal(enterAction({ key: 'Enter', shiftKey: false, isComposing: true }, false), 'newline');
});
