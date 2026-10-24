// Thread model: turns grok's SSE / history events into an ordered list of
// turns, each holding segments (user bubble, message, thought, tool run, ...).
//
// Pure: no DOM. The chat view feeds every event through `apply()` and hands
// the returned change record to the renderer. Live events and history replay
// share this one path so they can't drift apart.
//
// Grouping rules (see docs/superpowers/specs/2026-10-25-chat-first-redesign-design.md):
// - a new segment starts whenever the segment type changes
// - a tool run stays open through thoughts and absorbs the thought just
//   before its first tool call; it closes on anything else
// - events that arrive after a turn ended (footer or idle) start a
//   "background update" turn, because grok wakes itself up on task completion

import { unwrap, extractText } from './acp-payload.js';
import { isTodoWriteToolCall, readToolStatus, inferToolTitle, type ToolPayload } from './render.js';

export type ToolStatus = 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Canceled';
export interface RunTool    { type: 'tool'; toolCallId: string; kind: string; title: string; status: ToolStatus }
export interface RunThought { type: 'thought'; id: string; text: string }
export type RunItem = RunTool | RunThought;

export type Segment =
  | { id: string; type: 'user'; text: string; attachments: unknown[]; ts: number }
  | { id: string; type: 'marker'; text: string }
  | { id: string; type: 'message'; text: string; ts: number }
  | { id: string; type: 'thought'; text: string }
  | { id: string; type: 'run'; items: RunItem[]; open: boolean }
  | { id: string; type: 'plan'; toolCallId: string }
  | { id: string; type: 'error'; text: string }
  | { id: string; type: 'compacted'; text: string }
  | { id: string; type: 'footer'; meta: Record<string, unknown>; ts: number };

export type RunSegment = Extract<Segment, { type: 'run' }>;
export type PlanSegment = Extract<Segment, { type: 'plan' }>;

export interface Turn { id: string; segments: Segment[]; running: boolean; background: boolean }

export interface ModelChange {
  turnId: string | null;
  added: string[];
  updated: string[];
  removed: string[];
  newTurn: boolean;
}

const ENDING_STATUSES = new Set(['idle', 'errored', 'killed', 'exited', 'disconnected']);

function toToolStatus(payload: ToolPayload): ToolStatus | null {
  const s = readToolStatus(payload);
  switch (s) {
    case 'Pending': case 'Running': case 'Completed': case 'Failed': case 'Canceled': return s;
    default: return null;
  }
}

export class ThreadModel {
  turns: Turn[] = [];
  private seq = 0;
  private byId = new Map<string, Segment>();
  private runByTool = new Map<string, RunSegment>();
  private planByTool = new Map<string, PlanSegment>();
  private currentPlan: PlanSegment | null = null;
  private ended = new WeakSet<Turn>();
  private running = false;
  private lastWasUserChunk = false;

  reset(): void {
    this.turns = [];
    this.seq = 0;
    this.byId.clear();
    this.runByTool.clear();
    this.planByTool.clear();
    this.currentPlan = null;
    this.ended = new WeakSet<Turn>();
    this.running = false;
    this.lastWasUserChunk = false;
  }

  segment(id: string): Segment | undefined { return this.byId.get(id); }
  runOf(toolCallId: string): RunSegment | undefined { return this.runByTool.get(toolCallId); }
  planOf(toolCallId: string): PlanSegment | undefined { return this.planByTool.get(toolCallId); }
  activeTurn(): Turn | null { return this.turns[this.turns.length - 1] || null; }
  isRunning(): boolean { return this.running; }

