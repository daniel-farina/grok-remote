#!/usr/bin/env node
// grok-remote installer
//
// Pure Node. Runs through the system setup with animated, terminal-style
// feedback. Each step is a self-contained cycle:
//
//   1. Heading types in
//   2. Spinner animates while the underlying command runs
//   3. The step resolves into an OK/FAIL panel
//
// Ends with a transmission frame showing your tailnet URL.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chooseModeFromInputs, pm2EnvForMode } from './lib/install-mode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HERE = __dirname;

// ─── colors ──────────────────────────────────────────────────────────────
const COLOR = !process.env.NO_COLOR && (
  process.env.FORCE_COLOR === '1' ||
  process.stdout.isTTY ||
  (process.env.npm_lifecycle_event && process.env.TERM_PROGRAM)
);
const rgb = (r, g, b) => COLOR ? `\x1b[38;2;${r};${g};${b}m` : '';
const bg  = (r, g, b) => COLOR ? `\x1b[48;2;${r};${g};${b}m` : '';
const bold = COLOR ? '\x1b[1m' : '';
const dim  = COLOR ? '\x1b[2m' : '';
const reset = COLOR ? '\x1b[0m' : '';

const TEAL = rgb(94, 234, 212);
const BLUE = rgb(121, 192, 255);
const GOOD = rgb(134, 239, 172);
const WARN = rgb(251, 191, 36);
const BAD  = rgb(255, 123, 114);
const AMBR = rgb(252, 168, 84);
const MUT  = rgb(134, 147, 164);
const DIM  = rgb(74, 83, 96);
const WHITE = rgb(232, 240, 248);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── ASCII art ───────────────────────────────────────────────────────────
// The logo: a hole opens, deepens, flashes, and settles into "GR" (Grok Remote).
const FIGLET_GR = [
  '  ██████╗ ██████╗  ',
  ' ██╔════╝ ██╔══██╗ ',
  ' ██║  ███╗██████╔╝ ',
  ' ██║   ██║██╔══██╗ ',
  ' ╚██████╔╝██║  ██║ ',
  '  ╚═════╝ ╚═╝  ╚═╝ ',
];
const SUBTITLE = '·  g r o k   r e m o t e  ·  v0.1.0';

// Hole frames. Each is 19 wide × 6 tall, lined up with FIGLET_GR.
// Read top to bottom as: empty → pinprick → ring → deepening hole → pulse → flash.
const HOLE_FRAMES = [
  // 0: empty
  ['                   ',
   '                   ',
   '                   ',
   '                   ',
   '                   ',
   '                   '],
  // 1: pinprick at center
  ['                   ',
   '                   ',
   '         ·         ',
   '         ·         ',
   '                   ',
   '                   '],
  // 2: small ring forming
  ['                   ',
   '        ░░░        ',
   '       ░   ░       ',
   '       ░   ░       ',
   '        ░░░        ',
   '                   '],
  // 3: medium ring with first shading
  ['       ░░░░░       ',
   '      ░▒▒▒▒▒░      ',
   '     ░▒▓▓▓▓▓▒░     ',
   '     ░▒▓▓▓▓▓▒░     ',
   '      ░▒▒▒▒▒░      ',
   '       ░░░░░       '],
  // 4: large hole with depth
  ['     ░░░░░░░░░     ',
   '    ░▒▒▒▓▓▓▒▒▒░    ',
   '   ░▒▓▓█████▓▓▒░   ',
   '   ░▒▓▓█████▓▓▒░   ',
   '    ░▒▒▒▓▓▓▒▒▒░    ',
   '     ░░░░░░░░░     '],
  // 5: fully formed hole, suspense
  ['    ░░░░░░░░░░░    ',
   '  ░▒▒▒▒▓▓▓▓▓▒▒▒▒░  ',
   ' ░▒▓▓▓███████▓▓▓▒░ ',
   ' ░▒▓▓▓███████▓▓▓▒░ ',
   '  ░▒▒▒▒▓▓▓▓▓▒▒▒▒░  ',
   '    ░░░░░░░░░░░    '],
  // 6: bright pulse from inside
  ['    ▓▓▓▓▓▓▓▓▓▓▓    ',
   '  ▓███████████████ ',
   ' █████████████████ ',
   ' █████████████████ ',
   '  ▓███████████████ ',
   '    ▓▓▓▓▓▓▓▓▓▓▓    '],
  // 7: full white flash
  ['███████████████████',
   '███████████████████',
   '███████████████████',
   '███████████████████',
   '███████████████████',
   '███████████████████'],
];

