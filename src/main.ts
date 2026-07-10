// grok-remote dashboard entry point.

import Split from 'split.js';
import { api } from './lib/api.js';
import { AgentsSidebar } from './views/agents.js';
import { ChatView } from './views/chat.js';
import { SettingsView } from './views/settings.js';
import { el } from './lib/render.js';
import { registerPwa } from './lib/pwa.js';
import { applyTheme, getTheme, nextTheme, getThemeMeta } from './lib/themes.js';
import { installVersionFooter } from './lib/version-footer.js';
import { SYSTEM_PAGES, getSystemPage } from './views/system/index.js';
import { iconHtml } from './lib/icons.js';
import { middleTruncate } from './lib/format.js';
import { applyAppIcon, getAppIconId } from './lib/app-icons.js';

interface Agent {
  id: string;
  name?: string;
  status?: string;
  inFlight?: number;
  [k: string]: unknown;
}

type Route =
  | { name: 'home' }
  | { name: 'chat'; agentId: string }
  | { name: 'settings'; sub: string }
  | { name: 'system'; area: string; parts: string[] }
  | { name: 'redirect'; to: string };

interface SystemPageRef {
  area: string;
  module?: { mount?: (host: HTMLElement, route?: unknown) => void; unmount?: () => void };
}

applyTheme(getTheme());

function syncThemeToggle(name: string): void {
  const meta = getThemeMeta(name);
  const dot   = document.getElementById('theme-toggle-dot');
  const label = document.getElementById('theme-toggle-label');
  const btn   = document.getElementById('theme-toggle');
  if (dot)   dot.style.background = meta.accent;
  if (label) label.textContent = meta.label;
  if (btn)   btn.title = `theme: ${meta.label} (click to cycle)`;
}

window.addEventListener('storage', (ev: StorageEvent) => {
  if (ev.key === 'grok-remote.theme') {
    applyTheme(getTheme());
    syncThemeToggle(getTheme());
  }
});
window.addEventListener('grok-remote:theme-change', () => {
  syncThemeToggle(getTheme());
});

function setStatus(kind: string, text: string, opts?: { title?: string }): void {
  const pill = document.getElementById('status-pill');
  const txt  = document.getElementById('status-text');
  if (!pill || !txt) return;
  pill.className = 'status-pill';
  pill.classList.add(`status-pill--${kind}`);
  pill.textContent = kind === 'ok' ? '●' : (kind === 'fail' ? '×' : (kind === 'warn' ? '!' : '·'));
  txt.textContent = text;
  const title = (opts && opts.title) || text;
  txt.setAttribute('title', title);
  // Keep the status group itself hoverable with the full name.
  const wrap = document.getElementById('status');
  if (wrap) wrap.setAttribute('title', title);
}

/** Prefer MagicDNS, then tailscale hostname, then the page host. */
function pickTailnetHost(ts: { dns?: string; hostname?: string } | null | undefined, pageHost?: string): string {
  const dns = (ts && typeof ts.dns === 'string' && ts.dns.trim()) || '';
  if (dns) return dns.replace(/\.$/, '');
  const hn = (ts && typeof ts.hostname === 'string' && ts.hostname.trim()) || '';
  if (hn) return hn;
  return (pageHost || (typeof location !== 'undefined' ? location.hostname : '') || '').trim();
}

async function pingHello(): Promise<void> {
  try {
    const data = await api.hello() as {
      hostname?: string;
      tailscale?: { backend?: string; dns?: string; hostname?: string; ip?: string };
    };
    const ts = data && data.tailscale;
    const fullHost = pickTailnetHost(ts, data && data.hostname);
    // Re-apply icon once we know the host so the auto-default (host-hash)
    // and manifest short_name stay in sync with the machine we're on.
    try { void applyAppIcon(undefined, { host: fullHost, fullHost }); } catch { /* ignore */ }

    if (ts && ts.backend === 'Running') {
      const label = fullHost
        ? middleTruncate(fullHost, 24)
        : 'tailnet up';
      setStatus('ok', label, { title: fullHost || 'tailnet up' });
    } else if (ts) {
      const state = ts.backend || 'unknown';
      const label = fullHost
        ? `${middleTruncate(fullHost, 18)} · ${state}`
        : `tailscale: ${state}`;
      setStatus('warn', label, { title: fullHost ? `${fullHost} (${state})` : `tailscale: ${state}` });
    } else if (fullHost) {
      setStatus('warn', middleTruncate(fullHost, 24), {
        title: `${fullHost} (no tailscale identity)`,
      });
    } else {
      setStatus('warn', 'no tailscale identity');
    }
  } catch {
    setStatus('fail', 'api unreachable');
  }
}

