// Pure-ish DOM helpers + markdown-light renderers.
// No external libraries. All functions return DOM nodes or strings.

type ElChild = Node | string | number | boolean | null | undefined | ElChild[];
type ElAttrs = Record<string, unknown> | null;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: ElAttrs,
  ...children: ElChild[]
): HTMLElementTagNameMap[K];
export function el(tag: string, attrs?: ElAttrs, ...children: ElChild[]): HTMLElement;
export function el(tag: string, attrs?: ElAttrs, ...children: ElChild[]): HTMLElement {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class')      node.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v as object);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v as object);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'html')  node.innerHTML = String(v);
      else node.setAttribute(k, String(v));
    }
  }
  for (const c of children) appendChild(node, c);
  return node;
}

function appendChild(parent: Node, c: ElChild): void {
  if (c == null || c === false) return;
  if (Array.isArray(c)) { for (const x of c) appendChild(parent, x); return; }
  if (c instanceof Node) { parent.appendChild(c); return; }
  parent.appendChild(document.createTextNode(String(c)));
}

export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c] as string));
}

export function renderMarkdownLight(text: string): HTMLElement {
  if (!text) return el('span');
  const container = el('div', { class: 'md' });
  const segments = String(text).split(/(```[\s\S]*?```)/g);
  for (const seg of segments) {
    if (!seg) continue;
    if (seg.startsWith('```') && seg.endsWith('```') && seg.length >= 6) {
      const inner = seg.slice(3, -3);
      const nl = inner.indexOf('\n');
      let lang = '', code = inner;
      if (nl >= 0 && /^[a-zA-Z0-9_-]*$/.test(inner.slice(0, nl))) {
        lang = inner.slice(0, nl);
        code = inner.slice(nl + 1);
      }
      const pre = el('pre', { class: 'md-code' },
        el('code', { class: lang ? `lang-${lang}` : '' }, code)
      );
      container.appendChild(pre);
    } else {
      const block = el('div', { class: 'md-block' });
      block.innerHTML = inlineMd(seg);
      container.appendChild(block);
    }
  }
  return container;
}