  apply(name: string, payload: unknown, opts: { ts?: number } = {}): ModelChange {
    const ts = opts.ts ?? Date.now();
    const data = unwrap(payload) as Record<string, unknown>;
    const ch: ModelChange = { turnId: null, added: [], updated: [], removed: [], newTurn: false };
    const wasUserChunk = this.lastWasUserChunk;
    this.lastWasUserChunk = false;

    switch (name) {
      case 'user_message': this.onUserMessage(data, ts, ch); break;
      case 'user_message_chunk': this.onUserChunk(data, ts, ch, wasUserChunk); break;
      case 'agent_message_chunk': this.onMessage(data, ts, ch); break;
      case 'agent_thought_chunk': this.onThought(data, ch); break;
      case 'tool_call': this.onTool(data as ToolPayload, ch); break;
      case 'tool_call_update': this.onTool(data as ToolPayload, ch); break;
      case 'tool_call_delta_chunk': this.onDelta(data as ToolPayload, ch); break;
      case 'prompt_complete': this.onComplete(payload, data, ts, ch); break;
      case 'prompt_result': this.onResult(payload, ch); break;
      case 'agent_status': this.onStatus(data, ch); break;
      case 'error': this.onNote('error', data, ch); break;
      case 'session_summary_generated': this.onNote('compacted', data, ch); break;
      default: break;
    }
    return ch;
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private nextId(): string { return `s${++this.seq}`; }

  private add<S extends Segment>(turn: Turn, seg: S, ch: ModelChange): S {
    turn.segments.push(seg);
    this.byId.set(seg.id, seg);
    ch.turnId = turn.id;
    ch.added.push(seg.id);
    return seg;
  }

  private touch(turn: Turn, id: string, ch: ModelChange): void {
    ch.turnId = turn.id;
    if (!ch.updated.includes(id) && !ch.added.includes(id)) ch.updated.push(id);
  }

  private newTurn(ch: ModelChange, background: boolean): Turn {
    const turn: Turn = { id: `t${this.turns.length + 1}`, segments: [], running: this.running, background };
    this.turns.push(turn);
    ch.newTurn = true;
    ch.turnId = turn.id;
    if (background) this.add(turn, { id: this.nextId(), type: 'marker', text: 'background update' }, ch);
    return turn;
  }

  /** Turn that agent output should land in: the open turn, or a new background turn. */
  private agentTurn(ch: ModelChange): Turn {
    const t = this.activeTurn();
    if (t && !this.ended.has(t)) return t;
    return this.newTurn(ch, true);
  }

  private last(turn: Turn): Segment | undefined { return turn.segments[turn.segments.length - 1]; }

  private closeRun(turn: Turn, ch: ModelChange): void {
    const l = this.last(turn);
    if (l && l.type === 'run' && l.open) {
      l.open = false;
      this.touch(turn, l.id, ch);
    }
  }

  private endTurn(turn: Turn, ch: ModelChange): void {
    this.closeRun(turn, ch);
    turn.running = false;
    this.ended.add(turn);
  }

  // ── event handlers ───────────────────────────────────────────────────

  private onUserMessage(data: Record<string, unknown>, ts: number, ch: ModelChange): void {
    const text = typeof data.text === 'string' ? data.text : (extractText(data) || '');
    const attachments = Array.isArray(data.attachments) ? data.attachments : [];
    if (!text && !attachments.length) return;
    const t = this.activeTurn();
    if (t && !this.ended.has(t) && t.segments.length === 1) {
      const u = t.segments[0]!;
      if (u.type === 'user' && (u.text === text || (u.attachments.length && attachments.length))) return;
    }
    const prev = this.activeTurn();
    if (prev && !this.ended.has(prev)) this.endTurn(prev, ch);
    const turn = this.newTurn(ch, false);
    this.add(turn, { id: this.nextId(), type: 'user', text, attachments, ts }, ch);
  }

  private onUserChunk(data: Record<string, unknown>, ts: number, ch: ModelChange, continuing: boolean): void {
    const text = extractText(data);
    if (text == null) return;
    this.lastWasUserChunk = true;
    const t = this.activeTurn();
    if (continuing && t && t.segments.length === 1 && t.segments[0]!.type === 'user') {
      const u = t.segments[0] as Extract<Segment, { type: 'user' }>;
      u.text += text;
      this.touch(t, u.id, ch);
      return;
    }
    if (t && !this.ended.has(t)) this.endTurn(t, ch);
    const turn = this.newTurn(ch, false);
    this.add(turn, { id: this.nextId(), type: 'user', text, attachments: [], ts }, ch);
  }

  private onMessage(data: Record<string, unknown>, ts: number, ch: ModelChange): void {
    const text = extractText(data);
    if (text == null) return;
    const turn = this.agentTurn(ch);
    this.closeRun(turn, ch);
    const l = this.last(turn);
    if (l && l.type === 'message') {
      l.text += text;
      this.touch(turn, l.id, ch);
      return;
    }
    this.add(turn, { id: this.nextId(), type: 'message', text, ts }, ch);
  }

  private onThought(data: Record<string, unknown>, ch: ModelChange): void {
    const text = extractText(data);
    if (text == null) return;
    const turn = this.agentTurn(ch);
    const l = this.last(turn);
    if (l && l.type === 'run' && l.open) {
      const li = l.items[l.items.length - 1];
      if (li && li.type === 'thought') li.text += text;
      else l.items.push({ type: 'thought', id: this.nextId(), text });
      this.touch(turn, l.id, ch);
      return;
    }
    if (l && l.type === 'thought') {
      l.text += text;
      this.touch(turn, l.id, ch);
      return;
    }
    this.add(turn, { id: this.nextId(), type: 'thought', text }, ch);
  }

  private onTool(data: ToolPayload, ch: ModelChange): void {
    const id = typeof data.toolCallId === 'string' ? data.toolCallId : null;
    if (!id) return;

    // TodoWrite: one plan segment, later merge calls update it.
    const knownPlan = this.planByTool.get(id);
    if (knownPlan || isTodoWriteToolCall(data)) {
      this.onPlan(id, data, knownPlan, ch);
      return;
    }

    const existing = this.runByTool.get(id);
    if (existing) {
      const item = existing.items.find((i): i is RunTool => i.type === 'tool' && i.toolCallId === id)!;
      const st = toToolStatus(data);
      if (st) item.status = st;
      if (typeof data.kind === 'string' && data.kind) item.kind = data.kind;
      if (data.title || data.rawInput) item.title = inferToolTitle(data);
      const owner = this.turns.find((t) => t.segments.includes(existing));
      if (owner) this.touch(owner, existing.id, ch);
      return;
    }
    this.addTool(id, data, ch);
  }

  private addTool(id: string, data: ToolPayload, ch: ModelChange): void {
    const item: RunTool = {
      type: 'tool',
      toolCallId: id,
      kind: typeof data.kind === 'string' && data.kind ? data.kind : 'other',
      title: inferToolTitle(data),
      status: toToolStatus(data) || 'Pending',
    };
    const turn = this.agentTurn(ch);
    const l = this.last(turn);
    if (l && l.type === 'run' && l.open) {
      l.items.push(item);
      this.runByTool.set(id, l);
      this.touch(turn, l.id, ch);
      return;
    }
    const items: RunItem[] = [];
    if (l && l.type === 'thought') {
      turn.segments.pop();
      this.byId.delete(l.id);
      ch.removed.push(l.id);
      items.push({ type: 'thought', id: l.id, text: l.text });
    }
    items.push(item);
    const run = this.add(turn, { id: this.nextId(), type: 'run', items, open: true }, ch);
    this.runByTool.set(id, run);
  }

  /** Drop a tool that turned out to be a TodoWrite from the run it was first filed in. */
  private detachFromRun(id: string, ch: ModelChange): void {
    const run = this.runByTool.get(id);
    if (!run) return;
    this.runByTool.delete(id);
    run.items = run.items.filter((i) => !(i.type === 'tool' && i.toolCallId === id));
    const owner = this.turns.find((t) => t.segments.includes(run));
    if (!owner) return;
    if (run.items.some((i) => i.type === 'tool')) { this.touch(owner, run.id, ch); return; }
    // Nothing but thoughts left: put them back as top-level thoughts.
    const at = owner.segments.indexOf(run);
    const thoughts: Segment[] = run.items.map((i) => ({ id: (i as RunThought).id, type: 'thought', text: (i as RunThought).text }));
    owner.segments.splice(at, 1, ...thoughts);
    this.byId.delete(run.id);
    ch.removed.push(run.id);
    for (const t of thoughts) { this.byId.set(t.id, t); ch.added.push(t.id); }
    ch.turnId = owner.id;
  }

  private onPlan(id: string, data: ToolPayload, known: PlanSegment | undefined, ch: ModelChange): void {
    this.detachFromRun(id, ch);
    const merge = !!(data.rawInput && data.rawInput.merge);
    const target = known || (merge ? this.currentPlan : null);
    if (target) {
      this.planByTool.set(id, target);
      const owner = this.turns.find((t) => t.segments.includes(target));
      if (owner) this.touch(owner, target.id, ch);
      return;
    }
    const turn = this.agentTurn(ch);
    this.closeRun(turn, ch);
    const seg = this.add(turn, { id: this.nextId(), type: 'plan', toolCallId: id }, ch);
    this.planByTool.set(id, seg);
    this.currentPlan = seg;
  }

  private onDelta(data: ToolPayload, ch: ModelChange): void {
    const id = typeof data.toolCallId === 'string' ? data.toolCallId : null;
    if (!id) return;
    const run = this.runByTool.get(id);
    if (run) {
      const owner = this.turns.find((t) => t.segments.includes(run));
      if (owner) this.touch(owner, run.id, ch);
      return;
    }
    if (this.planByTool.has(id)) return;
    this.addTool(id, { toolCallId: id, status: 'running' }, ch);
  }

  private onComplete(payload: unknown, data: Record<string, unknown>, ts: number, ch: ModelChange): void {
    const turn = this.activeTurn();
    if (!turn || this.ended.has(turn)) return;
    const raw = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const meta = (raw._meta as Record<string, unknown>) || (data._meta as Record<string, unknown>) || data;
    this.closeRun(turn, ch);
    this.add(turn, { id: this.nextId(), type: 'footer', meta, ts }, ch);
    this.endTurn(turn, ch);
  }

  /** Token counts arrive in prompt_result just after prompt_complete: merge them into the footer. */
  private onResult(payload: unknown, ch: ModelChange): void {
    const turn = this.activeTurn();
    const footer = turn && [...turn.segments].reverse().find((s) => s.type === 'footer');
    const meta = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)._meta : null;
    if (!turn || !footer || footer.type !== 'footer' || !meta || typeof meta !== 'object') return;
    footer.meta = { ...footer.meta, ...(meta as Record<string, unknown>) };
    this.touch(turn, footer.id, ch);
  }