const SYSTEM_AREAS = new Set(SYSTEM_PAGES.map((p) => p.area));

const SETTINGS_AREAS = new Set([
  'general',
  'skills', 'subagents', 'hooks', 'plugins', 'marketplaces',
  'mcp', 'lsp', 'models', 'worktrees', 'import', 'setup',
]);

function parseRoute(): Route {
  const h = (location.hash || '#/').replace(/^#/, '');
  const parts = h.split('/').filter(Boolean);
  if (!parts.length) return { name: 'home' };
  if (parts[0] === 'agents' && parts[1]) return { name: 'chat', agentId: parts[1] };
  if (parts[0] === 'settings') {
    return { name: 'settings', sub: parts[1] || 'general' };
  }
  if (parts[0] && SYSTEM_AREAS.has(parts[0])) return { name: 'system', area: parts[0], parts };
  if (parts[0] && SETTINGS_AREAS.has(parts[0])) {
    return { name: 'redirect', to: `#/settings/${parts[0]}` };
  }
  return { name: 'home' };
}

function navigate(hash: string): void {
  if (location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = hash;
  }
}

function openDrawer(): void {
  document.body.setAttribute('data-drawer-open', '');
  const btn = document.getElementById('hamburger-btn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  const bd = document.getElementById('drawer-backdrop') as HTMLElement | null;
  if (bd) bd.hidden = false;
}
function closeDrawer(): void {
  document.body.removeAttribute('data-drawer-open');
  const btn = document.getElementById('hamburger-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  const bd = document.getElementById('drawer-backdrop') as HTMLElement | null;
  if (bd) bd.hidden = true;
}
function toggleDrawer(): void {
  if (document.body.hasAttribute('data-drawer-open')) closeDrawer();
  else openDrawer();
}

interface RailIconOpts {
  href: string;
  title: string;
  area: string;
  iconName?: string;
  label?: string;
}

function makeRailIcon({ href, title, area, iconName, label }: RailIconOpts): HTMLElement {
  const a = el('a', {
    class: 'left-rail-item',
    href,
    title,
    'aria-label': title,
    'data-area': area,
  });
  const icon = document.createElement('span');
  icon.className = 'left-rail-icon';
  icon.innerHTML = iconHtml(iconName || '');
  a.appendChild(icon);
  const lbl = el('span', { class: 'left-rail-label' }, label || title);
  a.appendChild(lbl);
  return a;
}

function buildLeftRail(): HTMLElement {
  const rail = el('nav', { class: 'left-rail', 'aria-label': 'top-level navigation' });
  rail.appendChild(makeRailIcon({
    href: '#/', title: 'conversations', area: 'home', iconName: 'home', label: 'chats',
  }));
  for (const p of SYSTEM_PAGES) {
    rail.appendChild(makeRailIcon({
      href: `#/${p.area}`, title: p.label, area: p.area, iconName: p.iconName, label: p.label,
    }));
  }
  return rail;
}

function updateRailHighlight(route: Route): void {
  const rail = document.querySelector('.left-rail');
  if (!rail) return;
  let activeArea = 'home';
  if (route.name === 'chat') activeArea = 'home';
  else if (route.name === 'system') activeArea = route.area;
  for (const item of rail.querySelectorAll<HTMLElement>('.left-rail-item')) {
    item.classList.toggle('left-rail-item--active', item.dataset.area === activeArea);
  }
}

function mountDashboard(): void {
  const host = document.getElementById('app');
  if (!host) return;
  host.replaceChildren();

  let currentAgent: Agent | null = null;
  let activeSystemPage: SystemPageRef | null = null;
  const chat     = new ChatView();
  const settings = new SettingsView();
  const sidebar  = new AgentsSidebar({
    onSelect: (id: string) => {
      chat.focusConversation();
      navigate(`#/agents/${encodeURIComponent(id)}`);
    },
    onCreate: () => { chat.focusConversation(); },
    onDelete: (id: string) => {
      if (currentAgent && currentAgent.id === id) {
        currentAgent = null;
        navigate('#/');
      }
    },
  });

  const mainHost = el('div', { class: 'main-pane' });
  const railHost = buildLeftRail();
  const shell = el('div', { class: 'dashboard dashboard--with-rail' });
  host.appendChild(shell);
  shell.appendChild(railHost);

  const splitHost   = el('div', { class: 'split-host' });
  const sidebarPane = el('div', { class: 'sidebar-pane' });
  const mainPane    = el('div', { class: 'main-pane-wrap' });
  sidebar.mount(sidebarPane);
  mainPane.appendChild(mainHost);
  splitHost.appendChild(sidebarPane);
  splitHost.appendChild(mainPane);
  shell.appendChild(splitHost);

  installOuterSplit(splitHost, sidebarPane, mainPane);
  installToolsToggle();

  const settingsBtn = document.getElementById('open-settings');
  if (settingsBtn) {
    settingsBtn.innerHTML = iconHtml('settings');
    settingsBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      navigate('#/settings');
      closeDrawer();
    });
  }
  const brandLink = document.getElementById('brand-link');
  if (brandLink) {
    brandLink.addEventListener('click', (ev) => {
      ev.preventDefault();
      navigate('#/');
      closeDrawer();
    });
  }

  const brandActive = document.getElementById('brand-active') as HTMLElement | null;
  const baseTitle = document.title;
  document.addEventListener('grok-remote:agents-refresh', (ev: Event) => {
    const list = ((ev as CustomEvent).detail || []) as Agent[];
    const active = list.some((a) =>
      (typeof a?.inFlight === 'number' && a.inFlight > 0) ||
      (a?.status === 'running')
    );
    if (brandActive) brandActive.hidden = !active;
    const wantTitle = active ? `(*) ${baseTitle}` : baseTitle;
    if (document.title !== wantTitle) document.title = wantTitle;
  });

  installBgTracker();

  shell.addEventListener('click', (ev) => {
    if (!document.body.hasAttribute('data-drawer-open')) return;
    const target = ev.target as Element | null;
    if (target && target.closest && target.closest('.sidebar .agent-item')) {
      closeDrawer();
    }
  });

  let activeSettings = false;

  function unmountActiveSystemPage(): void {
    if (!activeSystemPage) return;
    try { activeSystemPage.module?.unmount?.(); } catch { /* ignore */ }
    activeSystemPage = null;
  }
  function unmountActiveSettings(): void {
    if (!activeSettings) return;
    try { settings.unmount(); } catch { /* ignore */ }
    activeSettings = false;
  }

  function renderRoute(): void {
    const route = parseRoute();
    if (route.name === 'redirect') {
      location.replace(location.pathname + location.search + route.to);
      return;
    }
    if (route.name === 'settings' && activeSettings) {
      updateRailHighlight(route);
      settings.setActive(route.sub);
      return;
    }
    unmountActiveSystemPage();
    unmountActiveSettings();
    mainHost.replaceChildren();
    updateRailHighlight(route);
    if (route.name === 'system') {
      const page = getSystemPage(route.area) as SystemPageRef | null;
      if (page && page.module && typeof page.module.mount === 'function') {
        page.module.mount(mainHost, route);
        activeSystemPage = page;
        return;
      }
    }
    if (route.name === 'settings') {
      settings.mount(mainHost);
      settings.setActive(route.sub);
      activeSettings = true;
      return;
    }
    if (route.name === 'chat') {
      chat.mount(mainHost);
      const found = sidebar.agents.find((a: Agent) => a.id === route.agentId);
      if (found) {
        currentAgent = found;
        sidebar.selectedId = found.id;
        sidebar.renderList();
        chat.setAgent(found);
      } else {
        api.getAgent(route.agentId).then((a: unknown) => {
          currentAgent = (a as Agent | null) || { id: route.agentId };
          sidebar.selectedId = currentAgent.id;
          sidebar.renderList();
          chat.setAgent(currentAgent);
        }).catch(() => {
          currentAgent = { id: route.agentId };
          chat.setAgent(currentAgent);
        });
      }
      return;
    }
    chat.mount(mainHost);
    chat.setAgent(null);
  }

  window.addEventListener('hashchange', renderRoute);
  renderRoute();
}

document.addEventListener('DOMContentLoaded', () => {
  // Paint the chosen (or host-hashed) homescreen icon ASAP so the tab /
  // install banner reflect it before hello returns.
  try { void applyAppIcon(getAppIconId()); } catch { /* ignore */ }

  void pingHello();
  setInterval(() => { void pingHello(); }, 10000);

  mountDashboard();

  syncThemeToggle(getTheme());
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      const n = nextTheme(getTheme());
      syncThemeToggle(n);
      window.dispatchEvent(new CustomEvent('grok-remote:theme-change', { detail: { theme: n } }));
    });
  }

  const ham = document.getElementById('hamburger-btn');
  if (ham) {
    ham.addEventListener('click', (ev) => {
      ev.preventDefault();
      toggleDrawer();
    });
  }
  const backdrop = document.getElementById('drawer-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', () => closeDrawer());
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && document.body.hasAttribute('data-drawer-open')) {
      closeDrawer();
    }
  });
  document.addEventListener('grok-remote:close-drawer', () => closeDrawer());

  registerPwa();

  installVersionFooter();
});

