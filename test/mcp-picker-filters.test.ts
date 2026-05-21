import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFilters,
  computeCounts,
  defaultFilters,
  classifyPackageSource,
  activeFilterCount,
  serializeFilters,
  deserializeFilters,
  type PickerFilters,
} from '../src/views/system/registry-filters.js';
import type { McpRegistryEntry } from '../src/views/system/mcp-registry.js';

function entry(overrides: Partial<McpRegistryEntry> & { name: string; slug: string }): McpRegistryEntry {
  return {
    description: '',
    category: 'other',
    transport: 'stdio',
    official: false,
    command: 'npx',
    args: ['-y', overrides.slug],
    ...overrides,
  } as McpRegistryEntry;
}

const FIXTURE: McpRegistryEntry[] = [
  entry({ name: 'alpha', slug: 'alpha', category: 'development', official: true, description: 'git repo helper' }),
  entry({ name: 'bravo', slug: 'bravo', category: 'data', description: 'postgres helper', command: 'uvx', args: ['bravo'] }),
  entry({ name: 'charlie', slug: 'charlie', category: 'browser', transport: 'http', url: 'https://c', official: true, command: undefined, args: undefined }),
  entry({ name: 'delta', slug: 'delta', category: 'search', transport: 'sse', url: 'https://d', command: undefined, args: undefined, env: [{ name: 'TOKEN', required: true }] }),
  entry({ name: 'echo', slug: 'echo', category: 'productivity', command: 'docker', args: ['run', 'echo:1'], env: [{ name: 'X', required: false }] }),
  entry({ name: 'foxtrot', slug: 'foxtrot', category: 'other', command: 'go', args: ['run', '.'] }),
];