function inlineMd(s: string): string {
  let out = escapeHtml(s);
  out = out.replace(/`([^`\n]+)`/g, (_m, g1) => `<code class="md-inline-code">${g1}</code>`);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, g1) => `<strong>${g1}</strong>`);
  out = out.replace(/\n/g, '<br/>');
  return out;
}

function fmtClock(d: Date): string {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function basename(p: unknown): string {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

export interface Attachment {
  mimeType?: string;
  dataUrl?: string;
  dataBase64?: string;
  rel?: string;
  name?: string;
  size?: number | null;
}

export interface AttachmentThumb {
  name: string;
  mimeType: string;
  size: number | null;
  src: string;
}

export interface UserAttachmentOpts {
  agentId?: string;
}

export function userAttachmentThumbnails(
  attachments: Attachment[] = [],
  { agentId }: UserAttachmentOpts = {},
): AttachmentThumb[] {
  const out: AttachmentThumb[] = [];
  for (const att of attachments || []) {
    if (!att || typeof att !== 'object') continue;
    const mimeType = String(att.mimeType || '');
    if (!mimeType.startsWith('image/')) continue;

    let src = '';
    if (typeof att.dataUrl === 'string' && att.dataUrl) {
      src = att.dataUrl;
    } else if (typeof att.dataBase64 === 'string' && att.dataBase64) {
      src = `data:${mimeType || 'image/png'};base64,${att.dataBase64}`;
    } else if (agentId && typeof att.rel === 'string' && att.rel) {
      src = `/api/agents/${encodeURIComponent(agentId)}/files/raw?path=${encodeURIComponent(att.rel)}`;
    }
    if (!src) continue;

    out.push({
      name: att.name || basename(att.rel) || 'attached image',
      mimeType,
      size: att.size ?? null,
      src,
    });
  }
  return out;
}

function looksLikeGeneratedAttachmentBlock(text: string): boolean {
  const lines = String(text || '').split('\n');
  if (lines[0] !== 'Attached files:') return false;
  const fileLines = lines.slice(1).filter(Boolean);
  return fileLines.length > 0 && fileLines.every(line => /^- .+ \([^,]+, .+\)$/.test(line));
}

export function stripGeneratedAttachmentBlock(text: string, attachments: Attachment[] = []): string {
  const s = String(text || '');
  if (!attachments || !attachments.length || !s) return s;

  const marker = 'Attached files:\n';
  const withGap = `\n\n${marker}`;
  const gapIdx = s.lastIndexOf(withGap);
  if (gapIdx >= 0) {
    const block = s.slice(gapIdx + 2);
    if (looksLikeGeneratedAttachmentBlock(block)) return s.slice(0, gapIdx);
  }

  if (s.startsWith(marker) && looksLikeGeneratedAttachmentBlock(s)) return '';
  return s;
}

function renderUserAttachments(attachments: Attachment[] | undefined, agentId: string | undefined): HTMLElement | null {
  const thumbs = userAttachmentThumbnails(attachments, { agentId });
  if (!thumbs.length) return null;
  return el('div', { class: 'msg-attachments' }, thumbs.map((att) =>
    el('a', {
      class: 'msg-attachment',
      href: att.src,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: att.name,
      onclick: (ev: MouseEvent) => {
        if (ev.button !== 0) return;
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        ev.preventDefault();
        void import('./image-lightbox.js').then((m) => m.openImageLightbox(att.src, att.name));
      },
    },
      el('img', {
        class: 'msg-attachment-thumb',
        src: att.src,
        alt: att.name,
        loading: 'lazy',
      }),
      el('span', { class: 'msg-attachment-name' }, att.name),
    )
  ));
}

export interface UserBubbleOpts {
  attachments?: Attachment[];
  agentId?: string;
}

export function renderUserBubble(text: string, ts?: number | string | Date, opts: UserBubbleOpts = {}): HTMLElement {
  const when = ts ? new Date(ts) : new Date();
  const attachments = Array.isArray(opts.attachments) ? opts.attachments : [];
  const visibleText = stripGeneratedAttachmentBlock(text, attachments);
  const body = el('div', { class: 'msg-body' });
  if (visibleText) body.appendChild(renderMarkdownLight(visibleText));
  const attachmentGrid = renderUserAttachments(attachments, opts.agentId);
  if (attachmentGrid) body.appendChild(attachmentGrid);
  if (!visibleText && !attachmentGrid) body.appendChild(renderMarkdownLight(''));

  return el('div', { class: 'msg msg--user' },
    el('div', { class: 'msg-head' },
      el('span', { class: 'msg-role' }, 'you'),
      el('span', { class: 'msg-time', title: when.toISOString() }, fmtClock(when)),
    ),
    body,
  );
}

export interface AssistantBubble {
  node: HTMLElement;
  append(text: string): void;
  text(): string;
  finalize(): void;
}

export function renderAssistantBubble(ts?: number | string | Date): AssistantBubble {
  const when = ts ? new Date(ts) : new Date();
  const body = el('div', { class: 'msg-body' });
  const timeEl = el('span', { class: 'msg-time', title: when.toISOString() }, fmtClock(when));
  const node = el('div', { class: 'msg msg--assistant' },
    el('div', { class: 'msg-head' },
      el('span', { class: 'msg-role' }, 'grok'),
      timeEl,
    ),
    body,
  );
  let buf = '';
  return {
    node,
    append(text: string): void {
      buf += text;
      body.replaceChildren(renderMarkdownLight(buf));
    },
    text(): string { return buf; },
    finalize(): void {
      node.classList.add('msg--done');
      const now = new Date();
      timeEl.textContent = fmtClock(now);
      timeEl.title = now.toISOString();
    },
  };
}

export interface ThinkingPane {
  node: HTMLElement;
  append(text: string): void;
  finalize(): void;
  text(): string;
  isActive(): boolean;
}

export function renderThinkingPane(): ThinkingPane {
  const dots = el('span', { class: 'thinking-dots' }, '...');
  const summary = el('summary', { class: 'thinking-summary' },
    el('span', { class: 'thinking-label' }, 'thinking'),
    dots,
  );
  const body = el('pre', { class: 'thinking-body' });
  const details = el('details', { class: 'thinking' }, summary, body);
  let buf = '';
  let active = true;
  return {
    node: details,
    append(text: string): void {
      buf += text;
      body.textContent = buf;
    },
    finalize(): void {
      active = false;
      dots.textContent = '';
      summary.classList.add('thinking-summary--done');
    },
    text(): string { return buf; },
    isActive(): boolean { return active; },
  };
}

interface StatusStyle { cls: string; label: string }

const PENDING_STYLE: StatusStyle = { cls: 'tool-status--pending', label: 'pending' };
const STATUS_STYLES: Record<string, StatusStyle> = {
  Pending:   PENDING_STYLE,
  Running:   { cls: 'tool-status--running',   label: 'running'   },
  Completed: { cls: 'tool-status--completed', label: 'completed' },
  Failed:    { cls: 'tool-status--failed',    label: 'failed'    },
  Canceled:  { cls: 'tool-status--canceled',  label: 'canceled'  },
};

function normalizeStatus(s: unknown): string | null {
  if (!s) return null;
  const k = String(s).trim().toLowerCase();
  switch (k) {
    case 'pending':                  return 'Pending';
    case 'running':
    case 'in_progress':
    case 'inprogress':               return 'Running';
    case 'completed':
    case 'success':
    case 'succeeded':                return 'Completed';
    case 'failed':
    case 'error':
    case 'errored':                  return 'Failed';
    case 'canceled':
    case 'cancelled':                return 'Canceled';
    default:                         return null;
  }
}

export interface ToolPayload {
  toolCallId?: string;
  kind?: string;
  title?: string;
  status?: string;
  rawInput?: Record<string, unknown> & { variant?: string; command?: string; cmd?: string; todos?: unknown[]; merge?: boolean };
  rawOutput?: unknown;
  content?: unknown;
  _meta?: { updateParams?: { status?: string } };
  [k: string]: unknown;
}

export function readStatus(payload: ToolPayload | null | undefined): string | null {
  if (!payload) return null;
  const meta = payload._meta && payload._meta.updateParams && payload._meta.updateParams.status;
  return normalizeStatus(meta) || normalizeStatus(payload.status) || null;
}

function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s ? ` ${s}s` : ''}`;
}