const HOLE_SEQUENCE = [
  { idx: 0, hold: 60,  phase: 'hole' },
  { idx: 1, hold: 110, phase: 'hole' },
  { idx: 2, hold: 110, phase: 'hole' },
  { idx: 3, hold: 130, phase: 'hole' },
  { idx: 4, hold: 150, phase: 'hole' },
  { idx: 5, hold: 280, phase: 'hole' },   // suspense beat
  { idx: 6, hold: 70,  phase: 'pulse' },
  { idx: 7, hold: 55,  phase: 'flash' },
];

// Color per char per phase (for the hole animation).
function holeColorFor(ch, phase) {
  if (phase === 'flash') return rgb(232, 240, 248);
  if (phase === 'pulse') {
    if (ch === '█') return rgb(232, 240, 248);
    if (ch === '▓') return TEAL;
    return TEAL;
  }
  // hole phase: bright rim → fading into a void
  if (ch === '·' || ch === '░') return TEAL;             // rim glow
  if (ch === '▒') return BLUE;                            // mid depth
  if (ch === '▓') return rgb(60, 84, 122);                // deep
  if (ch === '█') return rgb(18, 24, 38);                 // void
  return reset;
}
function colorizeHoleLine(line, phase) {
  let out = '';
  let last = null;
  for (const ch of line) {
    const c = holeColorFor(ch, phase);
    if (c !== last) { out += c; last = c; }
    out += ch;
  }
  return out + reset;
}

function write(s) { process.stdout.write(s); }
function writeLn(s = '') { process.stdout.write(s + '\n'); }
function hideCursor() { if (COLOR) write('\x1b[?25l'); }
function showCursor() { if (COLOR) write('\x1b[?25h'); }
function moveUp(n) { if (COLOR && n > 0) write(`\x1b[${n}A`); }
function clearLine() { if (COLOR) write('\x1b[2K\r'); }

// Gradient helper: blend teal -> blue across a vertical span
function gradColor(i, total) {
  const t = total <= 1 ? 0 : i / (total - 1);
  const r = Math.round(94 + (121 - 94) * t);
  const g = Math.round(234 + (192 - 234) * t);
  const b = Math.round(212 + (255 - 212) * t);
  return rgb(r, g, b);
}

// ─── intro animation ─────────────────────────────────────────────────────
async function intro() {
  hideCursor();

  // Static fallback for non-TTY (CI, redirected output): just print GR.
  if (!COLOR || !process.stdout.isTTY) {
    for (let i = 0; i < FIGLET_GR.length; i++) {
      writeLn(`${gradColor(i, FIGLET_GR.length)}${FIGLET_GR[i]}${reset}`);
    }
    writeLn(`${MUT}        ${SUBTITLE}${reset}`);
    writeLn(`${DIM}        your grok agent · local or tailnet${reset}`);
    writeLn();
    return;
  }

  // Reserve 6 lines for the figlet; we'll overwrite them frame by frame.
  for (let i = 0; i < 6; i++) writeLn();
  moveUp(6);

  // Play the hole sequence: empty → ring → hole → pulse → flash.
  for (const { idx, hold, phase } of HOLE_SEQUENCE) {
    const frame = HOLE_FRAMES[idx];
    for (let i = 0; i < frame.length; i++) {
      write('\x1b[2K\r' + colorizeHoleLine(frame[i], phase) + '\n');
    }
    moveUp(frame.length);
    await sleep(hold);
  }

  // Reveal final GR figlet (replaces the flash).
  for (let i = 0; i < FIGLET_GR.length; i++) {
    write('\x1b[2K\r' + gradColor(i, FIGLET_GR.length) + FIGLET_GR[i] + reset + '\n');
  }
  writeLn(`${MUT}        ${SUBTITLE}${reset}`);
  writeLn(`${DIM}        your grok agent · local or tailnet${reset}`);
  writeLn();
  showCursor();
}

