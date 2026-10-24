// Thread renderer: draws ThreadModel segments into the conversation stream
// and keeps them in sync with the model's change records.
//
// Tool cards are built lazily (first time a run is opened) from the latest
// merged payload, because big histories have hundreds of tool calls and
// building every card up front made replay slow.

import {
  el, renderUserBubble, renderMarkdownLight, renderToolCard, renderTodoWriteCard,
  renderErrorBanner, renderCompactedPill,
  type ToolCard, type ToolPayload,
} from './render.js';
import { unwrap } from './acp-payload.js';
import {
  ThreadModel, summarizeRun, runCaption, thoughtPreview, runIsActive, runFailedCount, footerText,
  type ModelChange, type Segment, type RunSegment, type RunItem, type Turn,
} from './thread-model.js';

export interface ThreadRendererOpts {
  container: HTMLElement;
  model: ThreadModel;
  agentId: () => string | null;
  animate: () => boolean;
  /** Return true when handled elsewhere (desktop details panel); otherwise the run expands inline. */
  onRunActivate?: (runId: string) => boolean;
  /** Called after something expands or collapses in place, so the view can keep the bottom pinned. */
  onExpand?: (node: HTMLElement) => void;
}

interface RunView { el: HTMLElement; count: number; thoughtEls: Map<string, ThoughtEl> }
interface ThoughtEl { root: HTMLElement; preview: HTMLElement; body: HTMLElement }

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** A one-line, tap-to-expand thought (used top-level and inside runs). */
function buildThought(text: string, onToggle: (n: HTMLElement) => void): ThoughtEl {
  const caret = el('span', { class: 'thread-thought__caret' }, '▸');
  const preview = el('span', { class: 'thread-thought__preview' }, thoughtPreview(text));
  const body = el('div', { class: 'thread-thought__body', hidden: true }, text);
  const head = el('button', { class: 'thread-thought__head', type: 'button' }, caret, preview);
  const root = el('div', { class: 'thread-thought' }, head, body);
  head.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    preview.hidden = open;
    caret.textContent = open ? '▾' : '▸';
    root.classList.toggle('thread-thought--open', open);
    onToggle(root);
  });
  return { root, preview, body };
}

function setThoughtText(t: ThoughtEl, text: string): void {
  t.preview.textContent = thoughtPreview(text);
  t.body.textContent = text;
}

export class ThreadRenderer {
  private opts: ThreadRendererOpts;
  private nodes = new Map<string, HTMLElement>();
  private turnRoots = new Map<string, HTMLElement>();
  private thoughts = new Map<string, ThoughtEl>();
  private cards = new Map<string, ToolCard>();
  private payloads = new Map<string, ToolPayload>();
  private pendingDeltas = new Map<string, unknown[]>();
  private planCards = new Map<string, ToolCard>();
  private runViews = new Map<string, RunView>();
  private expanded = new Set<string>();
  private liveEl: HTMLElement | null = null;

  constructor(opts: ThreadRendererOpts) { this.opts = opts; }

  clear(): void {
    this.nodes.clear();
    this.turnRoots.clear();
    this.thoughts.clear();
    this.cards.clear();
    this.payloads.clear();
    this.pendingDeltas.clear();
    this.planCards.clear();
    this.runViews.clear();
    this.expanded.clear();
    this.liveEl = null;
  }

  turnRoot(turnId: string): HTMLElement | undefined { return this.turnRoots.get(turnId); }
  nodeOf(segId: string): HTMLElement | undefined { return this.nodes.get(segId); }
  toolCard(toolCallId: string): ToolCard | undefined { return this.cards.get(toolCallId); }

  /** Card for a tool call, built on first use from the latest merged payload. */
  ensureToolCard(toolCallId: string): ToolCard | undefined {
    const have = this.cards.get(toolCallId);
    if (have) return have;
    const payload = this.payloads.get(toolCallId);
    if (!payload) return undefined;
    const card = renderToolCard(payload);
    for (const d of this.pendingDeltas.get(toolCallId) || []) card.appendDelta(d);
    this.pendingDeltas.delete(toolCallId);
    this.cards.set(toolCallId, card);
    return card;
  }

  apply(ch: ModelChange, name: string, payload: unknown): void {
    this.trackToolPayload(name, payload);
    const { model } = this.opts;
    const turn = ch.turnId ? model.turns.find((t) => t.id === ch.turnId) : undefined;
    if (ch.newTurn && turn) this.addTurnRoot(turn);

    for (const id of ch.removed) {
      const n = this.nodes.get(id);
      if (n) n.remove();
      this.nodes.delete(id);
      this.thoughts.delete(id);
    }
    for (const id of ch.added) {
      const seg = model.segment(id);
      if (seg && turn) this.insertSegment(turn, seg);
    }
    for (const id of ch.updated) {
      const seg = model.segment(id);
      if (seg) this.updateSegment(seg, name, payload);
    }
  }

