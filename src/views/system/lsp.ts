// LSP servers page.

import {
  loadInspect, buildPageShell, setStatusLine, clearBody,
  addConfigFilesBanner,
  buildGroup, buildItem, emptyState, buildFooterHint, copyToClipboard,
  shortenPath, scopeLabel,
  type ConfigFile,
} from './_native_common.js';
import { api } from '../../lib/api.js';
import { LSP_REGISTRY, type LspRegistryEntry } from './lsp-registry.js';
import { openRegistryPicker, type RegistryPickEntry } from './registry-picker.js';

interface LspSource { type?: string; path?: string; plugin_name?: string }
interface LspServer {
  language?: string;
  name?: string;
  command?: string;
  args?: string[];
  root_markers?: string[];
  rootMarkers?: string[];
  filetypes?: string[];
  extensions?: string[];
  extensionToLanguage?: Record<string, string>;
  scope?: string;
  source?: LspSource;
  env?: Record<string, unknown>;
  [k: string]: unknown;
}

interface InspectShape {
  lspServers?: LspServer[];
  configSources?: { userPath?: string; projectPaths?: string[] };
}

let activeContainer: HTMLElement | null = null;
let aborted = false;

const BLURB = `
  Language servers give grok code intelligence (hover, go-to-definition,
  references) while it works in your codebase. Each LSP entry binds a
  language to a server command. They are configured under
  <code>[[lsp]]</code> in <code>config.toml</code>. Most projects don't
  need this; it's an advanced opt-in.
`;

export async function mount(container: HTMLElement): Promise<void> {
  activeContainer = container;
  aborted = false;
  const section = buildPageShell(container, { title: 'LSP servers', blurb: BLURB });
  addToolbar(section);
  await reload(section);
}

