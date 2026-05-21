import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { _internal } from '../lib/routes/system/lsp.js';

// ---------------------------------------------------------------------------
// normalizeBody: input validation + shaping
// ---------------------------------------------------------------------------

test('normalizeBody requires a name (or language)', () => {
  assert.throws(
    () => _internal.normalizeBody({ command: 'foo', root_markers: ['x'], extensions: { '.x': 'x' } }),
    /name or language is required/,
  );
});

test('normalizeBody falls back to language when name is omitted', () => {
  const n = _internal.normalizeBody({
    language: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    root_markers: ['package.json'],
    extensions: { '.ts': 'typescript' },
  });
  assert.equal(n.name, 'typescript');
});

test('normalizeBody rejects names with disallowed characters', () => {
  assert.throws(
    () => _internal.normalizeBody({
      name: 'bad name', command: 'x', root_markers: ['y'], extensions: { '.z': 'z' },
    }),
    /alphanumeric/,
  );
});

test('normalizeBody requires a non-empty command', () => {
  assert.throws(
    () => _internal.normalizeBody({
      name: 'foo', command: '   ', root_markers: ['x'], extensions: { '.x': 'x' },
    }),
    /command is required/,
  );
});

test('normalizeBody requires at least one root marker', () => {
  assert.throws(
    () => _internal.normalizeBody({
      name: 'foo', command: 'foo', root_markers: [], extensions: { '.x': 'x' },
    }),
    /at least one root_marker/,
  );
});

test('normalizeBody requires at least one extension', () => {
  assert.throws(
    () => _internal.normalizeBody({
      name: 'foo', command: 'foo', root_markers: ['x'],
    }),
    /extensions.*required/,
  );
});

test('normalizeBody accepts extensions as an array using language fallback', () => {
  const n = _internal.normalizeBody({
    language: 'python',
    command: 'pylsp',
    root_markers: ['pyproject.toml'],
    extensions: ['.py', '.pyi'],
  });
  assert.deepEqual(n.extensionToLanguage, { '.py': 'python', '.pyi': 'python' });
});

test('normalizeBody adds a leading dot to bare extension keys', () => {
  const n = _internal.normalizeBody({
    name: 'foo',
    command: 'foo',
    root_markers: ['x'],
    extensions: { ts: 'typescript', '.tsx': 'typescriptreact' },
  });
  assert.deepEqual(n.extensionToLanguage, { '.ts': 'typescript', '.tsx': 'typescriptreact' });
});

test('normalizeBody passes extensionToLanguage straight through', () => {
  const n = _internal.normalizeBody({
    name: 'rust-analyzer',
    command: 'rust-analyzer',
    root_markers: ['Cargo.toml'],
    extensionToLanguage: { '.rs': 'rust' },
  });
  assert.deepEqual(n.extensionToLanguage, { '.rs': 'rust' });
});

test('normalizeBody accepts both root_markers and rootMarkers spellings', () => {
  const a = _internal.normalizeBody({
    name: 'a', command: 'a', root_markers: ['x'], extensions: { '.x': 'x' },
  });
  const b = _internal.normalizeBody({
    name: 'b', command: 'b', rootMarkers: ['y'], extensions: { '.y': 'y' },
  });
  assert.deepEqual(a.rootMarkers, ['x']);
  assert.deepEqual(b.rootMarkers, ['y']);
});

test('normalizeBody coerces env values to strings and drops nullish entries', () => {
  const n = _internal.normalizeBody({
    name: 'go',
    command: 'gopls',
    root_markers: ['go.mod'],
    extensions: { '.go': 'go' },
    env: { GOPATH: '/home/user/go', PORT: 9099, MAYBE: null, NOPE: undefined },
  });
  assert.deepEqual(n.env, { GOPATH: '/home/user/go', PORT: '9099' });
});

// ---------------------------------------------------------------------------
// mergeAndWrite: round-trips, refusal on duplicate, overwrite flag
// ---------------------------------------------------------------------------

function tmpJsonPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-route-'));
  return path.join(dir, 'sub', 'lsp.json');
}

function nrm(body: Parameters<typeof _internal.normalizeBody>[0]): ReturnType<typeof _internal.normalizeBody> {
  return _internal.normalizeBody(body);
}

test('mergeAndWrite creates parent dirs and writes a valid JSON object', () => {
  const filePath = tmpJsonPath();
  const body = nrm({
    name: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    root_markers: ['package.json', 'tsconfig.json'],
    extensions: { '.ts': 'typescript', '.tsx': 'typescriptreact' },
  });
  _internal.mergeAndWrite(filePath, body);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  assert.ok(parsed['typescript'], 'expected typescript entry');
  const entry = parsed['typescript'] as Record<string, unknown>;
  assert.equal(entry['command'], 'typescript-language-server');
  assert.deepEqual(entry['args'], ['--stdio']);
  assert.deepEqual(entry['rootMarkers'], ['package.json', 'tsconfig.json']);
  assert.deepEqual(entry['extensionToLanguage'], { '.ts': 'typescript', '.tsx': 'typescriptreact' });
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
});

test('mergeAndWrite preserves existing server entries when adding another language', () => {
  const filePath = tmpJsonPath();
  _internal.mergeAndWrite(filePath, nrm({
    name: 'typescript', command: 'typescript-language-server', args: ['--stdio'],
    root_markers: ['package.json'], extensions: { '.ts': 'typescript' },
  }));
  _internal.mergeAndWrite(filePath, nrm({
    name: 'rust-analyzer', command: 'rust-analyzer',
    root_markers: ['Cargo.toml'], extensions: { '.rs': 'rust' },
  }));
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  assert.ok(parsed['typescript'], 'typescript must still be present');
  assert.ok(parsed['rust-analyzer'], 'rust-analyzer must be present');
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
});