// ─── mode prompt ─────────────────────────────────────────────────────────
// Ask the user whether they want local-only or tailnet mode. Honors flags
// and env, and falls back to tailnet on non-TTY (preserves prior behavior).
async function chooseMode() {
  const args = process.argv.slice(2);
  const resolved = chooseModeFromInputs({ args, env: process.env, isTTY: process.stdin.isTTY });
  if (resolved) return resolved;

  writeLn(`${WHITE}${bold}choose a mode:${reset}`);
  writeLn(`  ${BLUE}[1]${reset} ${WHITE}local-only${reset}      ${MUT}(just this Mac, no tailscale)${reset}`);
  writeLn(`  ${BLUE}[2]${reset} ${WHITE}tailnet${reset}         ${MUT}(reach grok-remote from any device on your tailnet)${reset}`);
  const rl = readline.createInterface({ input, output });
  let answer = '';
  try {
    answer = (await rl.question(`${MUT}default [2]: ${reset}`)).trim().toLowerCase();
  } finally {
    rl.close();
  }
  writeLn();
  if (answer === '1' || answer === 'local' || answer === 'l') return 'local';
  // Default and explicit 2/tailnet/t all map to tailnet.
  return 'tailnet';
}

// ─── shell helpers ───────────────────────────────────────────────────────
function which(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}
function tryCmd(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { ok: r.status === 0, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), code: r.status };
}
// Run a command with the spinner running until it completes.
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    let out = '', err = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', (e) => resolve({ ok: false, stdout: out, stderr: err + e.message, code: -1 }));
    child.on('exit', (code) => resolve({ ok: code === 0, stdout: out.trim(), stderr: err.trim(), code }));
  });
}

// ─── step rendering ──────────────────────────────────────────────────────
let stepCounter = 0;
async function step(label, fn, opts = {}) {
  stepCounter++;
  const num = String(stepCounter).padStart(2, '0');

  // Typewriter heading
  const prefix = `${DIM}┃${reset} ${BLUE}${bold}[${num}]${reset} `;
  const animate = COLOR && process.stdout.isTTY && !process.env.NO_ANIMATE;
  if (animate) {
    write(prefix);
    for (const ch of label) {
      write(`${WHITE}${ch}${reset}`);
      await sleep(8);
    }
    write(' ');
  } else {
    write(`${prefix}${label} `);
  }

  // Spinner + run
  const spinChars = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let stop = false;
  let spinIdx = 0;
  const spinStart = Date.now();
  const spin = async () => {
    if (!animate) return;
    hideCursor();
    while (!stop) {
      write(`\x1b[s${TEAL}${spinChars[spinIdx % spinChars.length]}${reset}\x1b[u`);
      spinIdx++;
      await sleep(80);
    }
  };
  const spinTask = spin();
  let result;
  try {
    result = await fn();
  } catch (e) {
    result = { ok: false, status: 'fail', detail: String(e?.message || e) };
  }
  stop = true;
  await spinTask;
  const elapsed = Date.now() - spinStart;

  // Render the final status badge
  const status = result.status || (result.ok ? 'ok' : 'fail');
  let badge;
  if (status === 'ok') badge = `${GOOD}[ OK ]${reset}`;
  else if (status === 'skip') badge = `${MUT}[skip]${reset}`;
  else if (status === 'warn') badge = `${WARN}[warn]${reset}`;
  else badge = `${BAD}[FAIL]${reset}`;
  const detail = result.detail ? ` ${MUT}${result.detail}${reset}` : '';
  const time = elapsed > 200 ? ` ${DIM}(${(elapsed / 1000).toFixed(1)}s)${reset}` : '';
  // Clear the spinner cell, write the final badge
  if (animate) write('\x1b[2K\r');
  writeLn(`${prefix}${label} ${badge}${time}${detail}`);
  showCursor();
  return result;
}

// ─── steps ───────────────────────────────────────────────────────────────
const ctx = {};   // shared state

async function stepCheckNode() {
  return step('verify node >= 20', async () => {
    const r = tryCmd('node', ['--version']);
    if (!r.ok) return { ok: false, detail: 'node binary not found' };
    const m = r.stdout.match(/v(\d+)\.(\d+)/);
    if (!m) return { ok: false, detail: `unparseable: ${r.stdout}` };
    const major = parseInt(m[1], 10);
    if (major < 20) return { ok: false, detail: `${r.stdout} (< v20)` };
    return { ok: true, detail: r.stdout };
  });
}

