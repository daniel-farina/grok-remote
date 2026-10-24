// One-line status bar above the conversation, with a drop-down panel that
// overlays the thread (background shells, this turn's tool calls, skills).

import { el } from './render.js';

export type ConnState = 'connected' | 'reconnecting' | 'disconnected';

export interface StatusInput {
  conn: ConnState;
  agentStatus: string | null;
  activity: string | null;
  toolsThisTurn: number;
  bgRunning: number;
}

export type StatusDot = 'ok' | 'warn' | 'fail' | 'idle';

const AGENT_WORDS: Record<string, [string, StatusDot]> = {
  running: ['working', 'warn'],
  idle: ['idle', 'ok'],
  errored: ['errored', 'fail'],
  killed: ['killed', 'fail'],
  exited: ['disconnected', 'fail'],
  disconnected: ['disconnected', 'fail'],
  starting: ['starting', 'warn'],
};

/** Text and dot colour for the collapsed bar, e.g. "working · curl -s · 14 tools · bg 1". */
export function statusSummary(s: StatusInput): { dot: StatusDot; text: string } {
  let state: string;
  let dot: StatusDot;
  if (s.conn === 'reconnecting') { state = 'reconnecting'; dot = 'warn'; }
  else if (s.conn === 'disconnected') { state = 'disconnected'; dot = 'fail'; }
  else {
    const w = AGENT_WORDS[String(s.agentStatus || '')];
    [state, dot] = w || [String(s.agentStatus || 'idle'), 'idle'];
  }
  const parts = [state];
  if (s.activity) parts.push(s.activity);
  if (s.toolsThisTurn > 0) parts.push(`${s.toolsThisTurn} tool${s.toolsThisTurn === 1 ? '' : 's'}`);
  if (s.bgRunning > 0) parts.push(`bg ${s.bgRunning}`);
  return { dot, text: parts.join(' · ') };
}

export class StatusBar {
  readonly el: HTMLElement;
  private bar: HTMLElement;
  private dotEl: HTMLElement;
  private textEl: HTMLElement;
  private chevron: HTMLElement;
  private panel: HTMLElement;
  private backdrop: HTMLElement;
  private onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && this.isOpen()) this.close(); };
  /** Called just before the panel opens, so the owner can refresh its sections. */
  onOpen: (() => void) | null = null;

  constructor() {
    this.dotEl = el('span', { class: 'status-bar__dot status-bar__dot--idle' });
    this.textEl = el('span', { class: 'status-bar__text' });
    this.chevron = el('span', { class: 'status-bar__chevron', 'aria-hidden': 'true' }, '▾');
    this.bar = el('button', {
      class: 'status-bar', type: 'button', 'aria-expanded': 'false', 'aria-haspopup': 'true',
      title: 'Show background shells and tool calls',
    }, this.dotEl, this.textEl, this.chevron);
    this.panel = el('div', { class: 'status-panel', hidden: true, role: 'dialog', 'aria-label': 'Activity' });
    this.backdrop = el('div', { class: 'status-backdrop', hidden: true });
    this.el = el('div', { class: 'status-wrap' }, this.bar, this.backdrop, this.panel);
    this.bar.addEventListener('click', () => (this.isOpen() ? this.close() : this.open()));
    this.backdrop.addEventListener('click', () => this.close());
  }

  render(s: StatusInput): void {
    const { dot, text } = statusSummary(s);
    this.dotEl.className = `status-bar__dot status-bar__dot--${dot}`;
    this.textEl.textContent = text;
  }

  setPanelContent(...sections: HTMLElement[]): void {
    this.panel.replaceChildren(...sections);
  }

  open(): void {
    if (this.onOpen) this.onOpen();
    this.panel.hidden = false;
    this.backdrop.hidden = false;
    this.bar.setAttribute('aria-expanded', 'true');
    this.chevron.textContent = '▴';
    document.addEventListener('keydown', this.onKey);
  }

  close(): void {
    this.panel.hidden = true;
    this.backdrop.hidden = true;
    this.bar.setAttribute('aria-expanded', 'false');
    this.chevron.textContent = '▾';
    document.removeEventListener('keydown', this.onKey);
  }

  isOpen(): boolean { return !this.panel.hidden; }
}
