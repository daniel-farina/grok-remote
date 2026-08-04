import test from 'node:test';
import assert from 'node:assert/strict';

import { createPermissionHost, pickPermissionOptionId } from '../lib/permission-host.js';

test('createPermissionHost always responds selected with a valid optionId', async () => {
  const host = createPermissionHost();
  const out = await host.requestPermission({ kind: 'write_file', path: '/tmp/whatever' });
  assert.equal(out.outcome.outcome, 'selected');
  assert.equal(out.outcome.optionId, 'allow_always');
});

test('createPermissionHost tolerates undefined params', async () => {
  const host = createPermissionHost();
  const out = await host.requestPermission();
  assert.equal(out.outcome.outcome, 'selected');
  assert.equal(out.outcome.optionId, 'allow_always');
});

test('createPermissionHost returns a fresh object per call so callers may not mutate shared state', async () => {
  const host = createPermissionHost();
  const a = await host.requestPermission({ a: 1 });
  const b = await host.requestPermission({ b: 2 });
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a.outcome, b.outcome);
});

test('pickPermissionOptionId prefers allow_always over allow_once', () => {
  const id = pickPermissionOptionId({
    options: [
      { optionId: 'once-1', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'always-1', kind: 'allow_always', name: 'Always allow' },
      { optionId: 'rej-1', kind: 'reject_once', name: 'Reject' },
    ],
  });
  assert.equal(id, 'always-1');
});

test('pickPermissionOptionId uses allow_once when always is absent (plan approval shape)', () => {
  // Plan exit often offers approve/reject with non-literal optionIds.
  const id = pickPermissionOptionId({
    options: [
      { optionId: 'approve-exit', kind: 'allow_once', name: 'Approve plan and exit' },
      { optionId: 'reject-stay', kind: 'reject_once', name: 'Keep planning' },
    ],
  });
  assert.equal(id, 'approve-exit');
});

test('pickPermissionOptionId skips reject-only options when picking by name heuristic', () => {
  const id = pickPermissionOptionId({
    options: [
      { optionId: 'nope', kind: 'reject_always', name: 'Deny' },
      { optionId: 'yes', kind: 'other', name: 'Approve' },
    ],
  });
  assert.equal(id, 'yes');
});

test('pickPermissionOptionId falls back to first optionId when kinds unknown', () => {
  const id = pickPermissionOptionId({
    options: [
      { optionId: 'opt-a', name: 'A' },
      { optionId: 'opt-b', name: 'B' },
    ],
  });
  assert.equal(id, 'opt-a');
});
