
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_ICONS,
  buildIconSvg,
  getAppIconMeta,
  iconSvgDataUrl,
} from '../src/lib/app-icons.js';

test('APP_ICONS exposes several distinct variants', () => {
  assert.ok(APP_ICONS.length >= 6);
  const ids = new Set(APP_ICONS.map((v) => v.id));
  assert.equal(ids.size, APP_ICONS.length);
  assert.ok(ids.has('teal'));
  assert.ok(ids.has('amber'));
});

test('getAppIconMeta falls back to teal for unknown ids', () => {
  assert.equal(getAppIconMeta('nope').id, 'teal');
  assert.equal(getAppIconMeta('violet').id, 'violet');
});

test('buildIconSvg embeds the variant colors and monogram', () => {
  const v = getAppIconMeta('rose');
  const svg = buildIconSvg(192, v);
  assert.ok(svg.includes('GR'));
  assert.ok(svg.includes(v.fg0));
  assert.ok(svg.includes(v.bg0));
  assert.ok(svg.includes('width="192"'));
});

test('buildIconSvg maskable is full-bleed (no rounded corner)', () => {
  const svg = buildIconSvg(512, getAppIconMeta('teal'), { maskable: true });
  // first rect has rx=0 for maskable
  assert.match(svg, /rx="0"/);
});

test('iconSvgDataUrl returns a data URL', () => {
  const url = iconSvgDataUrl(64, getAppIconMeta('sky'));
  assert.ok(url.startsWith('data:image/svg+xml'));
});