async function stepEnsurePM2() {
  return step('ensure pm2 (process manager)', async () => {
    if (which('pm2')) {
      const v = tryCmd('pm2', ['--version']);
      return { ok: true, detail: `present, v${v.stdout}` };
    }
    // npm install -g pm2
    const r = await runCmd('npm', ['install', '-g', 'pm2'], { env: process.env });
    if (!r.ok) return { ok: false, detail: r.stderr.split('\n').pop() || 'npm install -g pm2 failed' };
    return { ok: true, detail: 'installed via npm' };
  });
}

async function stepEnsureTailscale() {
  return step('ensure tailscale', async () => {
    if (which('tailscale')) {
      const v = tryCmd('tailscale', ['version']);
      const ver = v.stdout.split('\n')[0] || 'present';
      return { ok: true, detail: ver };
    }
    // Try Homebrew install (macOS)
    if (process.platform === 'darwin') {
      if (!which('brew')) {
        return { ok: false, detail: 'install Homebrew first (https://brew.sh) or install Tailscale manually' };
      }
      const r = await runCmd('brew', ['install', 'tailscale']);
      if (!r.ok) return { ok: false, detail: 'brew install tailscale failed' };
      return { ok: true, detail: 'installed via brew' };
    }
    // Linux: defer to curl-based installer
    if (process.platform === 'linux') {
      return { ok: false, detail: 'install Tailscale: curl -fsSL https://tailscale.com/install.sh | sh' };
    }
    return { ok: false, detail: `unsupported platform: ${process.platform}` };
  });
}

async function stepStartTailscaled() {
  return step('start tailscaled (daemon)', async () => {
    // Check if it's already running (try `tailscale status`)
    const status = tryCmd('tailscale', ['status', '--json']);
    if (status.ok) return { status: 'skip', detail: 'already running' };

    if (process.platform === 'darwin') {
      // Two ways to get tailscaled running on macOS:
      //   (a) Tailscale.app from tailscale.com (GUI; runs daemon in user
      //       session). If /Applications/Tailscale.app exists, the user
      //       just needs to launch it once.
      //   (b) CLI-only install (e.g. `brew install tailscale`): no GUI,
      //       no auto-start. Tailscale ships an installer for a launchd
      //       LaunchDaemon: `sudo tailscale install-system-daemon`.
      //
      // We don't run sudo from here because the installer's piped stdio
      // can't relay a password prompt. We detect the situation and tell
      // the user exactly what to run, then warn so they re-run install.sh.
      const hasGuiApp = fs.existsSync('/Applications/Tailscale.app');
      if (hasGuiApp) {
        return { ok: false, status: 'warn',
          detail: 'open Tailscale.app once to start the daemon, then re-run installer' };
      }
      // CLI-only install path.
      const hasSystemDaemonCmd = tryCmd('tailscale', ['install-system-daemon', '--help']).ok;
      if (hasSystemDaemonCmd) {
        return { ok: false, status: 'warn',
          detail: 'CLI-only install detected. Run: sudo tailscale install-system-daemon (you will be prompted for your password). Then re-run installer.' };
      }
      // Neither GUI app nor system-daemon subcommand: tell them to grab
      // the official GUI from tailscale.com.
      return { ok: false, status: 'warn',
        detail: 'Tailscale daemon not running. Install Tailscale.app from https://tailscale.com/download and launch it once. Then re-run installer.' };
    }

    if (process.platform === 'linux') {
      const r = await runCmd('sudo', ['systemctl', 'enable', '--now', 'tailscaled']);
      if (r.ok) return { ok: true, detail: 'tailscaled enabled via systemctl' };
      // Common reason for failure: no systemd (Alpine, minimal containers).
      // Detect and give a more useful hint.
      const hasSystemctl = !!which('systemctl');
      if (!hasSystemctl) {
        return { ok: false, status: 'warn',
          detail: 'no systemd detected. Start tailscaled however your distro expects (e.g. `sudo tailscaled --tun=userspace-networking &`), then re-run installer.' };
      }
      return { ok: false, detail: 'sudo systemctl enable --now tailscaled failed (run it manually with sudo and inspect the error, then re-run installer)' };
    }

    return { ok: false, detail: `unsupported platform: ${process.platform}` };
  });
}