/** Public alias used by the thread model. */
export const readToolStatus = readStatus;

export function inferToolTitle(update: ToolPayload): string {
  const title = update.title;
  const cmd = update.rawInput && (update.rawInput.command || update.rawInput.cmd);
  if (cmd) return String(cmd);
  if (title) return title;
  if (update.kind) return update.kind;
  return 'tool call';
}

export function isTodoWriteToolCall(data: ToolPayload | null | undefined): boolean {
  return !!(data && data.rawInput && data.rawInput.variant === 'TodoWrite');
}

export interface ToolCard {
  node: HTMLElement;
  applyUpdate(payload: ToolPayload): void;
  appendDelta(payload: unknown): void;
  getStatus(): string;
  ingestExternal?: (payload: ToolPayload) => void;
  isTodo?: boolean;
}

export function renderToolCard(initial: ToolPayload): ToolCard {
  if (isTodoWriteToolCall(initial)) return renderTodoWriteCard(initial);
  const status = readStatus(initial) || 'Pending';
  const styleInfo = STATUS_STYLES[status] || PENDING_STYLE;
  const startedAt = Date.now();
  let endedAt: number | null = null;

  const kindEl   = el('span', { class: 'tool-pill__kind' }, (initial && initial.kind) || 'tool');
  const titleEl  = el('span', { class: 'tool-pill__label' }, inferToolTitle(initial || {}));
  const durEl    = el('span', { class: 'tool-pill__dur' }, '');
  const statusEl = el('span', { class: `tool-pill__status ${styleInfo.cls}` }, styleInfo.label);
  const caretEl  = el('span', { class: 'tool-pill__caret' }, '▸');

  const rawInputBody = el('pre', { class: 'tool-pill-body__pre' });
  rawInputBody.textContent = initial && initial.rawInput ? JSON.stringify(initial.rawInput, null, 2) : '{}';
  const outputBody = el('pre', { class: 'tool-pill-body__pre' });

  const inputSection = el('div', { class: 'tool-pill-body__section' },
    el('div', { class: 'tool-pill-body__title' }, 'input'),
    rawInputBody,
  );
  const outputSection = el('div', { class: 'tool-pill-body__section tool-pill-body__section--output' },
    el('div', { class: 'tool-pill-body__title' }, 'output'),
    outputBody,
  );
  const body = el('div', { class: 'tool-pill__body', hidden: true }, inputSection, outputSection);

  const head = el('button', {
    type: 'button',
    class: 'tool-pill__head',
    title: inferToolTitle(initial || {}),
    onclick: () => {
      body.hidden = !body.hidden;
      caretEl.textContent = body.hidden ? '▸' : '▾';
      node.classList.toggle('tool-pill--open', !body.hidden);
    },
  }, caretEl, kindEl, titleEl, durEl, statusEl);

  const node = el('div', { class: 'tool-pill', dataset: { toolId: (initial && initial.toolCallId) || '' } },
    head,
    body,
  );

  let outputBuf = '';

  let durTimer: ReturnType<typeof setInterval> | null = null;
  const isTerminal = (status === 'Completed' || status === 'Failed' || status === 'Canceled');
  if (isTerminal) {
    endedAt = startedAt;
    durEl.textContent = '';
  } else {
    durTimer = setInterval(() => {
      if (endedAt) { if (durTimer) clearInterval(durTimer); durTimer = null; return; }
      durEl.textContent = fmtDur(Date.now() - startedAt) + '…';
    }, 500);
  }

  function setStatus(canonical: string): void {
    const info = STATUS_STYLES[canonical] || styleInfo;
    statusEl.className = `tool-pill__status ${info.cls}`;
    statusEl.textContent = info.label;
    if ((canonical === 'Completed' || canonical === 'Failed' || canonical === 'Canceled') && !endedAt) {
      endedAt = Date.now();
      if (durTimer) { clearInterval(durTimer); durTimer = null; }
      durEl.textContent = fmtDur(endedAt - startedAt);
    }
  }

  function applyUpdate(payload: ToolPayload): void {
    const canonical = readStatus(payload);
    if (canonical) setStatus(canonical);
    if (payload.title || (payload.rawInput && payload.rawInput.command)) {
      titleEl.textContent = inferToolTitle(payload);
      head.title = inferToolTitle(payload);
    }
    if (payload.kind) kindEl.textContent = payload.kind;
    if (payload.rawInput) {
      rawInputBody.textContent = JSON.stringify(payload.rawInput, null, 2);
    }
    if (Array.isArray(payload.content) && payload.content.length) {
      const chunks: string[] = [];
      for (const c of payload.content as Array<unknown>) {
        if (!c) continue;
        if (typeof c === 'string') chunks.push(c);
        else if (typeof c === 'object') {
          const co = c as { type?: string; text?: unknown; content?: unknown };
          if (co.type === 'text' && typeof co.text === 'string') chunks.push(co.text);
          else if (co.text) chunks.push(String(co.text));
          else if (co.content) chunks.push(typeof co.content === 'string' ? co.content : JSON.stringify(co.content));
          else chunks.push(JSON.stringify(c));
        }
      }
      const joined = chunks.join('\n');
      if (joined.length > outputBuf.length) {
        outputBuf = joined;
        outputBody.textContent = outputBuf;
      }
    }
  }

  function appendDelta(payload: unknown): void {
    let chunk = '';
    if (typeof payload === 'string') chunk = payload;
    else if (payload && typeof payload === 'object') {
      const p = payload as { text?: unknown; content?: unknown; delta?: unknown };
      if (typeof p.text === 'string') chunk = p.text;
      else if (p.content) {
        if (typeof p.content === 'string') chunk = p.content;
        else if (typeof (p.content as { text?: unknown }).text === 'string') chunk = (p.content as { text: string }).text;
      } else if (p.delta) {
        chunk = typeof p.delta === 'string' ? p.delta : JSON.stringify(p.delta);
      } else {
        chunk = JSON.stringify(payload);
      }
    } else {
      chunk = JSON.stringify(payload);
    }
    outputBuf += chunk;
    outputBody.textContent = outputBuf;
  }

  return { node, applyUpdate, appendDelta, getStatus: () => statusEl.textContent || '' };
}