  private onStatus(data: Record<string, unknown>, ch: ModelChange): void {
    const s = String(data.status || data.state || '');
    const turn = this.activeTurn();
    if (s === 'running') {
      this.running = true;
      if (turn && !this.ended.has(turn)) turn.running = true;
    } else if (ENDING_STATUSES.has(s)) {
      this.running = false;
      if (turn && !this.ended.has(turn)) this.endTurn(turn, ch);
    }
  }

  private onNote(type: 'error' | 'compacted', data: Record<string, unknown>, ch: ModelChange): void {
    const text = String(
      (type === 'error' ? (data.message || data.error) : (data.summary || data.text)) || '',
    );
    const turn = this.activeTurn() || this.newTurn(ch, false);
    this.closeRun(turn, ch);
    this.add(turn, { id: this.nextId(), type, text }, ch);
  }
}

// ── run summary helpers ────────────────────────────────────────────────

const KIND_WORDING: Record<string, [string, string, string]> = {
  // kind: [verb, singular noun, plural noun]
  execute: ['ran', 'command', 'commands'],
  read:    ['read', 'file', 'files'],
  edit:    ['edited', 'file', 'files'],
  delete:  ['deleted', 'file', 'files'],
  move:    ['moved', 'file', 'files'],
  search:  ['ran', 'search', 'searches'],
  fetch:   ['fetched', 'URL', 'URLs'],
};
const OTHER_WORDING: [string, string, string] = ['used', 'tool', 'tools'];

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const capitalise = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function clip(text: string, max: number): string {
  const first = text.split('\n').find((l) => l.trim()) || '';
  const line = first.trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Collapsed one-line summary, e.g. "Ran 2 commands, read 1 file · 3 thoughts · 1 failed". */
export function summarizeRun(items: RunItem[]): string {
  const counts = new Map<string, number>();
  let thoughts = 0;
  for (const it of items) {
    if (it.type === 'thought') { thoughts++; continue; }
    const key = KIND_WORDING[it.kind] ? it.kind : 'other';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const parts: string[] = [];
  for (const [kind, n] of counts) {
    const [verb, one, many] = KIND_WORDING[kind] || OTHER_WORDING;
    parts.push(`${verb} ${plural(n, one, many)}`);
  }
  const extras: string[] = [];
  if (thoughts) extras.push(plural(thoughts, 'thought', 'thoughts'));
  const failed = runFailedCount(items);
  if (failed) extras.push(`${failed} failed`);
  return capitalise([parts.join(', '), ...extras].filter(Boolean).join(' · '));
}

/** Live caption for an active run: the latest thought's first line, ≤120 chars. */
export function runCaption(items: RunItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.type === 'thought') return clip(it.text, 120);
  }
  return null;
}