async function stepTailscaleAuth() {
  return step('check tailscale auth', async () => {
    const s = tryCmd('tailscale', ['status', '--json']);
    if (!s.ok) return { ok: false, detail: 'tailscaled not reachable (run earlier step first)' };
    try {
      const parsed = JSON.parse(s.stdout);
      if (parsed.BackendState === 'Running') {
        const user = parsed.Self?.LoginName || parsed.User?.[parsed.Self?.UserID]?.LoginName || '';
        return { ok: true, detail: user ? `logged in as ${user}` : 'logged in' };
      }
      if (parsed.BackendState === 'NeedsLogin' || parsed.BackendState === 'NoState') {
        // Try `tailscale up` (interactive): prints a URL to authenticate in the browser
        return { ok: false, status: 'warn',
          detail: 'run `tailscale up` and open the URL printed to authenticate, then re-run installer' };
      }
      return { ok: false, detail: `BackendState=${parsed.BackendState}` };
    } catch (e) {
      return { ok: false, detail: 'failed to parse tailscale status' };
    }
  });
}

async function stepResolveTailnetURL() {
  return step('resolve tailnet url', async () => {
    const s = tryCmd('tailscale', ['status', '--json']);
    if (!s.ok) return { ok: false, detail: 'tailscale status failed' };
    let parsed;
    try { parsed = JSON.parse(s.stdout); } catch { return { ok: false, detail: 'unparseable JSON' }; }
    const self = parsed.Self || {};
    const dnsName = (self.DNSName || '').replace(/\.$/, '');
    const ip = (self.TailscaleIPs && self.TailscaleIPs[0]) || '';
    const port = ctx.appPort || 7910;
    if (!dnsName && !ip) return { ok: false, detail: 'no tailscale identity found on this device' };
    ctx.tailnetDNS = dnsName;
    ctx.tailnetIP  = ip;
    ctx.tailnetURL = dnsName ? `http://${dnsName}:${port}` : `http://${ip}:${port}`;
    return { ok: true, detail: ctx.tailnetURL };
  });
}

async function stepNpmInstall() {
  return step('install app dependencies (npm install)', async () => {
    if (existsSync(path.join(HERE, 'node_modules', 'vite'))) {
      return { status: 'skip', detail: 'node_modules present' };
    }
    const r = await runCmd('npm', ['install'], { cwd: HERE });
    return r.ok
      ? { ok: true, detail: 'dependencies installed' }
      : { ok: false, detail: 'npm install failed (check terminal output)' };
  });
}

async function stepBuildVite() {
  return step('build dashboard (vite build)', async () => {
    const r = await runCmd('npx', ['vite', 'build'], { cwd: HERE });
    if (!r.ok) return { ok: false, detail: 'vite build failed' };
    const out = r.stdout.split('\n').find(l => l.includes('built in')) || 'built';
    return { ok: true, detail: out.trim() };
  });
}

async function stepWriteEcosystem() {
  return step('write pm2 ecosystem config', async () => {
    const cfgPath = path.join(HERE, 'ecosystem.config.cjs');
    // Already shipped, but stamp the cwd at install time so PM2 has it on save
    if (!existsSync(cfgPath)) {
      return { ok: false, detail: 'ecosystem.config.cjs missing from repo' };
    }
    return { ok: true, detail: cfgPath };
  });
}

async function stepStartPM2() {
  return step('start under pm2', async () => {
    // Stop any prior instance first (best-effort)
    await runCmd('pm2', ['delete', 'grok-remote'], { cwd: HERE });
    const r = await runCmd('pm2', ['start', 'ecosystem.config.cjs'], {
      cwd: HERE,
      env: pm2EnvForMode(ctx.mode, process.env),
    });
    return r.ok
      ? { ok: true, detail: 'pm2 start grok-remote' }
      : { ok: false, detail: r.stderr.split('\n').pop() || 'pm2 start failed' };
  });
}