test('applyFilters with default filters returns the full list sorted by name asc', () => {
  const out = applyFilters(FIXTURE, defaultFilters());
  assert.equal(out.length, FIXTURE.length);
  assert.deepEqual(out.map(e => e.name), ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']);
});

test('applyFilters category filter restricts correctly', () => {
  const f = defaultFilters();
  f.category = 'development';
  const out = applyFilters(FIXTURE, f);
  assert.deepEqual(out.map(e => e.slug), ['alpha']);
});

test('applyFilters transport multi-select: empty Set means show all, subset filters', () => {
  const all = applyFilters(FIXTURE, defaultFilters());
  assert.equal(all.length, FIXTURE.length);
  const f = defaultFilters();
  f.transports = new Set(['http', 'sse']);
  const remote = applyFilters(FIXTURE, f);
  assert.deepEqual(remote.map(e => e.slug).sort(), ['charlie', 'delta']);
});

test('search is case-insensitive across name, description, and category', () => {
  const cases: Array<[string, string[]]> = [
    ['ALPHA', ['alpha']],
    ['postgres', ['bravo']],
    ['SEARCH', ['delta']],
  ];
  for (const [q, expected] of cases) {
    const f = defaultFilters();
    f.search = q;
    const out = applyFilters(FIXTURE, f);
    assert.deepEqual(out.map(e => e.slug).sort(), expected.sort(), `search "${q}"`);
  }
});

test('sort respects the chosen mode', () => {
  const asc = applyFilters(FIXTURE, { ...defaultFilters(), sort: 'name-asc' });
  assert.deepEqual(asc.map(e => e.name), ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']);
  const desc = applyFilters(FIXTURE, { ...defaultFilters(), sort: 'name-desc' });
  assert.deepEqual(desc.map(e => e.name), ['foxtrot', 'echo', 'delta', 'charlie', 'bravo', 'alpha']);
  const cat = applyFilters(FIXTURE, { ...defaultFilters(), sort: 'category' });
  assert.deepEqual(cat.map(e => e.category), ['browser', 'data', 'development', 'other', 'productivity', 'search']);
  const off = applyFilters(FIXTURE, { ...defaultFilters(), sort: 'official' });
  assert.deepEqual(off.slice(0, 2).map(e => e.slug).sort(), ['alpha', 'charlie']);
  assert.equal(off[0]?.official, true);
  assert.equal(off[1]?.official, true);
});

test('officialMode "only" excludes non-official and "hide" excludes official', () => {
  const only = applyFilters(FIXTURE, { ...defaultFilters(), officialMode: 'only' });
  assert.deepEqual(only.map(e => e.slug).sort(), ['alpha', 'charlie']);
  const hide = applyFilters(FIXTURE, { ...defaultFilters(), officialMode: 'hide' });
  assert.deepEqual(hide.map(e => e.slug).sort(), ['bravo', 'delta', 'echo', 'foxtrot']);
});

test('envMode "with" keeps entries whose env array is non-empty; "without" drops them', () => {
  const withEnv = applyFilters(FIXTURE, { ...defaultFilters(), envMode: 'with' });
  assert.deepEqual(withEnv.map(e => e.slug).sort(), ['delta', 'echo']);
  const withoutEnv = applyFilters(FIXTURE, { ...defaultFilters(), envMode: 'without' });
  assert.deepEqual(withoutEnv.map(e => e.slug).sort(), ['alpha', 'bravo', 'charlie', 'foxtrot']);
});

test('remoteMode "remote" keeps http+sse; "stdio-only" keeps stdio', () => {
  const remote = applyFilters(FIXTURE, { ...defaultFilters(), remoteMode: 'remote' });
  assert.deepEqual(remote.map(e => e.slug).sort(), ['charlie', 'delta']);
  const stdio = applyFilters(FIXTURE, { ...defaultFilters(), remoteMode: 'stdio-only' });
  assert.deepEqual(stdio.map(e => e.slug).sort(), ['alpha', 'bravo', 'echo', 'foxtrot']);
});

test('classifyPackageSource recognises common runners', () => {
  assert.equal(classifyPackageSource(entry({ name: 'a', slug: 'a', command: 'npx' })), 'npm');
  assert.equal(classifyPackageSource(entry({ name: 'a', slug: 'a', command: 'uvx' })), 'python');
  assert.equal(classifyPackageSource(entry({ name: 'a', slug: 'a', command: 'docker' })), 'docker');
  assert.equal(classifyPackageSource(entry({ name: 'a', slug: 'a', command: 'go' })), 'go');
  assert.equal(classifyPackageSource(entry({ name: 'a', slug: 'a', command: 'bunx' })), 'npm');
  assert.equal(classifyPackageSource(entry({ name: 'a', slug: 'a', command: 'mystery' })), 'other');
  assert.equal(
    classifyPackageSource(entry({ name: 'a', slug: 'a', transport: 'http', url: 'https://x', command: undefined })),
    'other',
  );
});

test('packageSources filter narrows to selected runners', () => {
  const f = defaultFilters();
  f.packageSources = new Set(['python']);
  assert.deepEqual(applyFilters(FIXTURE, f).map(e => e.slug), ['bravo']);
  f.packageSources = new Set(['docker', 'go']);
  assert.deepEqual(applyFilters(FIXTURE, f).map(e => e.slug).sort(), ['echo', 'foxtrot']);
});

test('computeCounts returns counts that sum sensibly with the active filter', () => {
  const counts = computeCounts(FIXTURE, defaultFilters());
  assert.equal(counts.categories['development'], 1);
  assert.equal(counts.categories['browser'], 1);
  assert.equal(counts.transports.stdio, 4);
  assert.equal(counts.transports.http, 1);
  assert.equal(counts.transports.sse, 1);
  // Pkg-source counts from fixture: alpha=npm, bravo=python, charlie=other, delta=other, echo=docker, foxtrot=go
  assert.equal(counts.packageSources.npm, 1);
  assert.equal(counts.packageSources.python, 1);
  assert.equal(counts.packageSources.docker, 1);
  assert.equal(counts.packageSources.go, 1);
  assert.equal(counts.packageSources.other, 2);
  assert.equal(counts.totals.official, 2);
  assert.equal(counts.totals.withEnv, 2);
  assert.equal(counts.totals.remote, 2);
});

test('computeCounts shows facet counts that account for OTHER active filters', () => {
  const f: PickerFilters = { ...defaultFilters(), category: 'development' };
  const counts = computeCounts(FIXTURE, f);
  // Transport counts should reflect "only development category" -> only alpha (stdio).
  assert.equal(counts.transports.stdio, 1);
  assert.equal(counts.transports.http, 0);
  assert.equal(counts.transports.sse, 0);
  // Category counts ignore the category filter so every value remains visible.
  assert.equal(counts.categories['development'], 1);
  assert.equal(counts.categories['data'], 1);
});

test('activeFilterCount counts only non-default axes', () => {
  assert.equal(activeFilterCount(defaultFilters()), 0);
  const f = defaultFilters();
  f.category = 'data';
  f.officialMode = 'only';
  f.search = 'foo';
  assert.equal(activeFilterCount(f), 3);
});

test('serialize and deserialize round-trip preserves filter state', () => {
  const f = defaultFilters();
  f.category = 'development';
  f.transports = new Set(['http']);
  f.packageSources = new Set(['npm', 'docker']);
  f.officialMode = 'only';
  f.envMode = 'with';
  f.remoteMode = 'remote';
  f.search = 'hello';
  f.sort = 'category';
  const roundTrip = deserializeFilters(serializeFilters(f));
  assert.equal(roundTrip.category, 'development');
  assert.deepEqual(Array.from(roundTrip.transports).sort(), ['http']);
  assert.deepEqual(Array.from(roundTrip.packageSources).sort(), ['docker', 'npm']);
  assert.equal(roundTrip.officialMode, 'only');
  assert.equal(roundTrip.envMode, 'with');
  assert.equal(roundTrip.remoteMode, 'remote');
  assert.equal(roundTrip.search, 'hello');
  assert.equal(roundTrip.sort, 'category');
});

test('deserializeFilters falls back to defaults on bad input', () => {
  assert.deepEqual(deserializeFilters(null), defaultFilters());
  assert.deepEqual(deserializeFilters('not json {'), defaultFilters());
  const bogus = deserializeFilters(JSON.stringify({ officialMode: 'nope', sort: 'wat', transports: ['ws'] }));
  assert.equal(bogus.officialMode, 'all');
  assert.equal(bogus.sort, 'name-asc');
  assert.equal(bogus.transports.size, 0);
});