test('mergeAndWrite refuses to overwrite an existing server name by default', () => {
  const filePath = tmpJsonPath();
  _internal.mergeAndWrite(filePath, nrm({
    name: 'typescript', command: 'typescript-language-server',
    root_markers: ['package.json'], extensions: { '.ts': 'typescript' },
  }));
  assert.throws(
    () => _internal.mergeAndWrite(filePath, nrm({
      name: 'typescript', command: 'something-else',
      root_markers: ['package.json'], extensions: { '.ts': 'typescript' },
    })),
    (err: Error) => err instanceof _internal.DuplicateNameError && /already configured/.test(err.message),
  );
  // File contents must be unchanged
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, Record<string, unknown>>;
  assert.equal(parsed['typescript']!['command'], 'typescript-language-server');
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
});

test('mergeAndWrite replaces an existing entry when overwrite=true', () => {
  const filePath = tmpJsonPath();
  _internal.mergeAndWrite(filePath, nrm({
    name: 'typescript', command: 'old',
    root_markers: ['package.json'], extensions: { '.ts': 'typescript' },
  }));
  const result = _internal.mergeAndWrite(filePath, nrm({
    name: 'typescript', command: 'new', args: ['--stdio'],
    root_markers: ['package.json'], extensions: { '.ts': 'typescript' },
    overwrite: true,
  }));
  assert.equal(result.overwrote, true);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, Record<string, unknown>>;
  assert.equal(parsed['typescript']!['command'], 'new');
  assert.deepEqual(parsed['typescript']!['args'], ['--stdio']);
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
});

test('mergeAndWrite preserves backslashes and double-quotes in arg strings', () => {
  const filePath = tmpJsonPath();
  _internal.mergeAndWrite(filePath, nrm({
    name: 'demo',
    command: 'c:\\bin\\demo.exe',
    args: ['--say', 'hi "there"', 'back\\slash'],
    root_markers: ['.demo'],
    extensions: { '.demo': 'demo' },
  }));
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, Record<string, unknown>>;
  const entry = parsed['demo']!;
  assert.equal(entry['command'], 'c:\\bin\\demo.exe');
  assert.deepEqual(entry['args'], ['--say', 'hi "there"', 'back\\slash']);
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
});

test('mergeAndWrite rejects existing lsp.json that is not a JSON object', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-route-'));
  const filePath = path.join(dir, 'lsp.json');
  fs.writeFileSync(filePath, '["not", "an", "object"]');
  assert.throws(
    () => _internal.mergeAndWrite(filePath, nrm({
      name: 'foo', command: 'foo', root_markers: ['x'], extensions: { '.x': 'x' },
    })),
    /must be a JSON object/,
  );
  assert.equal(fs.readFileSync(filePath, 'utf8'), '["not", "an", "object"]');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mergeAndWrite leaves the original file intact when JSON parse fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-route-'));
  const filePath = path.join(dir, 'lsp.json');
  fs.writeFileSync(filePath, '{ this is not json');
  assert.throws(
    () => _internal.mergeAndWrite(filePath, nrm({
      name: 'foo', command: 'foo', root_markers: ['x'], extensions: { '.x': 'x' },
    })),
    /not valid JSON/,
  );
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{ this is not json');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('atomicWriteJson uses a temp file + rename and cleans up the tmp on rename failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-route-'));
  const targetAsDir = path.join(dir, 'lsp.json');
  fs.mkdirSync(targetAsDir);
  assert.throws(() => _internal.atomicWriteJson(targetAsDir, { foo: 1 }));
  const leftover = fs.readdirSync(dir).filter(n => n.startsWith('lsp.json.tmp-'));
  assert.deepEqual(leftover, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// HOME-isolated round-trip: lazy import of the route module after setting HOME
// ---------------------------------------------------------------------------

const ORIGINAL_HOME = process.env['HOME'];

async function freshRouteModule(): Promise<typeof import('../lib/routes/system/lsp.js')> {
  const url = new URL('../lib/routes/system/lsp.js?bust=' + Math.random(), import.meta.url).href;
  return import(url) as Promise<typeof import('../lib/routes/system/lsp.js')>;
}

test('userLspPath resolves against the current HOME at call time', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-route-home-'));
  process.env['HOME'] = home;
  try {
    const m = await freshRouteModule();
    const p = m._internal.userLspPath();
    assert.equal(p, path.join(home, '.grok', 'lsp.json'));
  } finally {
    if (ORIGINAL_HOME == null) delete process.env['HOME']; else process.env['HOME'] = ORIGINAL_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('end-to-end: normalize + mergeAndWrite produce lsp.json that grok would accept', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-route-home-'));
  process.env['HOME'] = home;
  try {
    const m = await freshRouteModule();
    const filePath = m._internal.userLspPath();
    const body = m._internal.normalizeBody({
      name: 'typescript',
      language: 'typescript',
      command: 'typescript-language-server',
      args: ['--stdio'],
      root_markers: ['package.json', 'tsconfig.json'],
      extensions: { '.ts': 'typescript', '.tsx': 'typescriptreact' },
    });
    m._internal.mergeAndWrite(filePath, body);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, Record<string, unknown>>;
    assert.ok(parsed['typescript'], 'expected a "typescript" key');
    const e = parsed['typescript']!;
    assert.equal(typeof e['command'], 'string');
    assert.ok(e['extensionToLanguage'] && typeof e['extensionToLanguage'] === 'object');
    assert.deepEqual(e['args'], ['--stdio']);
    assert.deepEqual(e['rootMarkers'], ['package.json', 'tsconfig.json']);
  } finally {
    if (ORIGINAL_HOME == null) delete process.env['HOME']; else process.env['HOME'] = ORIGINAL_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