  /** Spinner row at the very bottom of the thread; null removes it. */
  liveLine(text: string | null): void {
    if (text == null) {
      if (this.liveEl) this.liveEl.remove();
      this.liveEl = null;
      return;
    }
    if (!this.liveEl) {
      this.liveEl = el('div', { class: 'thread-live' },
        el('span', { class: 'thread-spinner', 'aria-hidden': 'true' }),
        el('span', { class: 'thread-live__text' }),
      );
    }
    (this.liveEl.lastChild as HTMLElement).textContent = text;
    if (this.liveEl.parentNode !== this.opts.container || this.opts.container.lastChild !== this.liveEl) {
      this.opts.container.appendChild(this.liveEl);
    }
  }

  /** Open a run: desktop panel if the view handles it, otherwise toggle inline. */
  activateRun(runId: string): void {
    if (this.opts.onRunActivate && this.opts.onRunActivate(runId)) return;
    const node = this.nodes.get(runId);
    const seg = this.opts.model.segment(runId);
    if (!node || !seg || seg.type !== 'run') return;
    if (this.expanded.has(runId)) {
      this.expanded.delete(runId);
      const v = this.runViews.get(runId);
      if (v) v.el.remove();
    } else {
      this.expanded.add(runId);
      node.appendChild(this.runItemsView(runId));
    }
    this.paintRun(node, seg);
    if (this.opts.onExpand) this.opts.onExpand(node);
  }

