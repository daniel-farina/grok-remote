// Pure-ish DOM helpers + markdown-light renderers.
// No external libraries. All functions return DOM nodes or strings.

export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class')      node.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html')  node.innerHTML = v;
      else node.setAttribute(k, v);
    }
  }
  for (const c of children) appendChild(node, c);
  return node;
}

function appendChild(parent, c) {
  if (c == null || c === false) return;
  if (Array.isArray(c)) { for (const x of c) appendChild(parent, x); return; }
  if (c instanceof Node) { parent.appendChild(c); return; }
  parent.appendChild(document.createTextNode(String(c)));
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]));
}

// Minimal markdown-light rendering.
// Supports: fenced code blocks (```), inline code (`), bold (**...**),
// and preserves newlines. Everything else is escaped.
export function renderMarkdownLight(text) {
  if (!text) return el('span');
  const container = el('div', { class: 'md' });
  const segments = String(text).split(/(```[\s\S]*?```)/g);
  for (const seg of segments) {
    if (!seg) continue;
    if (seg.startsWith('```') && seg.endsWith('```') && seg.length >= 6) {
      // fenced code block
      const inner = seg.slice(3, -3);
      // optional language prefix
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

function inlineMd(s) {
  // 1) escape HTML first
  let out = escapeHtml(s);
  // 2) inline code (`...`)
  out = out.replace(/`([^`\n]+)`/g, (_m, g1) => `<code class="md-inline-code">${g1}</code>`);
  // 3) bold (**...**)
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, g1) => `<strong>${g1}</strong>`);
  // 4) preserve newlines
  out = out.replace(/\n/g, '<br/>');
  return out;
}

// ── Conversation blocks ────────────────────────────────────────────────

function fmtClock(d) {
  // HH:MM in the user's locale, 24h. Empty when d isn't a valid date.
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function basename(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

export function userAttachmentThumbnails(attachments = [], { agentId } = {}) {
  const out = [];
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

function looksLikeGeneratedAttachmentBlock(text) {
  const lines = String(text || '').split('\n');
  if (lines[0] !== 'Attached files:') return false;
  const fileLines = lines.slice(1).filter(Boolean);
  return fileLines.length > 0 && fileLines.every(line => /^- .+ \([^,]+, .+\)$/.test(line));
}

export function stripGeneratedAttachmentBlock(text, attachments = []) {
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

function renderUserAttachments(attachments, agentId) {
  const thumbs = userAttachmentThumbnails(attachments, { agentId });
  if (!thumbs.length) return null;
  return el('div', { class: 'msg-attachments' }, thumbs.map((att) =>
    el('a', {
      class: 'msg-attachment',
      href: att.src,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: att.name,
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

export function renderUserBubble(text, ts, opts = {}) {
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

export function renderAssistantBubble(ts) {
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
    append(text) {
      buf += text;
      body.replaceChildren(renderMarkdownLight(buf));
    },
    text() { return buf; },
    finalize() {
      node.classList.add('msg--done');
      // Snap timestamp to when the turn actually finished if it didn't get
      // updated mid-stream.
      const now = new Date();
      timeEl.textContent = fmtClock(now);
      timeEl.title = now.toISOString();
    },
  };
}

export function renderThinkingPane() {
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
    append(text) {
      buf += text;
      body.textContent = buf;
    },
    finalize() {
      active = false;
      dots.textContent = '';
      summary.classList.add('thinking-summary--done');
    },
    text() { return buf; },
    isActive() { return active; },
  };
}

const STATUS_STYLES = {
  Pending:   { cls: 'tool-status--pending',   label: 'pending'   },
  Running:   { cls: 'tool-status--running',   label: 'running'   },
  Completed: { cls: 'tool-status--completed', label: 'completed' },
  Failed:    { cls: 'tool-status--failed',    label: 'failed'    },
  Canceled:  { cls: 'tool-status--canceled',  label: 'canceled'  },
};

// ACP status values arrive either capitalized (legacy "Pending"/"Running"/...)
// or lowercase + snake_case ("pending", "in_progress", "completed", "failed",
// "canceled"). Normalize so the rest of the UI can look up STATUS_STYLES.
function normalizeStatus(s) {
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

function readStatus(payload) {
  if (!payload) return null;
  const meta = payload._meta && payload._meta.updateParams && payload._meta.updateParams.status;
  return normalizeStatus(meta) || normalizeStatus(payload.status) || null;
}

function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s ? ` ${s}s` : ''}`;
}

function inferToolTitle(update) {
  const title = update.title;
  const cmd = update.rawInput && (update.rawInput.command || update.rawInput.cmd);
  if (cmd) return cmd;
  if (title) return title;
  if (update.kind) return update.kind;
  return 'tool call';
}

export function renderToolCard(initial) {
  // initial is the `tool_call` update payload.
  const status = readStatus(initial) || 'Pending';
  const styleInfo = STATUS_STYLES[status] || STATUS_STYLES.Pending;
  const startedAt = Date.now();
  let endedAt = null;

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

  // Tick the duration label while the call is running so the user sees
  // elapsed time live (every 500ms is enough; cheap and aligned with the
  // SSE token throttle). Skip the timer entirely when the initial payload
  // is already terminal — no reason to tick a long-finished history pill.
  let durTimer = null;
  const isTerminal = (status === 'Completed' || status === 'Failed' || status === 'Canceled');
  if (isTerminal) {
    endedAt = startedAt; // unknown duration for replayed terminal calls
    durEl.textContent = '';
  } else {
    durTimer = setInterval(() => {
      if (endedAt) { clearInterval(durTimer); durTimer = null; return; }
      durEl.textContent = fmtDur(Date.now() - startedAt) + '…';
    }, 500);
  }

  function setStatus(canonical) {
    const info = STATUS_STYLES[canonical] || styleInfo;
    statusEl.className = `tool-pill__status ${info.cls}`;
    statusEl.textContent = info.label;
    if ((canonical === 'Completed' || canonical === 'Failed' || canonical === 'Canceled') && !endedAt) {
      endedAt = Date.now();
      if (durTimer) { clearInterval(durTimer); durTimer = null; }
      durEl.textContent = fmtDur(endedAt - startedAt);
    }
  }

  function applyUpdate(payload) {
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
      // best-effort: concatenate text-ish content blocks
      const chunks = [];
      for (const c of payload.content) {
        if (!c) continue;
        if (typeof c === 'string') chunks.push(c);
        else if (c.type === 'text' && typeof c.text === 'string') chunks.push(c.text);
        else if (c.text) chunks.push(c.text);
        else if (c.content) chunks.push(typeof c.content === 'string' ? c.content : JSON.stringify(c.content));
        else chunks.push(JSON.stringify(c));
      }
      const joined = chunks.join('\n');
      if (joined.length > outputBuf.length) {
        outputBuf = joined;
        outputBody.textContent = outputBuf;
      }
    }
  }

  function appendDelta(payload) {
    // tool_call_delta_chunk — shape not fully observed yet. Try common keys.
    let chunk = '';
    if (typeof payload === 'string') chunk = payload;
    else if (payload && typeof payload.text === 'string') chunk = payload.text;
    else if (payload && payload.content) {
      if (typeof payload.content === 'string') chunk = payload.content;
      else if (typeof payload.content.text === 'string') chunk = payload.content.text;
    } else if (payload && payload.delta) {
      chunk = typeof payload.delta === 'string' ? payload.delta : JSON.stringify(payload.delta);
    } else {
      chunk = JSON.stringify(payload);
    }
    outputBuf += chunk;
    outputBody.textContent = outputBuf;
  }

  return { node, applyUpdate, appendDelta, getStatus: () => statusEl.textContent };
}

export function renderTokenFooter(meta) {
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

function chip(label, value) {
  return el('span', { class: 'chip' },
    el('span', { class: 'chip-label' }, label),
    el('span', { class: 'chip-value' }, String(value)),
  );
}

export function renderCompactedPill(text) {
  return el('div', { class: 'compacted-pill' },
    el('span', { class: 'compacted-pill-label' }, 'context compacted'),
    text ? el('span', { class: 'compacted-pill-text' }, ' · ', text.slice(0, 120)) : null,
  );
}

export function renderErrorBanner(text) {
  return el('div', { class: 'error-banner' },
    el('span', { class: 'error-banner-label' }, 'error'),
    el('span', { class: 'error-banner-text' }, text || 'unknown error'),
  );
}

export function renderToast(text, kind) {
  return el('div', { class: `toast toast--${kind || 'info'}` }, text);
}