export function unmount(): void {
  aborted = true;
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

function addToolbar(section: HTMLElement): void {
  const header = section.querySelector('.system-page-header');
  if (!header) return;
  const prev = header.querySelector('[data-slot="lsp-toolbar"]');
  if (prev) prev.remove();
  const toolbar = document.createElement('div');
  toolbar.className = 'mcp-header-actions';
  toolbar.dataset['slot'] = 'lsp-toolbar';
  toolbar.style.marginTop = '8px';

  const browse = document.createElement('button');
  browse.type = 'button';
  browse.className = 'mcp-btn';
  browse.textContent = 'browse registry';
  browse.addEventListener('click', () => openLspRegistryPicker(section));
  toolbar.appendChild(browse);

  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'mcp-btn';
  refresh.textContent = 'refresh';
  refresh.addEventListener('click', () => { void reload(section); });
  toolbar.appendChild(refresh);

  header.appendChild(toolbar);
}

async function reload(section: HTMLElement): Promise<void> {
  const { inspect, error } = await loadInspect();
  if (aborted) return;
  if (error) { setStatusLine(section, 'failed to load: ' + error); return; }

  const data = (inspect && typeof inspect === 'object') ? inspect as InspectShape : {};
  const items = Array.isArray(data.lspServers) ? data.lspServers : [];
  const cs = data.configSources || {};
  const banner: ConfigFile[] = [
    ...(cs.userPath ? [{ label: 'user config', path: cs.userPath }] : []),
    ...(Array.isArray(cs.projectPaths) ? cs.projectPaths.map((p) => ({ label: 'project config', path: p })) : []),
  ];
  addConfigFilesBanner(section, banner);
  clearBody(section);

  if (!items.length) {
    section.appendChild(emptyState({
      message: 'no LSP servers configured.',
      hint: 'add one from the registry or edit ~/.grok/lsp.json',
    }));
    section.appendChild(buildFooterHint(
      'Starter snippet: ' +
      '<code>{ "typescript": { "command": "typescript-language-server", ' +
      '"args": ["--stdio"], "extensionToLanguage": { ".ts": "typescript" } } }</code> ' +
      'in <code>~/.grok/lsp.json</code>',
    ));
    return;
  }

  const byKey = new Map<string, LspServer[]>();
  for (const s of items) {
    const key = String((s.source && s.source.type) || s.scope || 'user').toLowerCase();
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(s);
  }
  for (const [key, list] of byKey) {
    const { wrap, list: listEl } = buildGroup({ label: scopeLabel(key), count: list.length });
    for (const s of list) listEl.appendChild(makeLspCard(s));
    section.appendChild(wrap);
  }

  section.appendChild(buildFooterHint(
    'Edits land in <code>~/.grok/lsp.json</code>. ' +
    'Use "browse registry" above to add a server with one click.',
  ));
}

function openLspRegistryPicker(section: HTMLElement): void {
  const entries: RegistryPickEntry[] = LSP_REGISTRY.map(e => ({
    slug: e.slug,
    name: e.name,
    description: e.description,
    group: e.language,
    tags: e.install_hint ? ['install: ' + e.install_hint] : undefined,
    official: e.official,
    docsUrl: e.url_docs,
  }));
  openRegistryPicker({
    title: 'LSP server registry',
    groupLabel: 'language',
    entries,
    closeAfterAdd: true,
    onAdd: (slug) => {
      const entry = LSP_REGISTRY.find(e => e.slug === slug);
      if (entry) void addFromRegistry(entry, section);
    },
  });
}

async function addFromRegistry(entry: LspRegistryEntry, section: HTMLElement): Promise<void> {
  setStatusLine(section, `adding ${entry.name}...`);
  try {
    await api.lsp.add({
      name: entry.slug,
      language: entry.language,
      command: entry.command,
      args: entry.args,
      root_markers: entry.root_markers,
      extensions: entry.extensions,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatusLine(section, `failed to add ${entry.name}: ${msg}`);
    return;
  }
  setStatusLine(section, `added ${entry.name}`);
  await reload(section);
}

function makeLspCard(s: LspServer): HTMLElement {
  const lang = s.language || s.name || '(unknown)';
  const cmd = s.command || '';
  const args = Array.isArray(s.args) ? s.args : [];
  const markers = Array.isArray(s.root_markers || s.rootMarkers) ? (s.root_markers || s.rootMarkers)! : [];
  const tags: string[] = [];
  if (markers.length) tags.push(`roots: ${markers.join(', ')}`);
  if (Array.isArray(s.extensions) && s.extensions.length) tags.push(`extensions: ${s.extensions.join(', ')}`);
  else if (Array.isArray(s.filetypes) && s.filetypes.length) tags.push(`filetypes: ${s.filetypes.join(', ')}`);

  const target = [cmd, ...args].filter(Boolean).join(' ');

  const actions = [{
    label: 'copy JSON',
    title: 'copy an lsp.json entry you can paste into ~/.grok/lsp.json',
    onClick: async (ev: MouseEvent): Promise<void> => {
      const ok = await copyToClipboard(toJson(s));
      const btn = ev.currentTarget as HTMLButtonElement;
      const prior = btn.textContent;
      btn.textContent = ok ? 'copied' : 'copy failed';
      setTimeout(() => { btn.textContent = prior; }, 1500);
    },
  }];

  return buildItem({
    primary: lang,
    secondary: cmd || null,
    tags,
    path: shortenPath(target),
    sourceLabel: s.source?.plugin_name
      ? `from plugin: ${s.source.plugin_name}`
      : (s.source?.type ? `defined in ${scopeLabel(s.source.type)}:` : 'defined in:'),
    sourcePath: s.source?.path || '',
    fullRecord: s,
    actions,
  });
}

function toJson(s: LspServer): string {
  const name = s.name || s.language || 'server';
  const entry: Record<string, unknown> = {};
  if (s.command) entry['command'] = s.command;
  if (Array.isArray(s.args) && s.args.length) entry['args'] = s.args;
  if (s.extensionToLanguage && typeof s.extensionToLanguage === 'object') {
    entry['extensionToLanguage'] = s.extensionToLanguage;
  } else if (Array.isArray(s.extensions) && s.extensions.length) {
    const lang = s.language || s.name || 'plaintext';
    const map: Record<string, string> = {};
    for (const e of s.extensions) map[e] = lang;
    entry['extensionToLanguage'] = map;
  }
  const markers = s.root_markers || s.rootMarkers;
  if (Array.isArray(markers) && markers.length) entry['rootMarkers'] = markers;
  if (s.env && typeof s.env === 'object' && !Array.isArray(s.env) && Object.keys(s.env).length) {
    entry['env'] = s.env;
  }
  return JSON.stringify({ [name]: entry }, null, 2) + '\n';
}