const SIDEBAR_SIZES_KEY = 'grok-remote.split.sidebar';
const SIDEBAR_COLLAPSED_KEY = 'grok-remote.split.sidebar.collapsed';
const SIDEBAR_DEFAULT_SIZES: [number, number] = [22, 78];
const MOBILE_MAX = 720;

function isMobileViewport(): boolean {
  return window.innerWidth <= MOBILE_MAX;
}

function readSidebarSizes(): [number, number] {
  try {
    const raw = localStorage.getItem(SIDEBAR_SIZES_KEY);
    if (!raw) return [...SIDEBAR_DEFAULT_SIZES] as [number, number];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length === 2 &&
        parsed.every((n) => typeof n === 'number' && isFinite(n) && n >= 0 && n <= 100)) {
      return parsed as [number, number];
    }
  } catch { /* ignore */ }
  return [...SIDEBAR_DEFAULT_SIZES] as [number, number];
}

function isSidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch { return false; }
}

function installToolsToggle(): void {
  const btn = document.getElementById('topbar-sidebar-right') as HTMLElement | null;
  if (!btn) return;
  if (isMobileViewport()) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  let collapsed = false;
  function paint(): void {
    btn!.innerHTML = iconHtml(collapsed ? 'panel-right-open' : 'panel-right-close');
    btn!.title = collapsed ? 'show tool calls panel' : 'hide tool calls panel';
    btn!.setAttribute('aria-label', btn!.title);
  }
  paint();
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    document.dispatchEvent(new CustomEvent('grok-remote:tools-toggle'));
  });
  document.addEventListener('grok-remote:tools-state', (ev: Event) => {
    const ce = ev as CustomEvent<{ collapsed?: boolean }>;
    collapsed = !!(ce && ce.detail && ce.detail.collapsed);
    paint();
  });
}

