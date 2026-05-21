import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  normalizeUpstream,
  normalizeAll,
  fetchAllServers,
  readCache,
  writeCache,
  cachePath,
  cacheAgeMs,
  type UpstreamServer,
  type UpstreamEntry,
} from '../lib/mcp-registry-upstream.js';

function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  return (async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-mcp-upstream-'));
    const previous = process.env['HOME'];
    process.env['HOME'] = tmp;
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previous;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  })();
}

test('normalizeUpstream picks the npm package and yields stdio + npx command', () => {
  const upstream: UpstreamServer = {
    name: 'io.github.modelcontextprotocol/server-github',
    description: 'GitHub repositories, issues and pull requests.',
    version: '1.0.0',
    packages: [{
      registryType: 'npm',
      identifier: '@modelcontextprotocol/server-github',
      version: '1.2.3',
      transport: { type: 'stdio' },
      environmentVariables: [{
        name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        description: 'PAT with repo scope.',
        isRequired: true,
        isSecret: true,
      }],
    }],
    repository: { url: 'https://github.com/modelcontextprotocol/servers', source: 'github' },
  };
  const norm = normalizeUpstream(upstream);
  assert.ok(norm);
  assert.equal(norm!.transport, 'stdio');
  assert.equal(norm!.command, 'npx');
  assert.deepEqual(norm!.args, ['-y', '@modelcontextprotocol/server-github@1.2.3']);
  assert.equal(norm!.slug, 'server-github');
  assert.equal(norm!.official, true);
  assert.ok(Array.isArray(norm!.env) && norm!.env!.length === 1);
  assert.equal(norm!.env![0]!.name, 'GITHUB_PERSONAL_ACCESS_TOKEN');
  assert.equal(norm!.env![0]!.required, true);
  assert.equal(norm!.env![0]!.help, 'PAT with repo scope.');
});

test('normalizeUpstream handles a docker package via oci registry', () => {
  const upstream: UpstreamServer = {
    name: 'com.example/postgres-tools',
    description: 'Postgres MCP server',
    packages: [{
      registryType: 'oci',
      identifier: 'docker.io/example/postgres-mcp:1.0',
      runtimeHint: 'docker',
      transport: { type: 'stdio' },
    }],
  };
  const norm = normalizeUpstream(upstream);
  assert.ok(norm);
  assert.equal(norm!.transport, 'stdio');
  assert.equal(norm!.command, 'docker');
  assert.deepEqual(norm!.args, ['run', '-i', '--rm', 'docker.io/example/postgres-mcp:1.0']);
  assert.equal(norm!.category, 'data');
  assert.equal(norm!.official, false);
});

test('normalizeUpstream falls back to remotes when there are no packages', () => {
  const upstream: UpstreamServer = {
    name: 'com.example/remote-only',
    description: 'Hosted MCP example',
    remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
  };
  const norm = normalizeUpstream(upstream);
  assert.ok(norm);
  assert.equal(norm!.transport, 'http');
  assert.equal(norm!.url, 'https://example.com/mcp');
  assert.equal(norm!.command, undefined);
});

test('normalizeUpstream recognizes sse remotes', () => {
  const upstream: UpstreamServer = {
    name: 'com.example/sse',
    description: 'SSE host',
    remotes: [{ type: 'sse', url: 'https://example.com/mcp/sse' }],
  };
  const norm = normalizeUpstream(upstream);
  assert.ok(norm);
  assert.equal(norm!.transport, 'sse');
  assert.equal(norm!.url, 'https://example.com/mcp/sse');
});

test('normalizeUpstream returns null when there are no packages and no remotes', () => {
  const upstream: UpstreamServer = {
    name: 'com.example/empty',
    description: 'Nothing here',
  };
  assert.equal(normalizeUpstream(upstream), null);
});

test('normalizeUpstream synthesizes a URL-safe slug from the last segment', () => {
  const upstream: UpstreamServer = {
    name: 'io.github.acme/sub.name with spaces/funky_server!!',
    description: 'desc',
    packages: [{ registryType: 'npm', identifier: 'acme-srv', version: '1.0.0', transport: { type: 'stdio' } }],
  };
  const norm = normalizeUpstream(upstream);
  assert.ok(norm);
  assert.match(norm!.slug, /^[A-Za-z0-9_.-]+$/);
});

