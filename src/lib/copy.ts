// Clipboard helpers + conversation serializers.
//
// copyToClipboard(text): async; uses navigator.clipboard if available,
//   falls back to a hidden textarea + document.execCommand('copy') for
//   non-secure contexts (e.g., tailnet http://).
//
// serializeThread(turns, toolText): renders the thread model's turns to a
//   plain text block suitable for pasting into a file.
//
// serializeResumeCommand(agent): renders the "Resume on CLI" instructions
//   that get pasted into a terminal.

import type { Turn } from './thread-model.js';

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

function indent(text: string, prefix: string): string {
  if (!text) return '';
  return String(text).split('\n').map((l) => prefix + l).join('\n');
}

/** Raw input and output text of a rendered tool card (used by copy). */
export function toolCardText(node: { querySelector?: (sel: string) => Element | null } | null | undefined): string {
  if (!node || typeof node.querySelector !== 'function') return '';
  const raw = (node.querySelector('.tool-raw-body')?.textContent || '').trim();
  const out = (node.querySelector('.tool-output-body')?.textContent || '').trim();
  const parts: string[] = [];
  if (raw) parts.push(indent(raw, '  '));
  if (out) parts.push(`Output:\n${out}`);
  return parts.join('\n\n');
}

/**
 * Plain-text copy of the conversation, in the order things happened.
 * `toolText(toolCallId)` returns a tool call's input/output text.
 */
export function serializeThread(
  turns: Turn[] | null | undefined,
  toolText: (toolCallId: string) => string,
  ctx?: ConvoCtx | null,
): string {
  const agent: ConvoAgent = (ctx && ctx.agent) || {};
  const lines: string[] = [];
  lines.push(`# Conversation with ${agent.name || agent.id || 'agent'}`);
  if (agent.model) lines.push(`# Model: ${agent.model}`);
  if (agent.sessionId) lines.push(`# Session: ${agent.sessionId}`);
  lines.push(`# Captured: ${new Date().toISOString()}`);
  lines.push('');

  const section = (title: string, body: string) => {
    lines.push(`## ${title}`);
    if (body) lines.push(body);
    lines.push('');
  };
  const tool = (id: string, title: string, status?: string) => {
    section(`Tool: ${title}${status ? ` (${status.toLowerCase()})` : ''}`, toolText(id).trim());
  };

  (turns || []).forEach((turn, i) => {
    if (i > 0) lines.push('', '----', '');
    for (const seg of turn.segments) {
      switch (seg.type) {
        case 'user':      section('You', seg.text || '(empty)'); break;
        case 'marker':    section(`Grok (${seg.text})`, ''); break;
        case 'message':   section('Grok', seg.text.trim()); break;
        case 'thought':   section('Thinking', seg.text.trim()); break;
        case 'run':
          for (const it of seg.items) {
            if (it.type === 'thought') section('Thinking', it.text.trim());
            else tool(it.toolCallId, it.title, it.status);
          }
          break;
        case 'plan':      tool(seg.toolCallId, 'plan'); break;
        case 'error':     section('Error', seg.text); break;
        case 'compacted': section('Compacted', seg.text); break;
        default: break; // footer
      }
    }
  });

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