async function stepSavePM2() {
  return step('save pm2 process list', async () => {
    const r = await runCmd('pm2', ['save']);
    return r.ok
      ? { ok: true, detail: 'saved (auto-resume on boot)' }
      : { status: 'warn', detail: 'pm2 save returned non-zero; you can re-run later' };
  });
}

async function stepInstallGrCommand() {
  return step('install gr command (global shortcut)', async () => {
    const grPath = path.join(HERE, 'bin', 'gr');
    if (!existsSync(grPath)) {
      return { ok: false, detail: `bin/gr missing at ${grPath}` };
    }
    // chmod +x
    try { spawnSync('chmod', ['+x', grPath]); } catch { /* best-effort */ }

    const tryLink = (target) => {
      try { mkdirSync(path.dirname(target), { recursive: true }); } catch {}
      const r = spawnSync('ln', ['-sf', grPath, target], { encoding: 'utf8' });
      return r.status === 0;
    };

    // 1. /usr/local/bin
    const sysTarget = '/usr/local/bin/gr';
    if (tryLink(sysTarget)) {
      return { ok: true, detail: sysTarget };
    }

    // 2. ~/.local/bin (verify on PATH)
    const userBin = path.join(os.homedir(), '.local', 'bin');
    const userTarget = path.join(userBin, 'gr');
    if (tryLink(userTarget)) {
      const onPath = (process.env.PATH || '').split(path.delimiter).includes(userBin);
      if (onPath) {
        return { ok: true, detail: userTarget };
      }
      return {
        ok: true, status: 'warn',
        detail: `linked at ${userTarget}; add ~/.local/bin to PATH to use \`gr\``,
      };
    }

    // 3. neither writable
    return {
      ok: true, status: 'warn',
      detail: `link manually: ln -sf ${grPath} /usr/local/bin/gr`,
    };
  });
}

// ─── finale ──────────────────────────────────────────────────────────────
async function finale() {
  const localURL = ctx.localURL || `http://localhost:${ctx.appPort || 7910}`;
  const isTailnet = ctx.mode !== 'local' && !!ctx.tailnetURL;
  writeLn();
  // ASCII frame
  const frameTop = `${DIM}╔══════════════════════════════════════════════════════════════════╗${reset}`;
  const frameBot = `${DIM}╚══════════════════════════════════════════════════════════════════╝${reset}`;
  const frameMid = (s) => `${DIM}║${reset}  ${s}${' '.repeat(Math.max(0, 64 - stripAnsi(s).length))}${DIM}║${reset}`;
  writeLn(frameTop);
  if (isTailnet) {
    writeLn(frameMid(`${GOOD}● ready${reset}   ${dim}grok-remote is live on your tailnet${reset}`));
    writeLn(frameMid(''));
    writeLn(frameMid(`${MUT}tailnet url:${reset} ${BLUE}${bold}${ctx.tailnetURL}${reset}`));
    writeLn(frameMid(`${MUT}local url  :${reset} ${BLUE}${bold}${localURL}${reset}`));
    writeLn(frameMid(`${MUT}dns        :${reset} ${WHITE}${ctx.tailnetDNS || '(none)'}${reset}`));
    writeLn(frameMid(`${MUT}ip         :${reset} ${WHITE}${ctx.tailnetIP || '127.0.0.1'}${reset}`));
  } else {
    writeLn(frameMid(`${GOOD}● ready${reset}   ${dim}grok-remote is live on this machine${reset}`));
    writeLn(frameMid(''));
    writeLn(frameMid(`${MUT}url:${reset} ${BLUE}${bold}${localURL}${reset}`));
    writeLn(frameMid(`${dim}tailscale not enabled (re-run with --tailnet to set it up)${reset}`));
  }
  writeLn(frameMid(''));
  writeLn(frameMid(`${dim}pm2 logs grok-remote${reset}    ${MUT}# follow${reset}`));
  writeLn(frameMid(`${dim}pm2 restart grok-remote${reset} ${MUT}# restart${reset}`));
  writeLn(frameMid(`${dim}pm2 stop grok-remote${reset}    ${MUT}# stop${reset}`));
  writeLn(frameBot);
  writeLn();
  if (isTailnet) {
    writeLn(`${TEAL}${bold}tip${reset}  run ${BLUE}gr${reset} from anywhere on your tailnet to check status, open the dashboard, or re-run setup.`);
  } else {
    writeLn(`${TEAL}${bold}tip${reset}  run ${BLUE}gr${reset} to check status, open the dashboard, or re-run setup.`);
  }
  writeLn();
  writeLn(`${AMBR}⚠ Not affiliated with xAI, grok, or Tailscale.${reset}`);
  if (isTailnet) {
    writeLn(`${MUT}Community tool. Reach your agent from anywhere on your tailnet.${reset}`);
  } else {
    writeLn(`${MUT}Community tool. Running locally on this machine.${reset}`);
  }
  writeLn();
}
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