interface TodoEntry { content: string; status: string }

export function renderTodoWriteCard(initial: ToolPayload): ToolCard {
  const startedAt = Date.now();
  let endedAt: number | null = null;
  void startedAt; void endedAt;
  const todos = new Map<string, TodoEntry>();

  const summaryEl = el('span', { class: 'todo-card__summary' }, '0/0');
  const titleEl   = el('span', { class: 'todo-card__title' }, 'plan');
  const statusEl  = el('span', { class: 'todo-card__status' }, 'running');
  void titleEl;
  const head      = el('div', { class: 'todo-card__head' },
    el('span', { class: 'todo-card__ico' }, '☑'),
    titleEl,
    summaryEl,
    el('span', { class: 'todo-card__spacer' }),
    statusEl,
  );
  const list = el('ol', { class: 'todo-card__list' });
  const node = el('div', { class: 'tool-pill tool-pill--todo todo-card' }, head, list);

  function statusGlyph(s: string | undefined): string {
    if (s === 'completed')   return '✓';
    if (s === 'in_progress') return '◐';
    if (s === 'cancelled' || s === 'canceled') return '×';
    return '○';
  }

  function ingest(payload: ToolPayload): void {
    const ri = payload && payload.rawInput;
    if (!ri || !Array.isArray(ri.todos)) return;
    const merge = !!ri.merge;
    if (!merge) todos.clear();
    for (const t of ri.todos as Array<{ id?: string | number; content?: unknown; status?: unknown } | null>) {
      if (!t || t.id == null) continue;
      const key = String(t.id);
      const cur = todos.get(key) || { content: '', status: 'pending' };
      if (t.content != null) cur.content = String(t.content);
      if (t.status  != null) cur.status  = String(t.status);
      todos.set(key, cur);
    }
  }

  function render(): void {
    let done = 0, inProgress = 0;
    list.replaceChildren();
    for (const [id, t] of todos) {
      if (t.status === 'completed') done++;
      else if (t.status === 'in_progress') inProgress++;
      const item = el('li', {
        class: `todo-item todo-item--${(t.status || 'pending').replace(/_/g, '-')}`,
        dataset: { id },
      },
        el('span', { class: 'todo-item__indicator' }, statusGlyph(t.status)),
        el('span', { class: 'todo-item__content' }, t.content || '(no description)'),
      );
      list.appendChild(item);
    }
    const total = todos.size;
    summaryEl.textContent = inProgress
      ? `${done}/${total} done · ${inProgress} in progress`
      : `${done}/${total} done`;
  }

  function applyStatus(payload: ToolPayload): void {
    const canonical = readStatus(payload);
    if (!canonical) return;
    if (canonical === 'Completed' || canonical === 'Failed' || canonical === 'Canceled') {
      if (!endedAt) endedAt = Date.now();
      statusEl.textContent = 'done';
      statusEl.classList.remove('todo-card__status--running');
      statusEl.classList.add('todo-card__status--done');
    } else {
      statusEl.textContent = 'running';
      statusEl.classList.add('todo-card__status--running');
      statusEl.classList.remove('todo-card__status--done');
    }
  }

  function applyUpdate(payload: ToolPayload): void {
    ingest(payload);
    applyStatus(payload);
    render();
  }

  ingest(initial);
  applyStatus(initial);
  render();

  return {
    node,
    applyUpdate,
    appendDelta: (): void => { /* TodoWrite uses rawInput, not delta chunks */ },
    getStatus: (): string => statusEl.textContent || '',
    ingestExternal: (payload: ToolPayload): void => { ingest(payload); applyStatus(payload); render(); },
    isTodo: true,
  };
}