function installOuterSplit(splitHost: HTMLElement, sidebarPane: HTMLElement, mainPane: HTMLElement): void {
  const topbarBtn = document.getElementById('topbar-sidebar-left') as HTMLElement | null;

  if (isMobileViewport()) {
    if (topbarBtn) topbarBtn.hidden = true;
    let wasMobile = true;
    window.addEventListener('resize', () => {
      const nowMobile = isMobileViewport();
      if (wasMobile !== nowMobile) {
        wasMobile = nowMobile;
        location.reload();
      }
    });
    return;
  }

  if (topbarBtn) topbarBtn.hidden = false;

  let collapsed = isSidebarCollapsed();
  let lastExpandedSizes = readSidebarSizes();
  let split: ReturnType<typeof Split> | null = null;

  function persistSizes(sizes: number[]): void {
    try { localStorage.setItem(SIDEBAR_SIZES_KEY, JSON.stringify(sizes)); } catch { /* ignore */ }
  }
  function persistCollapsed(v: boolean): void {
    try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  }

  function updateTopbarBtn(): void {
    if (!topbarBtn) return;
    topbarBtn.innerHTML = iconHtml(collapsed ? 'panel-left-open' : 'panel-left-close');
    topbarBtn.title = collapsed ? 'show conversations sidebar' : 'hide conversations sidebar';
    topbarBtn.setAttribute('aria-label', collapsed ? 'show conversations sidebar' : 'hide conversations sidebar');
  }

  function buildSplit(initialSizes: number[]): void {
    split = Split([sidebarPane, mainPane], {
      sizes: initialSizes,
      minSize: [220, 480],
      maxSize: [560, Infinity],
      gutterSize: 6,
      snapOffset: 0,
      expandToMin: true,
      direction: 'horizontal',
      elementStyle: (_dim: string, size: number, gutterSize: number) => ({
        'flex-basis': `calc(${size}% - ${gutterSize}px)`,
      }),
      gutterStyle: (_dim: string, gutterSize: number) => ({ 'flex-basis': `${gutterSize}px` }),
      onDragEnd: (sizes: number[]) => {
        lastExpandedSizes = sizes as [number, number];
        persistSizes(sizes);
      },
    });
  }

  function destroySplit(): void {
    if (split) {
      try { split.destroy(); } catch { /* ignore */ }
      split = null;
    }
  }

  function applyCollapsedState(): void {
    splitHost.classList.toggle('sidebar-collapsed', collapsed);
    if (collapsed) {
      destroySplit();
    } else if (!split) {
      buildSplit(lastExpandedSizes);
    }
    updateTopbarBtn();
  }

  function setCollapsed(next: boolean): void {
    if (collapsed === next) return;
    collapsed = next;
    persistCollapsed(collapsed);
    applyCollapsedState();
  }

  if (collapsed) {
    splitHost.classList.add('sidebar-collapsed');
  } else {
    buildSplit(lastExpandedSizes);
  }
  updateTopbarBtn();

  if (topbarBtn) {
    topbarBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      setCollapsed(!collapsed);
    });
  }
  document.addEventListener('grok-remote:sidebar-toggle', () => setCollapsed(!collapsed));

  let wasMobile = false;
  window.addEventListener('resize', () => {
    const nowMobile = isMobileViewport();
    if (wasMobile !== nowMobile) {
      wasMobile = nowMobile;
      location.reload();
    }
  });
}