// Decide whether to auto-open the dashboard in a browser. Skip when:
//   - --no-open / -n flag is passed
//   - NO_OPEN=1 / GR_NO_OPEN=1 env var is set
//   - CI=1
//   - running over SSH (SSH_CONNECTION set) - no display on the remote box
function shouldAutoOpen() {
  const args = process.argv.slice(2);
  if (args.includes('--no-open') || args.includes('-n')) return false;
  if (process.env.NO_OPEN === '1' || process.env.GR_NO_OPEN === '1') return false;
  if (process.env.CI === '1' || process.env.CI === 'true') return false;
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT) return false;
  return true;
}

// Open the URL in Chrome if available; fall back to the OS default browser.
// Returns { ok, detail }.
async function openInBrowser(url) {
  if (process.platform === 'darwin') {
    // Try Chrome via `open -a`. On failure (Chrome not installed) fall back
    // to the OS default browser.
    const chrome = await runCmd('open', ['-a', 'Google Chrome', url]);
    if (chrome.ok) return { ok: true, detail: 'opened in Chrome' };
    const def = await runCmd('open', [url]);
    return def.ok
      ? { ok: true, detail: 'opened in default browser' }
      : { ok: false, detail: 'failed to open browser' };
  }
  if (process.platform === 'linux') {
    if (which('google-chrome')) {
      const r = spawn('google-chrome', [url], { detached: true, stdio: 'ignore' });
      r.unref?.();
      return { ok: true, detail: 'opened in Chrome' };
    }
    if (which('chromium-browser')) {
      const r = spawn('chromium-browser', [url], { detached: true, stdio: 'ignore' });
      r.unref?.();
      return { ok: true, detail: 'opened in Chromium' };
    }
    if (which('xdg-open')) {
      const r = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
      r.unref?.();
      return { ok: true, detail: 'opened in default browser' };
    }
    return { ok: false, detail: 'no opener found (install xdg-utils)' };
  }
  return { ok: false, detail: `unsupported platform: ${process.platform}` };
}

async function stepOpenBrowser() {
  return step('open dashboard in Chrome', async () => {
    if (!shouldAutoOpen()) return { status: 'skip', detail: 'disabled via flag/env' };
    // Prefer tailnet URL when available; fall back to local URL otherwise.
    const url = (ctx.mode !== 'local' && ctx.tailnetURL)
      ? ctx.tailnetURL
      : (ctx.localURL || `http://localhost:${ctx.appPort || 7910}`);
    // Give the server a beat to accept connections.
    await sleep(800);
    return openInBrowser(url);
  });
}

// ─── main ────────────────────────────────────────────────────────────────
async function main() {
  ctx.appPort = parseInt(process.env.PORT || '7910', 10);
  ctx.localURL = `http://localhost:${ctx.appPort}`;

  try {
    await intro();
    ctx.mode = await chooseMode();
    await stepCheckNode();
    await stepEnsurePM2();
    if (ctx.mode !== 'local') {
      await stepEnsureTailscale();
      await stepStartTailscaled();
      await stepTailscaleAuth();
      await stepResolveTailnetURL();
    }
    await stepNpmInstall();
    await stepBuildVite();
    await stepWriteEcosystem();
    await stepStartPM2();
    await stepSavePM2();
    await stepInstallGrCommand();
    await stepOpenBrowser();
    await finale();
  } catch (e) {
    showCursor();
    writeLn(`\n${BAD}installer crashed:${reset} ${e?.stack || e}`);
    process.exit(1);
  }
}

main();