export interface TokenMeta {
  inputTokens?: number; input_tokens?: number;
  outputTokens?: number; output_tokens?: number;
  cachedReadTokens?: number; cached_read_tokens?: number; cachedTokens?: number;
  reasoningTokens?: number; reasoning_tokens?: number;
  totalTokens?: number | null; total_tokens?: number | null;
  modelId?: string | null; model_id?: string | null; model?: string | null;
  stopReason?: string | null; stop_reason?: string | null;
}

export function renderTokenFooter(meta: TokenMeta | null | undefined): HTMLElement {
  if (!meta) return el('div', { class: 'turn-footer' }, 'turn complete');
  const inputT  = meta.inputTokens     ?? meta.input_tokens     ?? '·';
  const outputT = meta.outputTokens    ?? meta.output_tokens    ?? '·';
  const cachedT = meta.cachedReadTokens ?? meta.cached_read_tokens ?? meta.cachedTokens ?? '·';
  const reasonT = meta.reasoningTokens ?? meta.reasoning_tokens ?? '·';
  const total   = meta.totalTokens     ?? meta.total_tokens     ?? null;
  const model   = meta.modelId         ?? meta.model_id         ?? meta.model ?? null;
  const stop    = meta.stopReason      ?? meta.stop_reason      ?? null;

  const chips = [
    chip('in',     inputT),
    chip('out',    outputT),
    chip('cached', cachedT),
    chip('think',  reasonT),
  ];
  if (total != null) chips.push(chip('total', total));
  if (model) chips.push(chip('model', model));
  if (stop)  chips.push(chip('stop', stop));
  chips.push(chip('cost', 'n/a'));

  return el('div', { class: 'turn-footer' }, ...chips);
}

function chip(label: string, value: unknown): HTMLElement {
  return el('span', { class: 'chip' },
    el('span', { class: 'chip-label' }, label),
    el('span', { class: 'chip-value' }, String(value)),
  );
}

export function renderCompactedPill(text: string | undefined): HTMLElement {
  return el('div', { class: 'compacted-pill' },
    el('span', { class: 'compacted-pill-label' }, 'context compacted'),
    text ? el('span', { class: 'compacted-pill-text' }, ' · ', text.slice(0, 120)) : null,
  );
}

export function renderErrorBanner(text: string | undefined): HTMLElement {
  return el('div', { class: 'error-banner' },
    el('span', { class: 'error-banner-label' }, 'error'),
    el('span', { class: 'error-banner-text' }, text || 'unknown error'),
  );
}

export function renderToast(text: string, kind?: string): HTMLElement {
  return el('div', { class: `toast toast--${kind || 'info'}` }, text);
}