  /** Show a run (from the status panel): desktop panel, or expand inline and scroll to it. */
  revealRun(runId: string): void {
    if (this.opts.onRunActivate && this.opts.onRunActivate(runId)) return;
    if (!this.expanded.has(runId)) this.activateRun(runId);
    const node = this.nodes.get(runId);
    if (node) node.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  /** Thoughts and tool cards of a run, interleaved in order. One live view per run. */
  runItemsView(runId: string): HTMLElement {
    const seg = this.opts.model.segment(runId);
    let view = this.runViews.get(runId);
    if (!view) {
      view = { el: el('div', { class: 'thread-run__items' }), count: 0, thoughtEls: new Map() };
      this.runViews.set(runId, view);
    }
    if (seg && seg.type === 'run') this.syncRunView(view, seg.items);
    return view.el;
  }

  // ── internals ───────────────────────────────────────────────────────

  private trackToolPayload(name: string, payload: unknown): void {
    if (name !== 'tool_call' && name !== 'tool_call_update' && name !== 'tool_call_delta_chunk') return;
    const data = unwrap(payload) as ToolPayload;
    const id = typeof data.toolCallId === 'string' ? data.toolCallId : null;
    if (!id) return;

    const plan = this.opts.model.planOf(id);
    if (plan) {
      const card = this.planCards.get(plan.id);
      if (card && name !== 'tool_call_delta_chunk') {
        if (plan.toolCallId === id) card.applyUpdate(data);
        else if (card.ingestExternal) card.ingestExternal(data);
      }
      this.payloads.set(id, { ...(this.payloads.get(id) || {}), ...data });
      return;
    }

    const card = this.cards.get(id);
    if (name === 'tool_call_delta_chunk') {
      if (card) card.appendDelta(data);
      else {
        const list = this.pendingDeltas.get(id) || [];
        list.push(data);
        this.pendingDeltas.set(id, list);
      }
      return;
    }
    this.payloads.set(id, { ...(this.payloads.get(id) || {}), ...data });
    if (card) card.applyUpdate(data);
  }

  private addTurnRoot(turn: Turn): void {
    const cls = ['turn', 'thread-turn'];
    if (turn.background) cls.push('thread-turn--background');
    if (this.opts.animate()) cls.push('turn--enter');
    const root = el('div', { class: cls.join(' '), 'data-turn': turn.id });
    this.turnRoots.set(turn.id, root);
    const c = this.opts.container;
    if (this.liveEl && this.liveEl.parentNode === c) c.insertBefore(root, this.liveEl);
    else c.appendChild(root);
  }

  private insertSegment(turn: Turn, seg: Segment): void {
    let root = this.turnRoots.get(turn.id);
    if (!root) { this.addTurnRoot(turn); root = this.turnRoots.get(turn.id)!; }
    const node = this.buildSegment(seg);
    if (!node) return;
    this.nodes.set(seg.id, node);
    // Insert at the segment's position (usually the end; a run that dissolves
    // back into thoughts re-inserts them mid-turn).
    const idx = turn.segments.indexOf(seg);
    let before: Node | null = null;
    for (let i = idx + 1; i < turn.segments.length; i++) {
      const n = this.nodes.get(turn.segments[i]!.id);
      if (n && n.parentNode === root) { before = n; break; }
    }
    root.insertBefore(node, before);
  }

  private buildSegment(seg: Segment): HTMLElement | null {
    const animate = this.opts.animate();
    switch (seg.type) {
      case 'user': {
        const n = renderUserBubble(seg.text, seg.ts, { attachments: seg.attachments as never, agentId: this.opts.agentId() || undefined });
        n.classList.add('thread-user');
        return n;
      }
      case 'marker':
        return el('div', { class: 'thread-marker' }, `grok · ${seg.text}`);
      case 'message': {
        const n = el('div', { class: `thread-msg${animate ? ' msg--enter' : ''}`, title: fmtClock(seg.ts) },
          renderMarkdownLight(seg.text));
        return n;
      }
      case 'thought': {
        const t = buildThought(seg.text, (n) => this.opts.onExpand && this.opts.onExpand(n));
        this.thoughts.set(seg.id, t);
        return t.root;
      }
      case 'run': {
        const node = el('div', { class: 'thread-run', 'data-run': seg.id });
        const head = el('button', { class: 'thread-run__head', type: 'button' },
          el('span', { class: 'thread-run__caret' }),
          el('span', { class: 'thread-spinner thread-run__spinner', 'aria-hidden': 'true' }),
          el('span', { class: 'thread-run__summary' }),
          el('span', { class: 'thread-run__failed' }),
        );
        head.addEventListener('click', () => this.activateRun(seg.id));
        node.append(head, el('div', { class: 'thread-run__caption' }));
        this.paintRun(node, seg);
        return node;
      }
      case 'plan': {
        const payload = this.payloads.get(seg.toolCallId) || { toolCallId: seg.toolCallId };
        const card = renderTodoWriteCard(payload);
        this.planCards.set(seg.id, card);
        card.node.classList.add('thread-plan');
        return card.node;
      }
      case 'error':
        return renderErrorBanner(seg.text);
      case 'compacted':
        return renderCompactedPill(seg.text);
      case 'footer': {
        const turn = this.opts.model.turns.find((t) => t.segments.includes(seg));
        const user = turn && turn.segments.find((x) => x.type === 'user');
        const started = user && user.type === 'user' ? user.ts : null;
        const detail = Object.entries(seg.meta)
          .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
          .map(([k, v]) => `${k}: ${v}`).join('\n');
        return el('div', { class: 'thread-footer', title: detail },
          footerText(seg.meta, started != null ? seg.ts - started : null));
      }
      default:
        return null;
    }
  }

  private updateSegment(seg: Segment, _name: string, _payload: unknown): void {
    const node = this.nodes.get(seg.id);
    if (!node) return;
    switch (seg.type) {
      case 'user': {
        const fresh = this.buildSegment(seg);
        if (fresh) { node.replaceWith(fresh); this.nodes.set(seg.id, fresh); }
        return;
      }
      case 'message':
        node.replaceChildren(renderMarkdownLight(seg.text));
        return;
      case 'thought': {
        const t = this.thoughts.get(seg.id);
        if (t) setThoughtText(t, seg.text);
        return;
      }
      case 'run':
        this.paintRun(node, seg);
        if (this.runViews.has(seg.id)) this.syncRunView(this.runViews.get(seg.id)!, seg.items);
        return;
      case 'footer': {
        const fresh = this.buildSegment(seg);
        if (fresh) { node.replaceWith(fresh); this.nodes.set(seg.id, fresh); }
        return;
      }
      default:
        return; // plan cards update through trackToolPayload; others are static
    }
  }

  private paintRun(node: HTMLElement, seg: RunSegment): void {
    // A closed run only spins while grok is still working (a tool that never
    // got a final status in history must not spin forever).
    const active = seg.open || (runIsActive(seg.items) && this.opts.model.isRunning());
    const failed = runFailedCount(seg.items);
    const open = this.expanded.has(seg.id);
    node.classList.toggle('thread-run--active', active);
    node.classList.toggle('thread-run--open', open);
    const head = node.firstChild as HTMLElement;
    (head.querySelector('.thread-run__caret') as HTMLElement).textContent = open ? '▾' : '▸';
    const summary = summarizeRun(seg.items).replace(/ · \d+ failed$/, '');
    (head.querySelector('.thread-run__summary') as HTMLElement).textContent = active ? `${summary}…` : summary;
    const failedEl = head.querySelector('.thread-run__failed') as HTMLElement;
    failedEl.textContent = failed ? ` · ${failed} failed` : '';
    const caption = node.querySelector(':scope > .thread-run__caption') as HTMLElement;
    const text = seg.open ? runCaption(seg.items) : null;
    caption.textContent = text || '';
    caption.hidden = !text;
  }

  private syncRunView(view: RunView, items: RunItem[]): void {
    // Update thoughts already shown (they grow while streaming).
    for (let i = 0; i < Math.min(view.count, items.length); i++) {
      const it = items[i]!;
      if (it.type === 'thought') {
        const t = view.thoughtEls.get(it.id);
        if (t) setThoughtText(t, it.text);
      }
    }
    // Rebuild if items were removed (a TodoWrite moved out of the run).
    if (items.length < view.count) {
      view.el.replaceChildren();
      view.thoughtEls.clear();
      view.count = 0;
    }
    for (let i = view.count; i < items.length; i++) {
      const it = items[i]!;
      if (it.type === 'thought') {
        const t = buildThought(it.text, (n) => this.opts.onExpand && this.opts.onExpand(n));
        t.root.classList.add('thread-thought--in-run');
        view.thoughtEls.set(it.id, t);
        view.el.appendChild(t.root);
      } else {
        const card = this.ensureToolCard(it.toolCallId);
        view.el.appendChild(card ? card.node : el('div', { class: 'thread-run__missing' }, it.title));
      }
    }
    view.count = items.length;
  }
}
