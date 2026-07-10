// EventSource wrapper.
//
// Notes:
// - The browser's EventSource already handles Last-Event-ID automatically on
//   reconnect: it sends the value of the last `id:` field it observed.
// - We surface lifecycle hooks (open / error / event), allow registering
//   handlers per event name, and expose a close() that stops the connection.
// - The server is expected to emit named events (sessionUpdate discriminator)
//   plus our own lifecycle ones: agent_status, prompt_complete, error.

const KNOWN_EVENTS = [
  // User input (emitted by the server when any client POSTs /prompt).
  // Without this, remote browsers never receive the text and ensureTurn()
  // creates empty "you" ghost bubbles when the assistant reply starts.
  'user_message',
  // Live ACP session updates
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'tool_call_delta_chunk',
  'available_commands_update',
  'session_summary_generated',
  // Lifecycle / status
  'agent_status',
  'agent_updated',
  'agent_renamed',
  'agent_exited',
  'handshake',
  'session_ready',
  'prompt_complete',
  'prompt_result',
  'error',
  'session_notification',
  'stderr',
] as const;

export type StreamEventName = (typeof KNOWN_EVENTS)[number] | 'message';

export type StreamHandler = (parsed: unknown, ev: MessageEvent) => void;

export interface StreamOptions {
  onOpen?: () => void;
  onError?: (err: unknown) => void;
  onAny?: (name: StreamEventName, parsed: unknown, ev: MessageEvent) => void;
  on?: Partial<Record<StreamEventName, StreamHandler>>;
}

export interface StreamHandle {
  close(): void;
  isClosed(): boolean;
  readyState(): number;
}

export function openStream(url: string, { onOpen, onError, onAny, on }: StreamOptions = {}): StreamHandle {
  let es: EventSource | null = null;
  let closed = false;

  const handlers: Partial<Record<StreamEventName, StreamHandler>> = { ...(on || {}) };

  const attach = (source: EventSource): void => {
    source.addEventListener('open', () => {
      if (typeof onOpen === 'function') onOpen();
    });
    source.addEventListener('error', (ev: Event) => {
      if (typeof onError === 'function') onError(ev);
    });
    for (const name of KNOWN_EVENTS) {
      source.addEventListener(name, (ev: MessageEvent) => {
        let parsed: unknown = ev.data;
        try { parsed = JSON.parse(ev.data); } catch { /* keep raw */ }
        if (typeof onAny === 'function') onAny(name, parsed, ev);
        const handler = handlers[name];
        if (typeof handler === 'function') handler(parsed, ev);
      });
    }
    source.addEventListener('message', (ev: MessageEvent) => {
      let parsed: unknown = ev.data;
      try { parsed = JSON.parse(ev.data); } catch { /* keep raw */ }
      if (typeof onAny === 'function') onAny('message', parsed, ev);
      const handler = handlers['message'];
      if (typeof handler === 'function') handler(parsed, ev);
    });
  };

  try {
    es = new EventSource(url);
    attach(es);
  } catch (err) {
    if (typeof onError === 'function') onError(err);
  }

  return {
    close(): void {
      closed = true;
      if (es) {
        try { es.close(); } catch { /* ignore */ }
        es = null;
      }
    },
    isClosed(): boolean { return closed; },
    readyState(): number { return es ? es.readyState : 2; },
  };
}