/** One-line preview of a thought, ≤100 chars. */
export function thoughtPreview(text: string): string { return clip(text, 100); }

export function runIsActive(items: RunItem[]): boolean {
  return items.some((i) => i.type === 'tool' && (i.status === 'Pending' || i.status === 'Running'));
}

export function runFailedCount(items: RunItem[]): number {
  return items.filter((i) => i.type === 'tool' && i.status === 'Failed').length;
}

// ── turn footer ─────────────────────────────────────────────────────────

function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

/** One muted line under a finished turn, e.g. "grok-4.7 · in 183k · out 90 · 1m 12s". */
export function footerText(meta: Record<string, unknown>, durationMs: number | null): string {
  const num = (...keys: string[]) => {
    for (const k of keys) { const v = meta[k]; if (typeof v === 'number' && Number.isFinite(v)) return v; }
    return null;
  };
  const parts: string[] = [];
  const model = meta.modelId ?? meta.model_id;
  if (typeof model === 'string' && model) parts.push(model);
  const input = num('inputTokens', 'input_tokens');
  const output = num('outputTokens', 'output_tokens');
  if (input != null) parts.push(`in ${fmtTok(input)}`);
  if (output != null) parts.push(`out ${fmtTok(output)}`);
  if (durationMs != null && durationMs > 0) parts.push(fmtDuration(durationMs));
  return parts.length ? parts.join(' · ') : 'turn complete';
}
