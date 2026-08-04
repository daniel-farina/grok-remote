// Clipboard helpers + conversation serializers.
//
// copyToClipboard(text): async; uses navigator.clipboard if available,
//   falls back to a hidden textarea + document.execCommand('copy') for
//   non-secure contexts (e.g., tailnet http://).
//
// serializeConversation(turns): renders the in-memory ChatView.turns array
//   to a plain ASCII text block suitable for pasting into a file.
//
// serializeResumeCommand(agent): renders the "Resume on CLI" instructions
//   that get pasted into a terminal.

export async function copyToClipboard(text: unknown): Promise<boolean> {
  const s = text == null ? '' : String(text);
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(s);
      return true;
    } catch {
      // fall through to legacy path
    }
  }
  // Fallback for http:// (tailnet) contexts.
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-10000px';
    ta.style.left = '-10000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Public structural shapes for the conversation serializer.
export interface ConvoBubble {
  text?: string | (() => string);
}

export interface ConvoToolEntry {
  card?: {
    node?: { querySelector?: (sel: string) => Element | null } | null;
  } | null;
}

export interface ConvoTurn {
  userText?: string;
  user?: HTMLElement | { querySelector?: (sel: string) => Element | null; textContent?: string | null } | null;
  thinking?: ConvoBubble | null;
  tools?: ConvoToolEntry[] | null;
  /** Current / last open assistant bubble (legacy single-bubble field). */
  assistant?: ConvoBubble | null;
  /** All assistant segments this turn (interim status lines + final reply). */
  assistants?: ConvoBubble[] | null;
}

export interface ConvoAgent {
  id?: string | null;
  name?: string | null;
  model?: string | null;
  sessionId?: string | null;
  cwd?: string | null;
}

export interface ConvoCtx {
  agent?: ConvoAgent | null;
}

function bubbleText(b: ConvoBubble | null | undefined): string {
  if (!b) return '';
  if (typeof b.text === 'function') {
    try { return b.text() || ''; } catch { /* ignore */ }
  }
  if (typeof b.text === 'string') return b.text;
  return '';
}

function userText(turn: ConvoTurn | null | undefined): string {
  if (!turn) return '';
  if (typeof turn.userText === 'string') return turn.userText;
  const node = turn.user as { querySelector?: (sel: string) => Element | null; textContent?: string | null } | null | undefined;
  if (node && typeof node.querySelector === 'function') {
    const body = node.querySelector('.msg-body');
    if (body) return (body.textContent || '').trim();
  }
  if (node && node.textContent) return node.textContent.replace(/^you\s*/i, '').trim();
  return '';
}

function toolTitle(t: ConvoToolEntry | null | undefined): string {
  if (!t || !t.card) return 'tool call';
  const node = t.card.node;
  if (node && typeof node.querySelector === 'function') {
    const titleEl = node.querySelector('.tool-title');
    if (titleEl) return (titleEl.textContent || 'tool call').trim();
  }
  return 'tool call';
}

function toolRawInputJson(t: ConvoToolEntry | null | undefined): string {
  if (!t || !t.card) return '';
  const node = t.card.node;
  if (node && typeof node.querySelector === 'function') {
    const body = node.querySelector('.tool-raw-body');
    if (body) return (body.textContent || '').trim();
  }
  return '';
}

function toolOutput(t: ConvoToolEntry | null | undefined): string {
  if (!t || !t.card) return '';
  const node = t.card.node;
  if (node && typeof node.querySelector === 'function') {
    const body = node.querySelector('.tool-output-body');
    if (body) return (body.textContent || '').trim();
  }
  return '';
}

function indent(text: string, prefix: string): string {
  if (!text) return '';
  return String(text).split('\n').map((l) => prefix + l).join('\n');
}

export function serializeConversation(turns: ConvoTurn[] | null | undefined, ctx?: ConvoCtx | null): string {
  const agent: ConvoAgent = (ctx && ctx.agent) || {};
  const captured = new Date().toISOString();
  const lines: string[] = [];
  lines.push(`# Conversation with ${agent.name || agent.id || 'agent'}`);
  if (agent.model) lines.push(`# Model: ${agent.model}`);
  if (agent.sessionId) lines.push(`# Session: ${agent.sessionId}`);
  lines.push(`# Captured: ${captured}`);
  lines.push('');

  const list = Array.isArray(turns) ? turns : [];
  let first = true;
  for (const turn of list) {
    if (!first) {
      lines.push('');
      lines.push('----');
      lines.push('');
    }
    first = false;

    lines.push('## You');
    lines.push(userText(turn) || '(empty)');
    lines.push('');

    const thinking = bubbleText(turn.thinking).trim();
    if (thinking) {
      lines.push('## Thinking');
      lines.push(thinking);
      lines.push('');
    }

    if (Array.isArray(turn.tools)) {
      for (const t of turn.tools) {
        lines.push(`## Tool: ${toolTitle(t)}`);
        const raw = toolRawInputJson(t);
        if (raw) {
          lines.push(indent(raw, '  '));
        }
        const out = toolOutput(t);
        if (out) {
          lines.push('');
          lines.push('Output:');
          lines.push(out);
        }
        lines.push('');
      }
    }

    // Prefer the full assistants[] list so intermediate status bubbles
    // between tool batches are not dropped when copying.
    const bubbles: ConvoBubble[] = Array.isArray(turn.assistants) && turn.assistants.length
      ? turn.assistants
      : (turn.assistant ? [turn.assistant] : []);
    for (const bubble of bubbles) {
      const assistant = bubbleText(bubble).trim();
      if (!assistant) continue;
      lines.push('## Grok');
      lines.push(assistant);
      lines.push('');
    }
  }

  // collapse trailing blanks
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

export function serializeResumeCommand(agent: ConvoAgent | null | undefined): string {
  const a: ConvoAgent = agent || {};
  const sid = a.sessionId || '<sessionId>';
  const cwd = a.cwd || '<cwd>';
  const lines = [
    'Headless one-shot:',
    `  grok -p "your next prompt" -r ${sid}`,
    '',
    'Interactive (TUI) in the same cwd:',
    `  cd ${cwd}`,
    `  grok --resume ${sid}`,
  ];
  return lines.join('\n');
}