interface BgTerminal {
  id: string;
  command?: string;
  cwd?: string;
  url?: string;
  exited?: boolean;
  exitStatus?: { exitCode?: number | null; signal?: string | null };
}
interface BgGroup { agentId: string; agentName?: string; terminals?: BgTerminal[] }
interface BgSnapshot { runningCount?: number; agents?: BgGroup[] }

function installBgTracker(): void {
  const btn   = document.getElementById('topbar-bg') as HTMLElement | null;
  const count = btn ? btn.querySelector<HTMLElement>('.topbar-bg__count') : null;
  if (!btn || !count) return;

  let lastSnapshot: BgSnapshot | null = null;

  async function tick(): Promise<void> {
    if (document.hidden) return;
    try {
      const data = await api.terminals.global() as BgSnapshot;
      lastSnapshot = data;
      const n = (data && data.runningCount) || 0;
      const totalEntries = (data && Array.isArray(data.agents))
        ? data.agents.reduce((a, g) => a + (g.terminals?.length || 0), 0)
        : 0;
      btn!.hidden = totalEntries === 0;
      count!.textContent = `bg: ${n}`;
      btn!.classList.toggle('topbar-bg--active', n > 0);
      btn!.classList.toggle('topbar-bg--exited-only', n === 0 && totalEntries > 0);
    } catch {
      btn!.hidden = true;
    }
  }
  btn.addEventListener('click', () => openBgViewer(() => lastSnapshot));
  void tick();
  setInterval(() => { void tick(); }, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void tick(); });
}

