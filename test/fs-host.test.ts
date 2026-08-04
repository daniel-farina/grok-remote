import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createFsHost } from '../lib/fs-host.js';

function newScope(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grok-remote-fshost-'));
}

test('readTextFile reads a file inside the agent cwd (relative path)', async () => {
  const scope = newScope();
  fs.writeFileSync(path.join(scope, 'a.txt'), 'hello\nworld\n');
  const host = createFsHost({ getCwd: () => scope });
  const out = await host.readTextFile({ path: 'a.txt' });
  assert.equal(out.content, 'hello\nworld\n');
});

test('readTextFile honours line + limit by slicing the file by line', async () => {
  const scope = newScope();
  fs.writeFileSync(path.join(scope, 'lines.txt'), '1\n2\n3\n4\n5\n');
  const host = createFsHost({ getCwd: () => scope });
  const out = await host.readTextFile({ path: 'lines.txt', line: 2, limit: 2 });
  assert.equal(out.content, '2\n3');
});

test('readTextFile accepts an absolute path outside the agent cwd', async () => {
  // Mirrors shell access: absolute paths are not fenced to the agent workspace.
  const scope = newScope();
  const outside = newScope();
  const file = path.join(outside, 'elsewhere.txt');
  fs.writeFileSync(file, 'outside-ok');
  const host = createFsHost({ getCwd: () => scope });
  const out = await host.readTextFile({ path: file });
  assert.equal(out.content, 'outside-ok');
});

test('writeTextFile accepts an absolute path outside the agent cwd', async () => {
  const scope = newScope();
  const outside = newScope();
  const file = path.join(outside, 'written.txt');
  const host = createFsHost({ getCwd: () => scope });
  await host.writeTextFile({ path: file, content: 'via-abs' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'via-abs');
});

test('writeTextFile can reach a sibling dir via relative .. path', async () => {
  const parent = newScope();
  const scope = path.join(parent, 'agent');
  const sibling = path.join(parent, 'project');
  fs.mkdirSync(scope);
  fs.mkdirSync(sibling);
  const host = createFsHost({ getCwd: () => scope });
  await host.writeTextFile({ path: '../project/out.txt', content: 'escaped-ok' });
  assert.equal(fs.readFileSync(path.join(sibling, 'out.txt'), 'utf8'), 'escaped-ok');
});

test('readTextFile rejects a non-string or empty path with -32602', async () => {
  const scope = newScope();
  const host = createFsHost({ getCwd: () => scope });
  await assert.rejects(host.readTextFile({}), /path must be a non-empty string/);
  await assert.rejects(host.readTextFile({ path: '' }), /path must be a non-empty string/);
});

test('writeTextFile creates the file and any missing parent directories', async () => {
  const scope = newScope();
  const host = createFsHost({ getCwd: () => scope });
  await host.writeTextFile({ path: 'nested/dir/out.txt', content: 'wrote it' });
  assert.equal(
    fs.readFileSync(path.join(scope, 'nested/dir/out.txt'), 'utf8'),
    'wrote it',
  );
});

test('writeTextFile rejects when content is not a string', async () => {
  const scope = newScope();
  const host = createFsHost({ getCwd: () => scope });
  await assert.rejects(
    host.writeTextFile({ path: 'x.txt', content: 123 as unknown as string }),
    /content must be a string/,
  );
});

test('falls back to process.cwd() resolution when getCwd returns null', async () => {
  const scope = newScope();
  const file = path.join(scope, 'cwd-fallback.txt');
  fs.writeFileSync(file, 'data');
  const host = createFsHost({ getCwd: () => null });
  const out = await host.readTextFile({ path: file });
  assert.equal(out.content, 'data');
});