test('normalizeUpstream prefers npm over pypi when both are present', () => {
  const upstream: UpstreamServer = {
    name: 'com.example/dual',
    description: 'Has both',
    packages: [
      { registryType: 'pypi', identifier: 'dual-mcp', version: '1.0.0', transport: { type: 'stdio' } },
      { registryType: 'npm', identifier: '@dual/mcp', version: '2.0.0', transport: { type: 'stdio' } },
    ],
  };
  const norm = normalizeUpstream(upstream);
  assert.ok(norm);
  assert.equal(norm!.command, 'npx');
  assert.deepEqual(norm!.args, ['-y', '@dual/mcp@2.0.0']);
});

test('normalizeUpstream uses uvx when runtimeHint is uvx', () => {
  const upstream: UpstreamServer = {
    name: 'com.example/uvx-server',
    description: 'uvx based',
    packages: [{
      registryType: 'pypi',
      identifier: 'example-mcp',
      version: '0.5.0',
      runtimeHint: 'uvx',
      transport: { type: 'stdio' },
    }],
  };
  const norm = normalizeUpstream(upstream);
  assert.ok(norm);
  assert.equal(norm!.command, 'uvx');
  assert.deepEqual(norm!.args, ['example-mcp==0.5.0']);
});

test('normalizeAll dedupes by name and puts official entries first', () => {
  const list: UpstreamServer[] = [
    { name: 'com.acme/zebra', description: 'zebra', packages: [{ registryType: 'npm', identifier: 'zebra', version: '1', transport: { type: 'stdio' } }] },
    { name: 'io.github.modelcontextprotocol/alpha', description: 'alpha', packages: [{ registryType: 'npm', identifier: 'alpha', version: '1', transport: { type: 'stdio' } }] },
    { name: 'com.acme/zebra', description: 'zebra-dup', packages: [{ registryType: 'npm', identifier: 'zebra', version: '1', transport: { type: 'stdio' } }] },
  ];
  const result = normalizeAll(list);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.name, 'io.github.modelcontextprotocol/alpha');
  assert.equal(result[0]!.official, true);
  assert.equal(result[1]!.name, 'com.acme/zebra');
});

test('fetchAllServers walks the cursor pagination across multiple pages', async () => {
  const pages = [
    { servers: makeEntries(['a/1', 'a/2']), metadata: { nextCursor: 'c1' } },
    { servers: makeEntries(['b/1']), metadata: { nextCursor: 'c2' } },
    { servers: makeEntries(['c/1', 'c/2', 'c/3']), metadata: {} },
  ];
  let pageIdx = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const body = pages[pageIdx] || { servers: [], metadata: {} };
    pageIdx++;
    res.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const out = await fetchAllServers(`http://127.0.0.1:${port}`);
    const names = out.map(s => s.name);
    assert.deepEqual(names, ['a/1', 'a/2', 'b/1', 'c/1', 'c/2', 'c/3']);
  } finally {
    server.close();
  }
});

test('cache read/write round-trips through a tmpdir HOME', async () => {
  await withTempHome(async () => {
    const before = await readCache();
    assert.equal(before, null);
    const sample: UpstreamServer[] = [{
      name: 'com.example/a',
      description: 'A',
      packages: [{ registryType: 'npm', identifier: 'a', version: '1.0.0', transport: { type: 'stdio' } }],
    }];
    const written = await writeCache(sample);
    assert.equal(written.count, 1);
    assert.match(cachePath(), /mcp-registry-cache\.json$/);
    const reread = await readCache();
    assert.ok(reread);
    assert.equal(reread!.servers.length, 1);
    assert.equal(reread!.servers[0]!.name, 'com.example/a');
    const age = await cacheAgeMs();
    assert.ok(typeof age === 'number' && age >= -1000 && age < 60_000, `unexpected cache age: ${age}`);
  });
});

test('cache file lives under the HOME .grok-remote directory', async () => {
  await withTempHome(async () => {
    const p = cachePath();
    assert.ok(p.endsWith(path.join('.grok-remote', 'mcp-registry-cache.json')));
    assert.ok(p.startsWith(process.env['HOME']!));
  });
});

function makeEntries(names: string[]): UpstreamEntry[] {
  return names.map(n => ({
    server: {
      name: n,
      description: `description for ${n}`,
      packages: [{
        registryType: 'npm',
        identifier: n.replace('/', '-'),
        version: '1.0.0',
        transport: { type: 'stdio' },
      }],
    },
  }));
}
