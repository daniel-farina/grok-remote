import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dashboardUrlFor,
  launchEnvForMode,
  modeForLaunch,
  pm2ConfiguredHost,
} from '../lib/launch.js';

test('modeForLaunch honors explicit local launch flags', () => {
  assert.equal(modeForLaunch({ args: ['--local'], tailnetAvailable: true }), 'local');
  assert.equal(modeForLaunch({ args: ['-l'], tailnetAvailable: true }), 'local');
});

test('modeForLaunch honors explicit tailnet launch flags', () => {
  assert.equal(modeForLaunch({ args: ['--tailnet'], tailnetAvailable: false }), 'tailnet');
});

test('modeForLaunch uses local mode when tailscale is unavailable', () => {
  assert.equal(modeForLaunch({ args: [], tailnetAvailable: false }), 'local');
});

test('modeForLaunch uses tailnet mode when tailscale is available', () => {
  assert.equal(modeForLaunch({ args: [], tailnetAvailable: true }), 'tailnet');
});

test('launchEnvForMode sets direct server and pm2 host values', () => {
  assert.deepEqual(launchEnvForMode('local', { PATH: '/bin' }), {
    PATH: '/bin',
    GROK_REMOTE_HOST: '127.0.0.1',
    HOST: '127.0.0.1',
  });
});

test('pm2ConfiguredHost reads host from common pm2 record shapes', () => {
  assert.equal(pm2ConfiguredHost({ pm2_env: { HOST: '127.0.0.1' } }), '127.0.0.1');
  assert.equal(pm2ConfiguredHost({ pm2_env: { env: { HOST: '0.0.0.0' } } }), '0.0.0.0');
});

test('dashboardUrlFor keeps local installs on localhost even with tailscale', () => {
  assert.equal(
    dashboardUrlFor({
      port: 7910,
      configuredHost: '127.0.0.1',
      tailnet: { available: true, url: 'http://mac.tailnet.ts.net:7910' },
    }),
    'http://localhost:7910',
  );
});

test('dashboardUrlFor prefers tailnet URL for tailnet installs', () => {
  assert.equal(
    dashboardUrlFor({
      port: 7910,
      configuredHost: '0.0.0.0',
      tailnet: { available: true, url: 'http://mac.tailnet.ts.net:7910' },
    }),
    'http://mac.tailnet.ts.net:7910',
  );
});

test('dashboardUrlFor falls back to localhost when tailnet is unavailable', () => {
  assert.equal(
    dashboardUrlFor({
      port: 7910,
      configuredHost: '0.0.0.0',
      tailnet: { available: false, url: null },
    }),
    'http://localhost:7910',
  );
});