function openBgViewer(getSnapshot: () => BgSnapshot | null): void {
  const overlay = el('div', { class: 'bgglobal-viewer' });
  const closeBtn = el('button', {
    type: 'button', class: 'bgglobal-viewer__close',
    onclick: () => overlay.remove(),
  }, '×');
  const title = el('div', { class: 'bgglobal-viewer__title' }, 'background processes');
  const body  = el('div', { class: 'bgglobal-viewer__body' });
  overlay.appendChild(el('div', { class: 'bgglobal-viewer__head' }, title, closeBtn));
  overlay.appendChild(body);
  document.body.appendChild(overlay);

  async function render(): Promise<void> {
    if (!overlay.isConnected) return;
    let data: BgSnapshot | null = getSnapshot && getSnapshot();
    try { data = await api.terminals.global() as BgSnapshot; } catch { /* keep stale */ }
    body.replaceChildren();
    const groups = (data && Array.isArray(data.agents)) ? data.agents : [];
    if (!groups.length) {
      body.appendChild(el('div', { class: 'bgglobal-viewer__empty' },
        'no background processes are running.'));
      return;
    }
    for (const g of groups) {
      const groupEl = el('div', { class: 'bgglobal-viewer__group' });
      groupEl.appendChild(el('div', { class: 'bgglobal-viewer__group-head' },
        el('span', { class: 'bgglobal-viewer__agent-name' }, g.agentName || g.agentId),
        el('button', {
          type: 'button',
          class: 'bgglobal-viewer__open-conv',
          onclick: () => {
            overlay.remove();
            navigate(`#/agents/${encodeURIComponent(g.agentId)}`);
          },
        }, 'open conversation'),
      ));
      for (const t of (g.terminals || [])) {
        const exited = !!t.exited;
        const code = t.exitStatus && (t.exitStatus.exitCode ?? t.exitStatus.signal);
        const row = el('div', { class: `bgglobal-viewer__term ${exited ? 'bgglobal-viewer__term--exited' : ''}` },
          el('span', { class: 'bgglobal-viewer__term-status' },
            el('span', { class: 'bgglobal-viewer__term-dot' }),
            exited ? `exit ${code ?? '?'}` : 'running'),
          el('div', { class: 'bgglobal-viewer__term-cmd' }, t.command || ''),
          el('div', { class: 'bgglobal-viewer__term-cwd' }, t.cwd || ''),
          el('div', { class: 'bgglobal-viewer__term-actions' },
            (t.url && !exited) && el('a', {
              class: 'bgglobal-viewer__open-url',
              href: t.url,
              target: '_blank',
              rel: 'noopener',
              title: `open ${t.url}`,
              html: `<span class="bgglobal-viewer__open-url-ico">${iconHtml('globe')}</span><span class="bgglobal-viewer__open-url-label">Open App</span>`,
            }),
            el('button', {
              type: 'button', class: 'bgglobal-viewer__open-output',
              onclick: () => {
                overlay.remove();
                navigate(`#/agents/${encodeURIComponent(g.agentId)}`);
              },
            }, 'view in conversation'),
            !exited && el('button', {
              type: 'button', class: 'bgglobal-viewer__kill',
              onclick: (ev: MouseEvent) => {
                const btn = ev.currentTarget as HTMLButtonElement;
                btn.disabled = true;
                btn.textContent = 'killing...';
                row.classList.add('bgglobal-viewer__term--killing');
                void (async () => {
                  try {
                    await api.terminals.kill(g.agentId, t.id);
                    btn.textContent = 'kill sent';
                    const stEl = row.querySelector('.bgglobal-viewer__term-status');
                    if (stEl) {
                      stEl.replaceChildren(
                        el('span', { class: 'bgglobal-viewer__term-dot' }),
                        document.createTextNode('killing'),
                      );
                    }
                  } catch (err) {
                    btn.disabled = false;
                    btn.textContent = 'kill failed; retry';
                    btn.title = err instanceof Error ? err.message : String(err);
                  }
                })();
              },
            }, 'kill'),
          ),
        );
        groupEl.appendChild(row);
      }
      body.appendChild(groupEl);
    }
  }

  void render();
  const timer = setInterval(() => {
    if (!overlay.isConnected) { clearInterval(timer); return; }
    void render();
  }, 1500);
}
