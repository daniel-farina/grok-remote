import { bindHostForMode, modeFromArgs, pm2EnvForMode } from './install-mode.js';

export function localUrlForPort(port = 7910) {
  return `http://localhost:${port}`;
}

export function pm2ConfiguredHost(record) {
  const env = record?.pm2_env || {};
  return env.HOST || env.env?.HOST || env.pm2_env?.HOST || '';
}

export function modeForLaunch({ args = [], tailnetAvailable = false } = {}) {
  const explicit = modeFromArgs(args);
  if (explicit) return explicit;
  return tailnetAvailable ? 'tailnet' : 'local';
}

export function launchEnvForMode(mode, baseEnv = process.env) {
  return {
    ...pm2EnvForMode(mode, baseEnv),
    HOST: bindHostForMode(mode),
  };
}

export function dashboardUrlFor({ port = 7910, configuredHost = '', tailnet = {} } = {}) {
  const localURL = localUrlForPort(port);
  const host = String(configuredHost || '').toLowerCase();
  if (host === '127.0.0.1' || host === 'localhost') return localURL;
  if (tailnet.available && tailnet.url) return tailnet.url;
  return localURL;
}

export function healthUrlForDashboard(url) {
  return new URL('/api/health', url).toString();
}
