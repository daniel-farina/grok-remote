import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bindHostForMode,
  modeFromArgs,
  chooseModeFromInputs,
  pm2EnvForMode,
} from '../lib/install-mode.js';

test('modeFromArgs recognizes explicit local flags', () => {
  assert.equal(modeFromArgs(['--local']), 'local');
  assert.equal(modeFromArgs(['-l']), 'local');
});

test('modeFromArgs recognizes explicit tailnet flag', () => {
  assert.equal(modeFromArgs(['--tailnet']), 'tailnet');
});

test('chooseModeFromInputs preserves non-interactive tailnet default', () => {
  assert.equal(chooseModeFromInputs({ args: [], env: {}, isTTY: false }), 'tailnet');
});

test('bindHostForMode binds local installs to localhost only', () => {
  assert.equal(bindHostForMode('local'), '127.0.0.1');
  assert.equal(bindHostForMode('tailnet'), '0.0.0.0');
});

test('pm2EnvForMode passes the computed bind host through to ecosystem config', () => {
  assert.deepEqual(pm2EnvForMode('local', { PATH: '/bin' }), {
    PATH: '/bin',
    GROK_REMOTE_HOST: '127.0.0.1',
  });
});
